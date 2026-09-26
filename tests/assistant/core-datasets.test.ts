import { describe, expect, it } from 'vitest';
import { capToolResult, isToolOutput, nextDatasetId, registerDatasets, summariseDataset } from '../../src/assistant/core/datasets';
import { queryDataset, queryDatasetTool } from '../../src/assistant/core/builtinTools';
import type { Dataset, ToolContext, ToolOutput } from '../../src/assistant/core/types';

const logs: Dataset = {
  id: 'ds_1',
  title: 'GR log, F-11 A',
  source: 'Well 15/9-F-11 A · GR, 3000–3009 m MD',
  createdAt: 0,
  columns: [
    { key: 'md', label: 'MD', unit: 'm', type: 'number' },
    { key: 'gr', label: 'Gamma ray', unit: 'API', type: 'number' },
    { key: 'zone', type: 'string' },
  ],
  rows: Array.from({ length: 10 }, (_, i) => ({ md: 3000 + i, gr: i === 4 ? null : 40 + i * 10, zone: i < 5 ? 'Hugin' : 'Sleipner' })),
};

const ctx = (datasets: Dataset[]): ToolContext => ({ signal: new AbortController().signal, toolCallId: 't1', datasets: new Map(datasets.map((d) => [d.id, d])) });

describe('datasets', () => {
  it('recognises ToolOutput', () => {
    expect(isToolOutput({ content: 1, datasets: [] })).toBe(true);
    expect(isToolOutput({ content: 1 })).toBe(false);
    expect(isToolOutput([1])).toBe(false);
    expect(isToolOutput(null)).toBe(false);
  });

  it('assigns thread-unique ids and infers missing columns and types', () => {
    expect(nextDatasetId({ ds_1: 1, ds_7: 1, other: 1 })).toBe('ds_8');
    const [a, b] = registerDatasets({ ds_1: logs }, [
      { title: 'Tops', columns: [], rows: [{ name: 'Hugin', md: 3050, date: '2024-01-02' }] },
      { title: 'Empty', columns: [{ key: 'x' }], rows: [] },
    ], 5);
    expect(a.id).toBe('ds_2');
    expect(b.id).toBe('ds_3');
    expect(a.columns).toEqual([
      { key: 'name', type: 'string' },
      { key: 'md', type: 'number' },
      { key: 'date', type: 'date' },
    ]);
    expect(a.createdAt).toBe(5);
  });

  it('summarises: size, columns with units, first 3 + last 2 rows, statistics', () => {
    const s = summariseDataset(logs);
    expect(s).toMatchObject({ id: 'ds_1', title: 'GR log, F-11 A', rowCount: 10, source: logs.source });
    expect(s.columns[0]).toEqual({ key: 'md', label: 'MD', unit: 'm', type: 'number' });
    expect(s.sample.map((r) => r.md)).toEqual([3000, 3001, 3002, 3008, 3009]);
    expect(s.stats.gr).toEqual({ nulls: 1, min: 40, max: 130, mean: 85.56 });
    expect(s.stats.zone).toEqual({ nulls: 0, distinct: 2 });
  });
});

describe('capToolResult', () => {
  it('leaves small results alone', () => {
    expect(capToolResult({ a: 1 })).toEqual({ a: 1 });
    expect(capToolResult(undefined)).toBeNull();
  });

  it('keeps the head of long arrays with a note of how many items were dropped', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i, v: Math.sin(i) }));
    const out = capToolResult({ well: 'F-11 A', rows }, 2000) as { well: string; rows: unknown[] };
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2000);
    expect(out.well).toBe('F-11 A');
    expect(out.rows[0]).toEqual({ i: 0, v: 0 });
    const note = out.rows[out.rows.length - 1] as string;
    expect(note).toMatch(/^… \d+ more items omitted/);
    expect(Number(/(\d+) more/.exec(note)![1]) + out.rows.length - 1).toBe(5000);
  });

  it('shortens huge strings and never exceeds the budget', () => {
    const out = capToolResult({ text: 'x'.repeat(50_000), nested: { list: Array(3000).fill('abcdef') } }, 1500);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1500);
  });
});

describe('query_dataset', () => {
  it('filters, sorts, projects and pages', () => {
    const r = queryDataset(logs, { dataset: 'ds_1', where: [{ column: 'gr', op: '>=', value: 70 }, { column: 'zone', op: '=', value: 'sleipner' }], sortBy: 'gr', descending: true, columns: ['md', 'gr'] });
    expect(r.matched).toBe(5);
    expect(r.rows).toEqual([
      { md: 3009, gr: 130 },
      { md: 3008, gr: 120 },
      { md: 3007, gr: 110 },
      { md: 3006, gr: 100 },
      { md: 3005, gr: 90 },
    ]);
  });

  it('aggregates by group with units carried over', () => {
    const r = queryDataset(logs, { dataset: 'ds_1', aggregate: { groupBy: ['zone'], metrics: [{ column: 'gr', fn: 'mean' }, { column: '*', fn: 'count' }, { column: 'gr', fn: 'p90' }] } });
    expect(r.rows).toEqual([
      { zone: 'Hugin', mean_gr: 55, count: 5, p90_gr: 67 },
      { zone: 'Sleipner', mean_gr: 110, count: 5, p90_gr: 126 },
    ]);
    expect(r.columns.find((c) => c.key === 'mean_gr')).toMatchObject({ unit: 'API', type: 'number' });
    expect(queryDataset(logs, { dataset: 'ds_1', aggregate: { metrics: [{ column: 'gr', fn: 'max' }] } }).rows).toEqual([{ max_gr: 130 }]);
  });

  it('downsamples with every and reports unknown columns helpfully', () => {
    expect(queryDataset(logs, { dataset: 'ds_1', every: 3 }).rows.map((r) => r.md)).toEqual([3000, 3003, 3006, 3009]);
    expect(() => queryDataset(logs, { dataset: 'ds_1', where: [{ column: 'rop', op: '>', value: 1 }] })).toThrow(/Unknown column "rop".*md, gr, zone/);
  });

  it('as a tool: pages rows, errors on an unknown dataset, and saves derived datasets', async () => {
    const tool = queryDatasetTool();
    expect(tool.kind).toBe('read');
    const page = (await tool.execute({ dataset: 'ds_1', limit: 3 }, ctx([logs]))) as { rows: unknown[]; more: string; total: number };
    expect(page.rows).toHaveLength(3);
    expect(page.total).toBe(10);
    expect(page.more).toContain('7 more rows');
    expect(() => tool.execute({ dataset: 'ds_9' }, ctx([logs]))).toThrow('Unknown dataset "ds_9". Available: ds_1.');
    const saved = (await tool.execute({ dataset: 'ds_1', where: [{ column: 'zone', op: '=', value: 'Hugin' }], saveAs: 'Hugin GR' }, ctx([logs]))) as ToolOutput;
    expect(isToolOutput(saved)).toBe(true);
    expect(saved.datasets![0]).toMatchObject({ title: 'Hugin GR', source: 'Derived from ds_1 (GR log, F-11 A)' });
    expect(saved.datasets![0].rows).toHaveLength(5);
  });
});
