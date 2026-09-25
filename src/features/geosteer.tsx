import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { STATUS_COLOR, steerAt, steerProfile, type SteerProfile, type SurfaceSource } from '../data/geosteer';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { ReactNode } from 'react';
import type { App } from '../ui/app';
import { CompactSelect, Note } from '../ui/controls';
import { fmt } from '../ui/dom';
import { ToolWindow, fitCanvas } from '../ui/toolWindow';
import { Live, Signal } from '../ui/signal';
import { font } from '../ui/tokens';
import type { FeatureModule } from './registry';
import type { UncertaintyFeature } from './uncertainty';

/**
 * Geosteering: where is the well relative to the top and base of the target
 * unit? 3D status band + vertical drop-lines to the (well-tied) surfaces, the
 * tied surfaces as ribbons along the path, a distance-to-boundary strip and a
 * HUD read-out.
 */
export class GeosteerFeature implements FeatureModule {
  readonly id = 'geosteer' as const;
  target = 'hugin';
  source: SurfaceSource = 'tied';
  profile: SteerProfile | null = null;
  private group = new THREE.Group();
  private panel: ToolWindow;
  private canvas: HTMLCanvasElement | null = null;
  private readout = new Signal<ReactNode>(null);
  private hud = new Signal<ReactNode>(null);
  private lastMd = -1;
  private view: 'window' | 'cursor' = 'window';

  constructor(private app: App) {
    this.group.name = 'geosteer';
    const targets = app.field.horizons
      .filter((hz, i) => FORMATION_BY_ID.has(hz.id) && app.field.horizons[i + 1])
      .map((hz) => ({ id: hz.id, label: FORMATION_BY_ID.get(hz.id)!.name }));
    this.panel = new ToolWindow({
      id: 'geosteer',
      title: 'Geosteering',
      badge: 'calculated',
      onClose: () => app.flags.set('geosteer', false),
      header: () => (
        <>
          <CompactSelect
            label="Target formation"
            value={this.target}
            onChange={(v) => {
              this.target = v;
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={targets}
          />
          <CompactSelect
            label="Surfaces"
            value={this.source}
            onChange={(v) => {
              this.source = v as SurfaceSource;
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={[
              { id: 'tied', label: 'Tied to this well’s picks' },
              { id: 'model', label: 'Regional model only' },
            ]}
          />
          <CompactSelect
            label="Strip extent"
            value={this.view}
            onChange={(v) => {
              this.view = v as 'window' | 'cursor';
              this.draw();
              this.panel.rev.bump();
            }}
            options={[
              { id: 'window', label: 'Whole lateral' },
              { id: 'cursor', label: '±250 m of cursor' },
            ]}
          />
        </>
      ),
      body: () => (
        <>
          <div className="flex flex-col gap-1 text-xs">
            <Live s={this.readout} />
          </div>
          <canvas
            ref={(el) => {
              this.canvas = el;
            }}
            aria-label="Distance to the target boundaries along the well: click to travel"
            className="block min-h-0 w-full flex-1 cursor-pointer"
            onClick={(e) => {
              const md = this.mdAtX(e.nativeEvent.offsetX);
              if (md !== null) app.travelTo(md);
            }}
          />
        </>
      ),
    });
    this.panel.onResize = () => this.draw();
    app.addHud({ id: 'geosteer', render: () => <Live s={this.hud} /> });
  }

  enable() {
    this.app.engine.scene.add(this.group);
    this.panel.show();
    this.rebuild();
  }

  disable() {
    this.app.engine.scene.remove(this.group);
    this.panel.hide();
    this.hud.set(null);
  }

  onWell() {
    this.rebuild();
  }

  frame() {
    const cam = this.app.engine.camera.position;
    for (const o of this.group.children) if (o instanceof CSS2DObject) o.visible = o.position.distanceTo(cam) < 1500;
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.05) return;
    this.lastMd = md;
    this.updateReadout();
    this.draw();
  }

  settings() {
    return (
      <Note>
        Tied mode corrects the regional picks model so it passes through every formation boundary this well crossed — as a geosteerer would. Distances are vertical (TVD). Status: <b style={{ color: STATUS_COLOR.in }}>in zone</b> · <b style={{ color: STATUS_COLOR.above }}>above top</b> · <b style={{ color: STATUS_COLOR.below }}>below base</b>
      </Note>
    );
  }

  // ------------------------------------------------------------------ data + 3D
  rebuild() {
    const e = this.app.engine;
    const w = e.activeWell;
    if (!w) return;
    const f = this.app.field;
    this.profile = steerProfile(w.trajectory, f.horizons, f.meta.datumElevation, this.target, w.tops, { zones: w.zones, source: this.source });
    this.build3D();
    this.lastMd = -1;
    this.frame();
  }

  private build3D() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      if (c instanceof CSS2DObject) c.element.remove();
    }
    const p = this.profile;
    const e = this.app.engine;
    if (!p || !p.window || !e.wellbore) return;
    const dz = this.app.field.meta.datumElevation;
    const S = p.samples.filter((s) => s.md >= p.window!.from);
    if (S.length < 2) return;
    const toScene = (ns: number, ew: number, tvdss: number) => e.coords.toScene(ns, ew, tvdss + dz);
    // status band: a ribbon riding on top of the hole, coloured in / above / below
    const band: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    for (const s of S) {
      const fr = e.wellbore.frameAt(s.md);
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(fr.tan, -fr.tan.y);
      if (up.lengthSq() < 1e-4) up.copy(fr.nor);
      up.normalize();
      const side = new THREE.Vector3().crossVectors(fr.tan, up).normalize();
      const base = fr.pos.clone().addScaledVector(up, fr.radius * 1.9 + 1.2);
      const w = Math.max(1.2, fr.radius * 0.7);
      band.push(...base.clone().addScaledVector(side, -w).toArray(), ...base.clone().addScaledVector(side, w).toArray());
      c.set(STATUS_COLOR[s.status]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const idx: number[] = [];
    for (let i = 0; i < S.length - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    bg.setIndex(idx);
    const bandMesh = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.95 }));
    bandMesh.renderOrder = 58;
    this.group.add(bandMesh);
    // tied surfaces as ribbons that follow the path (60 m wide), drawn at their TVDSS
    const ribbon = (key: 'top' | 'base', color: string) => {
      const pos: number[] = [];
      const ix: number[] = [];
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        const a = S[Math.max(0, i - 1)];
        const b = S[Math.min(S.length - 1, i + 1)];
        let sx = -(b.ns - a.ns);
        let sy = b.ew - a.ew;
        const l = Math.hypot(sx, sy) || 1;
        sx /= l;
        sy /= l;
        const halfW = 20;
        pos.push(...toScene(s.ns + sy * halfW, s.ew + sx * halfW, s[key]).toArray(), ...toScene(s.ns - sy * halfW, s.ew - sx * halfW, s[key]).toArray());
        if (i < S.length - 1) ix.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(ix);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = 57;
      this.group.add(m);
      // crisp edge line along the centre
      const lg = new THREE.BufferGeometry().setFromPoints(S.map((s) => toScene(s.ns, s.ew, s[key])));
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      line.renderOrder = 58;
      this.group.add(line);
    };
    const tf = FORMATION_BY_ID.get(this.target);
    ribbon('top', '#ffd27a');
    ribbon('base', '#ff8fa3');
    // drop-lines every 20 m of MD from the well to both surfaces
    const lp: number[] = [];
    const lc: number[] = [];
    const cTop = new THREE.Color('#ffd27a');
    const cBase = new THREE.Color('#ff8fa3');
    let next = S[0].md;
    for (const s of S) {
      if (s.md < next) continue;
      next = s.md + 20;
      const wp = toScene(s.ns, s.ew, s.tvdss);
      lp.push(...wp.toArray(), ...toScene(s.ns, s.ew, s.top).toArray());
      lc.push(cTop.r, cTop.g, cTop.b, cTop.r, cTop.g, cTop.b);
      lp.push(...wp.toArray(), ...toScene(s.ns, s.ew, s.base).toArray());
      lc.push(cBase.r, cBase.g, cBase.b, cBase.r, cBase.g, cBase.b);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
    lines.renderOrder = 58;
    this.group.add(lines);
    // labels at the start of the ribbons
    const s0 = S[Math.min(S.length - 1, 10)];
    const lab = (text: string, tvdss: number, cls: string) => {
      const el = document.createElement('div');
      el.className = `label3d gs ${cls}`;
      el.innerHTML = text;
      const o = new CSS2DObject(el);
      o.position.copy(toScene(s0.ns, s0.ew, tvdss));
      this.group.add(o);
    };
    lab(`<b>${tf?.name ?? this.target} top</b><span>${this.source === 'tied' ? 'tied to picks' : 'regional model'}</span>`, s0.top, 'top');
    lab(`<b>${tf?.name ?? this.target} base</b>`, s0.base, 'base');
  }

  // ------------------------------------------------------------------ read-outs
  private updateReadout() {
    const p = this.profile;
    const md = this.app.engine.rig.md;
    if (!p || !p.window) {
      this.readout.set(<span className="text-muted-foreground">This well does not reach the {FORMATION_BY_ID.get(this.target)?.name ?? this.target} in the model.</span>);
      this.hud.set(null);
      return;
    }
    const s = steerAt(p, md);
    const tot = p.footage.in + p.footage.above + p.footage.below;
    const pc = (v: number) => `${Math.round((v / Math.max(1, tot)) * 100)}%`;
    const unc = this.app.flags.on('uncertainty') ? this.app.feature<UncertaintyFeature>('uncertainty')?.verticalAt(md) : null;
    const status = s ? { in: 'IN ZONE', above: 'ABOVE TOP', below: 'BELOW BASE' }[s.status] : '—';
    const inWin = s && md >= p.window.from - 1;
    this.readout.set(
      <>
        {inWin && s ? (
          <span>
            <b className="font-medium" style={{ color: STATUS_COLOR[s.status] }}>
              {status}
            </b>{' '}
            <span className="text-muted-foreground">
              {s.dTop >= 0 ? `${fmt.n(s.dTop, 1)} m below top` : `${fmt.n(-s.dTop, 1)} m above top`} · {s.dBase >= 0 ? `${fmt.n(s.dBase, 1)} m above base` : `${fmt.n(-s.dBase, 1)} m below base`}
              {unc ? ` · ±${fmt.n(unc, 1)} m vertical (2σ)` : ''}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Cursor above the landing section — scrub to MD ≥ {fmt.n(p.window.from, 0)} m</span>
        )}
        <span className="flex gap-3 font-mono">
          <span style={{ color: STATUS_COLOR.in }}>
            in {fmt.n(p.footage.in, 0)} m ({pc(p.footage.in)})
          </span>
          <span style={{ color: STATUS_COLOR.above }}>above {fmt.n(p.footage.above, 0)} m</span>
          <span style={{ color: STATUS_COLOR.below }}>below {fmt.n(p.footage.below, 0)} m</span>
        </span>
      </>,
    );
    this.hud.set(
      inWin && s ? (
        <span className="flex items-center gap-2 font-mono text-xs">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s.status] }} />
          {status} · top {s.dTop >= 0 ? '+' : ''}
          {fmt.n(s.dTop, 1)} m · base {s.dBase >= 0 ? '+' : ''}
          {fmt.n(s.dBase, 1)} m
        </span>
      ) : null,
    );
  }

  private range(): { a: number; b: number } | null {
    const p = this.profile;
    if (!p || !p.window) return null;
    if (this.view === 'cursor') {
      const md = this.app.engine.rig.md;
      return { a: Math.max(p.window.from, md - 250), b: Math.min(p.window.to, md + 250) };
    }
    return { a: p.window.from, b: p.window.to };
  }

  private pad = { l: 46, r: 12, t: 8, b: 20 };

  private mdAtX(x: number): number | null {
    const r = this.range();
    const W = this.canvas?.clientWidth ?? 0;
    if (!r || !W) return null;
    const f = (x - this.pad.l) / (W - this.pad.l - this.pad.r);
    if (f < 0 || f > 1) return null;
    return r.a + f * (r.b - r.a);
  }

  draw() {
    if (!this.panel.visible) return;
    const fit = fitCanvas(this.canvas);
    const p = this.profile;
    const r = this.range();
    if (!fit || !p || !r) return;
    const { g, W, H } = fit;
    const P = this.pad;
    const S = p.samples.filter((s) => s.md >= r.a && s.md <= r.b);
    if (S.length < 2) return;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of S) {
      y0 = Math.min(y0, s.top, s.tvdss);
      y1 = Math.max(y1, s.base, s.tvdss);
    }
    const m = Math.max(4, (y1 - y0) * 0.12);
    y0 -= m;
    y1 += m;
    const X = (md: number) => P.l + ((md - r.a) / (r.b - r.a)) * (W - P.l - P.r);
    const Y = (d: number) => P.t + ((d - y0) / (y1 - y0)) * (H - P.t - P.b);
    const idx = this.app.field.horizons.findIndex((q) => q.id === this.target);
    const upper = FORMATION_BY_ID.get(this.app.field.horizons[idx - 1]?.id ?? '')?.color ?? '#3a3f47';
    const tcol = FORMATION_BY_ID.get(this.target)?.color ?? '#c9a45c';
    const lower = FORMATION_BY_ID.get(p.baseId ?? '')?.color ?? '#6b5a4a';
    // background layers
    g.fillStyle = upper;
    g.globalAlpha = 0.35;
    g.fillRect(P.l, P.t, W - P.l - P.r, H - P.t - P.b);
    const poly = (up: (s: (typeof S)[0]) => number, dn: (s: (typeof S)[0]) => number, color: string, alpha: number) => {
      g.beginPath();
      S.forEach((s, i) => (i ? g.lineTo(X(s.md), Y(up(s))) : g.moveTo(X(s.md), Y(up(s)))));
      for (let i = S.length - 1; i >= 0; i--) g.lineTo(X(S[i].md), Y(dn(S[i])));
      g.closePath();
      g.fillStyle = color;
      g.globalAlpha = alpha;
      g.fill();
    };
    poly((s) => s.base, () => y1, lower, 0.45);
    poly((s) => s.top, (s) => s.base, tcol, 0.75);
    g.globalAlpha = 1;
    // grid + depth axis
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.fillStyle = 'rgba(231,236,241,0.55)';
    g.font = font.mono(10);
    g.textAlign = 'right';
    const stepY = niceStep((y1 - y0) / 5);
    for (let d = Math.ceil(y0 / stepY) * stepY; d <= y1; d += stepY) {
      g.beginPath();
      g.moveTo(P.l, Y(d));
      g.lineTo(W - P.r, Y(d));
      g.stroke();
      g.fillText(d.toFixed(0), P.l - 4, Y(d) + 3);
    }
    g.textAlign = 'center';
    const stepX = niceStep((r.b - r.a) / 8);
    for (let md = Math.ceil(r.a / stepX) * stepX; md <= r.b; md += stepX) g.fillText(md.toFixed(0), X(md), H - 6);
    // untied model surfaces for comparison
    if (p.source === 'tied') {
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      for (const k of ['topModel', 'baseModel'] as const) {
        g.beginPath();
        S.forEach((s, i) => (i ? g.lineTo(X(s.md), Y(s[k])) : g.moveTo(X(s.md), Y(s[k]))));
        g.stroke();
      }
      g.setLineDash([]);
    }
    // surfaces
    g.lineWidth = 1.5;
    g.strokeStyle = '#ffd27a';
    g.beginPath();
    S.forEach((s, i) => (i ? g.lineTo(X(s.md), Y(s.top)) : g.moveTo(X(s.md), Y(s.top))));
    g.stroke();
    g.strokeStyle = '#ff8fa3';
    g.beginPath();
    S.forEach((s, i) => (i ? g.lineTo(X(s.md), Y(s.base)) : g.moveTo(X(s.md), Y(s.base))));
    g.stroke();
    // vertical uncertainty band around the well path
    const unc = this.app.flags.on('uncertainty') ? this.app.feature<UncertaintyFeature>('uncertainty') : undefined;
    if (unc) {
      g.beginPath();
      S.forEach((s, i) => {
        const v = unc.verticalAt(s.md) ?? 0;
        if (i) g.lineTo(X(s.md), Y(s.tvdss - v));
        else g.moveTo(X(s.md), Y(s.tvdss - v));
      });
      for (let i = S.length - 1; i >= 0; i--) g.lineTo(X(S[i].md), Y(S[i].tvdss + (unc.verticalAt(S[i].md) ?? 0)));
      g.closePath();
      g.fillStyle = 'rgba(180,200,255,0.18)';
      g.fill();
    }
    // well path coloured by status
    g.lineWidth = 3;
    for (let i = 1; i < S.length; i++) {
      g.strokeStyle = STATUS_COLOR[S[i].status];
      g.beginPath();
      g.moveTo(X(S[i - 1].md), Y(S[i - 1].tvdss));
      g.lineTo(X(S[i].md), Y(S[i].tvdss));
      g.stroke();
    }
    g.lineWidth = 1;
    // tie points (formation boundaries crossed, from this well's picks)
    for (const t of p.ties) {
      if (t.md < r.a || t.md > r.b) continue;
      const x = X(t.md);
      const y = Y(t.tvdss);
      g.fillStyle = t.which === 'top' ? '#ffd27a' : '#ff8fa3';
      g.beginPath();
      g.moveTo(x, y - 5);
      g.lineTo(x + 4, y);
      g.lineTo(x, y + 5);
      g.lineTo(x - 4, y);
      g.closePath();
      g.fill();
      g.strokeStyle = '#0b0e13';
      g.stroke();
    }
    // cursor
    const md = this.app.engine.rig.md;
    if (md >= r.a && md <= r.b) {
      g.strokeStyle = 'rgba(127,227,255,0.9)';
      g.beginPath();
      g.moveTo(X(md), P.t);
      g.lineTo(X(md), H - P.b);
      g.stroke();
    }
    g.fillStyle = 'rgba(231,236,241,0.5)';
    g.textAlign = 'left';
    g.fillText('TVDSS m', 4, P.t + 8);
    g.textAlign = 'right';
    const ve = (r.b - r.a) / (W - P.l - P.r) / ((y1 - y0) / (H - P.t - P.b));
    g.fillText(`MD m · vertical exaggeration ×${ve < 2 ? ve.toFixed(1) : ve.toFixed(0)}`, W - P.r, P.t + 10);
  }
}

export function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
