/*
 * Rows for the data catalog: where they come from (a dataset id, inline
 * `rows`, or a data-model path), how they are thinned for plotting (LTTB),
 * how numbers and dates are shown, and how they leave as CSV/TSV.
 */
import type { Dataset, DatasetColumn, DatasetRow } from '../core/types';
import { toDate } from './functions';
import { getAt, resolvePath } from './pointer';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Rows plus what is known about their columns. */
export interface RowSource {
  rows: Rec[];
  columns: DatasetColumn[];
  title?: string;
  /** `ds_3`, when the rows are a dataset's */
  datasetId?: string;
  /** a dataset id was given but the thread does not have it */
  missing?: string;
}

const EMPTY: Rec[] = [];

/** Resolves `{dataset | rows | path}` against the thread's datasets and the surface's data model. */
export function resolveRows(props: Rec, datasets: Record<string, Dataset>, model: unknown, scope = '/'): RowSource {
  if (typeof props.dataset === 'string') {
    const ds = datasets[props.dataset];
    if (!ds) return { rows: EMPTY, columns: [], missing: props.dataset };
    return { rows: ds.rows as Rec[], columns: ds.columns, title: ds.title, datasetId: ds.id };
  }
  let rows: unknown = props.rows;
  if (rows === undefined && typeof props.path === 'string') rows = getAt(model, resolvePath(props.path, scope));
  if (!Array.isArray(rows)) return { rows: EMPTY, columns: [] };
  const clean = rows.filter(isRec);
  return { rows: clean, columns: inferColumns(clean) };
}

/** Column descriptions from the rows themselves (key order of the first rows, type from the first value). */
export function inferColumns(rows: readonly Rec[]): DatasetColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 50))
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
  return keys.map((key) => {
    const sample = rows.find((r) => r[key] !== null && r[key] !== undefined)?.[key];
    const type = typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : typeof sample === 'string' && isIsoDate(sample) ? 'date' : 'string';
    return { key, type } as DatasetColumn;
  });
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s);

/** A cell as a finite number, or null (strings of digits count; dates do not). */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

/** A cell as epoch milliseconds (numbers pass through, ISO strings are parsed). */
export function timeValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const d = toDate(v);
  return d ? d.getTime() : null;
}

// ------------------------------------------------------------------ LTTB

/**
 * Largest-Triangle-Three-Buckets: the indices of at most `threshold` points
 * that keep the visual shape of a series (peaks survive, flat runs thin out).
 * `xs` must be sorted; points with a null y are skipped.
 */
export function lttbIndices(xs: ArrayLike<number>, ys: ArrayLike<number | null>, threshold: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < xs.length; i++) if (ys[i] !== null && Number.isFinite(ys[i] as number) && Number.isFinite(xs[i])) idx.push(i);
  const n = idx.length;
  if (threshold >= n || threshold < 3) return threshold < 3 && n > threshold ? idx.slice(0, Math.max(0, threshold)) : idx;
  const out: number[] = [idx[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += xs[idx[j]];
      avgY += ys[idx[j]] as number;
    }
    const len = avgEnd - avgStart || 1;
    avgX /= len;
    avgY /= len;
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const ax = xs[idx[a]];
    const ay = ys[idx[a]] as number;
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * ((ys[idx[j]] as number) - ay) - (ax - xs[idx[j]]) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(idx[next]);
    a = next;
  }
  out.push(idx[n - 1]);
  return out;
}

/**
 * Thins rows for plotting several series against one x: the union of each
 * series' LTTB points (so every series keeps its shape), in x order.
 */
export function downsampleRows<T>(rows: readonly T[], x: (r: T) => number | null, series: ((r: T) => number | null)[], perSeries = 1500): T[] {
  if (rows.length <= perSeries) return rows as T[];
  const order = rows.map((_, i) => i).filter((i) => x(rows[i]) !== null);
  order.sort((a, b) => (x(rows[a]) as number) - (x(rows[b]) as number));
  const xs = order.map((i) => x(rows[i]) as number);
  const keep = new Set<number>();
  for (const y of series) {
    const ys = order.map((i) => y(rows[i]));
    for (const k of lttbIndices(xs, ys, perSeries)) keep.add(k);
  }
  return [...keep].sort((a, b) => a - b).map((k) => rows[order[k]]);
}

/** Every n-th row, for scatter plots and other unordered data. */
export function strideRows<T>(rows: readonly T[], max: number): T[] {
  if (rows.length <= max) return rows as T[];
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

// ------------------------------------------------------------------ formatting

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(undefined, opts);
    nfCache.set(key, f);
  }
  return f;
}

/** A number for an axis tick or a KPI: compact above 10k (12.4k, 3.1M), a sensible number of decimals below. */
export function formatNumber(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (digits !== undefined) return nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  if (a >= 10000) return nf({ notation: 'compact', maximumFractionDigits: a >= 1e6 ? 2 : 1 }).format(v);
  if (a === 0) return '0';
  if (a >= 100) return nf({ maximumFractionDigits: 0 }).format(v);
  if (a >= 1) return nf({ maximumFractionDigits: 2 }).format(v);
  if (a >= 0.01) return nf({ maximumFractionDigits: 3 }).format(v);
  return nf({ maximumSignificantDigits: 3 }).format(v);
}

/** A full-precision-ish number for tables and tooltips (grouping, up to `digits` decimals). */
export function formatExact(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '–';
  if (digits !== undefined) return nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  const a = Math.abs(v);
  return nf({ maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 2 : 4 }).format(v);
}

const dfCache = new Map<string, Intl.DateTimeFormat>();
function df(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = dfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    dfCache.set(key, f);
  }
  return f;
}

/** A date for a tick or a cell, as coarse as the span of the axis allows. */
export function formatTime(ms: number, spanMs = 0, withTime = false): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const day = 864e5;
  if (withTime) return df({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  if (spanMs > 3 * 365 * day) return df({ year: 'numeric' }).format(d);
  if (spanMs > 60 * day) return df({ year: '2-digit', month: 'short' }).format(d);
  if (spanMs > 2 * day) return df({ month: 'short', day: 'numeric' }).format(d);
  if (spanMs > 0) return df({ hour: '2-digit', minute: '2-digit' }).format(d);
  return df({ year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

/** How a DataTable column shows its values. */
export type CellFormat = 'number' | 'integer' | 'percent' | 'date' | 'datetime' | 'text';

/** One table cell as text. */
export function formatCell(v: unknown, format: CellFormat | undefined, digits?: number): string {
  if (v === null || v === undefined || v === '') return '';
  if (format === 'text') return String(v);
  if (format === 'date' || format === 'datetime') {
    const t = timeValue(v);
    return t === null ? String(v) : format === 'date' ? df({ year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t)) : formatTime(t, 0, true);
  }
  const n = num(v);
  if (n === null || typeof v === 'boolean') return String(v);
  if (format === 'percent') return nf({ style: 'percent', maximumFractionDigits: digits ?? 1, minimumFractionDigits: digits }).format(n);
  if (format === 'integer') return nf({ maximumFractionDigits: 0 }).format(n);
  return formatExact(n, digits);
}

// ------------------------------------------------------------------ export

function escapeCsv(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV (RFC 4180), header from the column labels (with units). */
export function toCsv(rows: readonly Rec[] | readonly DatasetRow[], columns: readonly DatasetColumn[]): string {
  const cols = columns.length ? columns : inferColumns(rows as Rec[]);
  const head = cols.map((c) => escapeCsv(c.unit ? `${c.label ?? c.key} (${c.unit})` : (c.label ?? c.key))).join(',');
  return [head, ...rows.map((r) => cols.map((c) => escapeCsv((r as Rec)[c.key])).join(','))].join('\n');
}

/** Rows as TSV, for pasting into a spreadsheet. */
export function toTsv(rows: readonly Rec[], columns: readonly DatasetColumn[]): string {
  const cols = columns.length ? columns : inferColumns(rows);
  const clean = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/[\t\n\r]+/g, ' '));
  return [cols.map((c) => clean(c.unit ? `${c.label ?? c.key} (${c.unit})` : (c.label ?? c.key))).join('\t'), ...rows.map((r) => cols.map((c) => clean(r[c.key])).join('\t'))].join('\n');
}

/** A safe file name from a title. */
export function fileName(title: string | undefined, ext: string): string {
  const base = (title ?? 'data').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'data';
  return `${base}.${ext}`;
}
