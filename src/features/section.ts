import { sampleHorizon } from '../data/surfaces';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { App } from '../ui/app';
import { chip, fmt, h } from '../ui/dom';
import { FloatingPanel, fitCanvas } from '../ui/floating';
import type { ContactsFeature } from './contacts';
import { CURVES, CURVE_BY_KEY, resample } from './curves';
import { niceStep, type GeosteerFeature } from './geosteer';
import type { FeatureModule } from './registry';
import type { UncertaintyFeature } from './uncertainty';

interface PathPt {
  md: number;
  s: number; // horizontal distance along the path (m)
  tvdss: number;
  ns: number;
  ew: number;
}

/**
 * Vertical cross-section that follows the well path ("unrolled curtain"):
 * horizontal axis = distance travelled along the path in plan view, vertical
 * axis = TVDSS. Formations are sampled from the picks model along the path.
 */
export class SectionFeature implements FeatureModule {
  readonly id = 'section' as const;
  private panel: FloatingPanel;
  private canvas = h('canvas', { class: 'fp-canvas' });
  private path: PathPt[] = [];
  private mode: 'reservoir' | 'full' | 'cursor' = 'reservoir';
  private ve = 0; // 0 = auto
  private curve = 'GR';
  private lastMd = -1;
  private tx: ((s: number) => number) | null = null;
  private ty: ((d: number) => number) | null = null;

  constructor(private app: App) {
    const modeSel = h('select', { class: 'select', title: 'Extent' }) as HTMLSelectElement;
    modeSel.append(h('option', { value: 'reservoir' }, 'Reservoir'), h('option', { value: 'full' }, 'Whole well'), h('option', { value: 'cursor' }, 'Follow cursor'));
    modeSel.onchange = () => ((this.mode = modeSel.value as typeof this.mode), this.draw());
    const veSel = h('select', { class: 'select', title: 'Vertical exaggeration' }) as HTMLSelectElement;
    for (const v of [0, 1, 2, 5, 10, 20]) veSel.append(h('option', { value: String(v) }, v ? `VE ×${v}` : 'VE auto'));
    veSel.onchange = () => ((this.ve = +veSel.value), this.draw());
    const curveSel = h('select', { class: 'select', title: 'Log along the path' }) as HTMLSelectElement;
    curveSel.append(h('option', { value: '' }, 'No log'));
    for (const c of CURVES) curveSel.append(h('option', { value: c.key }, c.label));
    curveSel.value = this.curve;
    curveSel.onchange = () => ((this.curve = curveSel.value), this.draw());
    this.panel = new FloatingPanel({
      id: 'section',
      title: 'Section along the well',
      badge: chip('interpreted'),
      width: 860,
      height: 320,
      place: 'top-center',
      headExtra: [modeSel, veSel, curveSel],
      onClose: () => app.flags.set('section', false),
    });
    this.panel.body.append(this.canvas);
    this.panel.onResize = () => this.draw();
    this.canvas.addEventListener('click', (e) => this.click(e.offsetX, e.offsetY));
  }

  enable() {
    this.panel.show();
    this.rebuild();
  }

  disable() {
    this.panel.hide();
  }

  onWell() {
    this.rebuild();
  }

  frame() {
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.5) return;
    this.lastMd = md;
    this.draw();
  }

  settings() {
    return h('div', { class: 'feat-note' }, 'Horizontal axis: distance travelled along the well in plan view (the well path unrolled). Formations come from the interpolated picks model; ties, contacts and uncertainty appear when those features are on. Click the section to travel there.');
  }

  private rebuild() {
    const w = this.app.engine.activeWell;
    if (!w) return;
    const t = w.trajectory;
    const dz = this.app.field.meta.datumElevation;
    const out: PathPt[] = [];
    let s = 0;
    for (let i = 0; i < t.md.length; i += 2) {
      if (out.length) {
        const p = out[out.length - 1];
        s += Math.hypot(t.ns[i] - p.ns, t.ew[i] - p.ew);
      }
      out.push({ md: t.md[i], s, tvdss: t.tvd[i] - dz, ns: t.ns[i], ew: t.ew[i] });
    }
    this.path = out;
    this.lastMd = -1;
    this.draw();
  }

  /** plan position at horizontal distance s, extending along the end azimuths */
  private planAt(s: number): { ns: number; ew: number } {
    const P = this.path;
    if (s <= 0) {
      const a = P[0];
      const b = P.find((q) => q.s > 30) ?? P[P.length - 1];
      const l = Math.hypot(b.ns - a.ns, b.ew - a.ew) || 1;
      return { ns: a.ns + ((b.ns - a.ns) / l) * s, ew: a.ew + ((b.ew - a.ew) / l) * s };
    }
    const L = P[P.length - 1];
    if (s >= L.s) {
      const a = [...P].reverse().find((q) => L.s - q.s > 30) ?? P[0];
      const l = Math.hypot(L.ns - a.ns, L.ew - a.ew) || 1;
      return { ns: L.ns + ((L.ns - a.ns) / l) * (s - L.s), ew: L.ew + ((L.ew - a.ew) / l) * (s - L.s) };
    }
    let lo = 0;
    let hi = P.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (P[m].s <= s) lo = m;
      else hi = m;
    }
    const f = (s - P[lo].s) / (P[hi].s - P[lo].s || 1);
    return { ns: P[lo].ns + (P[hi].ns - P[lo].ns) * f, ew: P[lo].ew + (P[hi].ew - P[lo].ew) * f };
  }

  private extent(W: number, H: number): { s0: number; s1: number; d0: number; d1: number } {
    const P = this.path;
    const L = P[P.length - 1].s;
    const w = this.app.engine.activeWell;
    const hug = w.zones.filter((z) => ['draupne', 'heather', 'hugin', 'sleipner', 'skagerrak'].includes(z.formationId));
    let s0: number;
    let s1: number;
    let dc: number;
    if (this.mode === 'full') {
      s0 = -Math.max(200, L * 0.08);
      s1 = L + Math.max(200, L * 0.08);
      const dMax = Math.max(...P.map((p) => p.tvdss)) + 150;
      const d0 = -60;
      if (!this.ve) return { s0, s1, d0, d1: dMax };
      dc = (d0 + dMax) / 2;
    } else if (this.mode === 'cursor') {
      const md = this.app.engine.rig.md;
      const c = P.reduce((a, b) => (Math.abs(b.md - md) < Math.abs(a.md - md) ? b : a));
      s0 = c.s - 600;
      s1 = c.s + 600;
      dc = c.tvdss;
    } else {
      const mds = hug.length ? [hug[0].topMD, hug[hug.length - 1].baseMD] : [P[0].md, P[P.length - 1].md];
      const inR = P.filter((p) => p.md >= mds[0] - 150 && p.md <= mds[1]);
      const q = inR.length ? inR : P;
      s0 = q[0].s - 250;
      s1 = q[q.length - 1].s + 250;
      dc = (Math.min(...q.map((p) => p.tvdss)) + Math.max(...q.map((p) => p.tvdss))) / 2;
    }
    const xScale = (W - 60) / (s1 - s0);
    const ve = this.ve || (this.mode === 'reservoir' ? 5 : this.mode === 'cursor' ? 5 : 1);
    const span = (H - 30) / (xScale * ve);
    return { s0, s1, d0: dc - span / 2, d1: dc + span / 2 };
  }

  private click(x: number, y: number) {
    if (!this.tx || !this.ty) return;
    let best = this.path[0];
    let bd = Infinity;
    for (const p of this.path) {
      const d = (this.tx(p.s) - x) ** 2 + (this.ty(p.tvdss) - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (bd < 40 * 40) this.app.travelTo(best.md);
  }

  draw() {
    if (!this.panel.visible || this.path.length < 2) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, W, H } = fit;
    const PL = 48;
    const PR = 10;
    const PT = 8;
    const PB = 20;
    const { s0, s1, d0, d1 } = this.extent(W, H);
    const X = (s: number) => PL + ((s - s0) / (s1 - s0)) * (W - PL - PR);
    const Y = (d: number) => PT + ((d - d0) / (d1 - d0)) * (H - PT - PB);
    this.tx = X;
    this.ty = Y;
    const f = this.app.field;
    // sky / sea
    g.fillStyle = '#0d1520';
    g.fillRect(PL, PT, W - PL - PR, Y(0) - PT);
    g.fillStyle = '#123247';
    g.fillRect(PL, Y(0), W - PL - PR, Y(f.meta.waterDepth) - Y(0));
    // formations sampled along the unrolled path
    const N = Math.max(60, Math.round((W - PL - PR) / 4));
    const cols: { s: number; d: number[] }[] = [];
    for (let i = 0; i <= N; i++) {
      const s = s0 + ((s1 - s0) * i) / N;
      const pl = this.planAt(s);
      cols.push({ s, d: f.horizons.map((hz) => sampleHorizon(hz, pl.ew, pl.ns)) });
    }
    const base = Math.max(d1, ...cols.map((c) => c.d[c.d.length - 1] + 200));
    f.horizons.forEach((hz, k) => {
      g.beginPath();
      cols.forEach((c, i) => (i ? g.lineTo(X(c.s), Y(c.d[k])) : g.moveTo(X(c.s), Y(c.d[k]))));
      for (let i = cols.length - 1; i >= 0; i--) g.lineTo(X(cols[i].s), Y(k + 1 < f.horizons.length ? cols[i].d[k + 1] : base));
      g.closePath();
      g.fillStyle = FORMATION_BY_ID.get(hz.id)?.color ?? '#555';
      g.globalAlpha = 0.82;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      cols.forEach((c, i) => (i ? g.lineTo(X(c.s), Y(c.d[k])) : g.moveTo(X(c.s), Y(c.d[k]))));
      g.stroke();
    });
    // formation names at the left edge
    g.font = '10px Inter Variable, sans-serif';
    g.textAlign = 'left';
    f.horizons.forEach((hz, k) => {
      const c = cols[2];
      const top = c.d[k];
      const bot = k + 1 < f.horizons.length ? c.d[k + 1] : base;
      if (Y(bot) - Y(top) < 11 || Y(top) > H - PB || Y(bot) < PT) return;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillText(FORMATION_BY_ID.get(hz.id)?.name ?? hz.id, X(c.s) + 4, Math.max(PT + 10, Y(top) + 11));
    });
    // cross-feature overlays
    const gs = this.app.flags.on('geosteer') ? this.app.feature<GeosteerFeature>('geosteer')?.profile : null;
    if (gs && gs.source === 'tied') {
      g.setLineDash([5, 3]);
      for (const [k, c] of [
        ['top', '#ffd27a'],
        ['base', '#ff8fa3'],
      ] as const) {
        g.strokeStyle = c;
        g.lineWidth = 1.4;
        g.beginPath();
        let started = false;
        for (const s of gs.samples) {
          if (gs.window && s.md < gs.window.from) continue;
          const p = this.path.find((q) => q.md >= s.md) ?? this.path[this.path.length - 1];
          if (!started) g.moveTo(X(p.s), Y(s[k]));
          else g.lineTo(X(p.s), Y(s[k]));
          started = true;
        }
        g.stroke();
      }
      g.setLineDash([]);
    }
    const owc = this.app.flags.on('owc') ? this.app.feature<ContactsFeature>('owc') : undefined;
    if (owc?.planeDepth) {
      const y = Y(owc.planeDepth);
      g.strokeStyle = '#4fb3ff';
      g.setLineDash([8, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(PL, y);
      g.lineTo(W - PR, y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#9fd4ff';
      g.textAlign = 'right';
      g.fillText(`OWC ${fmt.n(owc.planeDepth, 0)} m (calc.)`, W - PR - 4, y - 4);
    }
    const unc = this.app.flags.on('uncertainty') ? this.app.feature<UncertaintyFeature>('uncertainty') : undefined;
    if (unc) {
      g.beginPath();
      this.path.forEach((p, i) => (i ? g.lineTo(X(p.s), Y(p.tvdss - (unc.verticalAt(p.md) ?? 0))) : g.moveTo(X(p.s), Y(p.tvdss - (unc.verticalAt(p.md) ?? 0)))));
      for (let i = this.path.length - 1; i >= 0; i--) g.lineTo(X(this.path[i].s), Y(this.path[i].tvdss + (unc.verticalAt(this.path[i].md) ?? 0)));
      g.closePath();
      g.fillStyle = 'rgba(190,205,255,0.22)';
      g.fill();
    }
    // log along the path, filled on the upper side
    const w = this.app.engine.activeWell;
    const def = this.curve ? CURVE_BY_KEY.get(this.curve) : undefined;
    const data = def?.get(w);
    if (def && data) {
      const pts = resample(data.depth, data.values, 2);
      const amp = 34;
      let j = 0;
      for (let i = 0; i < pts.length; i++) {
        while (j < this.path.length - 2 && this.path[j + 1].md < pts[i].md) j++;
        const a = this.path[j];
        const b = this.path[Math.min(this.path.length - 1, j + 1)];
        const fr = (pts[i].md - a.md) / (b.md - a.md || 1);
        const x = X(a.s + (b.s - a.s) * fr);
        const y = Y(a.tvdss + (b.tvdss - a.tvdss) * fr);
        // screen-space normal of the path (pointing up / left)
        let nx = -(Y(b.tvdss) - Y(a.tvdss));
        let ny = X(b.s) - X(a.s);
        const l = Math.hypot(nx, ny) || 1;
        nx /= l;
        ny /= l;
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        const v = def.amp(pts[i].v) * amp;
        const c = def.color(pts[i].v, this.app.colormapName);
        g.strokeStyle = `rgb(${c.map((q) => Math.round(q * 255)).join(',')})`;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x + nx * 4, y + ny * 4);
        g.lineTo(x + nx * (4 + v), y + ny * (4 + v));
        g.stroke();
      }
    }
    // trajectory
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    this.path.forEach((p, i) => (i ? g.lineTo(X(p.s), Y(p.tvdss)) : g.moveTo(X(p.s), Y(p.tvdss))));
    g.stroke();
    g.lineWidth = 1.6;
    g.strokeStyle = '#e8f6ff';
    g.stroke();
    // casing shoes
    for (const c of w.casing) {
      const p = this.path.find((q) => q.md >= c.shoeMD);
      if (!p) continue;
      g.fillStyle = '#dfe6ec';
      g.beginPath();
      g.moveTo(X(p.s) - 6, Y(p.tvdss));
      g.lineTo(X(p.s), Y(p.tvdss) - 7);
      g.lineTo(X(p.s), Y(p.tvdss));
      g.fill();
    }
    // tops on this well
    g.font = '9.5px Inter Variable, sans-serif';
    for (const t of w.tops) {
      const p = this.path.find((q) => q.md >= t.md);
      if (!p) continue;
      const x = X(p.s);
      const y = Y(p.tvdss);
      if (x < PL || x > W - PR || y < PT || y > H - PB) continue;
      g.fillStyle = FORMATION_BY_ID.get(t.formationId)?.color ?? '#aaa';
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fill();
    }
    // cursor
    const md = this.app.engine.rig.md;
    const cp = this.path.reduce((a, b) => (Math.abs(b.md - md) < Math.abs(a.md - md) ? b : a));
    g.fillStyle = '#7fe3ff';
    g.strokeStyle = '#0b0e13';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(X(cp.s), Y(cp.tvdss), 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // axes
    g.fillStyle = 'rgba(8,11,15,0.85)';
    g.fillRect(0, 0, PL - 2, H);
    g.fillRect(0, H - PB + 2, W, PB);
    g.font = '10px "IBM Plex Mono", monospace';
    g.fillStyle = 'rgba(231,236,241,0.6)';
    g.textAlign = 'right';
    const sy = niceStep((d1 - d0) / 6);
    for (let d = Math.ceil(d0 / sy) * sy; d <= d1; d += sy) g.fillText(d.toFixed(0), PL - 5, Y(d) + 3);
    g.textAlign = 'center';
    const sx = niceStep((s1 - s0) / 8);
    for (let s = Math.ceil(s0 / sx) * sx; s <= s1; s += sx) g.fillText(`${s.toFixed(0)}`, X(s), H - 6);
    g.textAlign = 'left';
    g.fillText('TVDSS', 4, 12);
    const ve = ((s1 - s0) / (W - PL - PR)) / ((d1 - d0) / (H - PT - PB));
    g.textAlign = 'right';
    g.fillText(`along-path distance m · VE ×${ve.toFixed(ve < 2 ? 1 : 0)}${def && data ? ` · ${def.label} (${def.range})` : ''}`, W - PR, H - 6 - 12);
  }
}
