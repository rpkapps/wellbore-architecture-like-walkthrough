/*
 * The Chart component's data preparation, free of React: series and colours
 * from the props, the x type from the data, rows re-keyed for Recharts
 * (`x`, `s0`, `s1`… so no column name ever has to be a CSS identifier),
 * sorted and thinned with LTTB to at most 1,500 points per series.
 */
import type { DatasetColumn } from '../../core/types';
import { downsampleRows, num, strideRows, timeValue } from '../data';
import { CHART_COLORS } from './schema';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

export type ChartKind = 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'composed';
export type XType = 'number' | 'category' | 'time';

export interface SeriesModel {
  key: string;
  column: string;
  label: string;
  unit?: string;
  kind: 'line' | 'area' | 'bar' | 'scatter';
  axis: 'left' | 'right';
  stack?: string;
  /** `var(--chart-N)` */
  color: string;
  /** a 6th+ series reuses a colour, dashed */
  dashed: boolean;
}

export interface ChartModel {
  kind: ChartKind;
  xType: XType;
  xLabel?: string;
  yUnit?: string;
  series: SeriesModel[];
  data: Rec[];
  /** rows before thinning */
  total: number;
  /** the rows were thinned or capped */
  reduced: boolean;
  hasRight: boolean;
  /** x extent (number/time) */
  xSpan: number;
  /** the axis starts at 0: it has bars or areas (whose length is the value) and no negative values */
  leftZero: boolean;
  rightZero: boolean;
}

export const MAX_POINTS = 1500;
const MAX_CATEGORIES = 400;
const MAX_SLICES = 5;

const colorVar = (c: unknown, i: number) => (typeof c === 'string' && (CHART_COLORS as readonly string[]).includes(c) ? `var(--${c})` : `var(--chart-${(i % 5) + 1})`);

/** Normalises the props' series (strings or objects) against the known columns. */
export function seriesOf(props: Rec, columns: readonly DatasetColumn[], kind: ChartKind): SeriesModel[] {
  const raw = Array.isArray(props.series) ? props.series : [];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return raw
    .map((s) => (typeof s === 'string' ? { column: s } : isRec(s) ? s : null))
    .filter((s): s is Rec => !!s && typeof s.column === 'string' && s.column !== '')
    .map((s, i) => {
      const col = byKey.get(String(s.column));
      const fallbackKind = kind === 'composed' ? (i === 0 ? 'bar' : 'line') : kind === 'pie' ? 'bar' : kind;
      const sk = ['line', 'area', 'bar', 'scatter'].includes(String(s.kind)) && kind === 'composed' ? (s.kind as SeriesModel['kind']) : (fallbackKind as SeriesModel['kind']);
      return {
        key: `s${i}`,
        column: String(s.column),
        label: typeof s.label === 'string' && s.label ? s.label : (col?.label ?? String(s.column)),
        unit: col?.unit,
        kind: sk,
        axis: s.axis === 'right' ? 'right' : 'left',
        stack: typeof s.stack === 'string' || typeof s.stack === 'number' ? String(s.stack) : s.stack === true ? 'stack' : undefined,
        color: colorVar(s.color, i),
        dashed: i >= 5 && s.color === undefined,
      } satisfies SeriesModel;
    });
}

/** Guesses the x type: numbers → number, dates → time, anything else → category (bars default to category). */
export function inferXType(props: Rec, rows: readonly Rec[], columns: readonly DatasetColumn[], kind: ChartKind): XType {
  if (props.xType === 'number' || props.xType === 'category' || props.xType === 'time') return props.xType;
  const x = String(props.x);
  const col = columns.find((c) => c.key === x);
  if (col?.type === 'date') return 'time';
  const sample = rows.slice(0, 20).map((r) => r[x]).filter((v) => v !== null && v !== undefined);
  if (!sample.length) return 'category';
  if (sample.every((v) => typeof v === 'number')) return kind === 'bar' ? 'category' : 'number';
  if (sample.every((v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?(T|$)/.test(v))) return 'time';
  return 'category';
}

/** Everything the Chart component needs to draw. */
export function buildChartModel(props: Rec, rows: readonly Rec[], columns: readonly DatasetColumn[]): ChartModel {
  const kind: ChartKind = (['line', 'area', 'bar', 'scatter', 'pie', 'composed'] as const).includes(props.kind as ChartKind) ? (props.kind as ChartKind) : 'line';
  const x = String(props.x ?? '');
  const series = seriesOf(props, columns, kind);
  const xType = kind === 'pie' ? 'category' : inferXType(props, rows, columns, kind);
  const xCol = columns.find((c) => c.key === x);
  const log = props.yScale === 'log';
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];

  const xOf = (r: Rec): number | string | null => {
    const v = r[x];
    if (xType === 'number') return num(v);
    if (xType === 'time') return timeValue(v);
    return v === null || v === undefined ? null : String(v);
  };
  const yOf = (r: Rec, column: string): number | null => {
    const n = num(r[column]);
    return n === null || (log && n <= 0) ? null : n;
  };

  if (kind === 'pie') {
    const s = series[0];
    const totals = new Map<string, number>();
    for (const r of rows) {
      const name = xOf(r);
      const v = s ? yOf(r, s.column) : null;
      if (name === null || v === null || v <= 0) continue;
      totals.set(String(name), (totals.get(String(name)) ?? 0) + v);
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, MAX_SLICES);
    const rest = sorted.slice(MAX_SLICES).reduce((acc, [, v]) => acc + v, 0);
    const data: Rec[] = top.map(([name, value], i) => ({ key: `p${i}`, name, value }));
    if (rest > 0) data.push({ key: `p${data.length}`, name: 'Other', value: rest, other: true });
    return { kind, xType, xLabel: undefined, yUnit: s?.unit, series, data, total: rows.length, reduced: false, hasRight: false, xSpan: 0, leftZero: true, rightZero: true };
  }

  let data: Rec[] = [];
  for (const r of rows) {
    const xv = xOf(r);
    if (xv === null) continue;
    const out: Rec = { x: xv };
    for (const s of series) out[s.key] = yOf(r, s.column);
    data.push(out);
  }
  const total = data.length;
  let reduced = false;
  const numericX = xType !== 'category';
  if (numericX && kind !== 'bar') data.sort((a, b) => (a.x as number) - (b.x as number));

  if (kind === 'scatter') {
    if (data.length > MAX_POINTS) {
      data = strideRows(data, MAX_POINTS);
      reduced = true;
    }
  } else if (kind === 'bar' || (kind === 'composed' && series.some((s) => s.kind === 'bar'))) {
    if (data.length > MAX_CATEGORIES) {
      data = numericX
        ? downsampleRows(data, (r) => r.x as number, series.map((s) => (r: Rec) => r[s.key] as number | null), MAX_CATEGORIES)
        : strideRows(data, MAX_CATEGORIES);
      reduced = true;
    }
  } else if (data.length > MAX_POINTS) {
    const indexed = numericX ? data : data.map((r, i) => ({ ...r, __i: i }));
    data = downsampleRows(indexed, (r) => (numericX ? (r.x as number) : (r.__i as number)), series.map((s) => (r: Rec) => r[s.key] as number | null), MAX_POINTS);
    reduced = true;
  }

  let xSpan = 0;
  if (numericX && data.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of data) {
      const v = r.x as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    xSpan = hi - lo;
  }
  // a time axis explains itself; a numeric one is named after its column unless the props name it
  const xLabel = typeof props.xLabel === 'string' ? props.xLabel : xCol && xType === 'number' ? (xCol.unit ? `${xCol.label ?? xCol.key} (${xCol.unit})` : xCol.label) : undefined;
  let leftMin = 0;
  let rightMin = 0;
  for (const r of data)
    for (const s of series) {
      const v = r[s.key];
      if (typeof v !== 'number') continue;
      if (s.axis === 'right') rightMin = Math.min(rightMin, v);
      else leftMin = Math.min(leftMin, v);
    }
  const filled = (axis: 'left' | 'right') => series.some((s) => s.axis === axis && (seriesKind(kind, s) === 'bar' || seriesKind(kind, s) === 'area'));
  return {
    kind,
    xType,
    xLabel,
    yUnit: units.length === 1 ? units[0] : undefined,
    series,
    data,
    total,
    reduced,
    hasRight: series.some((s) => s.axis === 'right'),
    xSpan,
    leftZero: leftMin >= 0 && filled('left'),
    rightZero: rightMin >= 0 && filled('right'),
  };
}

/** How one series is drawn: its own kind in a composed chart, the chart's otherwise. */
function seriesKind(kind: ChartKind, s: SeriesModel): SeriesModel['kind'] {
  return kind === 'composed' ? s.kind : (kind as SeriesModel['kind']);
}
