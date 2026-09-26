import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { A2UISurface, DATA_CATALOG_ID, PROMPT_EXAMPLE } from '../../src/assistant/a2ui';
import type { Dataset } from '../../src/assistant/core/types';

const datasets: Record<string, Dataset> = {
  ds_1: {
    id: 'ds_1',
    title: 'GR log',
    columns: [
      { key: 'md', label: 'MD', unit: 'm', type: 'number' },
      { key: 'gr', label: 'GR', unit: 'gAPI', type: 'number' },
    ],
    rows: Array.from({ length: 50 }, (_, i) => ({ md: 3000 + i, gr: 40 + (i % 7) * 10 })),
    createdAt: 0,
  },
};

const render = (messages: unknown[], opts: { streaming?: boolean } = {}) =>
  renderToStaticMarkup(createElement(A2UISurface, { messages, datasets, onAction: () => {}, streaming: opts.streaming }));
const create = (surfaceId = 's') => ({ version: 'v0.9', createSurface: { surfaceId, catalogId: DATA_CATALOG_ID } });
const comps = (components: unknown[], surfaceId = 's') => ({ version: 'v0.9', updateComponents: { surfaceId, components } });

describe('A2UISurface (server render)', () => {
  it('renders the prompt example: text, a chart frame and a button', () => {
    const html = render(PROMPT_EXAMPLE);
    expect(html).toContain('data-surface-id="gr_log"');
    expect(html).toContain('Gamma ray, 3000–3100 m');
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain('Next 100 m');
    expect(html).not.toContain('problem');
  });

  it('renders text with inline markdown, safely', () => {
    const html = render([create(), comps([{ id: 'root', component: 'Text', text: '**bold** <script>alert(1)</script> [x](javascript:alert(1))' }])]);
    expect(html).toContain('<strong class="font-semibold">bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('binds text to the data model and repeats templates per item', () => {
    const html = render([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['title', 'list'] },
        { id: 'title', component: 'Text', text: { call: 'formatString', args: { value: 'Wells: ${/count}' } } },
        { id: 'list', component: 'List', children: { componentId: 'item', path: '/wells' } },
        { id: 'item', component: 'Text', text: { path: 'name' } },
      ]),
      { version: 'v0.9', updateDataModel: { surfaceId: 's', value: { count: 2, wells: [{ name: 'F-11 A' }, { name: 'F-12' }] } } },
    ]);
    expect(html).toContain('Wells: 2');
    expect(html).toContain('F-11 A');
    expect(html).toContain('F-12');
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
  });

  it('renders inputs with their bound values', () => {
    const html = render([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['name', 'ok', 'pick', 'sl', 'dt'] },
        { id: 'name', component: 'TextField', label: 'Name', value: { path: '/f/name' } },
        { id: 'ok', component: 'CheckBox', label: 'Agree', value: { path: '/f/ok' } },
        { id: 'pick', component: 'ChoicePicker', label: 'Curve', options: [{ label: 'GR', value: 'gr' }, { label: 'RT', value: 'rt' }], value: { path: '/f/c' } },
        { id: 'sl', component: 'Slider', label: 'DLS', min: 0, max: 10, value: { path: '/f/dls' } },
        { id: 'dt', component: 'DateTimeInput', label: 'Date', enableDate: true, value: { path: '/f/d' } },
      ]),
      { version: 'v0.9', updateDataModel: { surfaceId: 's', path: '/f', value: { name: 'Plan B', ok: true, c: ['rt'], dls: 3.5, d: '2026-10-12T00:00:00Z' } } },
    ]);
    expect(html).toContain('value="Plan B"');
    expect(html).toContain('Agree');
    expect(html).toContain('GR');
    expect(html).toContain('3.5');
    expect(html).toContain('value="2026-10-12"');
  });

  it('renders the data widgets', () => {
    const html = render([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['g', 'kv', 'b', 'c', 'p', 'code', 'tbl', 'depth'] },
        { id: 'g', component: 'MetricGroup', children: ['m'] },
        { id: 'm', component: 'Metric', label: 'Net pay', value: 52.6, unit: 'm', delta: '+4.1 m', deltaTone: 'good', sparkline: { dataset: 'ds_1', column: 'gr' } },
        { id: 'kv', component: 'KeyValue', items: [{ label: 'Operator', value: 'Equinor' }] },
        { id: 'b', component: 'Badge', text: 'Producing', tone: 'success' },
        { id: 'c', component: 'Callout', tone: 'warning', title: 'Heads up', text: 'Water cut **rising**' },
        { id: 'p', component: 'Progress', label: 'Recovery', value: 38 },
        { id: 'code', component: 'Code', code: 'SELECT 1', language: 'sql' },
        { id: 'tbl', component: 'DataTable', title: 'Samples', dataset: 'ds_1', maxRows: 3 },
        { id: 'depth', component: 'DepthChart', title: 'Log', dataset: 'ds_1', depth: 'md', tracks: [{ curves: ['gr'] }], markers: [{ depth: 3010, label: 'Top Hugin' }] },
      ]),
    ]);
    for (const s of ['Net pay', '52.6', '+4.1 m', 'Equinor', 'Producing', 'Heads up', 'Recovery', 'SELECT 1', 'Samples', '50 rows', 'Show all (50)', 'Top Hugin', 'MD (m)']) expect(html).toContain(s);
  });

  it('shows unsupported components, skips dangling refs and survives cycles', () => {
    const html = render([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['a', 'ghost', 'z'] },
        { id: 'a', component: 'Card', child: 'root' },
        { id: 'z', component: 'Hologram' },
      ]),
    ]);
    expect(html).toContain('Unsupported component “Hologram”');
    expect(html).toContain('problem');
  });

  it('while streaming: no errors, pending charts as skeletons, nothing before the root', () => {
    expect(render([create()], { streaming: true })).toContain('Building interface');
    const html = render(
      [create(), comps([{ id: 'root', component: 'Column', children: ['t', 'c'] }, { id: 't', component: 'Text', text: 'Gamma' }, { id: 'c', component: 'Chart', kind: 'line', dataset: 'ds_1', x: 'md', series: ['gr'] }])],
      { streaming: true },
    );
    expect(html).toContain('Gamma');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-slot="chart"');
    expect(html).not.toContain('problem');
  });

  it('shows a note for a dataset the thread does not have', () => {
    const html = render([create(), comps([{ id: 'root', component: 'Chart', kind: 'bar', dataset: 'ds_9', x: 'a', series: ['b'] }])]);
    expect(html).toContain('Dataset “ds_9” is not available');
  });

  it('renders several surfaces of one part and v0.8 input', () => {
    const html = render([
      create('one'),
      comps([{ id: 'root', component: 'Text', text: 'First' }], 'one'),
      { surfaceUpdate: { surfaceId: 'two', components: [{ id: 'top', component: { Text: { text: { literalString: 'Second' } } } }] } },
      { beginRendering: { surfaceId: 'two', root: 'top' } },
    ]);
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'));
    expect(html.match(/data-surface-id=/g)).toHaveLength(2);
  });
});
