import type { Dataset, DatasetColumn, DatasetRow, Json, ToolOutput } from './types';
import { safeJsonStringify } from './json';

/*
 * Datasets: tabular tool output kept in the browser. The model sees a
 * summary (columns, size, a few rows, statistics); generated charts and
 * tables bind to the dataset's id and read every row.
 */

/** Whether a tool's return value is a `ToolOutput` (an object with `content` and `datasets`). */
export function isToolOutput(x: unknown): x is ToolOutput {
  return !!x && typeof x === 'object' && !Array.isArray(x) && 'content' in x && 'datasets' in x && (Array.isArray((x as ToolOutput).datasets) || (x as ToolOutput).datasets === undefined);
}

/** The next free `ds_<n>` id of a thread. */
export function nextDatasetId(existing: Record<string, unknown>): string {
  let max = 0;
  for (const id of Object.keys(existing)) {
    const m = /^ds_(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ds_${max + 1}`;
}

const inferType = (rows: DatasetRow[], key: string): DatasetColumn['type'] => {
  for (let i = 0; i < rows.length && i < 50; i++) {
    const v = rows[i]?.[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? 'date' : 'string';
  }
  return undefined;
};

/** Gives incoming datasets thread-unique ids and fills in missing column descriptions. */
export function registerDatasets(existing: Record<string, Dataset>, incoming: Omit<Dataset, 'id' | 'createdAt'>[], now = Date.now()): Dataset[] {
  const taken: Record<string, unknown> = { ...existing };
  const out: Dataset[] = [];
  for (const d of incoming) {
    if (!d || !Array.isArray(d.rows)) continue;
    const id = nextDatasetId(taken);
    taken[id] = true;
    const rows = d.rows;
    const columns: DatasetColumn[] =
      Array.isArray(d.columns) && d.columns.length
        ? d.columns.map((c) => (c.type ? c : { ...c, type: inferType(rows, c.key) }))
        : Object.keys(rows[0] ?? {}).map((key) => ({ key, type: inferType(rows, key) }));
    const ds: Dataset = { id, title: d.title || id, columns, rows, createdAt: now };
    if (d.source) ds.source = d.source;
    out.push(ds);
  }
  return out;
}

/** Rounds to 4 significant digits (statistics in the prompt do not need more). */
const round = (v: number) => (Number.isInteger(v) || !Number.isFinite(v) ? v : Number(v.toPrecision(4)));

export interface ColumnStats {
  nulls: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  distinct?: number;
}

export interface DatasetSummary {
  id: string;
  title: string;
  source?: string;
  rowCount: number;
  columns: { key: string; label?: string; unit?: string; type?: string }[];
  /** the first 3 and last 2 rows */
  sample: DatasetRow[];
  stats: Record<string, ColumnStats>;
}

/** What the model is told about a dataset. */
export function summariseDataset(ds: Dataset): DatasetSummary {
  const rows = ds.rows;
  const stats: Record<string, ColumnStats> = {};
  for (const c of ds.columns) {
    const s: ColumnStats = { nulls: 0 };
    if (c.type === 'number' || (!c.type && typeof rows.find((r) => r[c.key] != null)?.[c.key] === 'number')) {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const v = r[c.key];
        if (typeof v !== 'number' || Number.isNaN(v)) {
          s.nulls++;
          continue;
        }
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        count++;
      }
      if (count) {
        s.min = round(min);
        s.max = round(max);
        s.mean = round(sum / count);
      }
    } else {
      const distinct = new Set<unknown>();
      let min: string | undefined;
      let max: string | undefined;
      for (const r of rows) {
        const v = r[c.key];
        if (v === null || v === undefined || v === '') {
          s.nulls++;
          continue;
        }
        if (distinct.size <= 1000) distinct.add(v);
        if (c.type === 'date' && typeof v === 'string') {
          if (min === undefined || v < min) min = v;
          if (max === undefined || v > max) max = v;
        }
      }
      s.distinct = distinct.size;
      if (min !== undefined) s.min = min;
      if (max !== undefined) s.max = max;
    }
    stats[c.key] = s;
  }
  const sample = rows.length <= 5 ? rows.slice() : [...rows.slice(0, 3), ...rows.slice(-2)];
  const out: DatasetSummary = {
    id: ds.id,
    title: ds.title,
    rowCount: rows.length,
    columns: ds.columns.map((c) => {
      const col: DatasetSummary['columns'][number] = { key: c.key };
      if (c.label && c.label !== c.key) col.label = c.label;
      if (c.unit) col.unit = c.unit;
      if (c.type) col.type = c.type;
      return col;
    }),
    sample: sample.map(roundRow),
    stats,
  };
  if (ds.source) out.source = ds.source;
  return out;
}

const roundRow = (r: DatasetRow): DatasetRow => {
  const o: DatasetRow = {};
  for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'number' ? round(v) : v;
  return o;
};

/** The most a single tool result may cost the model, in characters. */
export const TOOL_RESULT_MAX_CHARS = 12_000;

/**
 * A tool result cut to fit `maxChars` of JSON: arrays keep their first
 * items and end with a note of how many were dropped, the largest members
 * of an object shrink first, long strings are shortened.
 */
export function capToolResult(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS): Json {
  const plain = JSON.parse(safeJsonStringify(value === undefined ? null : value)) as Json;
  const fitted = fit(plain, maxChars);
  if (size(fitted) <= maxChars) return fitted;
  return { truncated: true, text: safeJsonStringify(fitted, maxChars - 40) };
}

const size = (v: Json) => JSON.stringify(v).length;

function fit(v: Json, budget: number): Json {
  const s = size(v);
  if (s <= budget) return v;
  if (typeof v === 'string') {
    const keep = Math.max(20, budget - 40);
    return `${v.slice(0, keep)}… [${v.length - keep} more characters]`;
  }
  if (Array.isArray(v)) {
    const note = (n: number) => `… ${n} more item${n === 1 ? '' : 's'} omitted (the result was too long)`;
    const room = budget - note(v.length).length - 4;
    const out: Json[] = [];
    let used = 2;
    for (const item of v) {
      const is = size(item) + 1;
      if (used + is > room) break;
      out.push(item);
      used += is;
    }
    if (!out.length && v.length) out.push(fit(v[0], Math.max(40, room - 2)));
    if (out.length < v.length) out.push(note(v.length - out.length));
    return out;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).map(([k, x]) => ({ k, x, s: size(x) }));
    let excess = s - budget;
    const out: Record<string, Json> = { ...v };
    for (const e of [...entries].sort((a, b) => b.s - a.s)) {
      if (excess <= 0) break;
      const shrunk = fit(e.x, Math.max(40, e.s - excess));
      excess -= e.s - size(shrunk);
      out[e.k] = shrunk;
    }
    return out;
  }
  return v;
}
