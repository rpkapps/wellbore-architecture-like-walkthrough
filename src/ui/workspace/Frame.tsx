import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@tecton/react/components/dropdown-menu';
import {
  ChevronsLeftRightIcon,
  EllipsisIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomCloseIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { Activity, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, ViewTransition, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { IconButton } from '../icon-button';
import { animate, useAnimatedSignal, withTransition } from '../transition';
import { SURFACE } from '../shell/overlay';
import { SIZE_LIMITS, ZONES, type Column, type DropTarget, type FloatWin, type Layout, type Stack, type Workspace, type Zone } from './layout';
import { atDefault, closePanel, isOpen, maximised, openIn, place, toggleMaximised } from './ops';
import { RAIL_ENTRIES, viewGroups, type PanelDef } from './panels';
import { Rail } from './Rail';

/** gap between the panels and the window edges (px) */
const G = 6;
/** a folded column: its icon strip */
const STRIP = 34;
/** the panel rail along the left edge */
export const RAIL = 58;
const MIN_STACK = 72;
/** narrower than this each, the tabs behind the active one drop their labels */
const MIN_TAB = 72;
/** how much of the 3D view a column drag always leaves visible (px) */
const MIN_VIEW = 160;

export interface Free {
  left: number;
  right: number;
  bottom: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Geometry {
  W: number;
  H: number;
  /** where the dock area starts on the left: the rail's right edge (0 without a rail) */
  x0: number;
  rail: Rect | null;
  cols: Record<Zone, Rect | null>;
  /** a maximised group fills this: the stage less the rail and the timeline */
  full: Rect;
  free: Free;
}

/** A panel of a folded column shown beside its strip (or beside the rail, for the left column). */
export interface Flyout {
  zone: Zone;
  stack: string;
  panel: string;
}

/** The rail beside the dock columns; the frame supplies its panel entries, the app its other ones. */
export interface RailSlots {
  /** entries after Views (Data) */
  extra?: ReactNode;
  /** entries at the bottom (settings, help) */
  footer?: ReactNode;
}

/** stage-relative rectangles of the drop targets, filled in by the groups as they render */
interface Registered {
  el: HTMLElement;
  strip: HTMLElement | null;
  zone: Zone | null;
}

type Indicator = (Rect & { line?: boolean }) | null;

/**
 * The workspace: the 3D view fills the stage and never changes size; the dock
 * columns, their groups of tabbed panels and the floating windows lie over it.
 * Tabs drag between groups, into a new group above or below another, to an
 * empty edge of the window, or out onto the view to float. Column edges and
 * the splits between groups drag to resize; a column folds to a strip of
 * icons that open its panels as flyouts.
 */
export function WorkspaceFrame({
  ws,
  panels,
  viewport,
  overlay,
  timeline,
  timelineHeight,
  chromeless,
  rail: slots,
  onFree,
}: {
  ws: Workspace;
  /** loading or presenting: no panels */
  chromeless?: boolean;
  panels: Map<string, PanelDef>;
  viewport: ReactNode;
  /** the widgets over the 3D view, laid out inside the area the panels leave free */
  overlay: ReactNode;
  timeline: ReactNode;
  timelineHeight: number;
  /** the panel rail along the left edge (hidden with the chrome, kept when Tab hides the panels) */
  rail?: RailSlots;
  onFree: (f: Free) => void;
}) {
  // layout changes made in `withTransition` render as a Transition, so the
  // <ViewTransition> around each group animates them
  const L = useAnimatedSignal(ws.layout);
  const hidden = useAnimatedSignal(ws.hidden) || !!chromeless;
  const railOn = !!slots && !chromeless;
  const maxId = useAnimatedSignal(maximised);
  // one panel of a folded column shown as a flyout (the rail and the strips open it)
  const [flyState, setFlyout] = useState<Flyout | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const freeEl = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const registry = useRef(new Map<string, Registered>());
  const ghost = useRef<Ghost | null>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }));
    ro.observe(el);
    setSize({ W: el.clientWidth, H: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => geometry(L, size.W, size.H, hidden ? 0 : timelineHeight, hidden, railOn, {}), [L, size, hidden, timelineHeight, railOn]);
  // the maximised group, while it exists and the panels show
  const max = !hidden && maxId && [...ZONES.flatMap((z) => L[z].stacks), ...L.floating].some((g) => g.id === maxId) ? maxId : null;
  useEffect(() => {
    if (maxId && !max) maximised.set(null);
  }, [maxId, max]);
  // the flyout, while its column is folded and still holds its panel
  const flyout = flyState && !hidden && L[flyState.zone].collapsed && L[flyState.zone].stacks.some((s) => s.id === flyState.stack && s.panels.includes(flyState.panel)) ? flyState : null;
  useEffect(() => {
    if (flyState && !flyout) setFlyout(null);
  }, [flyState, flyout]);
  // Escape restores a maximised group (unless a menu, dialog or field has it)
  useEffect(() => {
    if (!max) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="menu"], [role="dialog"], [role="listbox"], input, textarea, select')) return;
      withTransition(() => maximised.set(null));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [max]);
  useEffect(() => onFree(geo.free), [geo.free.left, geo.free.right, geo.free.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tab (with nothing focused, as in Illustrator) hides and shows every panel
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = document.activeElement;
      if (a && a !== document.body && a.tagName !== 'CANVAS') return;
      e.preventDefault();
      withTransition(() => ws.hidden.set(!ws.hidden.value));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ws]);

  const dnd = useMemo(() => createDnd(ws, stage, registry, ghost, () => geoRef.current), [ws]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  // a column edge being dragged: the columns, their edges and the free area
  // follow the pointer by writing styles directly (no React render per move);
  // the layout, and the 3D view's centring, are updated when the drag ends.
  // The elements are looked up once per drag and only changed values are written.
  const beginLive = (zone: Zone) => {
    const st = stage.current;
    const els = (['left', 'right', 'bottom'] as Zone[]).map((z) => ({
      z,
      box: st?.querySelector<HTMLElement>(`[data-col="${z}"]`) ?? null,
      edge: st?.querySelector<HTMLElement>(`[data-edge="${z}"]`) ?? null,
    }));
    const free = freeEl.current;
    return (v: number) => {
      const g = geometry(L, size.W, size.H, hidden ? 0 : timelineHeight, hidden, railOn, { [zone]: v });
      for (const { z, box, edge } of els) {
        const r = g.cols[z];
        if (!r) continue;
        if (box) setStyle(box, px(r));
        if (edge) setStyle(edge, px(edgeRect(z, r)));
      }
      if (free) setStyle(free, { left: `${g.free.left}px`, right: `${g.free.right}px`, bottom: `${g.free.bottom}px` });
    };
  };

  // (no inherited custom properties on the stage: changing one restyles every element in it)
  return (
    <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
      <div className="absolute inset-0">{viewport}</div>
      {/* the area the panels leave free: overlays are laid out in it */}
      <div ref={freeEl} className="pointer-events-none absolute @container [contain:size_layout_style]" style={{ left: geo.free.left, right: geo.free.right, top: 0, bottom: geo.free.bottom }}>
        {overlay}
      </div>
      {!hidden && (
        <>
          {(['left', 'right', 'bottom'] as Zone[]).map((z) => {
            // a folded left column has no strip of its own: its panels are on the rail, and its flyouts open beside it
            const merged = z === 'left' && !!geo.rail && L.left.collapsed && L.left.stacks.length > 0;
            const r = merged ? geo.rail : geo.cols[z];
            if (!r) return null;
            return (
              <DockColumn
                key={z}
                ws={ws}
                zone={z}
                col={L[z]}
                rect={r}
                strip={!merged}
                max={maxSize(geo, z)}
                full={geo.full}
                maximised={max}
                flyout={flyout?.zone === z ? flyout : null}
                setFlyout={setFlyout}
                panels={panels}
                dnd={dnd}
                registry={registry.current}
                onLive={() => beginLive(z)}
              />
            );
          })}
          {/* in a fixed order, stacked by z-index: raising a window must not move its
              element in the document, which would drop the pointer capture of its drag */}
          <div className="pointer-events-none absolute inset-0 z-20">
            {[...L.floating]
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map((f) => (
                <FloatWindow
                  key={f.id}
                  ws={ws}
                  win={f}
                  z={L.floating.indexOf(f) + 1}
                  panels={panels}
                  dnd={dnd}
                  registry={registry.current}
                  bounds={size}
                  minX={geo.x0 + G}
                  full={geo.full}
                  maximised={max}
                  others={L.floating.filter((o) => o !== f)}
                />
              ))}
          </div>
        </>
      )}
      {railOn && geo.rail && (
        <Rail ws={ws} panels={panels} x={geo.rail.x} y={geo.rail.y} w={geo.rail.w} h={geo.rail.h} flyout={flyout} setFlyout={setFlyout} extra={slots?.extra} footer={slots?.footer} />
      )}
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <ViewTransition default="none" enter="ws-enter" exit="ws-exit">
          <div className="absolute" style={{ left: G, right: G, bottom: G, height: timelineHeight }}>
            {timeline}
          </div>
        </ViewTransition>
      </Activity>
      <DragLayer api={ghost} />
    </div>
  );
}

const px = (r: Rect) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

/** Write only the inline styles that change (a drag writes every frame). */
function setStyle(el: HTMLElement, s: Record<string, string>) {
  const st = el.style as unknown as Record<string, string>;
  for (const k in s) if (st[k] !== s[k]) st[k] = s[k];
}

/**
 * Follow one pointer from its pointerdown on `e.currentTarget` until it is
 * released. The pointer is captured, so while it moves nothing else sees it:
 * no hover styles or tooltips change, the 3D view does not pick under it and
 * no text selection starts.
 */
function follow(e: ReactPointerEvent<HTMLElement>, move: (ev: PointerEvent) => void, end: (released: boolean) => void) {
  const el = e.currentTarget;
  const id = e.pointerId;
  el.setPointerCapture(id);
  const onMove = (ev: PointerEvent) => ev.pointerId === id && move(ev);
  const done = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', done);
    el.removeEventListener('pointercancel', done);
    el.removeEventListener('lostpointercapture', done);
    end(ev.type === 'pointerup');
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', done);
  el.addEventListener('lostpointercapture', done);
}

/** the strip along a column's inner edge that resizes it */
function edgeRect(zone: Zone, r: Rect): Rect {
  return zone === 'left' ? { x: r.x + r.w, y: r.y, w: G, h: r.h } : zone === 'right' ? { x: r.x - G, y: r.y, w: G, h: r.h } : { x: r.x, y: r.y - G, w: r.w, h: G };
}

/** A column can grow until only MIN_VIEW of the 3D view is left beside (or above) it. */
function maxSize(g: Geometry, z: Zone): number {
  const { left, right } = g.cols;
  if (z === 'left') return g.W - 2 * G - g.x0 - (right ? right.w + G : 0) - MIN_VIEW;
  if (z === 'right') return g.W - 2 * G - g.x0 - (left ? left.w + G : 0) - MIN_VIEW;
  const colH = left?.h ?? right?.h ?? g.H - 2 * G;
  return colH - MIN_VIEW / 2;
}

function geometry(L: Layout, W: number, H: number, tl: number, hidden: boolean, rail: boolean, live: Partial<Record<Zone, number>>): Geometry {
  const ext = (z: Zone) => {
    const c = L[z];
    if (hidden || !c.stacks.length) return 0;
    // the rail stands in for the left column's strip
    if (c.collapsed && z === 'left' && rail) return 0;
    return c.collapsed ? STRIP : (live[z] ?? c.size);
  };
  // the rail takes the far left; the dock columns start after it
  const x0 = rail ? G + RAIL : 0;
  const lw = ext('left');
  const rw = ext('right');
  const bh = ext('bottom');
  const bottomLimit = H - (tl ? tl + 2 * G : G);
  const colH = Math.max(0, bottomLimit - G);
  const cols: Record<Zone, Rect | null> = {
    left: lw ? { x: x0 + G, y: G, w: lw, h: colH } : null,
    right: rw ? { x: W - G - rw, y: G, w: rw, h: colH } : null,
    bottom: null,
  };
  if (bh) {
    const x = x0 + G + (lw ? lw + G : 0);
    const w = W - x - G - (rw ? rw + G : 0);
    cols.bottom = { x, y: bottomLimit - bh, w: Math.max(0, w), h: bh };
  }
  return {
    W,
    H,
    x0,
    rail: rail ? { x: G, y: G, w: RAIL, h: colH } : null,
    cols,
    full: { x: x0 + G, y: G, w: Math.max(0, W - x0 - 2 * G), h: colH },
    free: {
      left: x0 + (lw ? G + lw : 0),
      right: rw ? G + rw : 0,
      bottom: H - (cols.bottom ? cols.bottom.y - G : bottomLimit),
    },
  };
}

// ---------------------------------------------------------------- dock columns

function DockColumn({
  ws,
  zone,
  col,
  rect,
  strip,
  max,
  full,
  maximised,
  flyout,
  setFlyout,
  panels,
  dnd,
  registry,
  onLive,
}: {
  ws: Workspace;
  zone: Zone;
  col: Column;
  /** the column; for a folded left column merged into the rail, the rail (its flyouts open beside it) */
  rect: Rect;
  /** draw the folded column's strip (not when the rail stands in for it) */
  strip: boolean;
  max: number;
  /** the rectangle a maximised group fills */
  full: Rect;
  /** the maximised group, if any (this column's or another's) */
  maximised: string | null;
  flyout: Flyout | null;
  setFlyout: (f: Flyout | null) => void;
  panels: Map<string, PanelDef>;
  dnd: Dnd;
  registry: Map<string, Registered>;
  /** starts a live resize: the returned function moves the edge */
  onLive: () => (v: number) => void;
}) {
  const horizontal = zone === 'bottom';
  const box = useRef<HTMLDivElement>(null);
  // a maximised group of this column: the column box fills the stage and shows only that group
  const maxHere = !!maximised && col.stacks.some((s) => s.id === maximised);
  if (col.collapsed && !maxHere)
    return (
      <ViewTransition key="strip" default="none" enter="ws-enter" exit="ws-exit">
        <IconStrip ws={ws} zone={zone} col={col} rect={rect} strip={strip} panels={panels} flyout={flyout} setFlyout={setFlyout} dnd={dnd} registry={registry} />
      </ViewTransition>
    );
  const at = maxHere ? full : rect;
  // another group is maximised: this column stays mounted (its panels keep their state) but is not shown
  const away = !!maximised && !maxHere;

  // the splits between groups: the two groups follow the drag directly, the
  // weights are written when it ends
  const splitDown = (i: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const kids = box.current?.querySelectorAll<HTMLElement>(':scope > [data-stack]');
    if (e.button !== 0 || !kids || !kids[i] || !kids[i + 1]) return;
    e.preventDefault();
    const ka = kids[i];
    const kb = kids[i + 1];
    const a = horizontal ? ka.offsetWidth : ka.offsetHeight;
    const b = horizontal ? kb.offsetWidth : kb.offsetHeight;
    const wSum = col.stacks[i].weight + col.stacks[i + 1].weight;
    const start = horizontal ? e.clientX : e.clientY;
    let weights: [number, number] | null = null;
    follow(
      e,
      (ev) => {
        const d = (horizontal ? ev.clientX : ev.clientY) - start;
        const na = Math.max(MIN_STACK, Math.min(a + b - MIN_STACK, a + d));
        weights = [(na / (a + b)) * wSum, ((a + b - na) / (a + b)) * wSum];
        ka.style.flex = `${weights[0]} 1 0`;
        kb.style.flex = `${weights[1]} 1 0`;
      },
      () => weights && ws.resizeSplit(zone, i, weights),
    );
  };

  return (
    <ViewTransition key="column" default="none" enter="ws-enter" exit="ws-exit">
      {/* sized from outside: contained, so what changes inside a group lays out only that group */}
      <div
        ref={box}
        data-col={maxHere ? undefined : zone}
        className={`absolute flex [contain:size_layout_style] ${horizontal ? 'flex-row' : 'flex-col'} ${away ? 'invisible' : ''} ${maxHere ? 'z-30' : ''}`}
        style={{ left: at.x, top: at.y, width: at.w, height: at.h, gap: G }}
      >
        {col.stacks.map((s, i) => (
          <div key={s.id} data-stack className={`relative flex min-h-0 min-w-0 [contain:size_layout_style] ${maxHere && s.id !== maximised ? 'hidden' : ''}`} style={{ flex: `${s.weight} 1 0` }}>
            <ViewTransition default="none" enter="ws-enter" exit="ws-exit" update="ws-morph">
              <StackView ws={ws} group={s} zone={zone} panels={panels} dnd={dnd} registry={registry} maxed={s.id === maximised} />
            </ViewTransition>
            {i < col.stacks.length - 1 && !maxHere && (
              <div
                aria-hidden
                onPointerDown={splitDown(i)}
                className={`absolute z-10 touch-none ${horizontal ? 'top-0 -right-[6px] h-full w-[6px] cursor-col-resize' : '-bottom-[6px] left-0 h-[6px] w-full cursor-row-resize'} group/split`}
              >
                <div
                  className={`absolute rounded-full bg-ui-accent opacity-0 transition-opacity group-hover/split:opacity-60 ${horizontal ? 'inset-y-6 left-[2px] w-0.5' : 'inset-x-6 top-[2px] h-0.5'}`}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {!maximised && <EdgeHandle zone={zone} rect={rect} size={col.size} max={max} onLive={onLive} onCommit={(v) => ws.setSize(zone, v)} />}
    </ViewTransition>
  );
}

/** The column's inner edge: drag to resize the column (the 3D view keeps its size). */
function EdgeHandle({ zone, rect, size, max, onLive, onCommit }: { zone: Zone; rect: Rect; size: number; max: number; onLive: () => (v: number) => void; onCommit: (v: number) => void }) {
  const style: CSSProperties = { ...px(edgeRect(zone, rect)), cursor: zone === 'bottom' ? 'row-resize' : 'col-resize' };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const lo = SIZE_LIMITS[zone][0];
    const hi = Math.max(lo, max);
    const live = onLive();
    let v = size;
    follow(
      e,
      (ev) => {
        const d = zone === 'left' ? ev.clientX - x0 : zone === 'right' ? x0 - ev.clientX : y0 - ev.clientY;
        const next = Math.round(Math.max(lo, Math.min(hi, size + d)));
        if (next === v) return;
        v = next;
        live(v);
      },
      () => v !== size && onCommit(v),
    );
  };
  return (
    <div aria-hidden data-edge={zone} onPointerDown={down} className="group/edge absolute z-10 touch-none" style={style}>
      <div
        className={`absolute rounded-full bg-ui-accent opacity-0 transition-opacity group-hover/edge:opacity-70 ${zone === 'bottom' ? 'inset-x-8 top-[2px] h-0.5' : 'inset-y-8 left-[2px] w-0.5'}`}
      />
    </div>
  );
}

/**
 * A folded column: one icon per panel; each opens its group as a flyout beside
 * the strip. The left column has no strip when the rail stands in for it: the
 * rail's entries open its flyouts, beside the rail.
 */
function IconStrip({
  ws,
  zone,
  col,
  rect,
  strip = true,
  panels,
  flyout,
  setFlyout,
  dnd,
  registry,
}: {
  ws: Workspace;
  zone: Zone;
  col: Column;
  rect: Rect;
  strip?: boolean;
  panels: Map<string, PanelDef>;
  flyout: Flyout | null;
  setFlyout: (f: Flyout | null) => void;
  dnd: Dnd;
  registry: Map<string, Registered>;
}) {
  const horizontal = zone === 'bottom';
  const fly = flyout && col.stacks.find((s) => s.id === flyout.stack);
  const flyRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flyout) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (flyRef.current?.contains(t) || stripRef.current?.contains(t)) return;
      // menus and popovers opened from the flyout live in a portal; the rail's panel entries toggle the flyout themselves
      if ((t as HTMLElement).closest?.('[data-slot$="-content"], [role="menu"], [role="dialog"], [role="listbox"], [data-rail-panel]')) return;
      animate(() => setFlyout(null));
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && animate(() => setFlyout(null));
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [flyout, setFlyout]);
  const flyRect: Rect = horizontal
    ? { x: rect.x, y: rect.y - G - col.size, w: rect.w, h: col.size }
    : zone === 'left'
      ? { x: rect.x + rect.w + G, y: rect.y, w: col.size, h: rect.h }
      : { x: rect.x - G - col.size, y: rect.y, w: col.size, h: rect.h };
  return (
    <>
      {strip && (
        <div
          ref={stripRef}
          role="toolbar"
          aria-label={`${zone} panels (folded)`}
          aria-orientation={horizontal ? 'horizontal' : 'vertical'}
          className={`absolute flex items-center gap-0.5 p-0.5 ${SURFACE} ${horizontal ? 'flex-row' : 'flex-col'}`}
          style={{ left: rect.x, top: rect.y, width: horizontal ? rect.w : STRIP, height: horizontal ? STRIP : rect.h }}
        >
          <IconButton
            label="Expand the column"
            size="icon-sm"
            placement={zone === 'left' ? 'right' : zone === 'right' ? 'left' : 'top'}
            onPress={() => withTransition(() => ws.setCollapsed(zone, false))}
          >
            <ChevronsLeftRightIcon className={horizontal ? 'rotate-90' : undefined} />
          </IconButton>
          {col.stacks.map((s, i) => (
            <div key={s.id} className={`flex items-center gap-0.5 ${horizontal ? 'flex-row' : 'flex-col'}`}>
              <div aria-hidden className={horizontal ? 'mx-0.5 h-4 w-px bg-border-subtle' : 'my-0.5 h-px w-4 bg-border-subtle'} />
              {s.panels.map((p) => {
                const d = panels.get(p);
                if (!d) return null;
                const on = flyout?.panel === p;
                return (
                  <IconButton
                    key={p}
                    label={d.title}
                    size="icon-sm"
                    variant={on ? 'secondary' : 'ghost'}
                    placement={zone === 'left' ? 'right' : zone === 'right' ? 'left' : 'top'}
                    onPress={() => animate(() => setFlyout(on ? null : { zone, stack: s.id, panel: p }))}
                    aria-pressed={on}
                    data-index={i}
                  >
                    {d.icon}
                  </IconButton>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {fly && flyout && (
        <ViewTransition default="none" enter="ws-enter" exit="ws-exit">
          <div ref={flyRef} className="absolute z-20 flex" style={{ left: flyRect.x, top: flyRect.y, width: flyRect.w, height: flyRect.h }}>
            <StackView ws={ws} group={fly} zone={zone} panels={panels} dnd={dnd} registry={registry} active={flyout.panel} onActivate={(p) => setFlyout({ zone, stack: fly.id, panel: p })} />
          </div>
        </ViewTransition>
      )}
    </>
  );
}

// ---------------------------------------------------------------- groups of tabbed panels

function StackView({
  ws,
  group,
  zone,
  panels,
  dnd,
  registry,
  active: activeOverride,
  onActivate,
  onHeaderDown,
  maxed = false,
}: {
  ws: Workspace;
  group: Stack | FloatWin;
  zone: Zone | null;
  panels: Map<string, PanelDef>;
  dnd: Dnd;
  registry: Map<string, Registered>;
  /** a flyout shows its own tab without changing the layout */
  active?: string;
  onActivate?: (id: string) => void;
  /** a floating window moves by its header */
  onHeaderDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** this group is maximised */
  maxed?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!el.current) return;
    registry.set(group.id, { el: el.current, strip: strip.current, zone });
    return () => {
      registry.delete(group.id);
    };
  }, [registry, group.id, zone]);
  const active = activeOverride ?? group.active;
  useCompactTabs(strip, group.panels.length, active);
  const def = panels.get(active);
  const seen = useRef(new Set<string>());
  seen.current.add(active);
  const activate = onActivate ?? ((id: string) => ws.activate(id));
  const close = (id: string) => {
    const d = panels.get(id);
    if (d) closePanel(ws, d);
    else ws.close(id);
  };
  const toggleMax = () => withTransition(() => toggleMaximised(group.id));
  return (
    <section
      ref={el}
      aria-label={def?.title}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${SURFACE}`}
      onKeyDown={(e) => {
        // Ctrl Space (focus in the panel) maximises the group, as in Blender
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Space') {
          e.preventDefault();
          toggleMax();
        }
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle pr-1 pl-1" onPointerDown={onHeaderDown}>
        <div ref={strip} role="tablist" aria-label="Panels" className="group/tabs flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          {group.panels.map((id) => {
            const d = panels.get(id);
            if (!d) return null;
            const on = id === active;
            return (
              <div
                key={id}
                role="tab"
                tabIndex={on ? 0 : -1}
                data-tab={id}
                aria-selected={on}
                title={d.title}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dnd.start(e, id, d.title, () => activate(id));
                }}
                onDoubleClick={toggleMax}
                onKeyDown={(e) => {
                  if (e.ctrlKey) return;
                  if (e.key === 'Enter' || e.key === ' ') activate(id);
                  if (e.key === 'Delete') close(id);
                }}
                // the tabs behind give up their room first; their close button shows over the label on hover
                className={`group/tab relative flex h-6 max-w-44 min-w-0 cursor-default items-center gap-1.5 rounded-md pl-2 text-xs font-medium whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0 ${
                  on ? 'shrink-0 bg-ghost-active pr-1 text-fg-1' : 'shrink pr-2 text-fg-2 hover:bg-ghost-hover hover:text-fg-1 group-data-compact/tabs:pr-1.5'
                }`}
              >
                {d.icon}
                {/* every tab is labelled; only when the header runs out of room do the tabs behind show just their icon */}
                <span className={on ? 'truncate' : 'truncate group-data-compact/tabs:hidden'}>{d.title}</span>
                <button
                  type="button"
                  aria-label={`Close ${d.title}`}
                  title={`Close ${d.title}`}
                  tabIndex={-1}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => close(id)}
                  className={`size-4 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:text-fg-1 [&_svg]:size-3! ${on ? 'flex hover:bg-foreground/10' : 'absolute right-1 hidden bg-panel group-hover/tab:flex'}`}
                >
                  <XIcon />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          {def?.actions?.()}
          {maxed && (
            <IconButton label="Restore (Esc)" size="icon-xs" onPress={toggleMax}>
              <Minimize2Icon />
            </IconButton>
          )}
          <AddView ws={ws} group={group.id} panels={panels} />
          {def && <PanelMenu ws={ws} def={def} zone={zone} maxed={maxed} onMaximise={toggleMax} />}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {group.panels.map((id) => {
          const d = panels.get(id);
          // a panel is built the first time its tab shows; after that it keeps its state while hidden
          if (!d || !seen.current.has(id)) return null;
          return (
            <Activity key={id} mode={id === active ? 'visible' : 'hidden'}>
              <div className="flex min-h-0 flex-1 flex-col">
                <PanelBody def={d} />
              </div>
            </Activity>
          );
        })}
      </div>
    </section>
  );
}

/** A panel's content renders only when the panel itself changes, not when its group moves or resizes. */
const PanelBody = memo(function PanelBody({ def }: { def: PanelDef }) {
  return def.body();
});

/**
 * Every tab keeps its label: the active one in full, the ones behind it
 * truncated, until they would be too narrow to read; then those show just
 * their icon. The tab strip is observed and marked with `data-compact`
 * directly (no React render while a column is dragged wider).
 */
function useCompactTabs(strip: { current: HTMLDivElement | null }, count: number, active: string) {
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const fit = (w: number) => {
      // (read after layout, in the observer's callback: no extra layout pass)
      const on = el.querySelector<HTMLElement>('[aria-selected="true"]')?.offsetWidth ?? 0;
      const compact = count > 1 && w - on < (count - 1) * MIN_TAB;
      if (compact !== el.hasAttribute('data-compact')) el.toggleAttribute('data-compact', compact);
    };
    fit(el.clientWidth);
    const ro = new ResizeObserver((es) => fit(es[es.length - 1].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [strip, count, active]);
}

/** A group's "+" menu: the panels that are not open; the one chosen opens as a tab of this group. */
function AddView({ ws, group, panels }: { ws: Workspace; group: string; panels: Map<string, PanelDef> }) {
  return (
    <DropdownMenuTrigger>
      <IconButton label="Add a view here" size="icon-xs">
        <PlusIcon />
      </IconButton>
      <DropdownMenu
        placement="bottom end"
        className="w-max min-w-52"
        onAction={(k) => {
          const d = panels.get(String(k));
          if (d) withTransition(() => openIn(ws, d, group));
        }}
      >
        <AddViewItems ws={ws} panels={panels} />
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

/** The closed panels by kind (read as the menu opens). */
function AddViewItems({ ws, panels }: { ws: Workspace; panels: Map<string, PanelDef> }) {
  const closed = (d: PanelDef) => !isOpen(ws, d);
  const own = RAIL_ENTRIES.map((e) => panels.get(e.id)).filter((d): d is PanelDef => !!d && closed(d));
  const views = viewGroups(panels)
    .map((g) => ({ ...g, panels: g.panels.filter(closed) }))
    .filter((g) => g.panels.length);
  if (!own.length && !views.length)
    return (
      <DropdownMenuItem id="none" isDisabled>
        Every panel is open
      </DropdownMenuItem>
    );
  const item = (d: PanelDef) => (
    <DropdownMenuItem key={d.id} id={d.id} textValue={d.title}>
      {d.icon}
      {d.title}
    </DropdownMenuItem>
  );
  return (
    <>
      {own.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Panels</DropdownMenuLabel>
          {own.map(item)}
        </DropdownMenuGroup>
      )}
      {views.map((g) => (
        <DropdownMenuGroup key={g.phase}>
          <DropdownMenuLabel>{g.phase}</DropdownMenuLabel>
          {g.panels.map(item)}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

/** The group header's ⋯ menu for the panel showing in it: where it goes, maximise, fold and close. */
function PanelMenu({ ws, def, zone, maxed, onMaximise }: { ws: Workspace; def: PanelDef; zone: Zone | null; maxed: boolean; onMaximise: () => void }) {
  const act = (k: string) => {
    if (k === 'max') return onMaximise();
    withTransition(() => {
      if (k === 'float' || k === 'left' || k === 'right' || k === 'bottom' || k === 'default') place(ws, def, k);
      else if (k === 'fold' && zone) ws.setCollapsed(zone, true);
      else if (k === 'close') closePanel(ws, def);
    });
  };
  const FoldIcon = zone === 'right' ? PanelRightCloseIcon : zone === 'bottom' ? PanelBottomCloseIcon : PanelLeftCloseIcon;
  return (
    <DropdownMenuTrigger>
      <IconButton label="Panel options" size="icon-xs">
        <EllipsisIcon />
      </IconButton>
      <DropdownMenu placement="bottom end" className="w-max min-w-48" onAction={(k) => act(String(k))}>
        <DropdownMenuGroup>
          {zone !== 'left' && <DropdownMenuItem id="left">Move to left</DropdownMenuItem>}
          {zone !== 'right' && <DropdownMenuItem id="right">Move to right</DropdownMenuItem>}
          {zone !== 'bottom' && <DropdownMenuItem id="bottom">Move to bottom</DropdownMenuItem>}
          {zone !== null && <DropdownMenuItem id="float">Undock</DropdownMenuItem>}
          <DropdownMenuItem id="default" isDisabled={atDefault(ws, def.id)}>
            <RotateCcwIcon />
            Reset location
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem id="max">
          {maxed ? <Minimize2Icon /> : <Maximize2Icon />}
          {maxed ? 'Restore' : 'Maximise'}
          <DropdownMenuShortcut>{maxed ? 'Esc' : 'Ctrl Space'}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {zone && !maxed && (
          <DropdownMenuItem id="fold">
            <FoldIcon />
            Fold column to icons
          </DropdownMenuItem>
        )}
        <DropdownMenuItem id="close">
          <XIcon />
          Close
        </DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

// ---------------------------------------------------------------- floating windows

function FloatWindow({
  ws,
  win,
  z,
  panels,
  dnd,
  registry,
  bounds,
  minX,
  full,
  maximised,
  others,
}: {
  ws: Workspace;
  win: FloatWin;
  /** place in the stacking order, 1 at the back */
  z: number;
  panels: Map<string, PanelDef>;
  dnd: Dnd;
  registry: Map<string, Registered>;
  bounds: { W: number; H: number };
  /** windows stay clear of the rail */
  minX: number;
  /** the rectangle a maximised group fills */
  full: Rect;
  maximised: string | null;
  others: FloatWin[];
}) {
  // position and size follow the pointer by writing the window's style
  // directly in the event handler (pointer events already come once a frame,
  // so waiting for the next one would only add a frame of lag); the layout is
  // written on release
  const el = useRef<HTMLDivElement>(null);
  const rect = { x: win.x, y: win.y, w: win.w, h: win.h };
  const clampR = (q: Rect): Rect => {
    const w = Math.max(220, Math.min(bounds.W - G - minX, q.w));
    const h = Math.max(140, Math.min(bounds.H - 2 * G, q.h));
    return { x: Math.max(minX, Math.min(bounds.W - w - G, q.x)), y: Math.max(G, Math.min(bounds.H - h - G, q.y)), w, h };
  };
  const snap = (q: Rect): Rect => {
    const xs = [minX, bounds.W - G, ...others.flatMap((o) => [o.x, o.x + o.w, o.x - G, o.x + o.w + G])];
    const ys = [G, bounds.H - G, ...others.flatMap((o) => [o.y, o.y + o.h, o.y - G, o.y + o.h + G])];
    const near = (v: number, list: number[]) => list.find((t) => Math.abs(t - v) < 8);
    let { x, y } = q;
    const sx = near(x, xs) ?? (near(x + q.w, xs) !== undefined ? near(x + q.w, xs)! - q.w : undefined);
    const sy = near(y, ys) ?? (near(y + q.h, ys) !== undefined ? near(y + q.h, ys)! - q.h : undefined);
    if (sx !== undefined) x = sx;
    if (sy !== undefined) y = sy;
    return { ...q, x, y };
  };
  // (the window is raised by its own pointerdown capture handler)
  const track = (e: ReactPointerEvent<HTMLElement>, f: (dx: number, dy: number, r0: Rect) => Rect, moveOnly = false) => {
    e.preventDefault();
    const node = el.current;
    if (!node) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = { ...rect };
    let last = r0;
    // a move only translates the window on the compositor: no layout, no repaint
    if (moveOnly) node.style.willChange = 'transform';
    follow(
      e,
      (ev) => {
        last = clampR(f(ev.clientX - x0, ev.clientY - y0, r0));
        if (moveOnly) node.style.transform = `translate(${last.x - r0.x}px, ${last.y - r0.y}px)`;
        else setStyle(node, px(last));
      },
      () => {
        node.style.transform = '';
        node.style.willChange = '';
        setStyle(node, px(last));
        if (last.x !== r0.x || last.y !== r0.y || last.w !== r0.w || last.h !== r0.h) ws.setFloat(win.id, last);
      },
    );
  };
  const edges: [string, string, (dx: number, dy: number, r0: Rect) => Rect][] = [
    ['n', 'top-0 left-2 right-2 h-1.5 cursor-ns-resize', (_dx, dy, q) => ({ ...q, y: q.y + dy, h: q.h - dy })],
    ['s', 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize', (_dx, dy, q) => ({ ...q, h: q.h + dy })],
    ['w', 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize', (dx, _dy, q) => ({ ...q, x: q.x + dx, w: q.w - dx })],
    ['e', 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize', (dx, _dy, q) => ({ ...q, w: q.w + dx })],
    ['nw', 'top-0 left-0 size-3 cursor-nwse-resize', (dx, dy, q) => ({ x: q.x + dx, y: q.y + dy, w: q.w - dx, h: q.h - dy })],
    ['ne', 'top-0 right-0 size-3 cursor-nesw-resize', (dx, dy, q) => ({ ...q, y: q.y + dy, w: q.w + dx, h: q.h - dy })],
    ['sw', 'bottom-0 left-0 size-3 cursor-nesw-resize', (dx, dy, q) => ({ ...q, x: q.x + dx, w: q.w - dx, h: q.h + dy })],
    ['se', 'bottom-0 right-0 size-3 cursor-nwse-resize', (dx, dy, q) => ({ ...q, w: q.w + dx, h: q.h + dy })],
  ];
  // maximised, the window fills the stage (its own rectangle is kept for the restore); another group maximised hides it
  const maxed = maximised === win.id;
  const at = maxed ? full : rect;
  return (
    <ViewTransition default="none" enter="ws-enter" exit="ws-exit" update="ws-morph">
      <div
        ref={el}
        data-float={win.id}
        className={`pointer-events-auto absolute flex [contain:size_layout_style] ${maximised && !maxed ? 'invisible' : ''}`}
        style={{ left: at.x, top: at.y, width: at.w, height: at.h, zIndex: maxed ? 100 : z }}
        onPointerDownCapture={() => ws.raise(win.id)}
      >
        <StackView
          ws={ws}
          group={win}
          zone={null}
          panels={panels}
          dnd={dnd}
          registry={registry}
          maxed={maxed}
          onHeaderDown={(e) => {
            if (e.button === 0 && !maxed) track(e, (dx, dy, q) => snap({ ...q, x: q.x + dx, y: q.y + dy }), true);
          }}
        />
        {!maxed &&
          edges.map(([k, cls, f]) => <div key={k} aria-hidden className={`absolute touch-none ${cls}`} onPointerDown={(e) => e.button === 0 && track(e, f)} />)}
      </div>
    </ViewTransition>
  );
}

// ---------------------------------------------------------------- drag and drop of tabs

interface Dnd {
  start: (e: ReactPointerEvent<HTMLElement>, panel: string, title: string, onClick: () => void) => void;
}

/** The drop targets as laid out when a tab drag begins (nothing moves until the drop), in client px. */
interface Snapshot {
  stage: DOMRect;
  /** floating windows front to back, then the docked groups */
  groups: { id: string; zone: Zone | null; r: DOMRect; strip: DOMRect | null; tabs: DOMRect[] }[];
}

function snapshot(ws: Workspace, stage: HTMLElement, registry: Map<string, Registered>): Snapshot {
  const order = ws.value.floating.map((f) => f.id).reverse();
  const rank = (id: string, r: Registered) => (r.zone === null ? order.indexOf(id) : 1000);
  const groups = [...registry.entries()]
    .sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]))
    .map(([id, reg]) => ({
      id,
      zone: reg.zone,
      r: reg.el.getBoundingClientRect(),
      strip: reg.strip?.getBoundingClientRect() ?? null,
      tabs: [...(reg.strip?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])].map((t) => t.getBoundingClientRect()),
    }));
  return { stage: stage.getBoundingClientRect(), groups };
}

function createDnd(ws: Workspace, stage: { current: HTMLDivElement | null }, registry: { current: Map<string, Registered> }, ghost: { current: Ghost | null }, geo: () => Geometry): Dnd {
  const hit = (snap: Snapshot, cx: number, cy: number): { target: DropTarget | null; indicator: Indicator } => {
    const st = snap.stage;
    const x = cx - st.left;
    const y = cy - st.top;
    const rel = (r: DOMRect): Rect => ({ x: r.left - st.left, y: r.top - st.top, w: r.width, h: r.height });
    for (const { id, zone, r, strip: s, tabs } of snap.groups) {
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      if (s && cy <= s.bottom + 2) {
        let index = tabs.length;
        let lx = tabs.length ? tabs[tabs.length - 1].right + 1 : s.left + 4;
        for (let i = 0; i < tabs.length; i++) {
          const t = tabs[i];
          if (cx < t.left + t.width / 2) {
            index = i;
            lx = t.left - 1;
            break;
          }
        }
        return { target: { kind: 'tab', stack: id, index }, indicator: { x: lx - st.left - 1, y: s.top - st.top + 5, w: 2, h: s.height - 10, line: true } };
      }
      const R = rel(r);
      if (zone) {
        const horiz = zone === 'bottom';
        const f = horiz ? (cx - r.left) / r.width : (cy - r.top) / r.height;
        if (f < 0.3) return { target: { kind: 'split', zone, stack: id, where: 'before' }, indicator: horiz ? { ...R, w: R.w / 2 } : { ...R, h: R.h / 2 } };
        if (f > 0.7) return { target: { kind: 'split', zone, stack: id, where: 'after' }, indicator: horiz ? { ...R, x: R.x + R.w / 2, w: R.w / 2 } : { ...R, y: R.y + R.h / 2, h: R.h / 2 } };
      }
      return { target: { kind: 'tab', stack: id, index: 999 }, indicator: R };
    }
    const g = geo();
    const bottomLimit = g.cols.left ? g.cols.left.y + g.cols.left.h : g.H - G;
    const edge = 56;
    const L = ws.value;
    // (over the rail counts as the left edge)
    if (x < g.x0 + edge) return { target: { kind: 'zone', zone: 'left' }, indicator: { x: g.x0 + G, y: G, w: L.left.stacks.length ? 6 : L.left.size, h: bottomLimit - G } };
    if (x > g.W - edge)
      return { target: { kind: 'zone', zone: 'right' }, indicator: { x: g.W - G - (L.right.stacks.length ? 6 : L.right.size), y: G, w: L.right.stacks.length ? 6 : L.right.size, h: bottomLimit - G } };
    if (y > g.H - g.free.bottom - edge && y < bottomLimit + G) {
      const bx = g.free.left + G;
      const bw = g.W - g.free.right - G - bx;
      return { target: { kind: 'zone', zone: 'bottom' }, indicator: { x: bx, y: bottomLimit - (L.bottom.stacks.length ? 6 : L.bottom.size), w: bw, h: L.bottom.stacks.length ? 6 : L.bottom.size } };
    }
    const w = 380;
    const h = 320;
    const fx = Math.max(g.x0 + G, Math.min(g.W - w - G, x - 60));
    const fy = Math.max(G, Math.min(g.H - h - G, y - 14));
    return { target: { kind: 'float', x: fx, y: fy, w, h }, indicator: { x: fx, y: fy, w, h } };
  };

  return {
    start(e, panel, title, onClick) {
      if (e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      // measured once, when the tab starts to move
      let snap: Snapshot | null = null;
      let target: DropTarget | null = null;
      let done = false;
      const key = (ev: KeyboardEvent) => ev.key === 'Escape' && end(false);
      const end = (commit: boolean) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', key);
        ghost.current?.hide();
        if (!snap) {
          if (commit) onClick();
          return;
        }
        if (commit && target) {
          const t = target;
          withTransition(() => ws.move(panel, t));
        }
      };
      // the ghost and the drop indicator are moved by writing their styles:
      // no React render and no layout read per move
      follow(
        e,
        (ev) => {
          if (done) return;
          if (!snap) {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5 || !stage.current) return;
            snap = snapshot(ws, stage.current, registry.current);
            ghost.current?.show(title);
          }
          const h = hit(snap, ev.clientX, ev.clientY);
          target = h.target;
          ghost.current?.move(ev.clientX - snap.stage.left, ev.clientY - snap.stage.top, h.indicator);
        },
        (released) => end(released),
      );
      window.addEventListener('keydown', key);
    },
  };
}

interface Ghost {
  show: (title: string) => void;
  move: (x: number, y: number, indicator: Indicator) => void;
  hide: () => void;
}

/** The dragged tab's label and the drop indicator, driven imperatively by the drag (see `Ghost`). */
const DragLayer = memo(function DragLayer({ api }: { api: { current: Ghost | null } }) {
  const root = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = (el: HTMLElement | null, r: Rect | null) => {
      if (!el) return;
      if (!r) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      // shown from display: none, a box starts where it is put rather than transitioning from its last place
      setStyle(el, { display: '', ...px(r) });
    };
    api.current = {
      show(title) {
        if (tag.current) tag.current.textContent = title;
        root.current?.removeAttribute('hidden');
      },
      move(x, y, i) {
        place(line.current, i?.line ? i : null);
        place(box.current, i && !i.line ? i : null);
        if (tag.current) tag.current.style.transform = `translate(${x + 12}px, ${y + 10}px)`;
      },
      hide() {
        root.current?.setAttribute('hidden', '');
        place(line.current, null);
        place(box.current, null);
      },
    };
    return () => {
      api.current = null;
    };
  }, [api]);
  return (
    <div ref={root} hidden className="pointer-events-none absolute inset-0 z-50">
      <div ref={line} className="absolute rounded-full bg-ui-accent" style={{ display: 'none' }} />
      <div ref={box} className="absolute rounded-lg border-2 border-ui-accent bg-ui-accent/12 transition-all duration-75" style={{ display: 'none' }} />
      <div
        ref={tag}
        className="absolute top-0 left-0 flex h-6 items-center gap-1.5 rounded-md bg-popover px-2 text-xs font-medium text-fg-1 shadow-lg ring-1 ring-ui-accent/60 will-change-transform"
      />
    </div>
  );
});
