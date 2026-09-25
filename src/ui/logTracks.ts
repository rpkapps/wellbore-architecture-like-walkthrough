import type { Well } from '../data/dataset';
import { findCurve, sampleCurve } from '../data/las';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { colormap, resToT, type ColormapName } from '../data/colormap';
import { DEFAULT_TRACKS, defaultLayout, parseLayout, resolveCurve, visibleTracks, type CurveSpec, type Scale, type TrackSpec } from '../data/trackLayout';
import type { Curve } from '../data/types';
import { fmt } from './dom';
import { Rev, Signal } from './signal';
import { fitStore } from './toolWindow';
import { cssVar, font, ink, wash } from './tokens';

const LAYOUT_KEY = 'vwt.logtracks.v1';

/** header: a title row, then one scale row per curve of the fullest track */
const TITLE_H = 21;
const ROW_H = 25;
const DEPTH_W = 46;
const ZONE_W = 9;
const HOLE_W = 9;
const PAY_W = 7;

export interface ReadoutRow {
  k: string;
  v: string;
  /** m = measured, c = calculated, i = operator interpretation */
  tone: 'm' | 'c' | 'i';
}

/** What the hover read-out over the log canvas shows at one depth. */
export interface Readout {
  md: number;
  /** pointer position and canvas size, to place the read-out beside the pointer */
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  zone: string;
  groups: ReadoutRow[][];
}

/**
 * Conventional well-log display (Techlog / Petrel style) drawn on a canvas and
 * synchronised with the 3D scene cursor. The panel around it (header, zoom,
 * track menu, hover read-out) is React; this class owns the drawing.
 */
export class LogTracks {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  well?: Well;
  cursorMd = 0;
  private hover: number | null = null;
  window = 160;
  private headH = 86;
  colormap: ColormapName = 'resistivity';
  onPick?: (md: number) => void;
  onHover?: (md: number | null) => void;
  onScroll?: (md: number) => void;
  private layout: { x: number; w: number; spec?: TrackSpec; kind: string }[] = [];
  /** user-editable track layout (built-in tracks + added ones), saved per browser */
  tracks: TrackSpec[] = defaultLayout();
  hideEmpty = false;
  /** depth window shown, for the zoom read-out */
  readonly windowSize = new Signal(160);
  readonly readout = new Signal<Readout | null>(null);
  /** the track layout or the active well changed (the track menu re-renders) */
  readonly rev = new Rev();
  private detach: (() => void) | null = null;
  /** dragging a track header (reorder) or a boundary between tracks (resize) */
  private gesture: { kind: 'move'; spec: TrackSpec; x0: number; x: number; started: boolean } | { kind: 'resize'; i: number; x0: number; f0: [number, number] } | null = null;
  private suppressClick = false;
  /** the panel's size in CSS px, from the ResizeObserver (never read from layout) */
  private W = 0;
  private H = 0;
  /**
   * The tracks are drawn once into a strip at least as tall as the depth window (and
   * the header into its own layer); a cursor move only copies the visible part
   * of the strip and draws the cursor over it. The strip is redrawn when the
   * data, the layout, the size or the zoom change, or the cursor leaves it.
   */
  private strip: { cv: HTMLCanvasElement; s0: number; rows: number; scale: number; window: number; dpr: number } | null = null;
  private head: HTMLCanvasElement | null = null;
  /** per shown track: prefix counts of strip rows where its first curve has data (null: the curve is missing) */
  private present: (Int32Array | null)[] = [];
  private stale = true;
  private pending = false;
  private raf = 0;
  private micro = false;
  /** the cursor's last move, for which way the strip reaches ahead */
  private step = 0;

  constructor() {
    this.loadLayout();
  }

  /** The 3D view's hover depth (a dashed line). Only the overlay redraws. */
  get hoverMd() {
    return this.hover;
  }

  set hoverMd(md: number | null) {
    this.hover = md;
    this.schedule();
  }

  /** Draw at the next frame; nothing runs while nothing changes. */
  private schedule() {
    this.pending = true;
    if (!this.raf && this.canvas) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.paint()));
  }

  /** Draw into this canvas (from the logs panel's ref callback; null when it unmounts). */
  attach(cv: HTMLCanvasElement | null) {
    this.detach?.();
    this.detach = null;
    this.canvas = cv;
    this.strip = null;
    this.head = null;
    this.W = 0;
    this.H = 0;
    this.ctx = cv?.getContext('2d') ?? null;
    if (!cv) return;
    const move = (e: PointerEvent) => this.move(e);
    const leave = () => {
      this.hover = null;
      this.readout.set(null);
      this.onHover?.(null);
      this.schedule();
    };
    const click = (e: MouseEvent) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const md = this.mdAtY(e.offsetY);
      if (md !== null) this.onPick?.(md);
    };
    const down = (e: PointerEvent) => this.down(e);
    const up = () => this.up();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.altKey) this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
      else this.onScroll?.(this.cursorMd + (e.deltaY / 100) * this.window * 0.08);
    };
    // the host's size, reported once per frame after layout: redraw now, before paint, so the tracks never show stretched
    const host = cv.parentElement ?? cv;
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      const W = Math.round(r.width);
      const H = Math.round(r.height);
      if (W === this.W && H === this.H) return;
      this.W = W;
      this.H = H;
      this.stale = true;
      this.pending = true;
      this.paint();
    });
    ro.observe(host);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave);
    cv.addEventListener('click', click);
    cv.addEventListener('wheel', wheel, { passive: false });
    this.stale = true;
    this.schedule();
    this.detach = () => {
      ro.disconnect();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('pointerleave', leave);
      cv.removeEventListener('click', click);
      cv.removeEventListener('wheel', wheel);
    };
  }

  zoom(f: number) {
    this.window = Math.max(20, Math.min(4000, this.window * f));
    this.windowSize.set(Math.round(this.window));
    this.invalidate();
  }

  setWell(w: Well) {
    this.well = w;
    this.invalidate();
    this.rev.bump();
  }

  /** The track layout or its options changed: store and redraw. */
  commitLayout() {
    this.saveLayout();
    this.invalidate();
    this.rev.bump();
  }

  resetLayout() {
    this.tracks = defaultLayout();
    this.hideEmpty = false;
    this.commitLayout();
  }

  private loadLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as { tracks?: unknown; hideEmpty?: unknown } | null;
      if (raw) {
        this.tracks = parseLayout(raw.tracks);
        this.hideEmpty = raw.hideEmpty === true;
      }
    } catch {
      this.tracks = defaultLayout();
    }
  }

  private saveLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tracks: this.tracks, hideEmpty: this.hideEmpty }));
    } catch {
      /* private mode: keep in memory only */
    }
  }

  /** The data, colours or layout changed: redraw the tracks. */
  invalidate() {
    this.stale = true;
    this.schedule();
  }

  /**
   * The 3D position moved (every frame in playback): the tracks scroll under
   * a fixed cursor, which is a copy out of the strip, so it is drawn in the
   * same frame (a microtask after the app's per-frame update) and costs little.
   */
  setCursor(md: number) {
    if (Math.abs(md - this.cursorMd) <= 1e-3) return;
    this.step = md - this.cursorMd;
    this.cursorMd = md;
    if (!this.canvas) return;
    this.pending = true;
    if (this.micro) return;
    this.micro = true;
    queueMicrotask(() => ((this.micro = false), this.paint()));
  }

  private range() {
    return { top: this.cursorMd - this.window / 2, bot: this.cursorMd + this.window / 2 };
  }

  private mdAtY(y: number): number | null {
    const H = this.H;
    if (y < this.headH) return null;
    const { top, bot } = this.range();
    return top + ((y - this.headH) / (H - this.headH)) * (bot - top);
  }

  private shownTracks() {
    return this.layout.filter((l) => l.kind === 'track' && l.spec) as { x: number; w: number; spec: TrackSpec; kind: string }[];
  }

  /** index of the track whose right edge is under x (a resize handle), or -1 */
  private edgeAt(x: number) {
    const t = this.shownTracks();
    for (let i = 0; i < t.length - 1; i++) if (Math.abs(x - (t[i].x + t[i].w)) <= 4) return i;
    return -1;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.canvas) return;
    const i = this.edgeAt(e.offsetX);
    const t = this.shownTracks();
    if (i >= 0) {
      this.gesture = { kind: 'resize', i, x0: e.offsetX, f0: [t[i].spec.flex, t[i + 1].spec.flex] };
    } else if (e.offsetY < this.headH) {
      const hit = t.find((l) => e.offsetX >= l.x && e.offsetX < l.x + l.w);
      if (!hit) return;
      this.gesture = { kind: 'move', spec: hit.spec, x0: e.offsetX, x: e.offsetX, started: false };
    } else return;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private up() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.kind === 'resize') {
      this.suppressClick = true;
      this.commitLayout();
      return;
    }
    if (!g.started) return;
    this.suppressClick = true;
    const t = this.shownTracks();
    const before = t.find((l) => g.x < l.x + l.w / 2 && l.spec !== g.spec)?.spec ?? null;
    const rest = this.tracks.filter((q) => q !== g.spec);
    const at = before ? rest.indexOf(before) : rest.length;
    rest.splice(at, 0, g.spec);
    this.tracks = rest;
    this.commitLayout();
  }

  private move(e: PointerEvent) {
    const g = this.gesture;
    if (g && this.canvas) {
      if (g.kind === 'resize') {
        const t = this.shownTracks();
        const avail = t.reduce((a, l) => a + l.w, 0) || 1;
        const flexTotal = t.reduce((a, l) => a + l.spec.flex, 0);
        const sum = g.f0[0] + g.f0[1];
        const a = Math.max(0.3, Math.min(sum - 0.3, g.f0[0] + ((e.offsetX - g.x0) / avail) * flexTotal));
        t[g.i].spec.flex = a;
        t[g.i + 1].spec.flex = sum - a;
        this.stale = true;
      } else {
        g.x = e.offsetX;
        if (Math.abs(g.x - g.x0) > 4) g.started = true;
        this.setCursorStyle(g.started ? 'grabbing' : 'grab');
      }
      this.schedule();
      return;
    }
    this.setCursorStyle(this.edgeAt(e.offsetX) >= 0 ? 'col-resize' : e.offsetY < this.headH ? 'grab' : 'crosshair');
    const md = this.mdAtY(e.offsetY);
    if (md === null || !this.well) {
      this.readout.set(null);
      return;
    }
    this.hover = md;
    this.onHover?.(md);
    this.schedule();
    this.readout.set(this.readoutAt(md, e.offsetX, e.offsetY));
  }

  /** only written when it changes: a style write per pointer move would restyle the canvas every time */
  private setCursorStyle(c: string) {
    if (this.canvas && this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  private readoutAt(md: number, x: number, y: number): Readout {
    const w = this.well!;
    const logs = w.logs;
    const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
    const z = w.zoneAt(md);
    const out: Readout = { md, x, y, w: this.W, h: this.H, title: `${fmt.n(md, 1)} m MD · ${fmt.n(t.tvd, 1)} TVD`, zone: z?.name ?? '', groups: [] };
    if (!logs) return out;
    const v = (k: string) => {
      const c = findCurve(logs, k);
      return c ? sampleCurve(logs.depth, c.values, md) : NaN;
    };
    const measured: ReadoutRow[] = [
      { k: 'GR', v: `${fmt.n(v('GR'), 1)} API`, tone: 'm' },
      { k: 'RT', v: `${fmt.res(v('RT'))} Ω·m`, tone: 'm' },
      { k: 'R shal', v: `${fmt.res(v('RSHAL'))} Ω·m`, tone: 'm' },
      { k: 'RHOB', v: `${fmt.n(v('RHOB'), 3)} g/cm³`, tone: 'm' },
      { k: 'NPHI', v: `${fmt.n(v('NPHI'), 3)} v/v`, tone: 'm' },
    ];
    if (findCurve(logs, 'DT')) measured.push({ k: 'DTC', v: `${fmt.n(v('DT'), 1)} µs/ft`, tone: 'm' });
    measured.push({ k: 'CALI', v: `${fmt.n(v('CALI'), 2)} in`, tone: 'm' });
    out.groups.push(measured);
    const p = w.petro;
    const interp: ReadoutRow[] = [];
    if (p) {
      const pv = (c: Curve) => sampleCurve(logs.depth, c.values, md);
      interp.push(
        { k: 'Vsh', v: fmt.pct(pv(p.vsh)), tone: 'c' },
        { k: 'PHIE', v: fmt.pct(pv(p.phie), 1), tone: 'c' },
        { k: 'Sw', v: fmt.pct(pv(p.sw)), tone: 'c' },
        { k: 'So', v: fmt.pct(pv(p.so)), tone: 'c' },
      );
    }
    if (w.cpi) {
      const c = w.cpi.curves.get('SW');
      const ph = w.cpi.curves.get('PHIF');
      if (c) interp.push({ k: 'Sw CPI', v: fmt.pct(sampleCurve(w.cpi.depth, c.values, md)), tone: 'i' });
      if (ph) interp.push({ k: 'PHIF CPI', v: fmt.pct(sampleCurve(w.cpi.depth, ph.values, md), 1), tone: 'i' });
    }
    if (interp.length) out.groups.push(interp);
    // curves the user added to the layout
    const extra: ReadoutRow[] = [];
    for (const { c, t: tr } of visibleTracks(this.tracks, w, this.hideEmpty)
      .flatMap((t) => t.curves.map((c) => ({ c, t })))
      .filter(({ c }) => !STANDARD_CURVES.has(curveId(c)))) {
      const d = resolveCurve(w, c);
      if (!d) continue;
      const val = sampleCurve(d.depth, d.values, md);
      extra.push({ k: c.label.slice(0, 10), v: `${fmtVal(val)}${c.unit ? ` ${c.unit}` : ''}`, tone: c.source === 'petro' ? 'c' : c.source === 'cpi' ? 'i' : tr.prov === 'calculated' ? 'c' : 'm' });
    }
    if (extra.length) out.groups.push(extra);
    return out;
  }

  private curveFor(spec: CurveSpec): { depth: Float64Array; values: Float32Array } | null {
    return this.well ? resolveCurve(this.well, spec) : null;
  }

  private paint() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.pending) return;
    this.pending = false;
    const cv = this.canvas;
    const g = this.ctx;
    if (!cv || !g || !this.W || !this.H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const st = this.strip;
    const top = this.cursorMd - this.window / 2;
    const off = st ? (top - st.s0) * st.scale : -1;
    if (this.stale || !st || st.window !== this.window || st.dpr !== dpr) this.build(dpr, false);
    else if (off < 0 || off + (this.H - this.headH) > st.rows) this.build(dpr, off > -(this.H - this.headH) && off < st.rows);
    this.compose(dpr);
  }

  /** Redraw the header layer and the strip around the cursor (`scrolling`: the cursor moved on past its end). */
  private build(dpr: number, scrolling: boolean) {
    this.stale = false;
    const cv = this.canvas!;
    const { W, H } = this;
    // grown in steps; the host clips the spare, so the canvas keeps the backing store's size in CSS px
    if (fitStore(cv, W, H, dpr)) {
      cv.style.width = `${cv.width / dpr}px`;
      cv.style.height = `${cv.height / dpr}px`;
    }
    const w = this.well;
    if (!w) {
      this.strip = null;
      return;
    }
    const shown = visibleTracks(this.tracks, w, this.hideEmpty);
    this.headH = TITLE_H + Math.max(1, ...shown.map((t) => t.curves.length)) * ROW_H + 4;
    const bodyH = Math.max(1, H - this.headH);

    // layout
    const fixed = DEPTH_W + ZONE_W + HOLE_W + PAY_W + 6;
    const flexTotal = shown.reduce((s, t) => s + t.flex, 0) || 1;
    const avail = W - fixed - 4;
    let x = 2;
    this.layout = [];
    this.layout.push({ x, w: DEPTH_W, kind: 'depth' });
    x += DEPTH_W;
    this.layout.push({ x, w: ZONE_W, kind: 'zone' });
    x += ZONE_W + 1;
    this.layout.push({ x, w: HOLE_W, kind: 'hole' });
    x += HOLE_W + 2;
    for (const t of shown) {
      const tw = (t.flex / flexTotal) * avail;
      this.layout.push({ x, w: tw, spec: t, kind: 'track' });
      x += tw;
    }
    this.layout.push({ x: x + 1, w: PAY_W, kind: 'pay' });

    // the strip: the depth window, plus half a window ahead when the cursor scrolled out of it slowly (playback), so
    // it is redrawn every half window at 1.5 times the cost of one view; a resize, new data or fast scrubbing redraw it
    // every frame anyway, so then it is just the window
    const top = this.cursorMd - this.window / 2;
    const ahead = scrolling && Math.abs(this.step) < this.window / 4 ? this.window / 2 : 0;
    const scale = bodyH / this.window;
    const rows = Math.ceil(bodyH * (1 + ahead / this.window));
    const s0 = this.step < 0 ? top - ahead : top;
    const scv = this.strip?.cv ?? document.createElement('canvas');
    fitStore(scv, W, rows, dpr);
    const sg = scv.getContext('2d')!;
    sg.setTransform(dpr, 0, 0, dpr, 0, 0);
    sg.clearRect(0, 0, scv.width, scv.height);
    this.strip = { cv: scv, s0, rows, scale, window: this.window, dpr };
    this.drawBody(sg, w, W, rows, s0, scale);

    // the header does not move with the cursor
    if (scrolling && this.head) return;
    const hcv = this.head ?? document.createElement('canvas');
    this.head = hcv;
    fitStore(hcv, W, this.headH + 1, dpr);
    const hg = hcv.getContext('2d')!;
    hg.setTransform(dpr, 0, 0, dpr, 0, 0);
    hg.clearRect(0, 0, hcv.width, hcv.height);
    this.drawHead(hg, W);
  }

  /** Everything below the header, in strip coordinates: y = 0 at depth `s0`, `scale` px per metre. */
  private drawBody(g: CanvasRenderingContext2D, w: Well, W: number, H: number, s0: number, scale: number) {
    const top = s0;
    const bot = s0 + H / scale;
    const yOf = (md: number) => (md - s0) * scale;
    g.font = font.mono(9.5);
    g.textBaseline = 'middle';
    // depth track
    const step = niceStep(this.window / 8);
    g.fillStyle = wash(0.02);
    g.fillRect(2, 0, DEPTH_W, H);
    for (let d = Math.ceil(top / step) * step; d <= bot; d += step) {
      const y = yOf(d);
      g.strokeStyle = wash(0.06);
      g.beginPath();
      g.moveTo(DEPTH_W + 2, y);
      g.lineTo(W, y);
      g.stroke();
      if (d < 0 || d > w.tdMD) continue;
      g.fillStyle = ink.muted;
      g.textAlign = 'right';
      g.fillText(d.toFixed(step < 1 ? 1 : 0), DEPTH_W - 2, y - 5);
      const tv = w.trajectory.at(Math.min(d, w.trajectory.mdEnd)).tvd;
      g.fillStyle = ink.faint;
      g.fillText(tv.toFixed(0), DEPTH_W - 2, y + 6);
    }
    // minor grid
    const minor = step / 5;
    g.strokeStyle = wash(0.025);
    for (let d = Math.ceil(top / minor) * minor; d <= bot; d += minor) {
      const y = Math.round(yOf(d)) + 0.5;
      g.beginPath();
      g.moveTo(DEPTH_W + ZONE_W + HOLE_W + 14, y);
      g.lineTo(W - PAY_W - 2, y);
      g.stroke();
    }

    // zones
    const zl = this.layout[1];
    for (const z of w.zones) {
      if (z.baseMD < top || z.topMD > bot) continue;
      const y0 = Math.max(0, yOf(z.topMD));
      const y1 = Math.min(H, yOf(z.baseMD));
      const col = z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a1f26' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555');
      g.fillStyle = col;
      g.fillRect(zl.x, y0, zl.w, y1 - y0);
      if (z.topMD >= top) {
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.beginPath();
        g.moveTo(zl.x, yOf(z.topMD));
        g.lineTo(W - PAY_W - 2, yOf(z.topMD));
        g.setLineDash([2, 3]);
        g.stroke();
        g.setLineDash([]);
      }
    }
    // hole / casing column
    const hl = this.layout[2];
    for (const s of w.holeSections) {
      if (s.baseMD < top || s.topMD > bot) continue;
      const y0 = Math.max(0, yOf(s.topMD));
      const y1 = Math.min(H, yOf(s.baseMD));
      const hw = (Math.min(s.hole, 36) / 36) * hl.w;
      g.fillStyle = 'rgba(160,140,110,0.35)';
      g.fillRect(hl.x + (hl.w - hw) / 2, y0, hw, y1 - y0);
    }
    for (const c of w.casing) {
      if (c.shoeMD < top || c.topMD > bot) continue;
      const y0 = Math.max(0, yOf(c.topMD));
      const y1 = Math.min(H, yOf(c.shoeMD));
      const cw = (Math.min(c.od, 36) / 36) * hl.w;
      g.fillStyle = '#aab3bc';
      g.fillRect(hl.x + (hl.w - cw) / 2 - 1, y0, 1, y1 - y0);
      g.fillRect(hl.x + (hl.w + cw) / 2, y0, 1, y1 - y0);
      if (c.shoeMD <= bot && c.shoeMD >= top) {
        g.beginPath();
        g.moveTo(hl.x, y1);
        g.lineTo(hl.x + hl.w / 2, y1 - 5);
        g.lineTo(hl.x + hl.w, y1);
        g.fill();
      }
    }

    // tracks
    this.present = [];
    for (const L of this.layout) {
      if (L.kind !== 'track' || !L.spec) continue;
      this.present.push(this.trackBody(g, L.x, L.w, L.spec, s0, scale, H));
    }

    // pay flags
    const pl = this.layout[this.layout.length - 1];
    if (w.petro && w.logs) {
      const d = w.logs.depth;
      g.fillStyle = '#ffb547';
      for (let py = 0; py < H; py++) {
        const k = nearest(d, s0 + py / scale);
        if (k >= 0 && w.petro.pay[k]) g.fillRect(pl.x, py, pl.w, 1);
      }
    }
  }

  /** The header layer: column titles, track headers and the frame's top. */
  private drawHead(g: CanvasRenderingContext2D, W: number) {
    g.fillStyle = wash(0.028);
    g.fillRect(0, 0, W, this.headH);
    for (const L of this.layout) if (L.kind === 'track' && L.spec) this.trackHead(g, L.x, L.w, L.spec);
    const zl = this.layout[1];
    const hl = this.layout[2];
    const pl = this.layout[this.layout.length - 1];
    const mid = this.headH / 2;
    const vlabel = (text: string, cx: number) => {
      g.save();
      g.translate(cx, mid);
      g.rotate(-Math.PI / 2);
      g.fillText(text, 0, 0);
      g.restore();
    };
    g.font = font.sans(9, 600);
    g.fillStyle = ink.faint;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    vlabel('PAY', pl.x + pl.w / 2 + 1);
    vlabel('ZONE', zl.x + ZONE_W / 2);
    vlabel('HOLE', hl.x + HOLE_W / 2 + 1);
    g.font = font.mono(9.5, 600);
    g.fillStyle = ink.muted;
    g.fillText('MD', 2 + DEPTH_W / 2, this.headH - 20);
    g.font = font.mono(9.5);
    g.fillStyle = ink.faint;
    g.fillText('TVD', 2 + DEPTH_W / 2, this.headH - 8);
    g.strokeStyle = ink.grid;
    g.beginPath();
    g.moveTo(0, this.headH + 0.5);
    g.lineTo(W, this.headH + 0.5);
    g.stroke();
  }

  /** The visible part of the strip under the header, then what moves with the pointer and the cursor. */
  private compose(dpr: number) {
    const cv = this.canvas!;
    const g = this.ctx!;
    const { W, H, headH } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    const st = this.strip;
    if (!st || !this.head) return;
    const bodyH = H - headH;
    const top = this.cursorMd - this.window / 2;
    const off = Math.round((top - st.s0) * st.scale * dpr);
    const dw = Math.round(W * dpr);
    const dh = Math.min(Math.round(bodyH * dpr), st.cv.height - off);
    if (dh > 0) g.drawImage(st.cv, 0, off, dw, dh, 0, headH * dpr, dw, dh);
    g.drawImage(this.head, 0, 0, dw, (headH + 1) * dpr, 0, 0, dw, (headH + 1) * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const yOf = (md: number) => headH + (md - top) * st.scale;

    // track frames' bottom edge, and the notice where a track has nothing to show in the window
    const a = Math.max(0, Math.round(off / dpr));
    const b = Math.min(st.rows, a + Math.ceil(bodyH));
    this.shownTracks().forEach((L, i) => {
      const { x, w, spec: t } = L;
      g.strokeStyle = wash(0.07);
      g.beginPath();
      g.moveTo(x + 1.5, H - 1.5);
      g.lineTo(x + w - 1.5, H - 1.5);
      g.stroke();
      const p = this.present[i];
      if (p && p[b] - p[a] > 0) return;
      g.save();
      g.fillStyle = ink.faint;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = font.sans(9.5);
      const msg = !p ? (t.prov === 'calculated' ? 'Inputs missing' : 'Not acquired') : 'No data in window';
      g.translate(x + w / 2, headH + bodyH / 2);
      g.rotate(-Math.PI / 2);
      g.fillText(msg, 0, 0);
      g.restore();
    });

    // hover line under the cursor line
    if (this.hover !== null) {
      const yh = yOf(this.hover);
      g.strokeStyle = 'rgba(255,217,160,0.55)';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, yh);
      g.lineTo(W, yh);
      g.stroke();
      g.setLineDash([]);
    }
    // the 3D position: a glowing accent line with its depth on a tag over the depth column
    const yc = yOf(this.cursorMd);
    if (yc >= headH) {
      const accent = cssVar('--ui-accent', '#b954fd');
      g.save();
      g.shadowColor = accent;
      g.shadowBlur = 6;
      g.fillStyle = accent;
      g.fillRect(0, yc - 1, W, 2);
      g.restore();
      const tag = fmt.n(this.cursorMd, 1);
      g.font = font.mono(9.5, 600);
      const tw = Math.min(DEPTH_W, g.measureText(tag).width + 8);
      g.fillStyle = accent;
      g.beginPath();
      g.roundRect(2, yc - 7, tw, 14, 3);
      g.fill();
      g.fillStyle = ink.card;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(tag, 2 + tw / 2, yc + 0.5);
    }
    // dragging a track: its column highlighted, and where it will land
    const gs = this.gesture;
    if (gs?.kind === 'move' && gs.started) {
      const accent = cssVar('--ui-accent', '#b954fd');
      const t = this.shownTracks();
      const src = t.find((l) => l.spec === gs.spec);
      if (src) {
        g.fillStyle = wash(0.05);
        g.fillRect(src.x, 0, src.w, H);
      }
      const before = t.find((l) => gs.x < l.x + l.w / 2 && l.spec !== gs.spec);
      const last = t[t.length - 1];
      const lx = before ? before.x : last.x + last.w;
      g.fillStyle = accent;
      g.fillRect(lx - 1, 0, 2, H);
    }
  }

  /** A track's body in strip coordinates; returns prefix counts of the rows its first curve has data in (null: missing). */
  private trackBody(g: CanvasRenderingContext2D, x: number, w: number, t: TrackSpec, s0: number, scale: number, H: number): Int32Array | null {
    // frame
    g.fillStyle = wash(0.018);
    g.fillRect(x + 1, 0, w - 2, H);
    g.strokeStyle = wash(0.07);
    g.beginPath();
    g.moveTo(x + 1.5, 0);
    g.lineTo(x + 1.5, H);
    g.moveTo(x + w - 1.5, 0);
    g.lineTo(x + w - 1.5, H);
    g.stroke();
    // vertical grid
    g.strokeStyle = wash(0.045);
    const s0c = t.curves[0].scale;
    if (t.grid === 'log' && s0c.log) {
      const a = Math.log10(Math.min(s0c.min, s0c.max));
      const b = Math.log10(Math.max(s0c.min, s0c.max));
      const rev = s0c.min > s0c.max;
      for (let e = Math.ceil(a); e <= b; e++) {
        for (let k = 1; k < 10; k++) {
          const v = Math.log10(k * Math.pow(10, e));
          if (v < a || v > b) continue;
          const f = (v - a) / (b - a);
          const gx = x + 1 + (rev ? 1 - f : f) * (w - 2);
          g.strokeStyle = k === 1 ? wash(0.09) : wash(0.03);
          g.beginPath();
          g.moveTo(gx, 0);
          g.lineTo(gx, H);
          g.stroke();
        }
      }
    } else {
      for (let k = 1; k < 5; k++) {
        const gx = Math.round(x + 1 + (k / 5) * (w - 2)) + 0.5;
        g.beginPath();
        g.moveTo(gx, 0);
        g.lineTo(gx, H);
        g.stroke();
      }
    }
    const xv = (s: Scale, v: number) => {
      let f: number;
      if (s.log) f = (Math.log10(Math.max(v, 1e-6)) - Math.log10(s.min)) / (Math.log10(s.max) - Math.log10(s.min));
      else f = (v - s.min) / (s.max - s.min);
      return x + 1 + Math.max(-0.02, Math.min(1.02, f)) * (w - 2);
    };
    const samples = (spec: CurveSpec) => {
      const c = this.curveFor(spec);
      if (!c) return null;
      const out = new Float32Array(Math.max(0, Math.ceil(H)));
      let any = false;
      for (let py = 0; py < out.length; py++) {
        const v = sampleCurve(c.depth, c.values, s0 + py / scale);
        out[py] = v;
        if (Number.isFinite(v)) any = true;
      }
      return { vals: out, any, exists: true };
    };
    const data = t.curves.map((c) => samples(c));
    g.save();
    g.beginPath();
    g.rect(x + 1, 0, w - 2, H);
    g.clip();

    // fills
    if (t.fill === 'gr' && data[0]) {
      const s = t.curves[0].scale;
      const w_ = this.well!;
      const p = w_.params;
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (!Number.isFinite(v)) continue;
        const ig = Math.max(0, Math.min(1, (v - p.grClean) / (p.grShale - p.grClean)));
        const sand = [214, 186, 110];
        const shale = [95, 102, 96];
        const c = sand.map((a, i) => Math.round(a + (shale[i] - a) * ig));
        g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.42)`;
        g.fillRect(x + 1, py, xv(s, v) - x - 1, 1);
      }
    }
    if (t.fill === 'shade' && data[0]) {
      g.fillStyle = t.curves[0].color;
      g.globalAlpha = 0.22;
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (Number.isFinite(v)) g.fillRect(x + 1, py, xv(t.curves[0].scale, v) - x - 1, 1);
      }
      g.globalAlpha = 1;
    }
    if (t.fill === 'res-strip' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (!Number.isFinite(v)) continue;
        const c = colormap(this.colormap, resToT(v));
        g.fillStyle = `rgb(${c[0] * 255},${c[1] * 255},${c[2] * 255})`;
        g.fillRect(x + w - 7, py, 5, 1);
      }
    }
    if (t.fill === 'nd' && data[0] && data[1]) {
      const sR = t.curves[0].scale;
      const sN = t.curves[1].scale;
      for (let py = 0; py < data[0].vals.length; py++) {
        const r = data[0].vals[py];
        const n = data[1].vals[py];
        if (!Number.isFinite(r) || !Number.isFinite(n)) continue;
        const xr = xv(sR, r);
        const xn = xv(sN, n);
        // density plots left of neutron → crossover (light fluid / clean porous sand)
        g.fillStyle = xr < xn ? 'rgba(255,200,70,0.45)' : 'rgba(120,128,138,0.22)';
        g.fillRect(Math.min(xr, xn), py, Math.abs(xn - xr), 1);
      }
    }
    if (t.fill === 'vsh-phi' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (Number.isFinite(v)) {
          g.fillStyle = 'rgba(140,146,152,0.35)';
          g.fillRect(x + 1, py, xv(t.curves[0].scale, v) - x - 1, 1);
        }
        const ph = data[1]?.vals[py];
        if (ph !== undefined && Number.isFinite(ph)) {
          g.fillStyle = 'rgba(127,227,255,0.35)';
          const xp = xv(t.curves[1].scale, ph);
          g.fillRect(xp, py, x + w - 1 - xp, 1);
        }
      }
    }
    if (t.fill === 'sw' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (!Number.isFinite(v)) continue;
        const xs = xv(t.curves[0].scale, v);
        g.fillStyle = 'rgba(70,140,215,0.35)';
        g.fillRect(x + 1, py, xs - x - 1, 1);
        g.fillStyle = 'rgba(255,170,50,0.55)';
        g.fillRect(xs, py, x + w - 1 - xs, 1);
      }
    }

    // curves
    t.curves.forEach((spec, i) => {
      const d = data[i];
      if (!d || !d.any) return;
      g.strokeStyle = spec.color;
      g.lineWidth = spec.width ?? 1.3;
      g.setLineDash(spec.dash ?? []);
      g.beginPath();
      let pen = false;
      for (let py = 0; py < d.vals.length; py++) {
        const v = d.vals[py];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const px = xv(spec.scale, v);
        if (!pen) g.moveTo(px, py);
        else g.lineTo(px, py);
        pen = true;
      }
      g.stroke();
      g.setLineDash([]);
    });
    g.restore();

    const d0 = data[0];
    if (!d0) return null;
    const present = new Int32Array(d0.vals.length + 1);
    for (let py = 0; py < d0.vals.length; py++) present[py + 1] = present[py] + (Number.isFinite(d0.vals[py]) ? 1 : 0);
    return present;
  }

  /** header: provenance bar and title, then per curve its name, a line in its colour and dash, and the scale ends */
  private trackHead(g: CanvasRenderingContext2D, x: number, w: number, t: TrackSpec) {
    // the frame's top; its sides run on in the strip, its bottom edge is drawn over the strip
    g.strokeStyle = wash(0.07);
    g.strokeRect(x + 1.5, 2.5, w - 3, this.headH + 4);
    g.save();
    g.fillStyle = wash(0.03);
    g.fillRect(x + 1, 3, w - 2, this.headH - 3);
    g.fillStyle = cssVar(`--tecton-palette-${{ measured: 'azure', calculated: 'saffron', interpreted: 'violet', mixed: 'saffron' }[t.prov]}-560`);
    g.fillRect(x + 2, 3, w - 4, 2);
    const hx = x + 5;
    const hw = w - 10;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.font = font.sans(10, 600);
    g.fillStyle = ink.text;
    g.fillText(fitTitle(g, t.title, hw), x + w / 2, 13);
    let hy = TITLE_H;
    t.curves.forEach((spec) => {
      g.globalAlpha = this.curveFor(spec) ? 1 : 0.35;
      g.font = font.sans(9.5, 600);
      g.fillStyle = spec.color;
      g.textAlign = 'center';
      g.fillText(fit(g, spec.label, hw), x + w / 2, hy + 5);
      g.strokeStyle = spec.color;
      g.lineWidth = 1.6;
      g.setLineDash(spec.dash ?? []);
      g.beginPath();
      g.moveTo(hx, hy + 12.5);
      g.lineTo(hx + hw, hy + 12.5);
      g.stroke();
      g.setLineDash([]);
      g.font = font.mono(8.5);
      g.fillStyle = ink.muted;
      g.textAlign = 'left';
      g.fillText(fmtNum(spec.scale.min), hx, hy + 19);
      g.textAlign = 'right';
      g.fillText(fmtNum(spec.scale.max), hx + hw, hy + 19);
      g.globalAlpha = 1;
      hy += ROW_H;
    });
    g.restore();
  }
}

const curveId = (c: CurveSpec) => `${c.source ?? 'logs'}:${c.petroKey ?? c.cpiKey ?? c.key}`;
const STANDARD_CURVES = new Set(DEFAULT_TRACKS.flatMap((t) => t.curves.map(curveId)));

/** Text cut to `max` px with an ellipsis (fillText's own maxWidth squashes the glyphs instead). */
function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const ABBR: [RegExp, string][] = [
  [/Gamma/i, 'GR'],
  [/Caliper/i, 'Cal'],
  [/Resistivity/i, 'Res'],
  [/Density/i, 'Den'],
  [/Neutron/i, 'Neu'],
  [/Porosity/i, 'Por'],
  [/Saturation/i, 'Sat'],
  [/Sonic/i, 'DT'],
];

/** The track title, or its abbreviation, or its first part, before cutting it. */
function fitTitle(g: CanvasRenderingContext2D, title: string, max: number) {
  const abbr = ABBR.reduce((t, [re, a]) => t.replace(re, a), title);
  for (const t of [title, abbr, abbr.split(' · ')[0]]) if (g.measureText(t).width <= max) return t;
  return fit(g, abbr, max);
}

function fmtVal(v: number) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}

/** compact scale label: no trailing zeros, so narrow tracks keep both ends readable */
function fmtNum(v: number) {
  if (Math.abs(v) >= 10 || Number.isInteger(v)) return v.toFixed(0);
  return String(+v.toPrecision(Math.abs(v) >= 1 ? 3 : 2));
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function nearest(d: Float64Array, md: number) {
  if (md < d[0] || md > d[d.length - 1]) return -1;
  let lo = 0;
  let hi = d.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (d[m] <= md) lo = m;
    else hi = m;
  }
  return md - d[lo] < d[hi] - md ? lo : hi;
}
