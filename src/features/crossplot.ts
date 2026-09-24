import * as THREE from 'three';
import { toCss } from '../data/colormap';
import { CROSSPLOTS, bvwLine, crossplotPoints, matrixLine, mdIntervals, pickettLine, type Axis, type CrossplotKind, type XPoint } from '../data/crossplot';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { App } from '../ui/app';
import { chip, fmt, h } from '../ui/dom';
import { FloatingPanel, fitCanvas } from '../ui/floating';
import { CURVE_BY_KEY } from './curves';
import type { FeatureModule } from './registry';

type ColourBy = 'formation' | 'gr' | 'sw' | 'md';

const SEL_COLOR = '#ff5fd2';
const PAD = { l: 52, r: 14, t: 12, b: 34 };

/**
 * Crossplots of the active well (density–neutron, Pickett, Buckles) linked to
 * the 3D view: hovering a point highlights its depth on the borehole, a click
 * travels there, and a dragged box selects samples that are then marked
 * along the well in 3D and listed as depth intervals.
 */
export class CrossplotFeature implements FeatureModule {
  readonly id = 'crossplot' as const;
  private panel: FloatingPanel;
  private canvas = h('canvas', { class: 'fp-canvas', style: 'cursor:crosshair' });
  private layer = document.createElement('canvas');
  private readout = h('div', { class: 'fp-readout mono' });
  private foot = h('div', { class: 'fp-foot' });
  private kind: CrossplotKind = 'pickett';
  private zone = 'reservoir';
  private colourBy: ColourBy = 'formation';
  private pts: XPoint[] = [];
  private selected = new Set<number>(); // indices into pts
  private dirty = true;
  private lastMd = -1;
  private brush: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private tx: ((v: number) => number) | null = null;
  private ty: ((v: number) => number) | null = null;
  private zoneSel: HTMLSelectElement;
  private markers?: THREE.Points;
  private wellId = '';

  constructor(private app: App) {
    const kindSel = h('select', { class: 'select', title: 'Crossplot' }) as HTMLSelectElement;
    for (const [k, d] of Object.entries(CROSSPLOTS)) kindSel.append(h('option', { value: k }, d.label));
    kindSel.value = this.kind;
    kindSel.onchange = () => {
      this.kind = kindSel.value as CrossplotKind;
      this.clearSelection();
      this.rebuild();
    };
    this.zoneSel = h('select', { class: 'select', title: 'Depth interval' }) as HTMLSelectElement;
    this.zoneSel.onchange = () => {
      this.zone = this.zoneSel.value;
      this.clearSelection();
      this.rebuild();
    };
    const colSel = h('select', { class: 'select', title: 'Colour points by' }) as HTMLSelectElement;
    for (const [v, l] of [
      ['formation', 'Formation'],
      ['gr', 'Gamma ray'],
      ['sw', 'Sw'],
      ['md', 'Depth'],
    ])
      colSel.append(h('option', { value: v }, l));
    colSel.onchange = () => {
      this.colourBy = colSel.value as ColourBy;
      this.dirty = true;
      this.draw();
    };
    this.panel = new FloatingPanel({
      id: 'crossplot',
      title: 'Crossplot',
      badge: chip('calculated'),
      width: 470,
      height: 440,
      place: 'bottom-left',
      headExtra: [kindSel, this.zoneSel, colSel],
      onClose: () => app.flags.set('crossplot', false),
    });
    this.panel.body.append(this.canvas, this.readout, this.foot);
    this.panel.onResize = () => {
      this.dirty = true;
      this.draw();
    };
    this.bindPointer();
  }

  enable() {
    this.panel.show();
    // the well may have changed while the feature was off
    this.selected.clear();
    this.rebuild();
    this.renderFoot();
  }

  disable() {
    this.panel.hide();
    this.setMarkers([]);
    this.hoverMd(null);
  }

  onWell() {
    // new well, or the interpretation changed (φ, Sw and the Pickett lines depend on it)
    const same = this.app.engine.activeWell?.id === this.wellId;
    const keep = same ? this.selectedMds() : [];
    this.selected.clear();
    this.rebuild();
    // keep a selection across re-interpretation of the same samples
    if (keep.length) {
      const set = new Set(keep);
      this.pts.forEach((p, i) => set.has(p.md) && this.selected.add(i));
    }
    this.applySelection();
  }

  frame() {
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.25) return;
    this.lastMd = md;
    this.draw();
  }

  settings() {
    return h(
      'div',
      { class: 'feat-note' },
      'Pickett: the Sw = 1 water line and iso-Sw lines follow a, m, n and Rw from the Interpretation drawer, so the water line should run along the wet sands when the parameters are right. Hover a point to see its depth in 3D, click to travel there, drag a box to mark samples along the well.',
    );
  }

  private rebuild() {
    const w = this.app.engine.activeWell;
    this.wellId = w?.id ?? '';
    this.fillZones();
    if (!w?.logs) {
      this.pts = [];
    } else {
      const zones = w.zones;
      let opts: { fromMD?: number; toMD?: number; formationId?: string } = {};
      if (this.zone === 'reservoir') {
        const res = zones.filter((z) => ['draupne', 'heather', 'hugin', 'sleipner', 'skagerrak'].includes(z.formationId));
        if (res.length) opts = { fromMD: res[0].topMD, toMD: res[res.length - 1].baseMD };
      } else if (this.zone) opts = { formationId: this.zone };
      this.pts = crossplotPoints(this.kind, w.logs, w.petro, zones, opts);
    }
    const inputs = this.kind === 'nd' ? 'measured' : 'calculated';
    const badge = this.panel.head.querySelector('.chip');
    if (badge) {
      badge.className = `chip ${inputs}`;
      badge.textContent = inputs === 'measured' ? 'Measured' : 'Calculated';
    }
    this.dirty = true;
    this.renderFoot();
    this.draw();
  }

  private fillZones() {
    const w = this.app.engine.activeWell;
    const prev = this.zone;
    this.zoneSel.innerHTML = '';
    this.zoneSel.append(h('option', { value: 'reservoir' }, 'Reservoir'), h('option', { value: '' }, 'All logged depths'));
    const seen = new Set<string>();
    for (const z of w?.zones ?? []) {
      if (seen.has(z.formationId) || z.formationId === 'air' || z.formationId === 'sea') continue;
      seen.add(z.formationId);
      this.zoneSel.append(h('option', { value: z.formationId }, z.name));
    }
    this.zone = [...this.zoneSel.options].some((o) => o.value === prev) ? prev : 'reservoir';
    this.zoneSel.value = this.zone;
  }

  // ------------------------------------------------------------------ axes
  private scale(a: Axis, p0: number, p1: number): (v: number) => number {
    const f = a.log ? Math.log10 : (v: number) => v;
    const lo = f(a.min);
    const hi = f(a.max);
    const [s0, s1] = a.reversed ? [p1, p0] : [p0, p1];
    return (v: number) => s0 + ((f(Math.max(v, a.log ? 1e-6 : -Infinity)) - lo) / (hi - lo)) * (s1 - s0);
  }

  private colour(p: XPoint): string {
    if (this.colourBy === 'formation') return FORMATION_BY_ID.get(p.formationId)?.color ?? '#9aa';
    if (this.colourBy === 'gr') {
      const d = CURVE_BY_KEY.get('GR')!;
      return Number.isFinite(p.gr) ? toCss(d.color(p.gr, this.app.colormapName)) : '#777';
    }
    if (this.colourBy === 'sw') {
      const d = CURVE_BY_KEY.get('SO')!;
      return Number.isFinite(p.sw) ? toCss(d.color(p.sw, this.app.colormapName)) : '#777';
    }
    const t = (p.md - (this.pts[0]?.md ?? 0)) / ((this.pts[this.pts.length - 1]?.md ?? 1) - (this.pts[0]?.md ?? 0) || 1);
    return `hsl(${200 - 170 * t},75%,${62 - 12 * t}%)`;
  }

  /** the static plot (grid, overlays, points) is drawn once into an offscreen layer */
  private drawLayer(W: number, H: number, dpr: number) {
    const L = this.layer;
    L.width = Math.round(W * dpr);
    L.height = Math.round(H * dpr);
    const g = L.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const def = CROSSPLOTS[this.kind];
    const X = this.scale(def.x, PAD.l, W - PAD.r);
    const Y = this.scale(def.y, H - PAD.b, PAD.t);
    this.tx = X;
    this.ty = Y;
    // grid + ticks
    g.font = '10px "IBM Plex Mono", monospace';
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.fillStyle = 'rgba(231,236,241,0.55)';
    g.lineWidth = 1;
    const ticks = (a: Axis) => {
      if (a.log) {
        const out: number[] = [];
        for (let e = Math.floor(Math.log10(a.min)); e <= Math.ceil(Math.log10(a.max)); e++)
          for (const m of [1, 2, 5]) {
            const v = m * 10 ** e;
            if (v >= a.min && v <= a.max) out.push(v);
          }
        return out;
      }
      const span = a.max - a.min;
      const st = span > 0.6 ? 0.2 : 0.05;
      const out: number[] = [];
      for (let v = Math.ceil(a.min / st) * st; v <= a.max + 1e-9; v += st) out.push(+v.toFixed(3));
      return out;
    };
    const lbl = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) : v.toFixed(2).replace(/^0/, '').replace(/^-0/, '-'));
    g.textAlign = 'center';
    for (const v of ticks(def.x)) {
      g.beginPath();
      g.moveTo(X(v), PAD.t);
      g.lineTo(X(v), H - PAD.b);
      g.stroke();
      g.fillText(lbl(v), X(v), H - PAD.b + 13);
    }
    g.textAlign = 'right';
    for (const v of ticks(def.y)) {
      g.beginPath();
      g.moveTo(PAD.l, Y(v));
      g.lineTo(W - PAD.r, Y(v));
      g.stroke();
      g.fillText(lbl(v), PAD.l - 5, Y(v) + 3);
    }
    g.font = '10.5px Inter Variable, sans-serif';
    g.fillStyle = 'rgba(231,236,241,0.75)';
    g.textAlign = 'center';
    g.fillText(def.x.label, (PAD.l + W - PAD.r) / 2, H - 6);
    g.save();
    g.translate(12, (PAD.t + H - PAD.b) / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(def.y.label, 0, 0);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b);
    g.clip();
    // points
    const sel = this.selected.size > 0;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const on = this.selected.has(i);
      g.globalAlpha = sel && !on ? 0.18 : 0.75;
      g.fillStyle = on ? SEL_COLOR : this.colour(p);
      g.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3);
    }
    g.globalAlpha = 1;
    // reference lines from the interpretation parameters
    const params = this.app.engine.activeWell?.params;
    const line = (pts: [number, number][], color: string, label?: string, dash: number[] = []) => {
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.lineWidth = 1.4;
      g.beginPath();
      pts.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
      g.setLineDash([]);
      if (label) {
        // label at the last point inside the plot
        const inside = pts.filter(([x, y]) => X(x) > PAD.l && X(x) < W - PAD.r - 30 && Y(y) > PAD.t + 8 && Y(y) < H - PAD.b);
        const q = inside[inside.length - 1];
        if (q) {
          g.fillStyle = color;
          g.font = '10px Inter Variable, sans-serif';
          // keep the label inside the plot: flip it to the left of the point near the right edge
          const flip = X(q[0]) + 4 + g.measureText(label).width > W - PAD.r - 2;
          g.textAlign = flip ? 'right' : 'left';
          g.fillText(label, X(q[0]) + (flip ? -4 : 4), Y(q[1]) - 3);
        }
      }
    };
    if (params && this.kind === 'pickett') {
      for (const [sw, c] of [
        [1, '#5fb4ff'],
        [0.5, '#9fd0a8'],
        [0.3, '#e8c170'],
        [0.2, '#f0976a'],
      ] as const) {
        line(pickettLine(params, sw), c, undefined, sw === 1 ? [] : [5, 3]);
        // label each line at φ = 0.35, where neighbouring lines are far enough apart
        g.fillStyle = c;
        g.textAlign = 'left';
        g.font = '10px Inter Variable, sans-serif';
        g.fillText(sw === 1 ? 'Sw 1 water' : `Sw ${sw}`, X((params.a * params.rw) / (0.35 ** params.m * sw ** params.n)) + 5, Y(0.35) + 3);
      }
    } else if (params && this.kind === 'nd') {
      const ml = matrixLine(params);
      line(ml, '#e8c170', `ρma ${params.rhoMa}`);
      g.fillStyle = '#e8c170';
      g.font = '9.5px Inter Variable, sans-serif';
      for (const [x, y] of ml) {
        g.beginPath();
        g.arc(X(x), Y(y), 2, 0, Math.PI * 2);
        g.fill();
        if (x > 0) g.fillText(`${Math.round(x * 100)}`, X(x) + 4, Y(y) + 10);
      }
    } else if (params && this.kind === 'buckles') {
      for (const b of [0.02, 0.04, 0.06, 0.1]) line(bvwLine(b), 'rgba(160,210,255,0.75)', `BVW ${b}`, [5, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(X(params.cutSw), PAD.t);
      g.lineTo(X(params.cutSw), H - PAD.b);
      g.moveTo(PAD.l, Y(params.cutPhi));
      g.lineTo(W - PAD.r, Y(params.cutPhi));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.textAlign = 'left';
      g.fillText('pay', PAD.l + 4, PAD.t + 12);
    }
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.strokeRect(PAD.l + 0.5, PAD.t + 0.5, W - PAD.l - PAD.r - 1, H - PAD.t - PAD.b - 1);
    if (!this.pts.length) {
      g.fillStyle = 'rgba(231,236,241,0.6)';
      g.textAlign = 'center';
      g.font = '11px Inter Variable, sans-serif';
      const need = this.kind === 'nd' ? 'NPHI and RHOB' : 'RT and RHOB (for φ)';
      g.fillText(`No samples with ${need} in this interval.`, (PAD.l + W - PAD.r) / 2, (PAD.t + H - PAD.b) / 2);
    }
  }

  draw() {
    if (!this.panel.visible) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, W, H } = fit;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this.dirty || this.layer.width !== Math.round(W * dpr) || this.layer.height !== Math.round(H * dpr)) {
      this.drawLayer(W, H, dpr);
      this.dirty = false;
    }
    g.drawImage(this.layer, 0, 0, W, H);
    // the sample at the camera depth
    const md = this.app.engine.rig.md;
    const X = this.tx;
    const Y = this.ty;
    if (X && Y && this.pts.length) {
      const i = this.nearestMd(md);
      const p = this.pts[i];
      if (p && Math.abs(p.md - md) < 1) {
        g.strokeStyle = '#7fe3ff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(X(p.x), Y(p.y), 6, 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (this.brush) {
      const b = this.brush;
      g.fillStyle = 'rgba(255,95,210,0.12)';
      g.strokeStyle = SEL_COLOR;
      g.lineWidth = 1;
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
  }

  private nearestMd(md: number): number {
    // points are in MD order
    let lo = 0;
    let hi = this.pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.pts[m].md <= md) lo = m;
      else hi = m;
    }
    return Math.abs(this.pts[hi].md - md) < Math.abs(this.pts[lo].md - md) ? hi : lo;
  }

  private nearest(x: number, y: number, r = 8): number {
    if (!this.tx || !this.ty) return -1;
    let best = -1;
    let bd = r * r;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const d = (this.tx(p.x) - x) ** 2 + (this.ty(p.y) - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ interaction
  private bindPointer() {
    let down: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.offsetX, y: e.offsetY };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 4) {
        this.brush = { x0: down.x, y0: down.y, x1: e.offsetX, y1: e.offsetY };
        this.draw();
        return;
      }
      if (down) return;
      const i = this.nearest(e.offsetX, e.offsetY);
      const p = this.pts[i];
      if (!p) {
        this.hoverMd(null);
        this.readout.textContent = this.pts.length ? `${this.pts.length.toLocaleString('en-US')} samples · hover for depth · drag a box to select` : '';
        return;
      }
      this.hoverMd(p.md);
      const def = CROSSPLOTS[this.kind];
      const fx = (v: number, a: Axis) => (a.log ? fmt.res(v) : fmt.n(v, 3));
      const z = this.app.engine.activeWell.zoneAt(p.md);
      this.readout.textContent = `MD ${fmt.n(p.md, 1)} m · ${z?.name ?? ''} · x ${fx(p.x, def.x)} · y ${fx(p.y, def.y)}${Number.isFinite(p.gr) ? ` · GR ${fmt.n(p.gr, 0)}` : ''}${Number.isFinite(p.sw) ? ` · Sw ${fmt.n(p.sw, 2)}` : ''}`;
    });
    const up = (e: PointerEvent) => {
      if (!down) return;
      const b = this.brush;
      down = null;
      this.brush = null;
      if (b && this.tx && this.ty) {
        const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
        const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
        if (!e.shiftKey) this.selected.clear();
        this.pts.forEach((p, i) => {
          const x = this.tx!(p.x);
          const y = this.ty!(p.y);
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) this.selected.add(i);
        });
        this.applySelection();
      } else {
        const i = this.nearest(e.offsetX, e.offsetY);
        if (i >= 0) this.app.travelTo(this.pts[i].md);
        else if (this.selected.size) this.clearSelection();
      }
      this.draw();
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', () => {
      down = null;
      this.brush = null;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (!down) this.hoverMd(null);
    });
  }

  private hoverMd(md: number | null) {
    const wb = this.app.engine.wellbore;
    if (wb) wb.uniforms.uHoverMd.value = md ?? -1e6;
  }

  private selectedMds(): number[] {
    return [...this.selected].map((i) => this.pts[i]?.md).filter((v): v is number => v !== undefined);
  }

  private clearSelection() {
    this.selected.clear();
    this.applySelection();
  }

  private applySelection() {
    this.dirty = true;
    this.setMarkers(this.selectedMds());
    this.renderFoot();
    this.draw();
  }

  private renderFoot() {
    this.foot.innerHTML = '';
    const mds = this.selectedMds();
    if (!mds.length) {
      this.foot.append(h('span', { class: 'faint' }, 'Drag a box to select samples (Shift adds). They are marked along the well in 3D.'));
      return;
    }
    const iv = mdIntervals(mds).sort((a, b) => b.n - a.n);
    const net = iv.reduce((s, q) => s + (q.base - q.top), 0);
    this.foot.append(
      h('b', {}, `${mds.length.toLocaleString('en-US')} samples`),
      h('span', { class: 'faint' }, ` · ${iv.length} interval${iv.length > 1 ? 's' : ''} · ${fmt.n(net, 1)} m MD`),
    );
    for (const q of iv.slice(0, 6))
      this.foot.append(
        h('button', { class: 'btn xs', title: 'Travel there', onclick: () => this.app.travelTo((q.top + q.base) / 2) }, q.base - q.top < 1 ? `${fmt.n(q.top, 0)}` : `${fmt.n(q.top, 0)}–${fmt.n(q.base, 0)}`),
      );
    this.foot.append(h('button', { class: 'btn xs ghost', onclick: () => this.clearSelection() }, 'Clear'));
  }

  /** mark the selected sample depths along the active well in 3D */
  private setMarkers(mds: number[]) {
    const e = this.app.engine;
    if (this.markers) {
      e.scene.remove(this.markers);
      this.markers.geometry.dispose();
      (this.markers.material as THREE.Material).dispose();
      this.markers = undefined;
    }
    if (!mds.length || !e.activeWell) return;
    const t = e.activeWell.trajectory;
    const pos = new Float32Array(mds.length * 3);
    const v = new THREE.Vector3();
    mds.forEach((md, i) => {
      const p = t.at(Math.min(md, t.mdEnd));
      e.coords.toScene(p.ns, p.ew, p.tvd, v);
      pos.set([v.x, v.y, v.z], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: SEL_COLOR, size: 5, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.9 });
    this.markers = new THREE.Points(geo, mat);
    this.markers.renderOrder = 999;
    this.markers.frustumCulled = false;
    e.scene.add(this.markers);
  }
}
