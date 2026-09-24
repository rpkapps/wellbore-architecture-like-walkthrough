import * as THREE from 'three';
import { OIL_RGB, WATER_RGB, colormap, toCss } from '../data/colormap';
import { sameWell } from '../data/csv';
import type { Well } from '../data/dataset';
import { contourSegments, horizonCrossing, horizonRange, productionAt, productionSpan, type PathArrays } from '../data/mapview';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { sampleHorizon } from '../data/surfaces';
import type { HorizonGrid, ProductionRecord } from '../data/types';
import type { App } from '../ui/app';
import { chip, fmt, h, slider } from '../ui/dom';
import { FloatingPanel, fitCanvas } from '../ui/floating';
import { I } from '../ui/icons';
import type { ContactsFeature } from './contacts';
import { niceStep } from './geosteer';
import type { FeatureModule } from './registry';

type BubbleMode = 'cum' | 'rate' | 'none';

interface Bubble {
  name: string;
  well?: Well;
  records: ProductionRecord[];
  ew: number;
  ns: number;
}

interface PathRef {
  name: string;
  well?: Well;
  path: PathArrays;
  /** where the path meets the mapped horizon, null when it stays above it */
  cross: { ew: number; ns: number } | null;
}

const MONTH = 30.4375 * 86400000;
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
const OIL = toCss(OIL_RGB);
const WATER = toCss(WATER_RGB);

/**
 * Plan view of the field: a structure map of one horizon (colour-filled
 * depth with contours), every well path, where each well meets the horizon,
 * the camera position, the oil–water contact line and production bubbles on a
 * date slider. Click a well to travel along it.
 */
export class MapViewFeature implements FeatureModule {
  readonly id = 'mapview' as const;
  private panel: FloatingPanel;
  private canvas = h('canvas', { class: 'fp-canvas', style: 'cursor:grab' });
  private readout = h('div', { class: 'fp-readout mono' });
  private foot = h('div', { class: 'fp-foot' });
  private horizonId = 'hugin';
  private bubbles: BubbleMode = 'cum';
  private image?: HTMLCanvasElement;
  private contours: { level: number; seg: number[]; major: boolean }[] = [];
  private range = { min: 0, max: 1 };
  private producers: Bubble[] = [];
  private paths: PathRef[] = [];
  private span: { t0: number; t1: number } | null = null;
  private t = 0;
  private playing = false;
  private playBtn = h('button', { class: 'btn icon ghost', title: 'Play production history', html: I.play });
  private dateSlider: ReturnType<typeof slider> | null = null;
  private maxOil = { cum: 1, rate: 1 };
  private view: { cx: number; cn: number; s: number } | null = null;
  /** the user zoomed or panned: keep their view when the panel is resized */
  private userView = false;
  private W = 0;
  private H = 0;
  private lastKey = '';
  private hoverPt: { x: number; y: number } | null = null;

  constructor(private app: App) {
    const hzSel = h('select', { class: 'select', title: 'Horizon' }) as HTMLSelectElement;
    for (const g of app.field.horizons) if (g.id !== 'nordland') hzSel.append(h('option', { value: g.id }, `Top ${FORMATION_BY_ID.get(g.id)?.name ?? g.name}`));
    hzSel.value = this.horizonId;
    hzSel.onchange = () => {
      this.horizonId = hzSel.value;
      this.rebuild();
    };
    const bSel = h('select', { class: 'select', title: 'Production bubbles' }) as HTMLSelectElement;
    for (const [v, l] of [
      ['cum', 'Cumulative'],
      ['rate', 'Monthly rate'],
      ['none', 'No bubbles'],
    ])
      bSel.append(h('option', { value: v }, l));
    bSel.value = this.bubbles;
    bSel.onchange = () => {
      this.bubbles = bSel.value as BubbleMode;
      this.renderFoot();
      this.draw();
    };
    this.panel = new FloatingPanel({
      id: 'mapview',
      title: 'Map',
      badge: chip('interpreted'),
      width: 520,
      height: 430,
      place: 'top-left',
      headExtra: [hzSel, bSel],
      onClose: () => app.flags.set('mapview', false),
    });
    this.panel.body.append(this.canvas, this.readout, this.foot);
    this.panel.onResize = () => this.draw();
    this.playBtn.onclick = () => this.setPlaying(!this.playing);
    // the well list follows the "More Volve wells" feature (skip the immediate call from watch)
    let first = true;
    app.flags.watch('extraWells', () => {
      if (!first && app.flags.on('mapview')) this.onWell();
      first = false;
    });
    this.bindPointer();
  }

  enable() {
    this.panel.show();
    this.rebuild();
  }

  disable() {
    this.setPlaying(false);
    this.panel.hide();
  }

  onWell() {
    this.buildWells();
    this.draw();
  }

  frame(dt: number) {
    if (this.playing && this.span) {
      this.t += dt * 12 * MONTH; // a year per second
      if (this.t >= this.span.t1) {
        this.t = this.span.t1;
        this.setPlaying(false);
      }
      this.syncSlider();
      this.draw();
      return;
    }
    // redraw when the camera or the cursor moves
    const e = this.app.engine;
    const p = e.camera.position;
    const key = `${p.x.toFixed(0)},${p.z.toFixed(0)},${e.rig.md.toFixed(0)},${e.activeWell?.id}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.draw();
    }
  }

  settings() {
    return h(
      'div',
      { class: 'feat-note' },
      'Structure map from the interpolated picks model (interpretive between wells). Bubbles: monthly reported production (amber oil, blue water) and water injection (blue rings), placed where each well meets the horizon. Wheel zooms, drag pans, double-click resets; click a well to travel along it.',
    );
  }

  // ------------------------------------------------------------------ data
  private grid(): HorizonGrid | undefined {
    return this.app.field.horizons.find((g) => g.id === this.horizonId);
  }

  private rebuild() {
    const g = this.grid();
    if (!g) return;
    this.range = horizonRange(g);
    // colour-filled depth image, north up
    const cv = document.createElement('canvas');
    cv.width = g.nx;
    cv.height = g.nz;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(g.nx, g.nz);
    const span = this.range.max - this.range.min || 1;
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++) {
        const d = g.depth[iz * g.nx + ix];
        const c = colormap('viridis', 1 - (d - this.range.min) / span);
        const o = ((g.nz - 1 - iz) * g.nx + ix) * 4;
        img.data[o] = c[0] * 255;
        img.data[o + 1] = c[1] * 255;
        img.data[o + 2] = c[2] * 255;
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    this.image = cv;
    const step = niceStep((this.range.max - this.range.min) / 14);
    this.contours = [];
    for (let lv = Math.ceil(this.range.min / step) * step; lv <= this.range.max; lv += step)
      this.contours.push({ level: lv, seg: contourSegments(g, lv), major: Math.round(lv / step) % 5 === 0 });
    this.buildWells();
    this.buildProduction();
    this.renderFoot();
    this.draw();
  }

  private buildWells() {
    const f = this.app.field;
    const extra = this.app.flags.on('extraWells');
    const g = this.grid();
    const cross = (p: PathArrays) => (g ? horizonCrossing(p, g, f.meta.datumElevation) : null);
    const refs: PathRef[] = [];
    for (const c of f.context) if (!f.wells.some((w) => sameWell(w.name, c.name))) refs.push({ name: c.name, path: c, cross: null });
    for (const w of f.wells) if (!w.extra || extra || w === this.app.engine.activeWell) refs.push({ name: w.name, well: w, path: w.trajectory, cross: cross(w.trajectory) });
    this.paths = refs;
  }

  private buildProduction() {
    const f = this.app.field;
    const g = this.grid();
    this.producers = [];
    for (const [name, records] of f.productionMonthly) {
      const well = f.wells.find((w) => w.productionWell && sameWell(w.productionWell, name));
      const path: PathArrays | undefined = well?.trajectory ?? f.context.find((c) => sameWell(c.name, name));
      if (!path || !records.length) continue;
      const x = g ? horizonCrossing(path, g, f.meta.datumElevation) : null;
      const n = path.md.length - 1;
      this.producers.push({ name, well, records, ew: x ? x.ew : path.ew[n], ns: x ? x.ns : path.ns[n] });
    }
    this.span = productionSpan(this.producers.map((p) => p.records));
    if (this.span) {
      // the last month with production, shown mid-month
      this.span.t1 += 14 * 86400000;
      if (this.t < this.span.t0 || this.t > this.span.t1) this.t = this.span.t1;
    }
    let cum = 1;
    let rate = 1;
    for (const p of this.producers) {
      const end = productionAt(p.records, Infinity);
      cum = Math.max(cum, end.cumOil + end.cumWater, end.cumInj);
      for (let i = 0; i < p.records.length; i++) {
        const s = productionAt(p.records, p.records[i].t);
        rate = Math.max(rate, s.oilRate + s.waterRate, s.injRate);
      }
    }
    this.maxOil = { cum, rate };
  }

  // ------------------------------------------------------------------ date controls
  /** mid-month time of the v-th month after the first production month */
  private monthT(v: number): number {
    const d = new Date(this.span!.t0);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + v, 15);
  }

  private monthIndex(t: number): number {
    const a = new Date(this.span!.t0);
    const b = new Date(t);
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  }

  private syncSlider() {
    if (this.dateSlider && this.span) this.dateSlider.set(this.monthIndex(this.t));
  }

  private setPlaying(on: boolean) {
    this.playing = on && !!this.span;
    if (this.playing && this.span && this.t >= this.span.t1 - MONTH) this.t = this.span.t0;
    this.playBtn.innerHTML = this.playing ? I.pause : I.play;
  }

  private renderFoot() {
    this.foot.innerHTML = '';
    this.dateSlider = null;
    if (this.bubbles === 'none' || !this.span) {
      this.foot.append(h('span', { class: 'faint' }, this.span ? 'Production bubbles off.' : 'No production data loaded.'));
      return;
    }
    this.dateSlider = slider({
      label: 'Date',
      min: 0,
      max: this.monthIndex(this.span.t1),
      step: 1,
      value: this.monthIndex(this.t),
      format: (v) => monthKey(this.monthT(v)),
      onInput: (v) => {
        this.setPlaying(false);
        this.t = this.monthT(v);
        this.updateReadout();
        this.draw();
      },
    });
    this.dateSlider.el.classList.add('map-date');
    this.foot.append(this.playBtn, this.dateSlider.el);
  }

  // ------------------------------------------------------------------ view
  private fit(W: number, H: number) {
    const e = this.app.field.extent;
    const s = Math.min((W - 20) / (e.xMax - e.xMin), (H - 20) / (e.nMax - e.nMin));
    this.view = { cx: (e.xMin + e.xMax) / 2, cn: (e.nMin + e.nMax) / 2, s };
  }

  private sx(ew: number) {
    return this.W / 2 + (ew - this.view!.cx) * this.view!.s;
  }

  private sy(ns: number) {
    return this.H / 2 - (ns - this.view!.cn) * this.view!.s;
  }

  private world(x: number, y: number): { ew: number; ns: number } {
    const v = this.view!;
    return { ew: v.cx + (x - this.W / 2) / v.s, ns: v.cn - (y - this.H / 2) / v.s };
  }

  private bindPointer() {
    let drag: { x: number; y: number; cx: number; cn: number; moved: boolean } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.view) return;
      drag = { x: e.offsetX, y: e.offsetY, cx: this.view.cx, cn: this.view.cn, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (drag && this.view) {
        const dx = e.offsetX - drag.x;
        const dy = e.offsetY - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.userView = true;
          this.canvas.style.cursor = 'grabbing';
          this.view.cx = drag.cx - dx / this.view.s;
          this.view.cn = drag.cn + dy / this.view.s;
          this.draw();
        }
        return;
      }
      this.hoverPt = { x: e.offsetX, y: e.offsetY };
      this.updateReadout();
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      this.canvas.style.cursor = 'grab';
      if (d && !d.moved) this.click(e.offsetX, e.offsetY);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverPt = null;
      this.updateReadout();
      this.draw();
    });
    this.canvas.addEventListener('dblclick', () => {
      this.userView = false;
      this.fit(this.W, this.H);
      this.draw();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.view) return;
        e.preventDefault();
        this.userView = true;
        const before = this.world(e.offsetX, e.offsetY);
        this.view.s = Math.max(0.01, Math.min(5, this.view.s * Math.exp(-e.deltaY * 0.0015)));
        const after = this.world(e.offsetX, e.offsetY);
        this.view.cx += before.ew - after.ew;
        this.view.cn += before.ns - after.ns;
        this.draw();
      },
      { passive: false },
    );
  }

  /** nearest point on a detailed well path within r pixels */
  private pickWell(x: number, y: number, r = 10): { well: Well; md: number } | null {
    let best: { well: Well; md: number } | null = null;
    let bd = r * r;
    for (const p of this.paths) {
      if (!p.well) continue;
      const t = p.well.trajectory;
      for (let i = 0; i < t.md.length; i += 2) {
        const d = (this.sx(t.ew[i]) - x) ** 2 + (this.sy(t.ns[i]) - y) ** 2;
        if (d < bd) {
          bd = d;
          best = { well: p.well, md: t.md[i] };
        }
      }
    }
    return best;
  }

  private pickBubble(x: number, y: number): Bubble | null {
    if (this.bubbles === 'none') return null;
    for (const b of this.producers) {
      const r = Math.max(6, this.radius(b));
      if ((this.sx(b.ew) - x) ** 2 + (this.sy(b.ns) - y) ** 2 < r * r) return b;
    }
    return null;
  }

  private click(x: number, y: number) {
    if (!this.view) return;
    const p = this.pickWell(x, y);
    if (!p) return;
    if (p.well === this.app.engine.activeWell) this.app.travelTo(p.md);
    else void this.app.loadWellAsync(p.well.id, false).then(() => this.app.travelTo(p.md));
  }

  private updateReadout() {
    const g = this.grid();
    if (!this.hoverPt || !this.view || !g) {
      this.readout.textContent = 'Hover for depth · click a well to travel';
      return;
    }
    const w = this.world(this.hoverPt.x, this.hoverPt.y);
    const parts = [`E ${fmt.n(w.ew + this.app.field.meta.originE, 0)} N ${fmt.n(w.ns + this.app.field.meta.originN, 0)}`, `top ${FORMATION_BY_ID.get(g.id)?.name ?? g.id} ${fmt.n(sampleHorizon(g, w.ew, w.ns), 0)} m TVDSS`];
    const b = this.pickBubble(this.hoverPt.x, this.hoverPt.y);
    if (b) {
      const s = productionAt(b.records, this.t);
      parts.unshift(
        s.cumInj > 0 && s.cumOil === 0
          ? `${b.name}: injected ${fmt.big(s.cumInj)} Sm³ water · ${fmt.n(s.injRate, 0)} Sm³/d`
          : `${b.name}: cum. oil ${fmt.big(s.cumOil)} Sm³ · water ${fmt.big(s.cumWater)} Sm³ · ${fmt.n(s.oilRate, 0)} Sm³/d oil · WCT ${fmt.pct(s.waterCut)}`,
      );
    } else {
      const p = this.pickWell(this.hoverPt.x, this.hoverPt.y);
      if (p) parts.unshift(`${p.well.name} · MD ${fmt.n(p.md, 0)} m`);
    }
    this.readout.textContent = parts.join(' · ');
  }

  private radius(b: Bubble): number {
    const s = productionAt(b.records, this.t);
    const inj = s.cumInj > 0 && s.cumOil === 0;
    const v = this.bubbles === 'cum' ? (inj ? s.cumInj : s.cumOil + s.cumWater) : inj ? s.injRate : s.oilRate + s.waterRate;
    const max = this.bubbles === 'cum' ? this.maxOil.cum : this.maxOil.rate;
    return 24 * Math.sqrt(Math.max(0, v) / max);
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    if (!this.panel.visible) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, W, H } = fit;
    if (!this.view || (!this.userView && (W !== this.W || H !== this.H))) this.fit(W, H);
    this.W = W;
    this.H = H;
    const hz = this.grid();
    g.fillStyle = '#0b1119';
    g.fillRect(0, 0, W, H);
    if (!hz || !this.image) return;
    // depth image
    g.imageSmoothingEnabled = true;
    const x0 = this.sx(hz.x0 - hz.dx / 2);
    const x1 = this.sx(hz.x0 + (hz.nx - 0.5) * hz.dx);
    const y0 = this.sy(hz.z0 + (hz.nz - 0.5) * hz.dz);
    const y1 = this.sy(hz.z0 - hz.dz / 2);
    g.globalAlpha = 0.8;
    g.drawImage(this.image, x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = 1;
    // contours
    for (const c of this.contours) {
      g.strokeStyle = c.major ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.28)';
      g.lineWidth = c.major ? 1.2 : 0.7;
      g.beginPath();
      for (let i = 0; i < c.seg.length; i += 4) {
        g.moveTo(this.sx(c.seg[i]), this.sy(c.seg[i + 1]));
        g.lineTo(this.sx(c.seg[i + 2]), this.sy(c.seg[i + 3]));
      }
      g.stroke();
    }
    // oil–water contact where it meets this horizon
    const owc = this.app.flags.on('owc') ? this.app.feature<ContactsFeature>('owc')?.planeDepth : null;
    if (owc && owc > this.range.min && owc < this.range.max) {
      const seg = contourSegments(hz, owc);
      g.strokeStyle = '#4fb3ff';
      g.lineWidth = 2.2;
      g.setLineDash([7, 4]);
      g.beginPath();
      for (let i = 0; i < seg.length; i += 4) {
        g.moveTo(this.sx(seg[i]), this.sy(seg[i + 1]));
        g.lineTo(this.sx(seg[i + 2]), this.sy(seg[i + 3]));
      }
      g.stroke();
      g.setLineDash([]);
    }
    // section box
    const box = this.app.engine.geology?.box;
    if (box) {
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.strokeRect(this.sx(box.xMin), this.sy(box.nMax), (box.xMax - box.xMin) * this.view!.s, (box.nMax - box.nMin) * this.view!.s);
      g.setLineDash([]);
    }
    // well paths: context wells first, then detailed wells, active well last
    const active = this.app.engine.activeWell;
    const ordered = [...this.paths].sort((a, b) => (a.well ? 1 : 0) - (b.well ? 1 : 0) + (a.well === active ? 1 : 0) - (b.well === active ? 1 : 0));
    g.font = '10px Inter Variable, sans-serif';
    for (const p of ordered) {
      const isActive = p.well && p.well === active;
      const P = p.path;
      g.strokeStyle = isActive ? '#7fe3ff' : p.well ? 'rgba(240,244,248,0.85)' : 'rgba(200,210,220,0.35)';
      g.lineWidth = isActive ? 2.6 : p.well ? 1.4 : 1;
      g.beginPath();
      for (let i = 0; i < P.md.length; i++) (i ? g.lineTo(this.sx(P.ew[i]), this.sy(P.ns[i])) : g.moveTo(this.sx(P.ew[i]), this.sy(P.ns[i])));
      g.stroke();
      if (!p.well) continue;
      // where the well meets the horizon, else its TD
      const x = p.cross;
      const n = P.md.length - 1;
      const ex = this.sx(x ? x.ew : P.ew[n]);
      const ey = this.sy(x ? x.ns : P.ns[n]);
      g.fillStyle = isActive ? '#7fe3ff' : '#f0f4f8';
      g.strokeStyle = '#0b0e13';
      g.lineWidth = 1.5;
      g.beginPath();
      if (x) g.arc(ex, ey, 3.2, 0, Math.PI * 2);
      else g.rect(ex - 2.5, ey - 2.5, 5, 5);
      g.fill();
      g.stroke();
      g.fillStyle = isActive ? '#7fe3ff' : 'rgba(240,244,248,0.85)';
      g.textAlign = 'left';
      g.fillText(p.name.replace(/^15\/9-/, ''), ex + 5, ey - 4);
    }
    // production bubbles
    if (this.bubbles !== 'none') this.drawBubbles(g);
    // platform
    g.fillStyle = '#ffd27a';
    g.beginPath();
    g.arc(this.sx(0), this.sy(0), 3.5, 0, Math.PI * 2);
    g.fill();
    // cursor on the active well and the camera
    if (active) {
      const c = active.trajectory.at(Math.min(this.app.engine.rig.md, active.trajectory.mdEnd));
      g.fillStyle = '#7fe3ff';
      g.strokeStyle = '#0b0e13';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(this.sx(c.ew), this.sy(c.ns), 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    this.drawCamera(g);
    this.drawLegend(g, W, H, owc ?? null);
  }

  private drawBubbles(g: CanvasRenderingContext2D) {
    for (const b of this.producers) {
      const s = productionAt(b.records, this.t);
      const r = this.radius(b);
      if (r < 0.5) continue;
      const x = this.sx(b.ew);
      const y = this.sy(b.ns);
      if (s.cumInj > 0 && s.cumOil === 0) {
        g.fillStyle = 'rgba(64,140,210,0.25)';
        g.strokeStyle = WATER;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        continue;
      }
      const oil = this.bubbles === 'cum' ? s.cumOil : s.oilRate;
      const water = this.bubbles === 'cum' ? s.cumWater : s.waterRate;
      const wf = oil + water > 0 ? water / (oil + water) : 0;
      const a0 = -Math.PI / 2;
      g.globalAlpha = 0.85;
      g.fillStyle = OIL;
      g.beginPath();
      g.moveTo(x, y);
      g.arc(x, y, r, a0 + wf * Math.PI * 2, a0 + Math.PI * 2);
      g.closePath();
      g.fill();
      if (wf > 0) {
        g.fillStyle = WATER;
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, r, a0, a0 + wf * Math.PI * 2);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
    }
  }

  private drawCamera(g: CanvasRenderingContext2D) {
    const e = this.app.engine;
    const p = e.coords.fromScene(e.camera.position);
    const dir = e.camera.getWorldDirection(new THREE.Vector3());
    const hd = Math.hypot(dir.x, dir.z);
    const x = this.sx(p.ew);
    const y = this.sy(p.ns);
    if (x < -20 || y < -20 || x > this.W + 20 || y > this.H + 20) return;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 1;
    if (hd > 0.05) {
      // plan heading: scene x = east, −z = north
      const ang = Math.atan2(-dir.z, dir.x);
      const L = 16;
      const sp = 0.45;
      g.globalAlpha = 0.35;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang - sp) * L, y - Math.sin(ang - sp) * L);
      g.lineTo(x + Math.cos(ang + sp) * L, y - Math.sin(ang + sp) * L);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
    }
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  private drawLegend(g: CanvasRenderingContext2D, W: number, H: number, owc: number | null) {
    // depth colour bar
    const bw = 12;
    const bh = Math.min(140, H - 60);
    const bx = W - bw - 42;
    const by = 12;
    g.fillStyle = 'rgba(8,11,15,0.75)';
    g.fillRect(bx - 8, by - 6, bw + 48, bh + 30);
    for (let i = 0; i < bh; i++) {
      g.fillStyle = toCss(colormap('viridis', 1 - i / bh));
      g.fillRect(bx, by + i, bw, 1);
    }
    g.font = '9.5px "IBM Plex Mono", monospace';
    g.fillStyle = 'rgba(231,236,241,0.8)';
    g.textAlign = 'left';
    g.fillText(fmt.n(this.range.min, 0), bx + bw + 4, by + 8);
    g.fillText(fmt.n(this.range.max, 0), bx + bw + 4, by + bh);
    if (owc) {
      const oy = by + ((owc - this.range.min) / (this.range.max - this.range.min)) * bh;
      g.fillStyle = '#4fb3ff';
      g.fillRect(bx - 3, oy - 1, bw + 6, 2);
      g.fillText('OWC', bx + bw + 4, oy + 3);
    }
    g.fillStyle = 'rgba(231,236,241,0.55)';
    g.fillText('m TVDSS', bx - 4, by + bh + 16);
    // scale bar
    const s = this.view!.s;
    const len = niceStep(120 / s);
    const px = len * s;
    const sx = 12;
    const sy = H - 14;
    g.strokeStyle = 'rgba(231,236,241,0.8)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + px, sy);
    g.stroke();
    g.fillStyle = 'rgba(231,236,241,0.8)';
    g.font = '10px Inter Variable, sans-serif';
    g.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, sx + px + 6, sy + 4);
    // north arrow
    const nx = 22;
    const ny = 26;
    g.beginPath();
    g.moveTo(nx, ny - 12);
    g.lineTo(nx + 6, ny + 4);
    g.lineTo(nx, ny);
    g.lineTo(nx - 6, ny + 4);
    g.closePath();
    g.fill();
    g.fillText('N', nx - 3.5, ny + 16);
    if (this.bubbles !== 'none' && this.span) {
      g.textAlign = 'right';
      g.fillStyle = 'rgba(231,236,241,0.85)';
      g.font = '600 11px Inter Variable, sans-serif';
      g.fillText(monthKey(this.t), W - 12, H - 10);
    }
  }
}
