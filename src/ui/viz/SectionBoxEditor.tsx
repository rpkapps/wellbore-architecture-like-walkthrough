import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import { sampleHorizon } from '../../data/surfaces';
import type { SectionBox } from '../../scene/geology';
import type { App } from '../app';
import { fmt } from '../dom';
import { useRev } from '../signal';

const MIN_SPAN = 100; // m between opposite faces
const STRIP_MAX = 3200; // m TVDSS
const GAUGE_W = 44;

type Edge = 'xMin' | 'xMax' | 'nMin' | 'nMax';
type Drag = { edges: Edge[]; move?: { x: number; n: number; box: SectionBox } } | { strip: true };

/** The plan's pixel layout: its size and the uniform world → pixel scale. */
interface View {
  w: number;
  h: number;
  k: number;
  ox: number;
  oy: number;
}

/**
 * The section box drawn where it cuts: a plan view of the field (every
 * wellbore, the active one and the camera's place on it) with the box as a
 * rectangle to drag by its edges, corners or middle, and beside it the
 * formation column with the overburden cut to drag up and down.
 *
 * The panel's width sets the plan's size, and panels resize every frame while
 * their edges are dragged, so the size never goes through React: the map is
 * drawn in world coordinates under one transform, and `layout` writes that
 * transform and the few pixel-sized marks (handles, bit, grid, scale bar).
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
  const svg = useRef<SVGSVGElement>(null);
  // the three layers drawn in world coordinates, between pixel-sized ones
  const worlds = useRef<(SVGGElement | null)[]>([]);
  const worldRef = useMemo(() => [0, 1, 2].map((i) => (el: SVGGElement | null) => void (worlds.current[i] = el)), []);
  const grid = useRef<SVGPatternElement>(null);
  const extent = useRef<SVGRectElement>(null);
  const handleEls = useRef<(SVGRectElement | null)[]>([]);
  const bit = useRef<SVGCircleElement>(null);
  const scaleBar = useRef<SVGRectElement>(null);
  const scaleText = useRef<SVGTextElement>(null);
  const gauge = useRef<GaugeLayout | null>(null);
  const v = useRef<View>({ w: 0, h: 0, k: 1, ox: 0, oy: 0 });
  const boxNow = useRef(box);
  boxNow.current = box;
  const [shown, setShown] = useState(false);

  const px = (x: number) => v.current.ox + (x - fb.xMin) * v.current.k;
  const py = (n: number) => v.current.h - v.current.oy - (n - fb.nMin) * v.current.k;
  const toX = (p: number) => fb.xMin + (p - v.current.ox) / v.current.k;
  const toN = (p: number) => fb.nMin + (v.current.h - v.current.oy - p) / v.current.k;

  // everything below reads the latest view and box through refs, so the effects that call it never go stale
  const placeBit = () => {
    const md = app.poseText.value.md;
    const t = app.engine.activeWell.trajectory.at(md);
    bit.current?.setAttribute('cx', px(t.ew).toFixed(1));
    bit.current?.setAttribute('cy', py(t.ns).toFixed(1));
  };
  const placeBox = () => {
    const b = boxNow.current;
    const bx0 = px(b.xMin);
    const bx1 = px(b.xMax);
    const by0 = py(b.nMax);
    const by1 = py(b.nMin);
    const at: [number, number][] = [
      [bx0 - 2, (by0 + by1) / 2 - 9],
      [bx1 - 2, (by0 + by1) / 2 - 9],
      [(bx0 + bx1) / 2 - 9, by0 - 2],
      [(bx0 + bx1) / 2 - 9, by1 - 2],
    ];
    handleEls.current.forEach((el, i) => {
      el?.setAttribute('x', at[i][0].toFixed(1));
      el?.setAttribute('y', at[i][1].toFixed(1));
    });
  };
  const layout = (W: number) => {
    const mapW = Math.max(0, W - GAUGE_W - 8);
    const aspect = (fb.nMax - fb.nMin) / (fb.xMax - fb.xMin);
    const mapH = Math.round(Math.max(140, Math.min(240, mapW * aspect)));
    const pad = 6;
    // uniform scale so the plan is not distorted
    const k = Math.max(1e-6, Math.min((mapW - 2 * pad) / (fb.xMax - fb.xMin), (mapH - 2 * pad) / (fb.nMax - fb.nMin)));
    v.current = { w: mapW, h: mapH, k, ox: (mapW - k * (fb.xMax - fb.xMin)) / 2, oy: (mapH - k * (fb.nMax - fb.nMin)) / 2 };
    setShown(mapW > 0);
    const s = svg.current;
    if (!s || mapW <= 0) return;
    s.setAttribute('width', String(mapW));
    s.setAttribute('height', String(mapH));
    // world (east, north) → pixels, north up
    const m = `matrix(${k} 0 0 ${-k} ${px(0).toFixed(2)} ${py(0).toFixed(2)})`;
    for (const g of worlds.current) g?.setAttribute('transform', m);
    const g = grid.current;
    if (g) {
      const c = (k * 500).toFixed(2);
      g.setAttribute('width', c);
      g.setAttribute('height', c);
      g.setAttribute('x', px(0).toFixed(1));
      g.setAttribute('y', py(0).toFixed(1));
      g.firstElementChild?.setAttribute('d', `M${c},0 L0,0 L0,${c}`);
    }
    const e = extent.current;
    if (e) {
      e.setAttribute('x', px(fb.xMin).toFixed(1));
      e.setAttribute('y', py(fb.nMax).toFixed(1));
      e.setAttribute('width', (k * (fb.xMax - fb.xMin)).toFixed(1));
      e.setAttribute('height', (k * (fb.nMax - fb.nMin)).toFixed(1));
    }
    scaleBar.current?.setAttribute('width', (k * 1000).toFixed(1));
    scaleText.current?.setAttribute('x', (8 + k * 1000 + 4).toFixed(1));
    placeBox();
    placeBit();
    gauge.current?.(mapH, boxNow.current.stripTo);
  };

  // the observer and the pose subscription outlive renders: they call the latest closures
  const latest = useRef({ layout, placeBit });
  latest.current = { layout, placeBit };
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let W = -1;
    // a ResizeObserver reports once per frame, after layout, with the size (no layout read)
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[es.length - 1].contentRect.width);
      if (w === W) return;
      W = w;
      latest.current.layout(w);
    });
    ro.observe(el);
    // laid out before the first paint (one read, on mount)
    W = Math.round(el.clientWidth);
    latest.current.layout(W);
    return () => ro.disconnect();
  }, []);
  // the box moved (drag, keys, another control) or the drawing mounted
  useLayoutEffect(() => {
    placeBox();
    placeBit();
    gauge.current?.(v.current.h, box.stripTo);
  });
  // the camera's place on the plan follows playback without rendering
  useEffect(() => app.poseText.subscribe(() => latest.current.placeBit()), [app]);

  const drag = useRef<Drag | null>(null);
  const [hot, setHotState] = useState<Edge[] | 'move' | null>(null);
  // hovering re-renders only when what is under the pointer changes
  const setHot = (h: Edge[] | 'move' | null) => setHotState((o) => (String(o) === String(h) ? o : h));

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
  const handles: [Edge, string][] = [
    ['xMin', 'West face'],
    ['xMax', 'East face'],
    ['nMax', 'North face'],
    ['nMin', 'South face'],
  ];
  // what the box cuts away, in world coordinates: everything but the box (far past the plan's edges)
  const far = 1e6;
  const km = (v: number) => (v / 1000).toFixed(2);

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={wrap} className="flex gap-2">
        <svg
          ref={svg}
          className={`shrink-0 touch-none rounded-md bg-muted select-none ${cursor} ${shown ? '' : 'hidden'}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => !drag.current && setHot(null)}
          aria-label="Section box, plan view"
        >
          <defs>
            <pattern ref={grid} id="sb-grid" patternUnits="userSpaceOnUse">
              <path fill="none" className="stroke-foreground/5" />
            </pattern>
          </defs>
          <g ref={worldRef[0]}>
            <Relief app={app} />
          </g>
          <rect width="100%" height="100%" fill="url(#sb-grid)" />
          <rect ref={extent} fill="none" strokeDasharray="3 3" className="stroke-border" />
          <g ref={worldRef[1]}>
            <Wells app={app} />
            <path
              d={`M${-far},${-far} H${far} V${far} H${-far} Z M${box.xMin},${box.nMin} V${box.nMax} H${box.xMax} V${box.nMin} Z`}
              fillRule="evenodd"
              className="pointer-events-none fill-background/55"
            />
            <ActiveWell app={app} />
          </g>
          <circle ref={bit} r={3.5} strokeWidth={1.5} className="pointer-events-none fill-primary stroke-card" />
          <g ref={worldRef[2]}>
            <rect
              x={box.xMin}
              y={box.nMin}
              width={box.xMax - box.xMin}
              height={box.nMax - box.nMin}
              fill="none"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className={hot === 'move' ? 'stroke-foreground' : 'stroke-foreground/70'}
            />
          </g>
          {handles.map(([e, label], i) => (
            <rect
              key={e}
              ref={(el) => {
                handleEls.current[i] = el;
              }}
              width={e[0] === 'x' ? 4 : 18}
              height={e[0] === 'x' ? 18 : 4}
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
          <g className="pointer-events-none fill-muted-foreground" fontSize="0.68rem" fontWeight={600}>
            {/* pinned to the right and bottom edges by nested viewports, so they need no layout */}
            <svg x="100%" overflow="visible">
              <text x={-9} y={14} textAnchor="middle">
                N
              </text>
              <path d="M-9,17 l3,7 l-3,-2 l-3,2 Z" />
            </svg>
            <text x={8} y={14} fontWeight={500}>
              Top Hugin · light = shallow
            </text>
            <svg y="100%" overflow="visible">
              <rect ref={scaleBar} x={8} y={-9} height={2} />
              <text ref={scaleText} y={-5} className="font-mono" fontWeight={400}>
                1 km
              </text>
            </svg>
          </g>
        </svg>
        {shown && <DepthGauge app={app} layout={gauge} value={box.stripTo} onChange={(v) => edit({ stripTo: v })} />}
      </div>
      <p className="font-mono text-[0.75rem] text-muted-foreground tabular-nums">
        W {km(box.xMin)} · E {km(box.xMax)} · S {km(box.nMin)} · N {km(box.nMax)} km · strip {fmt.n(box.stripTo, 0)} m
      </p>
    </div>
  );
}

/** Depth to the top of the reservoir as shaded relief: deep is dark, the crest is light. In world coordinates, so it renders once. */
const Relief = memo(function Relief({ app }: { app: App }) {
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
  // cells overlap by a tenth so no seams show between them at any scale
  return (
    <g className="pointer-events-none" opacity={0.75}>
      {cells.map((c) => (Number.isFinite(c.t) ? <rect key={`${c.i}:${c.j}`} x={fb.xMin + c.i * c.cw} y={fb.nMin + c.j * c.ch} width={c.cw * 1.1} height={c.ch * 1.1} fill={shade(c.t)} /> : null))}
    </g>
  );
});

/** Every other wellbore of the field, in world coordinates. */
const Wells = memo(function Wells({ app }: { app: App }) {
  useRev(app.wellRev);
  const well = app.engine.activeWell;
  return (
    <>
      {app.field.wells
        .filter((w) => w !== well)
        .map((w) => (
          <polyline key={w.id} points={worldLine(w.trajectory)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-muted-foreground/45" />
        ))}
    </>
  );
});

const ActiveWell = memo(function ActiveWell({ app }: { app: App }) {
  useRev(app.wellRev);
  return <polyline points={worldLine(app.engine.activeWell.trajectory)} fill="none" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" className="stroke-primary" />;
});

function worldLine(t: { ew: Float64Array; ns: Float64Array }) {
  const pts: string[] = [];
  for (let i = 0; i < t.ew.length; i += 4) pts.push(`${t.ew[i].toFixed(1)},${t.ns[i].toFixed(1)}`);
  return pts.join(' ');
}

/** Lays the gauge out for a height and a strip depth. */
type GaugeLayout = (height: number, value: number) => void;

/**
 * The formation column of the active well by TVDSS, with the overburden cut
 * as a handle: everything above it is stripped from the 3D model.
 */
function DepthGauge({ app, layout, value, onChange }: { app: App; layout: RefObject<GaugeLayout | null>; value: number; onChange: (v: number) => void }) {
  const w = app.engine.activeWell;
  const datum = app.field.meta.datumElevation;
  const top = 4;
  const bx = 12;
  const bw = 14;
  const tvdss = (md: number) => Math.max(0, Math.min(STRIP_MAX, w.trajectory.at(Math.min(md, w.trajectory.mdEnd)).tvd - datum));
  const svg = useRef<SVGSVGElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const column = useRef<SVGSVGElement>(null);
  const hatch = useRef<SVGRectElement>(null);
  const ticks = useRef<SVGGElement>(null);
  const handle = useRef<SVGGElement>(null);
  const H = useRef(0);
  // its height follows the plan's, set by the plan's layout rather than by rendering
  useLayoutEffect(() => {
    layout.current = (h, v) => {
      H.current = h;
      const span = Math.max(0, h - 2 * top);
      const y = (d: number) => (top + (Math.max(0, Math.min(STRIP_MAX, d)) / STRIP_MAX) * span).toFixed(1);
      svg.current?.setAttribute('height', String(h));
      clip.current?.setAttribute('height', String(span));
      column.current?.setAttribute('height', String(span));
      hatch.current?.setAttribute('height', (+y(v) - top).toFixed(1));
      handle.current?.setAttribute('transform', `translate(0,${y(v)})`);
      ticks.current?.childNodes.forEach((t, i) => (t as SVGGElement).setAttribute('transform', `translate(0,${y(i * 1000)})`));
    };
    return () => {
      layout.current = null;
    };
  }, [layout]);
  const toV = (sy: number) => Math.round((Math.max(0, Math.min(1, (sy - top) / Math.max(1, H.current - 2 * top))) * STRIP_MAX) / 10) * 10;
  const dragging = useRef(false);
  const set = (ev: ReactPointerEvent<SVGSVGElement>) => onChange(toV(ev.clientY - ev.currentTarget.getBoundingClientRect().top));
  return (
    <svg
      ref={svg}
      width={GAUGE_W}
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
          <rect ref={clip} x={bx} y={top} width={bw} rx={3} />
        </clipPath>
        <pattern id="sb-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} className="fill-background/70" />
          <line x1={0} y1={0} x2={0} y2={4} strokeWidth={1.5} className="stroke-foreground/25" />
        </pattern>
      </defs>
      <g clipPath="url(#sb-col)">
        {/* the column in metres TVDSS, stretched to the gauge's height */}
        <svg ref={column} x={bx} y={top} width={bw} viewBox={`0 0 ${bw} ${STRIP_MAX}`} preserveAspectRatio="none">
          <rect width={bw} height={STRIP_MAX} className="fill-muted" />
          {w.zones
            .filter((z) => z.formationId !== 'air')
            .map((z) => {
              const y0 = tvdss(z.topMD);
              const y1 = tvdss(z.baseMD);
              return (
                <rect
                  key={`${z.formationId}:${z.topMD}`}
                  width={bw}
                  y={Math.min(y0, y1)}
                  height={Math.max(8, Math.abs(y1 - y0))}
                  fill={z.formationId === 'sea' ? '#1d4e6b' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555')}
                />
              );
            })}
        </svg>
        <rect ref={hatch} x={bx} y={top} width={bw} fill="url(#sb-hatch)" />
      </g>
      <g ref={ticks} className="fill-muted-foreground font-mono" fontSize="0.68rem">
        {[0, 1000, 2000, 3000].map((d) => (
          <g key={d}>
            <rect x={bx + bw + 1} y={-0.5} width={3} height={1} />
            <text x={bx + bw + 6} y={3}>
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
        className="outline-none [&:focus-visible_path]:stroke-ring"
      >
        <g ref={handle}>
          <line x1={bx - 3} x2={bx + bw + 3} y1={0} y2={0} strokeWidth={2} className="stroke-foreground" />
          <path d={`M${bx - 10},-5 L${bx - 3},0 L${bx - 10},5 Z`} strokeWidth={1.5} className="fill-foreground stroke-transparent" />
        </g>
      </g>
    </svg>
  );
}
