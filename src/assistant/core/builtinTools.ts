import { renderUiTool } from '../a2ui';
import type { AssistantTool, Dataset, DatasetColumn, DatasetRow, ToolContext, ToolOutput } from './types';

/*
 * The tools the kit adds to the host's: `query_dataset` (read, filter,
 * aggregate and derive datasets without sending their rows to the model)
 * and `render_ui` (generated interfaces, from `a2ui/`).
 */

export const QUERY_DATASET = 'query_dataset';
export const RENDER_UI = 'render_ui';

type Op = '<' | '<=' | '>' | '>=' | '=' | '!=' | 'contains';
type Fn = 'mean' | 'min' | 'max' | 'sum' | 'count' | 'median' | 'p10' | 'p90' | 'std';
const FNS: Fn[] = ['mean', 'min', 'max', 'sum', 'count', 'median', 'p10', 'p90', 'std'];
const OPS: Op[] = ['<', '<=', '>', '>=', '=', '!=', 'contains'];

export interface QueryDatasetArgs {
  dataset: string;
  columns?: string[];
  where?: { column: string; op: Op; value: number | string | boolean | null }[];
  sortBy?: string;
  descending?: boolean;
  limit?: number;
  offset?: number;
  every?: number;
  aggregate?: { groupBy?: string | string[]; metrics: { column: string; fn: Fn }[] };
  saveAs?: string;
}

const MAX_ROWS = 200;
const PREVIEW_ROWS = 20;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

function test(v: DatasetRow[string], op: Op, target: unknown): boolean {
  if (op === 'contains') return v != null && String(v).toLowerCase().includes(String(target ?? '').toLowerCase());
  if (op === '=' || op === '!=') {
    const a = num(v);
    const b = num(target);
    const eq = a !== undefined && b !== undefined ? a === b : String(v ?? 'null').toLowerCase() === String(target ?? 'null').toLowerCase();
    return op === '=' ? eq : !eq;
  }
  if (v === null || v === undefined) return false;
  const a = num(v);
  const b = num(target);
  const [x, y] = a !== undefined && b !== undefined ? [a, b] : [String(v), String(target)];
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function metric(rows: DatasetRow[], column: string, fn: Fn): number | null {
  if (fn === 'count') return column === '*' ? rows.length : rows.filter((r) => r[column] !== null && r[column] !== undefined).length;
  const vals: number[] = [];
  for (const r of rows) {
    const v = num(r[column]);
    if (v !== undefined) vals.push(v);
  }
  if (!vals.length) return null;
  switch (fn) {
    case 'sum':
      return vals.reduce((a, b) => a + b, 0);
    case 'mean':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'min':
      return vals.reduce((a, b) => (b < a ? b : a), Infinity);
    case 'max':
      return vals.reduce((a, b) => (b > a ? b : a), -Infinity);
    case 'std': {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    }
    default: {
      const sorted = vals.sort((a, b) => a - b);
      return quantile(sorted, fn === 'median' ? 0.5 : fn === 'p10' ? 0.1 : 0.9);
    }
  }
}

const tidy = (v: number | null) => (v === null || Number.isInteger(v) ? v : Number(v.toPrecision(6)));

/** Runs a query on a dataset (exported for tests and for hosts that want the same semantics). */
export function queryDataset(ds: Dataset, a: QueryDatasetArgs): { rows: DatasetRow[]; columns: DatasetColumn[]; matched: number; total: number } {
  const colByKey = new Map(ds.columns.map((c) => [c.key, c]));
  const known = (c: string, what: string) => {
    if (c !== '*' && !colByKey.has(c)) throw new Error(`Unknown column "${c}" in ${what}. Columns of ${ds.id}: ${ds.columns.map((x) => x.key).join(', ')}.`);
  };
  for (const w of a.where ?? []) {
    known(w.column, 'where');
    if (!OPS.includes(w.op)) throw new Error(`Unknown operator "${w.op}". Use one of ${OPS.join(' ')}.`);
  }
  let rows = ds.rows;
  if (a.where?.length) rows = rows.filter((r) => a.where!.every((w) => test(r[w.column], w.op, w.value)));
  const matched = rows.length;
  let columns: DatasetColumn[];

  if (a.aggregate) {
    const groupBy = a.aggregate.groupBy === undefined ? [] : Array.isArray(a.aggregate.groupBy) ? a.aggregate.groupBy : [a.aggregate.groupBy];
    groupBy.forEach((g) => known(g, 'groupBy'));
    const metrics = a.aggregate.metrics?.length ? a.aggregate.metrics : [{ column: '*', fn: 'count' as Fn }];
    for (const m of metrics) {
      known(m.column, 'metrics');
      if (!FNS.includes(m.fn)) throw new Error(`Unknown aggregate "${m.fn}". Use one of ${FNS.join(', ')}.`);
    }
    const groups = new Map<string, DatasetRow[]>();
    for (const r of rows) {
      const key = JSON.stringify(groupBy.map((g) => r[g] ?? null));
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(r);
    }
    if (!groupBy.length && !groups.size) groups.set('[]', []);
    const name = (m: { column: string; fn: Fn }) => (m.column === '*' ? m.fn : `${m.fn}_${m.column}`);
    rows = [...groups.entries()].map(([key, list]) => {
      const out: DatasetRow = {};
      (JSON.parse(key) as DatasetRow[string][]).forEach((v, i) => (out[groupBy[i]] = v));
      for (const m of metrics) out[name(m)] = tidy(metric(list, m.column, m.fn));
      return out;
    });
    columns = [
      ...groupBy.map((g) => colByKey.get(g)!),
      ...metrics.map((m) => {
        const src = colByKey.get(m.column);
        const col: DatasetColumn = { key: name(m), label: m.column === '*' ? 'Count' : `${m.fn} of ${src?.label ?? m.column}`, type: 'number' };
        if (src?.unit && m.fn !== 'count') col.unit = src.unit;
        return col;
      }),
    ];
    if (!a.sortBy && groupBy.length) {
      const g = groupBy[0];
      rows = [...rows].sort((x, y) => cmp(x[g], y[g]));
    }
  } else {
    const keep = a.columns?.length ? a.columns : undefined;
    keep?.forEach((c) => known(c, 'columns'));
    columns = keep ? keep.map((k) => colByKey.get(k)!) : ds.columns;
    if (keep) rows = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] ?? null])) as DatasetRow);
  }

  if (a.sortBy) {
    if (!columns.some((c) => c.key === a.sortBy)) throw new Error(`Cannot sort by "${a.sortBy}": the result's columns are ${columns.map((c) => c.key).join(', ')}.`);
    const k = a.sortBy;
    const dir = a.descending ? -1 : 1;
    rows = [...rows].sort((x, y) => {
      const xv = x[k];
      const yv = y[k];
      if (xv == null) return yv == null ? 0 : 1;
      if (yv == null) return -1;
      return cmp(xv, yv) * dir;
    });
  }
  const every = Math.max(1, Math.floor(a.every ?? 1));
  if (every > 1) rows = rows.filter((_, i) => i % every === 0);
  const total = rows.length;
  return { rows, columns, matched, total };
}

const cmp = (a: DatasetRow[string], b: DatasetRow[string]) => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
};

/** The built-in `query_dataset` tool. */
export function queryDatasetTool(): AssistantTool {
  return {
    name: QUERY_DATASET,
    title: 'Query dataset',
    kind: 'read',
    description:
      'Reads rows of a dataset produced earlier in this conversation (ids like "ds_1"), with optional filters, sorting, downsampling and aggregation. ' +
      `Returns at most ${MAX_ROWS} rows. Use "saveAs" to keep the full result as a new dataset (for example a filtered interval or per-group statistics) that a generated chart or table can bind to. ` +
      'Prefer this over asking for raw data: dataset summaries in the conversation already give sizes, columns and statistics.',
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'The dataset id, e.g. "ds_1".' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Columns to return (default: all). Ignored with "aggregate".' },
        where: {
          type: 'array',
          description: 'Filters, all of which must hold.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: { type: 'string', enum: OPS },
              value: { type: ['number', 'string', 'boolean'] },
            },
            required: ['column', 'op', 'value'],
          },
        },
        sortBy: { type: 'string', description: 'A column of the result to sort by.' },
        descending: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: `Rows to return (default 50, at most ${MAX_ROWS}).` },
        offset: { type: 'integer', minimum: 0 },
        every: { type: 'integer', minimum: 1, description: 'Keep every n-th row (downsampling), applied after filtering and sorting.' },
        aggregate: {
          type: 'object',
          description: 'Group and summarise instead of returning rows.',
          properties: {
            groupBy: { type: 'array', items: { type: 'string' }, description: 'Columns to group by (none: one row for the whole selection).' },
            metrics: {
              type: 'array',
              items: {
                type: 'object',
                properties: { column: { type: 'string', description: 'A column, or "*" with count.' }, fn: { type: 'string', enum: FNS } },
                required: ['column', 'fn'],
              },
            },
          },
          required: ['metrics'],
        },
        saveAs: { type: 'string', description: 'Save the whole result (not only the returned page) as a new dataset with this title.' },
      },
      required: ['dataset'],
    },
    execute: (raw: unknown, ctx: ToolContext): unknown => {
      const a = (raw ?? {}) as QueryDatasetArgs;
      const ds = ctx.datasets.get(a.dataset);
      if (!ds) {
        const ids = [...ctx.datasets.keys()];
        throw new Error(`Unknown dataset "${a.dataset}". ${ids.length ? `Available: ${ids.join(', ')}.` : 'No dataset exists in this conversation yet.'}`);
      }
      const { rows, columns, matched, total } = queryDataset(ds, a);
      const offset = Math.max(0, Math.floor(a.offset ?? 0));
      const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(a.limit ?? 50)));
      if (a.saveAs) {
        const saved = a.limit !== undefined || a.offset !== undefined ? rows.slice(offset, offset + limit) : rows;
        const out: ToolOutput = {
          content: { saved: true, dataset: ds.id, matched, rowCount: saved.length, preview: saved.slice(0, PREVIEW_ROWS) },
          datasets: [{ title: a.saveAs, columns, rows: saved, source: `Derived from ${ds.id} (${ds.title})` }],
        };
        return out;
      }
      const page = rows.slice(offset, offset + limit);
      const result: Record<string, unknown> = { dataset: ds.id, matched, total, returned: page.length, rows: page };
      if (offset + page.length < total) result.more = `${total - offset - page.length} more rows: raise "offset", use "every" to downsample, or "aggregate".`;
      return result;
    },
  };
}

/** The kit's tools: `query_dataset` and, when the A2UI module provides it, `render_ui`. */
export function builtinTools(): AssistantTool[] {
  const tools = [queryDatasetTool()];
  try {
    if (typeof renderUiTool === 'function') tools.push(renderUiTool());
  } catch {
    /* the generated-UI module is unavailable: answers stay text */
  }
  return tools;
}
