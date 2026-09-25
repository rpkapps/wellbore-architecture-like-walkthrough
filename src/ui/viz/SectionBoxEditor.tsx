import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import { sampleHorizon } from '../../data/surfaces';
import type { SectionBox } from '../../scene/geology';
import type { App } from '../app';
import { fmt } from '../dom';
import { useRev, useSignal } from '../signal';

const MIN_SPAN = 100; // m between opposite faces
const STRIP_MAX = 3200; // m TVDSS
const GAUGE_W = 44;

type Edge = 'xMin' | 'xMax' | 'nMin' | 'nMax';
type Drag = { edges: Edge[]; move?: { x: number; n: number; box: SectionBox } } | { strip: true };

/**
 * The section box drawn where it cuts: a plan view of the field (every
 * wellbore, the active one and the camera's place on it) with the box as a
 * rectangle to drag by its edges, corners or middle, and beside it the
 * formation column with the overburden cut to drag up and down.
 */
export function SectionBoxEditor({ app }: { app: App }) {
  const rev = useRev(app.sceneRev, app.wellRev);
  const geo = app.engine.geology;
  const fb = geo.fullBox;
  // the drawing follows the drag at once; the 3D box rebuilds once per frame
  const [box, setBox] = useState<SectionBox>(geo.box);
  useEffect(() => setBox(geo.box), [rev, geo]);
  const edit = (b: Partial<SectionBox>) => {
    setBox((x) => ({ ...x, ...b }));
    app.setBox(b);
  };

  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const mapW = Math.max(0, W - GAUGE_W - 8);
  const aspect = (fb.nMax - fb.nMin) / (fb.xMax - fb.xMin);
  const mapH = Math.round(Math.max(140, Math.min(240, mapW * aspect)));
  const pad = 6;
  // uniform scale so the plan is not distorted
  const k = Math.min((mapW - 2 * pad) / (fb.xMax - fb.xMin), (mapH - 2 * pad) / (fb.nMax - fb.nMin));
  const ox = (mapW - k * (fb.xMax - fb.xMin)) / 2;
  const oy = (mapH - k * (fb.nMax - fb.nMin)) / 2;
  const px = (x: number) => ox + (x - fb.xMin) * k;
  const py = (n: number) => mapH - oy - (n - fb.nMin) * k;
  const toX = (p: number) => fb.xMin + (p - ox) / k;
  const toN = (p: number) => fb.nMin + (mapH - oy - p) / k;

  const drag = useRef<Drag | null>(null);
  const [hot, setHot] = useState<Edge[] | 'move' | null>(null);

  const clampEdge = (e: Edge, v: number, b: SectionBox) => {
    if (e === 'xMin') return Math.max(fb.xMin, Math.min(b.xMax - MIN_SPAN, v));
    if (e === 'xMax') return Math.min(fb.xMax, Math.max(b.xMin + MIN_SPAN, v));
    if (e === 'nMin') return Math.max(fb.nMin, Math.min(b.nMax - MIN_SPAN, v));
    return Math.min(fb.nMax, Math.max(b.nMin + MIN_SPAN, v));
  };
  const hit = (sx: number, sy: number): Edge[] | 'move' | null => {
    const T = 7;
    const inX = sx > px(box.xMin) - T && sx < px(box.xMax) + T;
    const inY = sy > py(box.nMax) - T && sy < py(box.nMin) + T;
    if (!inX || !inY) return null;
    const e: Edge[] = [];
    if (Math.abs(sx - px(box.xMin)) < T) e.push('xMin');
    else if (Math.abs(sx - px(box.xMax)) < T) e.push('xMax');
    if (Math.abs(sy - py(box.nMin)) < T) e.push('nMin');
    else if (Math.abs(sy - py(box.nMax)) < T) e.push('nMax');
    return e.length ? e : 'move';
  };
  const local = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const onDown = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const [sx, sy] = local(ev);
    const h = hit(sx, sy);
    if (!h) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    drag.current = h === 'move' ? { edges: [], move: { x: toX(sx), n: toN(sy), box } } : { edges: h };
  };
  const onMove = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const [sx, sy] = local(ev);
    const d = drag.current;
    if (!d || 'strip' in d) {
      setHot(hit(sx, sy));
      return;
    }
    if (d.move) {
      const m = d.move;
      const dx = Math.max(fb.xMin - m.box.xMin, Math.min(fb.xMax - m.box.xMax, toX(sx) - m.x));
      const dn = Math.max(fb.nMin - m.box.nMin, Math.min(fb.nMax - m.box.nMax, toN(sy) - m.n));
      edit({ xMin: m.box.xMin + dx, xMax: m.box.xMax + dx, nMin: m.box.nMin + dn, nMax: m.box.nMax + dn });
      return;
    }
    const b: Partial<SectionBox> = {};
    for (const e of d.edges) b[e] = Math.round(clampEdge(e, e[0] === 'x' ? toX(sx) : toN(sy), box) / 10) * 10;
    edit(b);
  };
  const onUp = () => {
    drag.current = null;
  };
  const edgeKey = (e: Edge) => (ev: KeyboardEvent) => {
    const step = ev.shiftKey ? 250 : 50;
    const d = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : 0;
    if (!d) return;
    ev.preventDefault();
    edit({ [e]: clampEdge(e, box[e] + d, box) });
  };

  const well = app.engine.activeWell;
  const others = app.field.wells.filter((w) => w !== well);
  const line = (t: { ew: Float64Array; ns: Float64Array }) => {
    const pts: string[] = [];
    for (let i = 0; i < t.ew.length; i += 4) pts.push(`${px(t.ew[i]).toFixed(1)},${py(t.ns[i]).toFixed(1)}`);
    return pts.join(' ');
  };
  const cursor =
    hot === 'move'
      ? 'cursor-move'
      : hot
        ? hot.length === 2
          ? hot.includes('xMin') === hot.includes('nMax')
            ? 'cursor-nwse-resize'
            : 'cursor-nesw-resize'
          : hot[0][0] === 'x'
            ? 'cursor-ew-resize'
            : 'cursor-ns-resize'
        : 'cursor-default';
  const bx0 = px(box.xMin);
  const bx1 = px(box.xMax);
  const by0 = py(box.nMax);
  const by1 = py(box.nMin);
  const handles: [Edge, string, number, number, number, number][] = [
    ['xMin', 'West face', bx0 - 2, (by0 + by1) / 2 - 9, 4, 18],
    ['xMax', 'East face', bx1 - 2, (by0 + by1) / 2 - 9, 4, 18],
    ['nMax', 'North face', (bx0 + bx1) / 2 - 9, by0 - 2, 18, 4],
    ['nMin', 'South face', (bx0 + bx1) / 2 - 9, by1 - 2, 18, 4],
  ];
  const km = (v: number) => (v / 1000).toFixed(2);

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={wrap} className="flex gap-2">
        {mapW > 0 && (
          <svg
            width={mapW}
            height={mapH}
            className={`shrink-0 touch-none rounded-md bg-muted select-none ${cursor}`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={() => !drag.current && setHot(null)}
            aria-label="Section box, plan view"
          >
            <defs>
              <pattern id="sb-grid" width={k * 500} height={k * 500} patternUnits="userSpaceOnUse" x={px(0)} y={py(0)}>
                <path d={`M${k * 500},0 L0,0 L0,${k * 500}`} fill="none" className="stroke-foreground/5" />
              </pattern>
            </defs>
            <Relief app={app} px={px} py={py} k={k} />
            <rect width={mapW} height={mapH} fill="url(#sb-grid)" />
            <rect x={px(fb.xMin)} y={py(fb.nMax)} width={k * (fb.xMax - fb.xMin)} height={k * (fb.nMax - fb.nMin)} fill="none" strokeDasharray="3 3" className="stroke-border" />
            {others.map((w) => (
              <polyline key={w.id} points={line(w.trajectory)} fill="none" strokeWidth={1} className="stroke-muted-foreground/45" />
            ))}
            {/* what the box cuts away */}
            <path d={`M0,0 H${mapW} V${mapH} H0 Z M${bx0},${by0} V${by1} H${bx1} V${by0} Z`} fillRule="evenodd" className="pointer-events-none fill-background/55" />
            <polyline points={line(well.trajectory)} fill="none" strokeWidth={2} strokeLinecap="round" className="stroke-primary" />
            <Bit app={app} px={px} py={py} />
            <rect x={bx0} y={by0} width={bx1 - bx0} height={by1 - by0} fill="none" strokeWidth={1.5} className={hot === 'move' ? 'stroke-foreground' : 'stroke-foreground/70'} />
            {handles.map(([e, label, x, y, w, h]) => (
              <rect
                key={e}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={2}
                role="slider"
                tabIndex={0}
                aria-label={label}
                aria-valuemin={Math.round(e[0] === 'x' ? fb.xMin : fb.nMin)}
                aria-valuemax={Math.round(e[0] === 'x' ? fb.xMax : fb.nMax)}
                aria-valuenow={Math.round(box[e])}
                aria-valuetext={`${km(box[e])} km`}
                onKeyDown={edgeKey(e)}
                className={`outline-none focus-visible:stroke-ring focus-visible:stroke-2 ${hot !== 'move' && hot?.includes(e) ? 'fill-primary' : 'fill-foreground'}`}
              />
            ))}
            <g className="pointer-events-none fill-muted-foreground" fontSize={9} fontWeight={600}>
              <text x={mapW - 9} y={14} textAnchor="middle">
                N
              </text>
              <path d={`M${mapW - 9},17 l3,7 l-3,-2 l-3,2 Z`} />
              <text x={8} y={14} fontWeight={500}>
                Top Hugin · light = shallow
              </text>
              <rect x={8} y={mapH - 9} width={k * 1000} height={2} />
              <text x={8 + k * 1000 + 4} y={mapH - 5} className="font-mono" fontWeight={400}>
                1 km
              </text>
            </g>
          </svg>
        )}
        {mapW > 0 && <DepthGauge app={app} height={mapH} value={box.stripTo} onChange={(v) => edit({ stripTo: v })} />}
      </div>
      <p className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
        W {km(box.xMin)} · E {km(box.xMax)} · S {km(box.nMin)} · N {km(box.nMax)} km · strip {fmt.n(box.stripTo, 0)} m
      </p>
    </div>
  );
}

/** Depth to the top of the reservoir as shaded relief: deep is dark, the crest is light. */
function Relief({ app, px, py, k }: { app: App; px: (x: number) => number; py: (n: number) => number; k: number }) {
  const fb = app.engine.geology.fullBox;
  const g = app.field.horizons.find((h) => h.id === 'hugin') ?? app.field.horizons[app.field.horizons.length - 1];
  const cells = useMemo(() => {
    if (!g) return [];
    const nx = 44;
    const cw = (fb.xMax - fb.xMin) / nx;
    const nz = Math.max(4, Math.round((fb.nMax - fb.nMin) / cw));
    const ch = (fb.nMax - fb.nMin) / nz;
    const d: number[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const v = sampleHorizon(g, fb.xMin + (i + 0.5) * cw, fb.nMin + (j + 0.5) * ch);
        d.push(v);
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    return d.map((v, idx) => ({ i: idx % nx, j: Math.floor(idx / nx), t: Number.isFinite(v) ? (v - lo) / Math.max(1, hi - lo) : NaN, cw, ch }));
  }, [g, fb]);
  // light crest (shallow) to dark flanks (deep)
  const shade = (t: number) => `color-mix(in oklch, var(--tecton-palette-azure-460) ${Math.round((1 - t) * 70)}%, var(--tecton-palette-azure-110))`;
  return (
    <g className="pointer-events-none" opacity={0.75}>
      {cells.map((c) =>
        Number.isFinite(c.t) ? <rect key={`${c.i}:${c.j}`} x={px(fb.xMin + c.i * c.cw)} y={py(fb.nMin + (c.j + 1) * c.ch)} width={k * c.cw + 0.6} height={k * c.ch + 0.6} fill={shade(c.t)} /> : null,
      )}
    </g>
  );
}

function Bit({ app, px, py }: { app: App; px: (x: number) => number; py: (n: number) => number }) {
  const pose = useSignal(app.poseText);
  const t = app.engine.activeWell.trajectory.at(pose.md);
  return <circle cx={px(t.ew)} cy={py(t.ns)} r={3.5} strokeWidth={1.5} className="pointer-events-none fill-primary stroke-card" />;
}

/**
 * The formation column of the active well by TVDSS, with the overburden cut
 * as a handle: everything above it is stripped from the 3D model.
 */
function DepthGauge({ app, height, value, onChange }: { app: App; height: number; value: number; onChange: (v: number) => void }) {
  const w = app.engine.activeWell;
  const datum = app.field.meta.datumElevation;
  const top = 4;
  const bot = height - 4;
  const y = (tvdss: number) => top + (Math.max(0, Math.min(STRIP_MAX, tvdss)) / STRIP_MAX) * (bot - top);
  const toV = (sy: number) => Math.round((Math.max(0, Math.min(1, (sy - top) / (bot - top))) * STRIP_MAX) / 10) * 10;
  const tvdss = (md: number) => w.trajectory.at(Math.min(md, w.trajectory.mdEnd)).tvd - datum;
  const dragging = useRef(false);
  const set = (ev: ReactPointerEvent<SVGSVGElement>) => onChange(toV(ev.clientY - ev.currentTarget.getBoundingClientRect().top));
  const cy = y(value);
  const bx = 12;
  const bw = 14;
  return (
    <svg
      width={GAUGE_W}
      height={height}
      className="shrink-0 cursor-ns-resize touch-none select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        set(e);
      }}
      onPointerMove={(e) => dragging.current && set(e)}
      onPointerUp={() => (dragging.current = false)}
    >
      <defs>
        <clipPath id="sb-col">
          <rect x={bx} y={top} width={bw} height={bot - top} rx={3} />
        </clipPath>
        <pattern id="sb-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} className="fill-background/70" />
          <line x1={0} y1={0} x2={0} y2={4} strokeWidth={1.5} className="stroke-foreground/25" />
        </pattern>
      </defs>
      <g clipPath="url(#sb-col)">
        <rect x={bx} y={top} width={bw} height={bot - top} className="fill-muted" />
        {w.zones
          .filter((z) => z.formationId !== 'air')
          .map((z) => {
            const y0 = y(tvdss(z.topMD));
            const y1 = y(tvdss(z.baseMD));
            return (
              <rect
                key={`${z.formationId}:${z.topMD}`}
                x={bx}
                y={Math.min(y0, y1)}
                width={bw}
                height={Math.max(0.5, Math.abs(y1 - y0))}
                fill={z.formationId === 'sea' ? '#1d4e6b' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555')}
              />
            );
          })}
        <rect x={bx} y={top} width={bw} height={Math.max(0, cy - top)} fill="url(#sb-hatch)" />
      </g>
      <g className="fill-muted-foreground font-mono" fontSize={8.5}>
        {[0, 1000, 2000, 3000].map((d) => (
          <g key={d}>
            <rect x={bx + bw + 1} y={y(d) - 0.5} width={3} height={1} />
            <text x={bx + bw + 6} y={y(d) + 3}>
              {d / 1000}k
            </text>
          </g>
        ))}
      </g>
      <g
        role="slider"
        tabIndex={0}
        aria-label="Strip overburden to"
        aria-valuemin={0}
        aria-valuemax={STRIP_MAX}
        aria-valuenow={value}
        aria-valuetext={`${fmt.n(value, 0)} m TVDSS`}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowDown' ? 50 : e.key === 'ArrowUp' ? -50 : 0;
          if (!d) return;
          e.preventDefault();
          onChange(Math.max(0, Math.min(STRIP_MAX, value + (e.shiftKey ? d * 5 : d))));
        }}
        className="outline-none [&:focus-visible>path]:stroke-ring"
      >
        <line x1={bx - 3} x2={bx + bw + 3} y1={cy} y2={cy} strokeWidth={2} className="stroke-foreground" />
        <path d={`M${bx - 10},${cy - 5} L${bx - 3},${cy} L${bx - 10},${cy + 5} Z`} strokeWidth={1.5} className="fill-foreground stroke-transparent" />
      </g>
    </svg>
  );
}
