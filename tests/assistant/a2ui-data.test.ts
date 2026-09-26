import { describe, expect, it } from 'vitest';
import { buildChartModel } from '../../src/assistant/a2ui/catalog/chartModel';
import { sortRows, tableColumns } from '../../src/assistant/a2ui/catalog/DataTable';
import { buildDepthModel } from '../../src/assistant/a2ui/catalog/DepthChart';
import { downsampleRows, formatCell, formatNumber, inferColumns, lttbIndices, resolveRows, toCsv, toTsv } from '../../src/assistant/a2ui/data';
import { parseBlocks, parseInline } from '../../src/assistant/a2ui/markdown';
import type { Dataset } from '../../src/assistant/core/types';

const wave = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: Math.sin(i / 50) * 10 + (i === 1234 ? 100 : 0) }));

describe('LTTB', () => {
  it('keeps the ends, the requested count and the peaks', () => {
    const rows = wave(5000);
    const idx = lttbIndices(
      rows.map((r) => r.x),
      rows.map((r) => r.y),
      1500,
    );
    expect(idx).toHaveLength(1500);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(4999);
    expect(idx).toContain(1234);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it('returns everything under the threshold and skips nulls', () => {
    expect(lttbIndices([0, 1, 2], [1, null, 3], 10)).toEqual([0, 2]);
  });

  it('thins several series to their union, in x order', () => {
    const rows = Array.from({ length: 4000 }, (_, i) => ({ x: 4000 - i, a: i === 100 ? 50 : 0, b: i === 3000 ? -50 : 0 }));
    const out = downsampleRows(rows, (r) => r.x, [(r) => r.a, (r) => r.b], 300);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.some((r) => r.a === 50)).toBe(true);
    expect(out.some((r) => r.b === -50)).toBe(true);
    expect(out[0].x).toBeLessThan(out[out.length - 1].x);
  });
});

describe('rows and formatting', () => {
  const ds: Dataset = { id: 'ds_1', title: 'T', columns: [{ key: 'a', type: 'number' }], rows: [{ a: 1 }], createdAt: 0 };

  it('resolves dataset, inline rows and paths', () => {
    expect(resolveRows({ dataset: 'ds_1' }, { ds_1: ds }, null)).toMatchObject({ rows: ds.rows, datasetId: 'ds_1', title: 'T' });
    expect(resolveRows({ dataset: 'ds_2' }, { ds_1: ds }, null).missing).toBe('ds_2');
    expect(resolveRows({ rows: [{ a: 1 }, 'junk'] }, {}, null).rows).toEqual([{ a: 1 }]);
    expect(resolveRows({ path: '/r' }, {}, { r: [{ b: 2 }] }).columns).toEqual([{ key: 'b', type: 'number' }]);
    expect(inferColumns([{ d: '2024-01-01', s: 'x', n: null }, { n: 3 }]).map((c) => c.type)).toEqual(['date', 'string', 'number']);
  });

  it('formats numbers compactly and cells by format', () => {
    expect(formatNumber(1_234_567)).toMatch(/1\.23M/);
    expect(formatNumber(0.000123)).toBe('0.000123');
    expect(formatNumber(12.345)).toBe('12.35');
    expect(formatCell(0.227, 'percent')).toBe('22.7%');
    expect(formatCell(3043.456, 'number', 1)).toMatch(/3.?043\.5/);
    expect(formatCell(null, 'number')).toBe('');
    expect(formatCell('abc', 'number')).toBe('abc');
  });

  it('exports CSV and TSV with labels and units', () => {
    const cols = [{ key: 'name', label: 'Name' }, { key: 'v', label: 'Value', unit: 'm' }];
    expect(toCsv([{ name: 'a, "b"', v: 1 }], cols)).toBe('Name,Value (m)\n"a, ""b""",1');
    expect(toTsv([{ name: 'x\ty', v: null }], cols)).toBe('Name\tValue (m)\nx y\t');
  });
});

describe('chart model', () => {
  const cols = [
    { key: 'date', type: 'date' as const },
    { key: 'oil', label: 'Oil', unit: 'Sm³', type: 'number' as const },
    { key: 'wct', label: 'Water cut', type: 'number' as const },
  ];

  it('re-keys series, infers a time axis and keeps colours to the chart accents', () => {
    const rows = [
      { date: '2020-02-01', oil: 5, wct: 0.1 },
      { date: '2020-01-01', oil: 10, wct: 0 },
    ];
    const m = buildChartModel({ kind: 'line', x: 'date', series: ['oil', { column: 'wct', axis: 'right', color: 'chart-4' }] }, rows, cols);
    expect(m.xType).toBe('time');
    expect(m.series.map((s) => [s.key, s.label, s.color, s.axis])).toEqual([
      ['s0', 'Oil', 'var(--chart-1)', 'left'],
      ['s1', 'Water cut', 'var(--chart-4)', 'right'],
    ]);
    expect(m.data[0]).toEqual({ x: Date.parse('2020-01-01'), s0: 10, s1: 0 });
    expect(m.hasRight).toBe(true);
    expect(m.yUnit).toBe('Sm³');
  });

  it('thins long line series to 1,500 points and caps bars', () => {
    const rows = wave(6000).map((r) => ({ md: r.x, gr: r.y }));
    const line = buildChartModel({ kind: 'line', x: 'md', series: ['gr'] }, rows, []);
    expect(line.xType).toBe('number');
    expect(line.data.length).toBe(1500);
    expect(line.reduced).toBe(true);
    const bars = buildChartModel({ kind: 'bar', x: 'md', series: ['gr'] }, rows, []);
    expect(bars.xType).toBe('category');
    expect(bars.data.length).toBeLessThanOrEqual(400);
  });

  it('drops non-positive values on a log scale and starts filled axes at zero', () => {
    const m = buildChartModel({ kind: 'area', x: 'x', yScale: 'log', series: ['y'] }, [{ x: 1, y: 0 }, { x: 2, y: 10 }], []);
    expect(m.data.map((r) => r.s0)).toEqual([null, 10]);
    expect(m.leftZero).toBe(true);
    expect(buildChartModel({ kind: 'line', x: 'x', series: ['y'] }, [{ x: 1, y: 5 }], []).leftZero).toBe(false);
  });

  it('groups pie slices beyond five into Other', () => {
    const rows = 'abcdefg'.split('').map((k, i) => ({ k, v: 10 - i }));
    const m = buildChartModel({ kind: 'pie', x: 'k', series: ['v'] }, rows, []);
    expect(m.data.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'Other']);
    expect(m.data[5].value).toBe(9);
  });
});

describe('depth model', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ md: 3000 + i * 0.1, gr: 50 + Math.sin(i / 20) * 30, rt: 10 ** (1 + Math.sin(i / 100)) }));

  it('builds tracks with per-curve scales, thins along depth and takes the depth range from the data', () => {
    const m = buildDepthModel(
      { depth: 'md', tracks: [{ curves: ['gr'], min: 0, max: 150 }, { curves: [{ column: 'rt', color: 'chart-4' }], scale: 'log' }], markers: [{ depth: 3100, label: 'Top' }], bands: [{ from: 3200, to: 3150 }] },
      rows,
      [{ key: 'md', label: 'MD', unit: 'm' }],
    );
    expect(m.tracks).toHaveLength(2);
    expect(m.tracks[0].curves[0]).toMatchObject({ min: 0, max: 150, scale: 'linear' });
    expect(m.tracks[1].curves[0]).toMatchObject({ min: 1, max: 100, scale: 'log', color: 'var(--chart-4)' });
    expect(m.tracks[0].curves[0].drawn.length).toBe(1500);
    expect(m.top).toBe(3000);
    expect(m.bottom).toBeCloseTo(3499.9);
    expect(m.bands[0]).toMatchObject({ from: 3150, to: 3200 });
    expect(m.depthLabel).toBe('MD (m)');
    expect(m.samples).toBe(5000);
  });

  it('accepts `curves` as one track per curve', () => {
    expect(buildDepthModel({ depth: 'md', curves: ['gr', 'rt'] }, rows.slice(0, 10), []).tracks).toHaveLength(2);
  });
});

describe('DataTable helpers', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }];
  it('derives columns and sorts numbers numerically, empties last', () => {
    const cols = tableColumns({}, [], rows);
    expect(cols.map((c) => [c.key, c.numeric])).toEqual([
      ['n', false],
      ['v', true],
    ]);
    expect(sortRows(rows, cols[1], 'descending').map((r) => r.v)).toEqual([10, 2, null]);
    expect(sortRows(rows, cols[0], 'ascending').map((r) => r.n)).toEqual(['a', 'b', 'c']);
  });
});

describe('inline markdown', () => {
  it('parses emphasis, code and safe links only', () => {
    expect(parseInline('**b** *i* `c` [x](https://a.io)')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'i' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://a.io', c: [{ t: 'text', v: 'x' }] },
    ]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }, { t: 'text', v: ')' }]);
    expect(parseInline('snake_case_name and 2 * 3')).toEqual([{ t: 'text', v: 'snake_case_name and 2 * 3' }]);
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  });

  it('splits headings, lists and paragraphs', () => {
    expect(parseBlocks('# T\n\nPara\nline\n\n- a\n- b\n1. c').map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol']);
  });
});
