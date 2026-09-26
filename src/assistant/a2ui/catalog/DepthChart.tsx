/*
 * The data catalog's DepthChart: a vertical profile for any depth-indexed
 * data (well logs, temperature or pressure profiles). Depth runs down the
 * left axis; tracks sit side by side, each with one or more curves on a
 * linear or log scale, a log-style header (name, unit, scale ends), shaded
 * intervals and horizontal markers across all tracks, and one crosshair
 * that reads every curve at the hovered depth. Plain SVG: 5,000 samples per
 * curve are thinned with LTTB along depth and the drawing is memoised, so
 * only the crosshair re-renders as the pointer moves.
 */
import { memo, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { DatasetColumn } from '../../core/types';
import { formatExact, formatNumber, lttbIndices, num } from '../data';
import { useRuntime, useRows, useText, type NodeProps } from '../runtime';
import { DataFrame, Note, PendingBlock } from './frame';
import { CHART_COLORS } from './schema';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A horizontal scale: a curve's, and its track's grid (the first curve's). */
export interface DepthAxis {
  scale: 'linear' | 'log';
  min: number;
  max: number;
}

export interface DepthCurve extends DepthAxis {
  column: string;
  label: string;
  unit?: string;
  color: string;
  /** full resolution, sorted by depth */
  depth: Float64Array;
  value: Float64Array;
  /** indices kept for drawing */
  drawn: number[];
}

export interface DepthTrack extends DepthAxis {
  title?: string;
  curves: DepthCurve[];
}

export interface DepthBand {
  from: number;
  to: number;
  label?: string;
  color: string;
}

export interface DepthMarker {
  depth: number;
  label?: string;
}

export interface DepthModel {
  tracks: DepthTrack[];
  top: number;
  bottom: number;
  bands: DepthBand[];
  markers: DepthMarker[];
  depthLabel: string;
  samples: number;
}

const MAX_POINTS = 1500;
const colorVar = (c: unknown, i: number) => (typeof c === 'string' && (CHART_COLORS as readonly string[]).includes(c) ? `var(--${c})` : `var(--chart-${(i % 5) + 1})`);

function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

/** A curve's scale: the given ends, or its data's range rounded outward (to decades on a log scale). */
function axisFor(values: Float64Array, scale: 'linear' | 'log', givenMin: number | null, givenMax: number | null): DepthAxis {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) {
    lo = scale === 'log' ? 1 : 0;
    hi = scale === 'log' ? 10 : 1;
  }
  let min = givenMin ?? lo;
  let max = givenMax ?? hi;
  if (scale === 'log') {
    if (givenMin === null) min = 10 ** Math.floor(Math.log10(Math.max(lo, 1e-9)));
    if (givenMax === null) max = 10 ** Math.ceil(Math.log10(Math.max(hi, min * 10)));
    if (min <= 0) min = 1e-3;
    if (max <= min) max = min * 10;
  } else {
    if (givenMin === null || givenMax === null) {
      const step = niceStep(max - min || Math.abs(max) || 1, 4);
      if (givenMin === null) min = Math.floor(min / step) * step;
      if (givenMax === null) max = Math.ceil(max / step) * step;
    }
    if (max <= min) max = min + 1;
  }
  return { scale, min, max };
}

/** Tracks, curves, scales and the depth range from the props and the rows. */
export function buildDepthModel(props: Rec, rows: readonly Rec[], columns: readonly DatasetColumn[]): DepthModel {
  const depthKey = String(props.depth ?? '');
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const depthCol = byKey.get(depthKey);
  const rawTracks: Rec[] = Array.isArray(props.tracks)
    ? props.tracks.filter(isRec)
    : Array.isArray(props.curves)
      ? props.curves.map((c) => ({ curves: [c] }))
      : [];
  let colorIndex = 0;
  const tracks: DepthTrack[] = [];
  for (const t of rawTracks) {
    const trackScale = t.scale === 'log' ? 'log' : 'linear';
    const curves: DepthCurve[] = [];
    for (const rc of Array.isArray(t.curves) ? t.curves : []) {
      const c = typeof rc === 'string' ? { column: rc } : isRec(rc) ? rc : null;
      if (!c || typeof c.column !== 'string') continue;
      const column = c.column;
      const scale = c.scale === 'log' || c.scale === 'linear' ? c.scale : trackScale;
      const pairs: [number, number][] = [];
      for (const r of rows) {
        const d = num(r[depthKey]);
        const v = num(r[column]);
        if (d === null || v === null || (scale === 'log' && v <= 0)) continue;
        pairs.push([d, v]);
      }
      pairs.sort((a, b) => a[0] - b[0]);
      const depth = Float64Array.from(pairs, (p) => p[0]);
      const value = Float64Array.from(pairs, (p) => p[1]);
      const ys = scale === 'log' ? Array.from(value, (v) => Math.log10(v)) : value;
      const col = byKey.get(column);
      // each curve has its own scale (as on a log print); the track's min/max, when given, apply to all of them
      const axis = axisFor(value, scale, num(c.min) ?? num(t.min), num(c.max) ?? num(t.max));
      curves.push({
        column,
        label: typeof c.label === 'string' && c.label ? c.label : (col?.label ?? column),
        unit: typeof c.unit === 'string' ? c.unit : col?.unit,
        color: colorVar(c.color, colorIndex++),
        depth,
        value,
        drawn: lttbIndices(depth, ys, MAX_POINTS),
        ...axis,
      });
    }
    if (!curves.length) continue;
    const { scale, min, max } = curves[0];
    tracks.push({ title: typeof t.title === 'string' ? t.title : undefined, scale, min, max, curves });
  }

  let top = Infinity;
  let bottom = -Infinity;
  for (const t of tracks)
    for (const c of t.curves)
      if (c.depth.length) {
        top = Math.min(top, c.depth[0]);
        bottom = Math.max(bottom, c.depth[c.depth.length - 1]);
      }
  const bands: DepthBand[] = (Array.isArray(props.bands) ? props.bands : [])
    .filter(isRec)
    .filter((b) => typeof b.from === 'number' && typeof b.to === 'number')
    .map((b, i) => ({ from: Math.min(b.from as number, b.to as number), to: Math.max(b.from as number, b.to as number), label: typeof b.label === 'string' ? b.label : undefined, color: colorVar(b.color, i + 2) }));
  const markers: DepthMarker[] = (Array.isArray(props.markers) ? props.markers : [])
    .filter(isRec)
    .filter((m) => typeof m.depth === 'number')
    .map((m) => ({ depth: m.depth as number, label: typeof m.label === 'string' ? m.label : undefined }));
  if (!Number.isFinite(top)) {
    const ds = [...bands.flatMap((b) => [b.from, b.to]), ...markers.map((m) => m.depth)];
    top = ds.length ? Math.min(...ds) : 0;
    bottom = ds.length ? Math.max(...ds) : 1;
  }
  if (typeof props.depthMin === 'number') top = props.depthMin;
  if (typeof props.depthMax === 'number') bottom = props.depthMax;
  if (bottom <= top) bottom = top + 1;
  const unit = typeof props.depthUnit === 'string' ? props.depthUnit : depthCol?.unit;
  const name = typeof props.depthLabel === 'string' && props.depthLabel ? props.depthLabel : (depthCol?.label ?? depthKey ?? 'Depth');
  return {
    tracks,
    top,
    bottom,
    bands,
    markers,
    depthLabel: unit ? `${name} (${unit})` : name,
    samples: Math.max(0, ...tracks.flatMap((t) => t.curves.map((c) => c.depth.length))),
  };
}

// ------------------------------------------------------------------ geometry

const AXIS_W = 52;
const GAP = 6;

interface Geometry {
  width: number;
  height: number;
  trackW: number;
  y: (d: number) => number;
  x: (a: DepthAxis, v: number) => number;
  trackX: (i: number) => number;
}

function geometry(model: DepthModel, width: number, height: number): Geometry {
  const n = Math.max(1, model.tracks.length);
  const trackW = Math.max(40, (width - AXIS_W - GAP * (n - 1)) / n);
  const span = model.bottom - model.top;
  return {
    width,
    height,
    trackW,
    y: (d) => ((d - model.top) / span) * height,
    trackX: (i) => AXIS_W + i * (trackW + GAP),
    x: (a, v) => {
      const f = a.scale === 'log' ? (Math.log10(v) - Math.log10(a.min)) / (Math.log10(a.max) - Math.log10(a.min)) : (v - a.min) / (a.max - a.min);
      return f * trackW;
    },
  };
}

function curvePath(c: DepthCurve, g: Geometry): string {
  if (!c.drawn.length) return '';
  // a gap much larger than the typical sample step breaks the line
  const steps: number[] = [];
  for (let i = 1; i < Math.min(c.depth.length, 200); i++) steps.push(c.depth[i] - c.depth[i - 1]);
  steps.sort((a, b) => a - b);
  const typical = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const drawnGap = typical > 0 ? typical * Math.max(10, c.depth.length / c.drawn.length) * 2 : Infinity;
  let d = '';
  let prev = NaN;
  for (const i of c.drawn) {
    const dep = c.depth[i];
    const cmd = !d || dep - prev > drawnGap ? 'M' : 'L';
    d += `${cmd}${g.x(c, c.value[i]).toFixed(1)},${g.y(dep).toFixed(1)}`;
    prev = dep;
  }
  return d;
}

function nearest(c: DepthCurve, depth: number): number | null {
  const a = c.depth;
  if (!a.length) return null;
  let lo = 0;
  let hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < depth) lo = mid;
    else hi = mid;
  }
  const i = Math.abs(a[lo] - depth) <= Math.abs(a[hi] - depth) ? lo : hi;
  const step = a.length > 1 ? (a[a.length - 1] - a[0]) / (a.length - 1) : Infinity;
  return Math.abs(a[i] - depth) <= Math.max(step * 3, 1e-9) ? c.value[i] : null;
}

function logTicks(t: DepthAxis): number[] {
  const out: number[] = [];
  for (let e = Math.ceil(Math.log10(t.min)); e <= Math.floor(Math.log10(t.max)); e++) out.push(10 ** e);
  return out;
}

// ------------------------------------------------------------------ drawing

/** The static part of the drawing: grid, bands, curves, markers, the depth axis. */
const Plot = memo(function Plot({ model, g, uid }: { model: DepthModel; g: Geometry; uid: string }) {
  const span = model.bottom - model.top;
  const step = niceStep(span, g.height / 56);
  const ticks: number[] = [];
  for (let d = Math.ceil(model.top / step) * step; d <= model.bottom + 1e-9; d += step) ticks.push(Number(d.toPrecision(12)));
  const right = g.trackX(model.tracks.length - 1) + g.trackW;
  return (
    <svg width={g.width} height={g.height + 1} className="block overflow-visible" aria-hidden="true">
      <defs>
        {model.tracks.map((_, i) => (
          <clipPath key={i} id={`${uid}-clip-${i}`}>
            <rect x={0} y={0} width={g.trackW} height={g.height} />
          </clipPath>
        ))}
      </defs>
      {model.bands.map((b, i) => {
        const y0 = g.y(b.from);
        const h = Math.max(1, g.y(b.to) - y0);
        return (
          <g key={`b${i}`}>
            <rect x={AXIS_W} y={y0} width={right - AXIS_W} height={h} fill={b.color} fillOpacity={0.14} />
            <rect x={AXIS_W} y={y0} width={3} height={h} fill={b.color} fillOpacity={0.8} />
          </g>
        );
      })}
      {ticks.map((d) => (
        <g key={`t${d}`}>
          <line x1={AXIS_W} x2={right} y1={g.y(d)} y2={g.y(d)} className="stroke-border" strokeOpacity={0.5} strokeDasharray="2 3" />
          <text x={AXIS_W - 6} y={g.y(d)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px] tabular-nums">
            {formatNumber(d)}
          </text>
        </g>
      ))}
      {model.tracks.map((t, i) => {
        const x0 = g.trackX(i);
        const grid = t.scale === 'log' ? logTicks(t) : [0.25, 0.5, 0.75].map((f) => t.min + f * (t.max - t.min));
        return (
          <g key={i} transform={`translate(${x0},0)`}>
            {grid.map((v) => (
              <line key={v} x1={g.x(t, v)} x2={g.x(t, v)} y1={0} y2={g.height} className="stroke-border" strokeOpacity={0.45} strokeDasharray="2 3" />
            ))}
            <rect x={0} y={0} width={g.trackW} height={g.height} fill="none" className="stroke-border" />
            <g clipPath={`url(#${uid}-clip-${i})`}>
              {t.curves.map((c) => (
                <path key={c.column} d={curvePath(c, g)} fill="none" stroke={c.color} strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          </g>
        );
      })}
      {model.bands.map((b, i) => {
        const y0 = g.y(b.from);
        const h = g.y(b.to) - y0;
        if (!b.label || h < 12 || y0 < 0 || y0 > g.height - 12) return null;
        return (
          <text key={`bl${i}`} x={AXIS_W + 8} y={y0 + 13} className="fill-foreground text-[10px] font-semibold" style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3, strokeLinejoin: 'round' }}>
            {b.label}
          </text>
        );
      })}
      {model.markers.map((m, i) => {
        const y = g.y(m.depth);
        if (y < 0 || y > g.height) return null;
        return (
          <g key={`m${i}`}>
            <line x1={AXIS_W} x2={right} y1={y} y2={y} className="stroke-foreground" strokeOpacity={0.55} strokeDasharray="5 3" />
            {m.label && (
              <text x={right - 4} y={y - 4} textAnchor="end" className="fill-foreground text-[10px] font-medium" style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3, strokeLinejoin: 'round' }}>
                {m.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});

function TrackHeader({ t, width }: { t: DepthTrack; width: number }) {
  const fmt = formatNumber;
  return (
    <div className="flex flex-col justify-between gap-1 pb-1.5" style={{ width }}>
      <span className="truncate text-[11px] font-semibold text-foreground">{t.title ?? '\u00a0'}</span>
      <div className="flex flex-col gap-1">
      {t.curves.map((c) => (
        <div key={c.column} className="flex flex-col">
          <div className="flex items-baseline justify-between gap-1 text-[10px] leading-tight">
            <span className="font-mono text-muted-foreground tabular-nums">{fmt(c.min)}</span>
            <span className="truncate font-medium text-foreground">
              {c.label}
              {c.unit && <span className="font-normal text-muted-foreground"> {c.unit}</span>}
            </span>
            <span className="font-mono text-muted-foreground tabular-nums">{fmt(c.max)}</span>
          </div>
          <svg width={width} height={3} aria-hidden="true" className="block">
            <line x1={0} x2={width} y1={1.5} y2={1.5} stroke={c.color} strokeWidth={2} />
          </svg>
        </div>
      ))}
      </div>
    </div>
  );
}

function useWidth<T extends HTMLElement>(initial: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Draws a prepared depth model at the container's width. */
export const DepthView = memo(function DepthView({ model, height }: { model: DepthModel; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const g = useMemo(() => geometry(model, width, height), [model, width, height]);
  const uid = useId().replace(/[^\w-]/g, '');
  const [hover, setHover] = useState<{ x: number; y: number; depth: number } | null>(null);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = Math.max(0, Math.min(height, e.clientY - rect.top));
    setHover({ x: e.clientX - rect.left, y, depth: model.top + (y / height) * (model.bottom - model.top) });
  };
  const readout = hover
    ? model.tracks.flatMap((t) => t.curves.map((c) => ({ c, v: nearest(c, hover.depth) })))
    : [];
  const right = g.trackX(model.tracks.length - 1) + g.trackW;
  return (
    <div ref={ref} className="w-full min-w-0 select-none">
      <div className="flex items-stretch" style={{ gap: GAP }}>
        <span className="flex shrink-0 items-end justify-end pr-1.5 pb-1.5 text-right text-[10px] leading-tight text-muted-foreground" style={{ width: AXIS_W - GAP }}>
          {model.depthLabel}
        </span>
        {model.tracks.map((t, i) => (
          <TrackHeader key={i} t={t} width={g.trackW} />
        ))}
      </div>
      <div className="relative" style={{ height: height + 1 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <Plot model={model} g={g} uid={uid} />
        {hover && (
          <>
            <div className="pointer-events-none absolute h-px bg-foreground/60" style={{ top: hover.y, left: AXIS_W, width: right - AXIS_W }} />
            <div
              className="pointer-events-none absolute -translate-y-1/2 rounded-sm bg-foreground px-1 font-mono text-[10px] text-background tabular-nums"
              style={{ top: hover.y, right: g.width - AXIS_W + 2 }}
            >
              {formatExact(hover.depth, hover.depth < 100 ? 2 : 1)}
            </div>
            <div
              className="pointer-events-none absolute z-10 grid min-w-32 gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
              style={{
                top: Math.min(hover.y + 10, height - 16 - readout.length * 18),
                ...(hover.x < (AXIS_W + right) / 2 ? { right: g.width - right + 8 } : { left: AXIS_W + 8 }),
              }}
            >
              <span className="font-medium text-foreground">
                {model.depthLabel.replace(/ \(.*\)$/, '')} {formatExact(hover.depth, 1)}
              </span>
              {readout.map(({ c, v }) => (
                <span key={c.column} className="flex items-center gap-2">
                  <span className="h-2.5 w-1 shrink-0 rounded-[2px]" style={{ background: c.color }} />
                  <span className="flex-1 text-muted-foreground">{c.label}</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">
                    {v === null ? '–' : formatExact(v)}
                    {c.unit && v !== null ? <span className="font-sans font-normal text-muted-foreground"> {c.unit}</span> : null}
                  </span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

function DepthChartNode({ node, scope }: NodeProps) {
  const rt = useRuntime();
  const src = useRows(node, scope);
  const title = useText(node.title, scope);
  const depthLabel = useText(node.depthLabel, scope);
  const height = typeof node.height === 'number' ? Math.max(200, Math.min(900, node.height)) : 420;
  const model = useMemo(() => buildDepthModel({ ...node, depthLabel }, src.rows, src.columns), [node, depthLabel, src.rows, src.columns]);
  if (rt.streaming && rt.surface.pending.includes(node.id)) return <PendingBlock height={height} title={title} />;
  if (src.missing) return <Note>Dataset “{src.missing}” is not available in this conversation.</Note>;
  if (!model.tracks.length) return <Note>No curves to plot.</Note>;
  const subtitle = [src.title && src.title !== title ? src.title : '', `${model.samples.toLocaleString()} samples`].filter(Boolean).join(' · ');
  return (
    <DataFrame title={title || undefined} subtitle={subtitle} rows={src.rows as Rec[]} columns={src.columns} copyable>
      {(expanded) => <DepthView model={model} height={expanded ? Math.max(height, Math.round(window.innerHeight * 0.66)) : height} />}
    </DataFrame>
  );
}

export { DepthChartNode as DepthChart };
