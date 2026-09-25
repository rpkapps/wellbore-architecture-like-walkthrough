import { createElement, type CanvasHTMLAttributes, type ReactNode } from 'react';
import type { Provenance } from './prov';
import { Rev, SCENE, Signal } from './signal';

export interface ToolWindowOptions {
  id: string;
  title: string;
  /** provenance badge next to the tabs */
  badge?: Provenance;
  onClose?: () => void;
  /** controls shown in the dock's tab bar while this window is the active tab */
  header?: () => ReactNode;
  /** the window body; canvases stretch to fill it */
  body: () => ReactNode;
}

/** Every tool window a feature created; the dock shows the open ones as tabs. */
export const toolWindows = new Signal<ToolWindow[]>([]);
/** open windows, in the order they were opened */
export const openWindows = new Signal<ToolWindow[]>([]);
/** the dock's selected tab */
export const activeWindow = new Signal<string | null>(null);

/**
 * A tool window of an optional feature (geosteering strip, cross-section,
 * correlation, map, simulation, saved views, the log-track editor). It opens
 * as a tab in the dock under the 3D view.
 */
export class ToolWindow {
  /** bump when the body or header content changes */
  readonly rev = new Rev(SCENE);

  constructor(readonly opts: ToolWindowOptions) {
    toolWindows.update((l) => [...l, this]);
  }

  get visible() {
    return openWindows.value.includes(this);
  }

  show() {
    if (!this.visible) openWindows.update((l) => [...l, this]);
    activeWindow.set(this.opts.id);
  }

  hide() {
    if (!this.visible) return;
    const rest = openWindows.value.filter((p) => p !== this);
    openWindows.set(rest);
    if (activeWindow.value === this.opts.id) activeWindow.set(rest[rest.length - 1]?.opts.id ?? null);
  }

  toggle() {
    if (this.visible && activeWindow.value === this.opts.id) this.hide();
    else this.show();
  }

  close() {
    if (this.opts.onClose) this.opts.onClose();
    else this.hide();
  }

  destroy() {
    this.hide();
    toolWindows.update((l) => l.filter((p) => p !== this));
  }
}

type Painter = (g: CanvasRenderingContext2D, W: number, H: number) => void;

const cssOf = new WeakMap<HTMLCanvasElement, string>();

/** Size a backing store in steps of 128 CSS px, so a continuous resize reallocates it rarely; returns whether it changed. */
export function fitStore(cv: HTMLCanvasElement, W: number, H: number, dpr: number): boolean {
  const step = (v: number, have: number) => (have >= v && have <= v + 256 ? have : Math.ceil(v / 128) * 128);
  const w = Math.round(step(W, cv.width / dpr) * dpr);
  const h = Math.round(step(H, cv.height / dpr) * dpr);
  // the CSS size follows the store at this density: a new DPR can keep the store and still change it
  const css = `${w}x${h}@${dpr}`;
  if (cssOf.get(cv) !== css) {
    cssOf.set(cv, css);
    cv.style.width = `${w / dpr}px`;
    cv.style.height = `${h / dpr}px`;
  }
  if (cv.width === w && cv.height === h) return false;
  cv.width = w;
  cv.height = h;
  return true;
}

/**
 * A tool window canvas. Its size comes from a ResizeObserver on the box around
 * it, so drawing never reads layout; the backing store grows in steps and the
 * box clips the spare, so a panel being resized does not reallocate it on every
 * pixel; and requests are coalesced to one draw per frame. With a `cursor`
 * painter the drawing is cached, and a cursor move only copies it back and
 * draws the cursor over it.
 */
export class PanelCanvas {
  el: HTMLCanvasElement | null = null;
  /** the box's size in CSS px */
  W = 0;
  H = 0;
  private base: HTMLCanvasElement | null = null;
  private dpr = 0;
  private stale = true;
  private pending = false;
  private raf = 0;
  private ro: ResizeObserver | null = null;

  constructor(
    private readonly paint: {
      draw: Painter;
      cursor?: Painter;
      visible?: () => boolean;
      /** bound non-passive, so it can stop the page scrolling */
      wheel?: (e: WheelEvent) => void;
    },
  ) {}

  /** ref for the canvas element (see CanvasBox) */
  readonly ref = (el: HTMLCanvasElement | null) => {
    if (el === this.el) return;
    this.ro?.disconnect();
    this.ro = null;
    if (this.paint.wheel) this.el?.removeEventListener('wheel', this.paint.wheel);
    this.el = el;
    this.W = 0;
    this.H = 0;
    if (!el) return;
    if (this.paint.wheel) el.addEventListener('wheel', this.paint.wheel, { passive: false });
    // reported once per frame, after layout: draw now, before paint, so the canvas never shows the old size
    this.ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      const W = Math.round(r.width);
      const H = Math.round(r.height);
      if (W === this.W && H === this.H) return;
      this.W = W;
      this.H = H;
      this.redraw();
    });
    this.ro.observe(el.parentElement ?? el);
  };

  /** Redraw everything at the next frame (from events: many per frame cost one draw). */
  invalidate() {
    this.stale = true;
    this.schedule();
  }

  /** Redraw everything now (from a per-frame hook, which already runs once per frame). */
  redraw() {
    this.stale = true;
    this.pending = true;
    this.flush();
  }

  /** Only the cursor layer changed (pointer feedback): redraw it at the next frame. */
  invalidateCursor() {
    if (!this.paint.cursor) this.stale = true;
    this.schedule();
  }

  /** Only the cursor moved: redraw it now over the cached drawing. */
  moveCursor() {
    if (!this.paint.cursor) this.stale = true;
    this.pending = true;
    this.flush();
  }

  private schedule() {
    this.pending = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.flush()));
  }

  private flush() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const { el, W, H } = this;
    if (!this.pending || !el || !W || !H || this.paint.visible?.() === false) return;
    this.pending = false;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (dpr !== this.dpr) this.stale = true;
    this.dpr = dpr;
    fitStore(el, W, H, dpr);
    const g = el.getContext('2d')!;
    const { draw, cursor } = this.paint;
    if (!cursor) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, el.width, el.height);
      draw(g, W, H);
      this.stale = false;
      return;
    }
    const base = (this.base ??= document.createElement('canvas'));
    if (this.stale) {
      fitStore(base, W, H, dpr);
      const bg = base.getContext('2d')!;
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.clearRect(0, 0, base.width, base.height);
      draw(bg, W, H);
      this.stale = false;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, el.width, el.height);
    const w = Math.round(W * dpr);
    const h = Math.round(H * dpr);
    g.drawImage(base, 0, 0, w, h, 0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cursor(g, W, H);
  }
}

/**
 * The box a PanelCanvas draws in: it fills the rest of the tool window (or
 * whatever `box` says) and clips the canvas, which keeps its own size.
 */
export function CanvasBox({ view, box = 'min-h-0 w-full flex-1', className, ...rest }: { view: PanelCanvas; box?: string } & CanvasHTMLAttributes<HTMLCanvasElement>) {
  return createElement('div', { className: `relative overflow-hidden ${box}` }, createElement('canvas', { ...rest, ref: view.ref, className: `absolute top-0 left-0 block ${className ?? ''}` }));
}
