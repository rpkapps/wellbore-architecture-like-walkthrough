import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { ChevronsLeftRightIcon, EllipsisIcon, PanelLeftCloseIcon, PanelRightCloseIcon, PanelBottomCloseIcon, XIcon } from 'lucide-react';
import { Activity, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, ViewTransition, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { IconButton } from '../icon-button';
import { animate, useAnimatedSignal, withTransition } from '../transition';
import { Signal, useSignal } from '../signal';
import { SURFACE } from '../shell/overlay';
import { SIZE_LIMITS, type Column, type DropTarget, type FloatWin, type Layout, type Stack, type Workspace, type Zone } from './layout';
import type { PanelDef } from './panels';

/** gap between the panels and the window edges (px) */
const G = 6;
/** a folded column: its icon strip */
const STRIP = 34;
const MIN_STACK = 72;
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
  cols: Record<Zone, Rect | null>;
  free: Free;
}

/** stage-relative rectangles of the drop targets, filled in by the groups as they render */
interface Registered {
  el: HTMLElement;
  strip: HTMLElement | null;
  zone: Zone | null;
}

interface DragState {
  panel: string;
  title: string;
  x: number;
  y: number;
  target: DropTarget | null;
  indicator: (Rect & { line?: boolean }) | null;
}

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
  onFree: (f: Free) => void;
}) {
  // layout changes made in `withTransition` render as a Transition, so the
  // <ViewTransition> around each group animates them
  const L = useAnimatedSignal(ws.layout);
  const hidden = useAnimatedSignal(ws.hidden) || !!chromeless;
  const stage = useRef<HTMLDivElement>(null);
  const freeEl = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const registry = useRef(new Map<string, Registered>());
  const drag = useMemo(() => new Signal<DragState | null>(null), []);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }));
    ro.observe(el);
    setSize({ W: el.clientWidth, H: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => geometry(L, size.W, size.H, hidden ? 0 : timelineHeight, hidden, {}), [L, size, hidden, timelineHeight]);
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

  const dnd = useMemo(() => createDnd(ws, stage, registry, drag, () => geoRef.current), [ws, drag]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  // a column edge being dragged: the columns, their edges and the free area
  // follow the pointer by writing styles directly (no React render per move);
  // the layout, and the 3D view's centring, are updated when the drag ends
  const live = (zone: Zone, v: number) => {
    const st = stage.current;
    if (!st) return;
    const g = geometry(L, size.W, size.H, hidden ? 0 : timelineHeight, hidden, { [zone]: v });
    for (const z of ['left', 'right', 'bottom'] as Zone[]) {
      const r = g.cols[z];
      const box = st.querySelector<HTMLElement>(`[data-col="${z}"]`);
      const edge = st.querySelector<HTMLElement>(`[data-edge="${z}"]`);
      if (r && box) Object.assign(box.style, px(r));
      if (r && edge) Object.assign(edge.style, px(edgeRect(z, r)));
    }
    if (freeEl.current) Object.assign(freeEl.current.style, { left: `${g.free.left}px`, right: `${g.free.right}px`, bottom: `${g.free.bottom}px` });
  };

  const style = { '--free-l': `${geo.free.left}px`, '--free-r': `${geo.free.right}px`, '--free-b': `${geo.free.bottom}px` } as CSSProperties;
  return (
    <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden" style={style}>
      <div className="absolute inset-0">{viewport}</div>
      {/* the area the panels leave free: overlays are laid out in it */}
      <div ref={freeEl} className="pointer-events-none absolute @container" style={{ left: geo.free.left, right: geo.free.right, top: 0, bottom: geo.free.bottom }}>
        {overlay}
      </div>
      {!hidden && (
        <>
          {(['left', 'right', 'bottom'] as Zone[]).map((z) => {
            const r = geo.cols[z];
            if (!r) return null;
            return <DockColumn key={z} ws={ws} zone={z} col={L[z]} rect={r} max={maxSize(geo, z)} panels={panels} dnd={dnd} registry={registry.current} onLive={(v) => live(z, v)} />;
          })}
          {L.floating.map((f) => (
            <FloatWindow key={f.id} ws={ws} win={f} panels={panels} dnd={dnd} registry={registry.current} bounds={size} others={L.floating.filter((o) => o !== f)} />
          ))}
        </>
      )}
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <ViewTransition default="none" enter="ws-enter" exit="ws-exit">
          <div className="absolute" style={{ left: G, right: G, bottom: G, height: timelineHeight }}>
            {timeline}
          </div>
        </ViewTransition>
      </Activity>
      <DragLayer drag={drag} />
    </div>
  );
}

const px = (r: Rect) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

/** the strip along a column's inner edge that resizes it */
function edgeRect(zone: Zone, r: Rect): Rect {
  return zone === 'left' ? { x: r.x + r.w, y: r.y, w: G, h: r.h } : zone === 'right' ? { x: r.x - G, y: r.y, w: G, h: r.h } : { x: r.x, y: r.y - G, w: r.w, h: G };
}

/** A column can grow until only MIN_VIEW of the 3D view is left beside (or above) it. */
function maxSize(g: Geometry, z: Zone): number {
  const { left, right } = g.cols;
  if (z === 'left') return g.W - 2 * G - (right ? right.w + G : 0) - MIN_VIEW;
  if (z === 'right') return g.W - 2 * G - (left ? left.w + G : 0) - MIN_VIEW;
  const colH = left?.h ?? right?.h ?? g.H - 2 * G;
  return colH - MIN_VIEW / 2;
}

function geometry(L: Layout, W: number, H: number, tl: number, hidden: boolean, live: Partial<Record<Zone, number>>): Geometry {
  const ext = (z: Zone) => {
    const c = L[z];
    if (hidden || !c.stacks.length) return 0;
    return c.collapsed ? STRIP : (live[z] ?? c.size);
  };
  const lw = ext('left');
  const rw = ext('right');
  const bh = ext('bottom');
  const bottomLimit = H - (tl ? tl + 2 * G : G);
  const colH = Math.max(0, bottomLimit - G);
  const cols: Record<Zone, Rect | null> = {
    left: lw ? { x: G, y: G, w: lw, h: colH } : null,
    right: rw ? { x: W - G - rw, y: G, w: rw, h: colH } : null,
    bottom: null,
  };
  if (bh) {
    const x = G + (lw ? lw + G : 0);
    const w = W - x - G - (rw ? rw + G : 0);
    cols.bottom = { x, y: bottomLimit - bh, w: Math.max(0, w), h: bh };
  }
  return {
    W,
    H,
    cols,
    free: {
      left: lw ? G + lw : 0,
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
  max,
  panels,
  dnd,
  registry,
  onLive,
}: {
  ws: Workspace;
  zone: Zone;
  col: Column;
  rect: Rect;
  max: number;
  panels: Map<string, PanelDef>;
  dnd: Dnd;
  registry: Map<string, Registered>;
  onLive: (v: number) => void;
}) {
  const [flyout, setFlyout] = useState<{ stack: string; panel: string } | null>(null);
  const horizontal = zone === 'bottom';
  const box = useRef<HTMLDivElement>(null);
  if (col.collapsed)
    return (
      <ViewTransition key="strip" default="none" enter="ws-enter" exit="ws-exit">
        <IconStrip ws={ws} zone={zone} col={col} rect={rect} panels={panels} flyout={flyout} setFlyout={setFlyout} dnd={dnd} registry={registry} />
      </ViewTransition>
    );

  // the splits between groups: the two groups follow the drag directly, the
  // weights are written when it ends
  const splitDown = (i: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const kids = box.current?.querySelectorAll<HTMLElement>(':scope > [data-stack]');
    if (!kids || !kids[i] || !kids[i + 1]) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ka = kids[i];
    const kb = kids[i + 1];
    const a = horizontal ? ka.offsetWidth : ka.offsetHeight;
    const b = horizontal ? kb.offsetWidth : kb.offsetHeight;
    const wSum = col.stacks[i].weight + col.stacks[i + 1].weight;
    const start = horizontal ? e.clientX : e.clientY;
    let weights: [number, number] | null = null;
    const move = (ev: PointerEvent) => {
      const d = (horizontal ? ev.clientX : ev.clientY) - start;
      const na = Math.max(MIN_STACK, Math.min(a + b - MIN_STACK, a + d));
      weights = [(na / (a + b)) * wSum, ((a + b - na) / (a + b)) * wSum];
      ka.style.flex = `${weights[0]} 1 0`;
      kb.style.flex = `${weights[1]} 1 0`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (weights) ws.resizeSplit(zone, i, weights);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <ViewTransition key="column" default="none" enter="ws-enter" exit="ws-exit">
      <div ref={box} data-col={zone} className={`absolute flex ${horizontal ? 'flex-row' : 'flex-col'}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, gap: G }}>
        {col.stacks.map((s, i) => (
          <div key={s.id} data-stack className="relative flex min-h-0 min-w-0" style={{ flex: `${s.weight} 1 0` }}>
            <ViewTransition default="none" enter="ws-enter" exit="ws-exit" update="ws-morph">
              <StackView ws={ws} group={s} zone={zone} panels={panels} dnd={dnd} registry={registry} />
            </ViewTransition>
            {i < col.stacks.length - 1 && (
              <div
                aria-hidden
                onPointerDown={splitDown(i)}
                className={`absolute z-10 ${horizontal ? 'top-0 -right-[6px] h-full w-[6px] cursor-col-resize' : '-bottom-[6px] left-0 h-[6px] w-full cursor-row-resize'} group/split`}
              >
                <div
                  className={`absolute rounded-full bg-ui-accent opacity-0 transition-opacity group-hover/split:opacity-60 ${horizontal ? 'inset-y-6 left-[2px] w-0.5' : 'inset-x-6 top-[2px] h-0.5'}`}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <EdgeHandle zone={zone} rect={rect} size={col.size} max={max} onLive={onLive} onCommit={(v) => ws.setSize(zone, v)} />
    </ViewTransition>
  );
}

/** The column's inner edge: drag to resize the column (the 3D view keeps its size). */
function EdgeHandle({ zone, rect, size, max, onLive, onCommit }: { zone: Zone; rect: Rect; size: number; max: number; onLive: (v: number) => void; onCommit: (v: number) => void }) {
  const style: CSSProperties = { ...px(edgeRect(zone, rect)), cursor: zone === 'bottom' ? 'row-resize' : 'col-resize' };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const lo = SIZE_LIMITS[zone][0];
    const hi = Math.max(lo, max);
    let v = size;
    const move = (ev: PointerEvent) => {
      const d = zone === 'left' ? ev.clientX - x0 : zone === 'right' ? x0 - ev.clientX : y0 - ev.clientY;
      v = Math.round(Math.max(lo, Math.min(hi, size + d)));
      onLive(v);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (v !== size) onCommit(v);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div aria-hidden data-edge={zone} onPointerDown={down} className="group/edge absolute z-10" style={style}>
      <div
        className={`absolute rounded-full bg-ui-accent opacity-0 transition-opacity group-hover/edge:opacity-70 ${zone === 'bottom' ? 'inset-x-8 top-[2px] h-0.5' : 'inset-y-8 left-[2px] w-0.5'}`}
      />
    </div>
  );
}

/** A folded column: one icon per panel; each opens its group as a flyout beside the strip. */
function IconStrip({
  ws,
  zone,
  col,
  rect,
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
  panels: Map<string, PanelDef>;
  flyout: { stack: string; panel: string } | null;
  setFlyout: (f: { stack: string; panel: string } | null) => void;
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
      // menus and popovers opened from the flyout live in a portal
      if ((t as HTMLElement).closest?.('[data-slot$="-content"], [role="menu"], [role="dialog"], [role="listbox"]')) return;
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
                  onPress={() => animate(() => setFlyout(on ? null : { stack: s.id, panel: p }))}
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
      {fly && flyout && (
        <ViewTransition default="none" enter="ws-enter" exit="ws-exit">
          <div ref={flyRef} className="absolute z-20 flex" style={{ left: flyRect.x, top: flyRect.y, width: flyRect.w, height: flyRect.h }}>
            <StackView ws={ws} group={fly} zone={zone} panels={panels} dnd={dnd} registry={registry} active={flyout.panel} onActivate={(p) => setFlyout({ stack: fly.id, panel: p })} />
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
  const def = panels.get(active);
  const seen = useRef(new Set<string>());
  seen.current.add(active);
  const activate = onActivate ?? ((id: string) => ws.activate(id));
  const closePanel = (id: string) => {
    const d = panels.get(id);
    if (d?.tool) d.tool.close();
    else ws.close(id);
  };
  return (
    <section ref={el} aria-label={def?.title} className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${SURFACE}`}>
      <div className="@container flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle pr-1 pl-1" onPointerDown={onHeaderDown}>
        <div ref={strip} role="tablist" aria-label="Panels" className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') activate(id);
                  if (e.key === 'Delete') closePanel(id);
                }}
                className={`group/tab flex h-6 max-w-44 min-w-0 shrink cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs font-medium whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0 ${
                  on ? 'bg-ghost-active text-fg-1' : 'text-fg-2 hover:bg-ghost-hover hover:text-fg-1'
                }`}
              >
                {d.icon}
                {/* in a narrow group the tabs behind show only their icon */}
                <span className={on || group.panels.length < 3 ? 'truncate' : 'hidden truncate @[24rem]:inline'}>{d.title}</span>
                <button
                  type="button"
                  aria-label={`Close ${d.title}`}
                  title={`Close ${d.title}`}
                  tabIndex={-1}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => closePanel(id)}
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-foreground/10 hover:text-fg-1 [&_svg]:size-3! ${on ? '' : 'invisible group-hover/tab:visible'}`}
                >
                  <XIcon />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          {def?.actions?.()}
          {def && <PanelMenu ws={ws} id={def.id} zone={zone} onClose={() => closePanel(def.id)} />}
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

function PanelMenu({ ws, id, zone, onClose }: { ws: Workspace; id: string; zone: Zone | null; onClose: () => void }) {
  const act = (k: string) =>
    withTransition(() => {
      if (k === 'float') ws.float(id, { x: 120, y: 80, w: 380, h: 340 });
      else if (k === 'left' || k === 'right' || k === 'bottom') ws.dock(id, k);
      else if (k === 'fold' && zone) ws.setCollapsed(zone, true);
      else if (k === 'close') onClose();
    });
  const FoldIcon = zone === 'right' ? PanelRightCloseIcon : zone === 'bottom' ? PanelBottomCloseIcon : PanelLeftCloseIcon;
  return (
    <>
      <DropdownMenuTrigger>
        <IconButton label="Panel options" size="icon-xs">
          <EllipsisIcon />
        </IconButton>
        <DropdownMenu placement="bottom end" className="w-max min-w-44" onAction={(k) => act(String(k))}>
          <DropdownMenuGroup>
            <DropdownMenuItem id="float">Float</DropdownMenuItem>
            {zone !== 'left' && <DropdownMenuItem id="left">Dock left</DropdownMenuItem>}
            {zone !== 'right' && <DropdownMenuItem id="right">Dock right</DropdownMenuItem>}
            {zone !== 'bottom' && <DropdownMenuItem id="bottom">Dock bottom</DropdownMenuItem>}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {zone && (
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
    </>
  );
}

// ---------------------------------------------------------------- floating windows

function FloatWindow({
  ws,
  win,
  panels,
  dnd,
  registry,
  bounds,
  others,
}: {
  ws: Workspace;
  win: FloatWin;
  panels: Map<string, PanelDef>;
  dnd: Dnd;
  registry: Map<string, Registered>;
  bounds: { W: number; H: number };
  others: FloatWin[];
}) {
  // position and size follow the pointer by writing the window's style
  // directly (at most once a frame); the layout is written on release
  const el = useRef<HTMLDivElement>(null);
  const rect = { x: win.x, y: win.y, w: win.w, h: win.h };
  const clampR = (q: Rect): Rect => {
    const w = Math.max(220, Math.min(bounds.W - 2 * G, q.w));
    const h = Math.max(140, Math.min(bounds.H - 2 * G, q.h));
    return { x: Math.max(G, Math.min(bounds.W - w - G, q.x)), y: Math.max(G, Math.min(bounds.H - h - G, q.y)), w, h };
  };
  const snap = (q: Rect): Rect => {
    const xs = [G, bounds.W - G, ...others.flatMap((o) => [o.x, o.x + o.w, o.x - G, o.x + o.w + G])];
    const ys = [G, bounds.H - G, ...others.flatMap((o) => [o.y, o.y + o.h, o.y - G, o.y + o.h + G])];
    const near = (v: number, list: number[]) => list.find((t) => Math.abs(t - v) < 8);
    let { x, y } = q;
    const sx = near(x, xs) ?? (near(x + q.w, xs) !== undefined ? near(x + q.w, xs)! - q.w : undefined);
    const sy = near(y, ys) ?? (near(y + q.h, ys) !== undefined ? near(y + q.h, ys)! - q.h : undefined);
    if (sx !== undefined) x = sx;
    if (sy !== undefined) y = sy;
    return { ...q, x, y };
  };
  const track = (e: ReactPointerEvent, f: (dx: number, dy: number, r0: Rect) => Rect) => {
    e.preventDefault();
    ws.raise(win.id);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = { ...rect };
    let last = r0;
    let raf = 0;
    const move = (ev: PointerEvent) => {
      last = clampR(f(ev.clientX - x0, ev.clientY - y0, r0));
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (el.current) Object.assign(el.current.style, px(last));
        });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(raf);
      if (el.current) Object.assign(el.current.style, px(last));
      if (last.x !== r0.x || last.y !== r0.y || last.w !== r0.w || last.h !== r0.h) ws.setFloat(win.id, last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
  return (
    <ViewTransition default="none" enter="ws-enter" exit="ws-exit" update="ws-morph">
      <div ref={el} className="absolute z-20 flex" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onPointerDownCapture={() => ws.raise(win.id)}>
        <StackView
          ws={ws}
          group={win}
          zone={null}
          panels={panels}
          dnd={dnd}
          registry={registry}
          onHeaderDown={(e) => {
            if (e.button === 0) track(e, (dx, dy, q) => snap({ ...q, x: q.x + dx, y: q.y + dy }));
          }}
        />
        {edges.map(([k, cls, f]) => (
          <div key={k} aria-hidden className={`absolute ${cls}`} onPointerDown={(e) => track(e, f)} />
        ))}
      </div>
    </ViewTransition>
  );
}

// ---------------------------------------------------------------- drag and drop of tabs

interface Dnd {
  start: (e: ReactPointerEvent, panel: string, title: string, onClick: () => void) => void;
}

function createDnd(ws: Workspace, stage: { current: HTMLDivElement | null }, registry: { current: Map<string, Registered> }, drag: Signal<DragState | null>, geo: () => Geometry): Dnd {
  const hit = (cx: number, cy: number): { target: DropTarget | null; indicator: DragState['indicator'] } => {
    const st = stage.current?.getBoundingClientRect();
    if (!st) return { target: null, indicator: null };
    const x = cx - st.left;
    const y = cy - st.top;
    const rel = (r: DOMRect): Rect => ({ x: r.left - st.left, y: r.top - st.top, w: r.width, h: r.height });
    // floating windows first (front to back), then the docked groups
    const order = ws.value.floating.map((f) => f.id).reverse();
    const rank = (id: string, r: Registered) => (r.zone === null ? order.indexOf(id) : 1000);
    const entries = [...registry.current.entries()].sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]));
    for (const [id, reg] of entries) {
      const r = reg.el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const s = reg.strip?.getBoundingClientRect();
      if (s && cy <= s.bottom + 2) {
        const tabs = [...(reg.strip?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])];
        let index = tabs.length;
        let lx = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right + 1 : s.left + 4;
        for (let i = 0; i < tabs.length; i++) {
          const t = tabs[i].getBoundingClientRect();
          if (cx < t.left + t.width / 2) {
            index = i;
            lx = t.left - 1;
            break;
          }
        }
        return { target: { kind: 'tab', stack: id, index }, indicator: { x: lx - st.left - 1, y: s.top - st.top + 5, w: 2, h: s.height - 10, line: true } };
      }
      const R = rel(r);
      if (reg.zone) {
        const horiz = reg.zone === 'bottom';
        const f = horiz ? (cx - r.left) / r.width : (cy - r.top) / r.height;
        if (f < 0.3) return { target: { kind: 'split', zone: reg.zone, stack: id, where: 'before' }, indicator: horiz ? { ...R, w: R.w / 2 } : { ...R, h: R.h / 2 } };
        if (f > 0.7)
          return { target: { kind: 'split', zone: reg.zone, stack: id, where: 'after' }, indicator: horiz ? { ...R, x: R.x + R.w / 2, w: R.w / 2 } : { ...R, y: R.y + R.h / 2, h: R.h / 2 } };
      }
      return { target: { kind: 'tab', stack: id, index: 999 }, indicator: R };
    }
    const g = geo();
    const bottomLimit = g.cols.left ? g.cols.left.y + g.cols.left.h : g.H - G;
    const edge = 56;
    const L = ws.value;
    if (x < edge) return { target: { kind: 'zone', zone: 'left' }, indicator: { x: G, y: G, w: L.left.stacks.length ? 6 : L.left.size, h: bottomLimit - G } };
    if (x > g.W - edge)
      return { target: { kind: 'zone', zone: 'right' }, indicator: { x: g.W - G - (L.right.stacks.length ? 6 : L.right.size), y: G, w: L.right.stacks.length ? 6 : L.right.size, h: bottomLimit - G } };
    if (y > g.H - g.free.bottom - edge && y < bottomLimit + G) {
      const bx = g.free.left + G;
      const bw = g.W - g.free.right - G - bx;
      return { target: { kind: 'zone', zone: 'bottom' }, indicator: { x: bx, y: bottomLimit - (L.bottom.stacks.length ? 6 : L.bottom.size), w: bw, h: L.bottom.stacks.length ? 6 : L.bottom.size } };
    }
    const w = 380;
    const h = 320;
    const fx = Math.max(G, Math.min(g.W - w - G, x - 60));
    const fy = Math.max(G, Math.min(g.H - h - G, y - 14));
    return { target: { kind: 'float', x: fx, y: fy, w, h }, indicator: { x: fx, y: fy, w, h } };
  };

  return {
    start(e, panel, title, onClick) {
      if (e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dragging = false;
      const move = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        dragging = true;
        const st = stage.current?.getBoundingClientRect();
        const { target, indicator } = hit(ev.clientX, ev.clientY);
        drag.set({ panel, title, x: ev.clientX - (st?.left ?? 0), y: ev.clientY - (st?.top ?? 0), target, indicator });
      };
      const end = (commit: boolean) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('keydown', key);
        const d = drag.value;
        drag.set(null);
        if (!dragging) {
          if (commit) onClick();
          return;
        }
        if (commit && d?.target) {
          const t = d.target;
          withTransition(() => ws.move(panel, t));
        }
      };
      const up = () => end(true);
      const key = (ev: KeyboardEvent) => ev.key === 'Escape' && end(false);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('keydown', key);
    },
  };
}

function DragLayer({ drag }: { drag: Signal<DragState | null> }) {
  const d = useSignal(drag);
  if (!d) return null;
  const i = d.indicator;
  return (
    <div className="pointer-events-none absolute inset-0 z-50">
      {i && (
        <div
          className={i.line ? 'absolute rounded-full bg-ui-accent' : 'absolute rounded-lg border-2 border-ui-accent bg-ui-accent/12 transition-all duration-75'}
          style={{ left: i.x, top: i.y, width: i.w, height: i.h }}
        />
      )}
      <div className="absolute flex h-6 items-center gap-1.5 rounded-md bg-popover px-2 text-xs font-medium text-fg-1 shadow-lg ring-1 ring-ui-accent/60" style={{ left: d.x + 12, top: d.y + 10 }}>
        {d.title}
      </div>
    </div>
  );
}
