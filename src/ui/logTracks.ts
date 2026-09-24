import type { Well } from '../data/dataset';
import { findCurve, sampleCurve } from '../data/las';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { colormap, resToT, RES_RANGE, type ColormapName } from '../data/colormap';
import type { Curve } from '../data/types';
import { h, fmt } from './dom';

interface Scale {
  min: number;
  max: number;
  log?: boolean;
}

interface CurveSpec {
  key: string; // alias key or mnemonic
  label: string;
  color: string;
  scale: Scale;
  dash?: number[];
  width?: number;
  source?: 'logs' | 'petro' | 'cpi';
  petroKey?: 'vsh' | 'phie' | 'sw';
  cpiKey?: string;
}

interface TrackSpec {
  id: string;
  title: string;
  flex: number;
  prov: 'measured' | 'calculated' | 'interpreted' | 'mixed';
  curves: CurveSpec[];
  grid?: 'linear' | 'log';
  fill?: 'gr' | 'nd' | 'sw' | 'vsh-phi' | 'res-strip';
}

const TRACKS: TrackSpec[] = [
  {
    id: 'gr',
    title: 'Gamma · Caliper',
    flex: 1,
    prov: 'measured',
    fill: 'gr',
    curves: [
      { key: 'GR', label: 'GR', color: '#9be27a', scale: { min: 0, max: 150 } },
      { key: 'CALI', label: 'CALI', color: '#d9dde2', scale: { min: 6, max: 16 }, dash: [3, 2], width: 1 },
      { key: 'BS', label: 'BS', color: '#6d7986', scale: { min: 6, max: 16 }, dash: [1, 2], width: 1 },
    ],
  },
  {
    id: 'res',
    title: 'Resistivity',
    flex: 1.2,
    prov: 'measured',
    grid: 'log',
    fill: 'res-strip',
    curves: [
      { key: 'RT', label: 'RT deep', color: '#ff8a65', scale: { min: RES_RANGE.min, max: RES_RANGE.max, log: true }, width: 1.6 },
      { key: 'RSHAL', label: 'R shallow', color: '#ffd166', scale: { min: RES_RANGE.min, max: RES_RANGE.max, log: true }, dash: [3, 2], width: 1 },
    ],
  },
  {
    id: 'nd',
    title: 'Density · Neutron',
    flex: 1.05,
    prov: 'measured',
    fill: 'nd',
    curves: [
      { key: 'RHOB', label: 'RHOB', color: '#ff6b81', scale: { min: 1.95, max: 2.95 } },
      { key: 'NPHI', label: 'NPHI', color: '#5aa9e6', scale: { min: 0.45, max: -0.15 }, dash: [4, 2] },
    ],
  },
  {
    id: 'dt',
    title: 'Sonic',
    flex: 0.8,
    prov: 'measured',
    curves: [
      { key: 'DT', label: 'DTC', color: '#c792ea', scale: { min: 140, max: 40 } },
      { key: 'DTS', label: 'DTS', color: '#82aaff', scale: { min: 340, max: 90 }, dash: [3, 2], width: 1 },
    ],
  },
  {
    id: 'vp',
    title: 'Vsh · Porosity',
    flex: 0.95,
    prov: 'calculated',
    fill: 'vsh-phi',
    curves: [
      { key: 'VSH_CALC', label: 'VSH', color: '#b8bec6', scale: { min: 0, max: 1 }, source: 'petro', petroKey: 'vsh', width: 1 },
      { key: 'PHIE_CALC', label: 'PHIE', color: '#7fe3ff', scale: { min: 0.5, max: 0 }, source: 'petro', petroKey: 'phie' },
    ],
  },
  {
    id: 'sw',
    title: 'Saturation',
    flex: 1.05,
    prov: 'mixed',
    fill: 'sw',
    curves: [
      { key: 'SW_CALC', label: 'Sw calc', color: '#6fb6ff', scale: { min: 0, max: 1 }, source: 'petro', petroKey: 'sw', width: 1.5 },
      { key: 'SW', label: 'Sw CPI', color: '#b8a2ff', scale: { min: 0, max: 1 }, source: 'cpi', cpiKey: 'SW', dash: [3, 2], width: 1.2 },
    ],
  },
];

const HEADER_H = 86;
const DEPTH_W = 46;
const ZONE_W = 9;
const HOLE_W = 9;
const PAY_W = 7;

/**
 * Conventional well-log display (Techlog / Petrel style) drawn on a canvas and
 * synchronised with the 3D scene cursor.
 */
export class LogTracks {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readout: HTMLElement;
  private well?: Well;
  cursorMd = 0;
  hoverMd: number | null = null;
  window = 160;
  private dirty = true;
  colormap: ColormapName = 'resistivity';
  onPick?: (md: number) => void;
  onHover?: (md: number | null) => void;
  onScroll?: (md: number) => void;
  private winLabel: HTMLElement;
  private layout: { x: number; w: number; spec?: TrackSpec; kind: string }[] = [];

  constructor() {
    this.canvas = h('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.readout = h('div', { class: 'logs-readout' });
    this.winLabel = h('span', { class: 'mono faint', style: 'font-size:10.5px;min-width:44px;text-align:center' });
    const zoom = (f: number) => {
      this.window = Math.max(20, Math.min(4000, this.window * f));
      this.dirty = true;
    };
    const wrap = h('div', { class: 'logs-canvas-wrap' }, this.canvas, this.readout);
    this.el = h(
      'div',
      { class: 'panel right glass', id: 'logs-panel' },
      h(
        'div',
        { class: 'logs-head' },
        h('h3', {}, 'Well logs'),
        h('span', { class: 'chip measured', title: 'Acquired by logging tools, as delivered by the operator' }, 'M'),
        h('span', { class: 'chip calculated', title: 'Computed live in this app from measured inputs' }, 'C'),
        h('span', { class: 'chip interpreted', title: "Operator's published interpretation (Equinor CPI)" }, 'I'),
        h('div', { style: 'flex:1' }),
        h('button', { class: 'btn icon ghost', title: 'Zoom out', onclick: () => zoom(1.6) }, '−'),
        this.winLabel,
        h('button', { class: 'btn icon ghost', title: 'Zoom in', onclick: () => zoom(1 / 1.6) }, '+'),
      ),
      wrap,
    );
    new ResizeObserver(() => (this.dirty = true)).observe(wrap);
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverMd = null;
      this.readout.style.display = 'none';
      this.onHover?.(null);
      this.dirty = true;
    });
    this.canvas.addEventListener('click', (e) => {
      const md = this.mdAtY(e.offsetY);
      if (md !== null) this.onPick?.(md);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || e.altKey) zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
        else this.onScroll?.(this.cursorMd + (e.deltaY / 100) * this.window * 0.08);
      },
      { passive: false },
    );
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
    };
    requestAnimationFrame(loop);
  }

  setWell(w: Well) {
    this.well = w;
    this.dirty = true;
  }
  invalidate() {
    this.dirty = true;
  }
  setCursor(md: number) {
    if (Math.abs(md - this.cursorMd) > 1e-3) {
      this.cursorMd = md;
      this.dirty = true;
    }
  }

  private range() {
    return { top: this.cursorMd - this.window / 2, bot: this.cursorMd + this.window / 2 };
  }

  private mdAtY(y: number): number | null {
    const H = this.canvas.clientHeight;
    if (y < HEADER_H) return null;
    const { top, bot } = this.range();
    return top + ((y - HEADER_H) / (H - HEADER_H)) * (bot - top);
  }

  private move(e: PointerEvent) {
    const md = this.mdAtY(e.offsetY);
    if (md === null || !this.well) {
      this.readout.style.display = 'none';
      return;
    }
    this.hoverMd = md;
    this.onHover?.(md);
    this.dirty = true;
    this.readout.innerHTML = this.readoutHtml(md);
    this.readout.style.display = 'block';
    const W = this.canvas.clientWidth;
    const rw = this.readout.offsetWidth;
    const x = e.offsetX + 14 + rw > W ? e.offsetX - rw - 14 : e.offsetX + 14;
    this.readout.style.left = `${Math.max(4, x)}px`;
    this.readout.style.top = `${Math.min(this.canvas.clientHeight - this.readout.offsetHeight - 6, e.offsetY + 12)}px`;
  }

  private readoutHtml(md: number): string {
    const w = this.well!;
    const logs = w.logs;
    const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
    const z = w.zoneAt(md);
    const row = (k: string, v: string, cls = 'm') => `<div><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;
    let s = `<div style="color:#fff;margin-bottom:3px">${fmt.n(md, 1)} m MD · ${fmt.n(t.tvd, 1)} TVD</div>`;
    s += `<div style="color:var(--text-2);margin-bottom:4px">${z?.name ?? ''}</div>`;
    if (logs) {
      const v = (k: string) => {
        const c = findCurve(logs, k);
        return c ? sampleCurve(logs.depth, c.values, md) : NaN;
      };
      s += row('GR', `${fmt.n(v('GR'), 1)} API`);
      s += row('RT', `${fmt.res(v('RT'))} Ω·m`);
      s += row('R shal', `${fmt.res(v('RSHAL'))} Ω·m`);
      s += row('RHOB', `${fmt.n(v('RHOB'), 3)} g/cm³`);
      s += row('NPHI', `${fmt.n(v('NPHI'), 3)} v/v`);
      if (findCurve(logs, 'DT')) s += row('DTC', `${fmt.n(v('DT'), 1)} µs/ft`);
      s += row('CALI', `${fmt.n(v('CALI'), 2)} in`);
      const p = w.petro;
      if (p) {
        const pv = (c: Curve) => sampleCurve(logs.depth, c.values, md);
        s += '<div style="height:4px"></div>';
        s += row('Vsh', fmt.pct(pv(p.vsh)), 'c');
        s += row('PHIE', fmt.pct(pv(p.phie), 1), 'c');
        s += row('Sw', fmt.pct(pv(p.sw)), 'c');
        s += row('So', fmt.pct(pv(p.so)), 'c');
      }
      if (w.cpi) {
        const c = w.cpi.curves.get('SW');
        const ph = w.cpi.curves.get('PHIF');
        if (c) s += row('Sw CPI', fmt.pct(sampleCurve(w.cpi.depth, c.values, md)), 'i');
        if (ph) s += row('PHIF CPI', fmt.pct(sampleCurve(w.cpi.depth, ph.values, md), 1), 'i');
      }
    }
    return s;
  }

  private curveFor(spec: CurveSpec): { depth: Float64Array; values: Float32Array } | null {
    const w = this.well;
    if (!w?.logs) return null;
    if (spec.source === 'petro') {
      const p = w.petro;
      if (!p || !spec.petroKey) return null;
      return { depth: w.logs.depth, values: p[spec.petroKey].values };
    }
    if (spec.source === 'cpi') {
      const c = w.cpi?.curves.get(spec.cpiKey!);
      return c ? { depth: w.cpi!.depth, values: c.values } : null;
    }
    const c = findCurve(w.logs, spec.key);
    return c ? { depth: w.logs.depth, values: c.values } : null;
  }

  private draw() {
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (W === 0 || H === 0) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    this.winLabel.textContent = `${Math.round(this.window)} m`;
    const w = this.well;
    if (!w) return;
    const { top, bot } = this.range();
    const bodyH = H - HEADER_H;
    const yOf = (md: number) => HEADER_H + ((md - top) / (bot - top)) * bodyH;

    // layout
    const fixed = DEPTH_W + ZONE_W + HOLE_W + PAY_W + 6;
    const flexTotal = TRACKS.reduce((s, t) => s + t.flex, 0);
    const avail = W - fixed - 4;
    let x = 2;
    this.layout = [];
    this.layout.push({ x, w: DEPTH_W, kind: 'depth' });
    x += DEPTH_W;
    this.layout.push({ x, w: ZONE_W, kind: 'zone' });
    x += ZONE_W + 1;
    this.layout.push({ x, w: HOLE_W, kind: 'hole' });
    x += HOLE_W + 2;
    for (const t of TRACKS) {
      const tw = (t.flex / flexTotal) * avail;
      this.layout.push({ x, w: tw, spec: t, kind: 'track' });
      x += tw;
    }
    this.layout.push({ x: x + 1, w: PAY_W, kind: 'pay' });

    g.font = '500 9.5px "IBM Plex Mono", monospace';
    g.textBaseline = 'middle';
    // depth track
    const step = niceStep(this.window / 8);
    g.fillStyle = 'rgba(255,255,255,0.02)';
    g.fillRect(2, HEADER_H, DEPTH_W, bodyH);
    for (let d = Math.ceil(top / step) * step; d <= bot; d += step) {
      const y = yOf(d);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.beginPath();
      g.moveTo(DEPTH_W + 2, y);
      g.lineTo(W, y);
      g.stroke();
      if (d < 0 || d > w.tdMD) continue;
      g.fillStyle = '#a3aeb9';
      g.textAlign = 'right';
      g.fillText(d.toFixed(step < 1 ? 1 : 0), DEPTH_W - 2, y - 5);
      const tv = w.trajectory.at(Math.min(d, w.trajectory.mdEnd)).tvd;
      g.fillStyle = '#4a5561';
      g.fillText(tv.toFixed(0), DEPTH_W - 2, y + 6);
    }
    // minor grid
    const minor = step / 5;
    g.strokeStyle = 'rgba(255,255,255,0.025)';
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
      const y0 = Math.max(HEADER_H, yOf(z.topMD));
      const y1 = Math.min(H, yOf(z.baseMD));
      const col = z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a1f26' : FORMATION_BY_ID.get(z.formationId)?.color ?? '#555';
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
      const y0 = Math.max(HEADER_H, yOf(s.topMD));
      const y1 = Math.min(H, yOf(s.baseMD));
      const hw = (Math.min(s.hole, 36) / 36) * hl.w;
      g.fillStyle = 'rgba(160,140,110,0.35)';
      g.fillRect(hl.x + (hl.w - hw) / 2, y0, hw, y1 - y0);
    }
    for (const c of w.casing) {
      if (c.shoeMD < top || c.topMD > bot) continue;
      const y1 = Math.min(H, yOf(c.shoeMD));
      const cw = (Math.min(c.od, 36) / 36) * hl.w;
      g.fillStyle = '#aab3bc';
      g.fillRect(hl.x + (hl.w - cw) / 2 - 1, Math.max(HEADER_H, yOf(c.topMD)), 1, y1 - Math.max(HEADER_H, yOf(c.topMD)));
      g.fillRect(hl.x + (hl.w + cw) / 2, Math.max(HEADER_H, yOf(c.topMD)), 1, y1 - Math.max(HEADER_H, yOf(c.topMD)));
      if (c.shoeMD <= bot && c.shoeMD >= top) {
        g.beginPath();
        g.moveTo(hl.x, y1);
        g.lineTo(hl.x + hl.w / 2, y1 - 5);
        g.lineTo(hl.x + hl.w, y1);
        g.fill();
      }
    }

    // tracks
    for (const L of this.layout) {
      if (L.kind !== 'track' || !L.spec) continue;
      this.drawTrack(g, L.x, L.w, L.spec, top, bot, yOf, H);
    }

    // pay flags
    const pl = this.layout[this.layout.length - 1];
    if (w.petro && w.logs) {
      const d = w.logs.depth;
      g.fillStyle = '#ffb547';
      for (let py = HEADER_H; py < H; py++) {
        const md = top + ((py - HEADER_H) / bodyH) * (bot - top);
        const k = nearest(d, md);
        if (k >= 0 && w.petro.pay[k]) g.fillRect(pl.x, py, pl.w, 1);
      }
    }
    g.fillStyle = '#6d7986';
    g.save();
    g.translate(pl.x + pl.w / 2 + 1, 40);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText('PAY', 0, 0);
    g.restore();

    // headers background + separators
    g.fillStyle = 'rgba(0,0,0,0.0)';
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.moveTo(0, HEADER_H + 0.5);
    g.lineTo(W, HEADER_H + 0.5);
    g.stroke();
    g.fillStyle = '#6d7986';
    g.textAlign = 'center';
    g.fillText('MD', 2 + DEPTH_W / 2, 16);
    g.fillStyle = '#4a5561';
    g.fillText('TVD', 2 + DEPTH_W / 2, 30);
    g.save();
    g.translate(zl.x + ZONE_W / 2, 44);
    g.rotate(-Math.PI / 2);
    g.fillStyle = '#6d7986';
    g.fillText('FM', 0, 0);
    g.restore();
    g.save();
    g.translate(hl.x + HOLE_W / 2 + 1, 44);
    g.rotate(-Math.PI / 2);
    g.fillStyle = '#6d7986';
    g.fillText('HOLE', 0, 0);
    g.restore();

    // cursor & hover lines
    const yc = yOf(this.cursorMd);
    g.strokeStyle = 'rgba(127,227,255,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, yc);
    g.lineTo(W, yc);
    g.stroke();
    g.fillStyle = '#7fe3ff';
    g.beginPath();
    g.moveTo(0, yc - 4);
    g.lineTo(5, yc);
    g.lineTo(0, yc + 4);
    g.fill();
    if (this.hoverMd !== null) {
      const yh = yOf(this.hoverMd);
      g.strokeStyle = 'rgba(255,217,160,0.6)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, yh);
      g.lineTo(W, yh);
      g.stroke();
      g.setLineDash([]);
    }
  }

  private drawTrack(
    g: CanvasRenderingContext2D,
    x: number,
    w: number,
    t: TrackSpec,
    top: number,
    bot: number,
    _yOf: (md: number) => number,
    H: number,
  ) {
    const bodyTop = HEADER_H;
    const bodyH = H - HEADER_H;
    // frame
    g.fillStyle = 'rgba(255,255,255,0.018)';
    g.fillRect(x + 1, bodyTop, w - 2, bodyH);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.strokeRect(x + 1.5, 2.5, w - 3, H - 4);
    // vertical grid
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    if (t.grid === 'log') {
      const a = Math.log10(RES_RANGE.min);
      const b = Math.log10(RES_RANGE.max);
      for (let e = Math.ceil(a); e <= b; e++) {
        for (let k = 1; k < 10; k++) {
          const v = Math.log10(k * Math.pow(10, e));
          if (v < a || v > b) continue;
          const gx = x + 1 + ((v - a) / (b - a)) * (w - 2);
          g.strokeStyle = k === 1 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.03)';
          g.beginPath();
          g.moveTo(gx, bodyTop);
          g.lineTo(gx, H);
          g.stroke();
        }
      }
    } else {
      for (let k = 1; k < 5; k++) {
        const gx = Math.round(x + 1 + (k / 5) * (w - 2)) + 0.5;
        g.beginPath();
        g.moveTo(gx, bodyTop);
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
      const out = new Float32Array(Math.max(0, Math.ceil(bodyH)));
      let any = false;
      for (let py = 0; py < out.length; py++) {
        const md = top + (py / bodyH) * (bot - top);
        const v = sampleCurve(c.depth, c.values, md);
        out[py] = v;
        if (Number.isFinite(v)) any = true;
      }
      return { vals: out, any, exists: true };
    };
    const data = t.curves.map((c) => samples(c));
    g.save();
    g.beginPath();
    g.rect(x + 1, bodyTop, w - 2, bodyH);
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
        g.fillRect(x + 1, bodyTop + py, xv(s, v) - x - 1, 1);
      }
    }
    if (t.fill === 'res-strip' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (!Number.isFinite(v)) continue;
        const c = colormap(this.colormap, resToT(v));
        g.fillStyle = `rgb(${c[0] * 255},${c[1] * 255},${c[2] * 255})`;
        g.fillRect(x + w - 7, bodyTop + py, 5, 1);
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
        g.fillRect(Math.min(xr, xn), bodyTop + py, Math.abs(xn - xr), 1);
      }
    }
    if (t.fill === 'vsh-phi' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (Number.isFinite(v)) {
          g.fillStyle = 'rgba(140,146,152,0.35)';
          g.fillRect(x + 1, bodyTop + py, xv(t.curves[0].scale, v) - x - 1, 1);
        }
        const ph = data[1]?.vals[py];
        if (ph !== undefined && Number.isFinite(ph)) {
          g.fillStyle = 'rgba(127,227,255,0.35)';
          const xp = xv(t.curves[1].scale, ph);
          g.fillRect(xp, bodyTop + py, x + w - 1 - xp, 1);
        }
      }
    }
    if (t.fill === 'sw' && data[0]) {
      for (let py = 0; py < data[0].vals.length; py++) {
        const v = data[0].vals[py];
        if (!Number.isFinite(v)) continue;
        const xs = xv(t.curves[0].scale, v);
        g.fillStyle = 'rgba(70,140,215,0.35)';
        g.fillRect(x + 1, bodyTop + py, xs - x - 1, 1);
        g.fillStyle = 'rgba(255,170,50,0.55)';
        g.fillRect(xs, bodyTop + py, x + w - 1 - xs, 1);
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
        if (!pen) g.moveTo(px, bodyTop + py);
        else g.lineTo(px, bodyTop + py);
        pen = true;
      }
      g.stroke();
      g.setLineDash([]);
    });
    g.restore();

    // "not acquired" notice
    const primaryMissing = !data[0] || !data[0].any;
    if (primaryMissing) {
      g.save();
      g.fillStyle = '#4a5561';
      g.textAlign = 'center';
      g.font = '500 9.5px Inter Variable, sans-serif';
      const msg = !data[0] ? (t.prov === 'calculated' ? 'Inputs missing' : 'Not acquired') : 'No data in window';
      g.translate(x + w / 2, bodyTop + bodyH / 2);
      g.rotate(-Math.PI / 2);
      g.fillText(msg, 0, 0);
      g.restore();
    }

    // header
    g.save();
    g.textAlign = 'left';
    g.font = '600 9px Inter Variable, sans-serif';
    const provColor = { measured: '#7fe3ff', calculated: '#ffb547', interpreted: '#b8a2ff', mixed: '#ffb547' }[t.prov];
    g.fillStyle = provColor;
    g.fillRect(x + 4, 7, 3, 9);
    g.fillStyle = '#a3aeb9';
    g.fillText(t.title.toUpperCase(), x + 10, 12, w - 14);
    let hy = 24;
    t.curves.forEach((spec, i) => {
      const exists = !!data[i];
      g.globalAlpha = exists ? 1 : 0.28;
      g.font = '600 9px Inter Variable, sans-serif';
      g.fillStyle = spec.color;
      g.textAlign = 'left';
      g.fillText(spec.label, x + 5, hy, w - 10);
      g.strokeStyle = spec.color;
      g.setLineDash(spec.dash ?? []);
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(x + 5, hy + 7);
      g.lineTo(x + w - 5, hy + 7);
      g.stroke();
      g.setLineDash([]);
      g.font = '500 8.5px "IBM Plex Mono", monospace';
      g.fillStyle = '#6d7986';
      g.fillText(fmtNum(spec.scale.min), x + 5, hy + 14);
      g.textAlign = 'right';
      g.fillText(fmtNum(spec.scale.max), x + w - 5, hy + 14);
      g.globalAlpha = 1;
      hy += 21;
    });
    g.restore();
  }
}

function fmtNum(v: number) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(v % 1 ? 2 : 0);
  return v.toFixed(2);
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
