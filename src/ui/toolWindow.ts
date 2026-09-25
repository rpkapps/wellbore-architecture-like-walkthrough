import type { ReactNode } from 'react';
import type { Provenance } from './prov';
import { Rev, Signal } from './signal';

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
  readonly rev = new Rev();
  /** body resized (and once after it is shown): redraw canvases */
  onResize?: () => void;

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

/** Canvas helper: size the backing store to the element and return a DPR-scaled context. */
export function fitCanvas(cv: HTMLCanvasElement | null): { g: CanvasRenderingContext2D; W: number; H: number } | null {
  if (!cv) return null;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}
