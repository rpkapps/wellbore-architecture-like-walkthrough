import { describe, expect, it } from 'vitest';
import type { Dataset, ToolContext } from '../../src/assistant/core/types';
import { a2uiPromptGuide, BASIC_CATALOG_ID, DATA_CATALOG_ID, PROMPT_EXAMPLE, renderUiTool, validateMessages } from '../../src/assistant/a2ui';

const ds1: Dataset = {
  id: 'ds_1',
  title: 'GR log',
  columns: [
    { key: 'md', label: 'MD', unit: 'm', type: 'number' },
    { key: 'gr', label: 'GR', unit: 'gAPI', type: 'number' },
  ],
  rows: [
    { md: 3000, gr: 50 },
    { md: 3001, gr: 55 },
  ],
  createdAt: 0,
};
const datasets = { ds_1: ds1 };

const create = (catalogId = DATA_CATALOG_ID, surfaceId = 's') => ({ version: 'v0.9', createSurface: { surfaceId, catalogId } });
const comps = (components: unknown[], surfaceId = 's') => ({ version: 'v0.9', updateComponents: { surfaceId, components } });
const ctx = (d: Record<string, Dataset> = datasets): ToolContext => ({ signal: new AbortController().signal, toolCallId: 't1', datasets: new Map(Object.entries(d)) });

describe('validateMessages', () => {
  it('accepts the prompt guide example against a matching dataset', () => {
    expect(validateMessages(PROMPT_EXAMPLE, { datasets })).toEqual([]);
  });

  it('accepts a full data-catalog surface', () => {
    const msgs = [
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['kpis', 'd', 'tbl', 'kv', 'b', 'c', 'p', 'code', 'list'] },
        { id: 'kpis', component: 'MetricGroup', children: ['m1'] },
        { id: 'm1', component: 'Metric', label: 'Pay', value: 52.6, unit: 'm', deltaTone: 'good', sparkline: { dataset: 'ds_1', column: 'gr' } },
        { id: 'd', component: 'DepthChart', dataset: 'ds_1', depth: 'md', tracks: [{ curves: [{ column: 'gr', color: 'chart-2' }], scale: 'linear' }], bands: [{ from: 3000, to: 3001, label: 'Z' }], markers: [{ depth: 3000.5, label: 'Top' }] },
        { id: 'tbl', component: 'DataTable', dataset: 'ds_1', columns: [{ key: 'md', format: 'number', digits: 1 }, 'gr'] },
        { id: 'kv', component: 'KeyValue', items: [{ label: 'TD', value: 3500, unit: 'm' }] },
        { id: 'b', component: 'Badge', text: 'Producing', tone: 'success' },
        { id: 'c', component: 'Callout', title: 'Note', text: 'Careful', tone: 'warning' },
        { id: 'p', component: 'Progress', value: { path: '/p' }, max: 100 },
        { id: 'code', component: 'Code', code: 'SELECT 1', language: 'sql' },
        { id: 'list', component: 'List', children: { componentId: 'row', path: '/rows' } },
        { id: 'row', component: 'Chart', kind: 'bar', rows: [{ k: 'a', v: 1 }], x: 'k', series: ['v'] },
      ]),
      { version: 'v0.9', updateDataModel: { surfaceId: 's', path: '/p', value: 40 } },
    ];
    expect(validateMessages(msgs, { datasets })).toEqual([]);
  });

  it('names a missing createSurface with the message to send', () => {
    const [e] = validateMessages([comps([{ id: 'root', component: 'Text', text: 'x' }])]);
    expect(e).toContain('messages[0].updateComponents');
    expect(e).toContain('createSurface');
    expect(e).toContain(DATA_CATALOG_ID);
  });

  it('requires a root and defined children', () => {
    expect(validateMessages([create(), comps([{ id: 'main', component: 'Text', text: 'x' }])])[0]).toMatch(/no component has id "root".*Ids present: main/);
    const errs = validateMessages([create(), comps([{ id: 'root', component: 'Column', children: ['a', 'ghost'] }, { id: 'a', component: 'Text', text: 'x' }])]);
    expect(errs).toEqual([expect.stringMatching(/components\[0\] \(id "root", Column\)\.children\[1\]: refers to "ghost", which is not defined/)]);
  });

  it('reports cycles and duplicate ids', () => {
    const errs = validateMessages([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['a'] },
        { id: 'a', component: 'Card', child: 'root' },
        { id: 'a', component: 'Card', child: 'root' },
      ]),
    ]);
    expect(errs.some((e) => e.includes('duplicate id "a"'))).toBe(true);
    expect(errs.some((e) => e.includes('cycle (root → a → root)'))).toBe(true);
  });

  it('explains unknown components, props, enums and required props', () => {
    const errs = validateMessages([
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['t', 'x', 'b', 'i'] },
        { id: 't', component: 'text', usageHint: 'h1' },
        { id: 'x', component: 'Text', text: 'x', variant: 'huge', usageHint: 'h1' },
        { id: 'b', component: 'Button', child: 't', action: { name: 'go' } },
        { id: 'i', component: 'Icon', name: 'rocket' },
      ]),
    ]);
    expect(errs).toContainEqual(expect.stringContaining('unknown component "text"; did you mean "Text"?'));
    expect(errs).toContainEqual(expect.stringContaining('.variant: "huge" is not allowed; use one of h1, h2, h3, h4, h5, caption, body'));
    expect(errs).toContainEqual(expect.stringContaining('unknown prop "usageHint"; use variant'));
    expect(errs).toContainEqual(expect.stringContaining('v0.9 wraps the action: {"event": {"name": "go"'));
    expect(errs).toContainEqual(expect.stringContaining('unknown icon "rocket"'));
  });

  it('checks datasets, columns and colours', () => {
    const errs = validateMessages(
      [
        create(),
        comps([
          { id: 'root', component: 'Column', children: ['a', 'b', 'c'] },
          { id: 'a', component: 'Chart', kind: 'line', dataset: 'ds_9', x: 'md', series: [{ column: 'gr' }] },
          { id: 'b', component: 'Chart', kind: 'line', dataset: 'ds_1', x: 'depth', series: [{ column: 'gr', color: 'red' }] },
          { id: 'c', component: 'Chart', kind: 'line', x: 'md', series: [] },
        ]),
      ],
      { datasets },
    );
    expect(errs).toContainEqual(expect.stringContaining('no dataset "ds_9"; available: ds_1 (GR log)'));
    expect(errs).toContainEqual(expect.stringContaining('.x: dataset "ds_1" has no column "depth"; columns: md, gr'));
    expect(errs).toContainEqual(expect.stringContaining('"red" is not allowed; use one of chart-1'));
    expect(errs).toContainEqual(expect.stringContaining('needs its data'));
    expect(errs).toContainEqual(expect.stringContaining('needs at least one series'));
  });

  it('asks for the data catalog when data components sit on the basic catalog', () => {
    const errs = validateMessages([create(BASIC_CATALOG_ID), comps([{ id: 'root', component: 'Badge', text: 'x' }])]);
    expect(errs).toEqual([expect.stringContaining(`set createSurface.catalogId to "${DATA_CATALOG_ID}"`)]);
    expect(validateMessages([create('https://example.com/cat.json'), comps([{ id: 'root', component: 'Text', text: 'x' }])])[0]).toContain('unknown catalog');
  });

  it('checks bindings, function calls and messages', () => {
    const errs = validateMessages([
      { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: DATA_CATALOG_ID }, deleteSurface: { surfaceId: 's' } },
      create(),
      comps([{ id: 'root', component: 'Text', text: { call: 'shout', args: {} } }, { id: 'x', component: 'Text', text: { path: '/a', extra: 1 } }]),
      { version: 'v0.9', hello: {} },
    ]);
    expect(errs[0]).toContain('exactly one of');
    expect(errs).toContainEqual(expect.stringContaining('unknown function "shout"'));
    expect(errs).toContainEqual(expect.stringContaining('a binding is exactly {"path": "…"}; remove extra'));
    expect(errs).toContainEqual(expect.stringContaining('unknown message (keys: hello)'));
  });

  it('reports unparseable JSON and empty input', () => {
    expect(validateMessages('[{"version": "v0.9", ')[0]).toContain('does not parse');
    expect(validateMessages([])[0]).toContain('No A2UI messages');
  });

  it('accepts v0.8 streams', () => {
    const v08 = [
      { surfaceUpdate: { surfaceId: 'm', components: [{ id: 'top', component: { Text: { text: { literalString: 'Hi' } } } }] } },
      { beginRendering: { surfaceId: 'm', root: 'top' } },
    ];
    expect(validateMessages(v08)).toEqual([]);
  });
});

describe('renderUiTool', () => {
  const tool = renderUiTool();

  it('is a read tool named render_ui with an object schema', () => {
    expect(tool.name).toBe('render_ui');
    expect(tool.kind).toBe('read');
    expect(tool.parameters.type).toBe('object');
    expect(tool.description).toMatch(/dataset/);
  });

  it('returns ok with the surface ids', async () => {
    expect(await tool.execute({ messages: PROMPT_EXAMPLE }, ctx())).toEqual({ ok: true, surfaces: ['gr_log'], note: 'Rendered in the chat.' });
  });

  it('accepts the official SDK shape (a2ui_json string)', async () => {
    expect(await tool.execute({ a2ui_json: JSON.stringify(PROMPT_EXAMPLE) }, ctx())).toMatchObject({ ok: true });
  });

  it('returns the errors so the model can retry', async () => {
    const res = (await tool.execute({ messages: PROMPT_EXAMPLE }, ctx({}))) as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('no dataset "ds_1"');
    expect(await tool.execute({}, ctx())).toMatchObject({ ok: false });
    expect(await tool.execute({ a2ui_json: '[{' }, ctx())).toMatchObject({ ok: false, errors: [expect.stringContaining('does not parse')] });
  });
});

describe('a2uiPromptGuide', () => {
  it('stays compact and names every component', () => {
    const guide = a2uiPromptGuide();
    // ~4 characters per token: keep it near 1,200 tokens
    expect(guide.length).toBeLessThan(4800);
    for (const name of ['Column', 'Text', 'Button', 'TextField', 'ChoicePicker', 'Chart', 'DepthChart', 'DataTable', 'Metric', 'KeyValue', 'Callout', 'Progress', 'Code'])
      expect(guide).toContain(name);
    expect(guide).toContain(DATA_CATALOG_ID);
    expect(guide).toContain(JSON.stringify(PROMPT_EXAMPLE));
  });
});
