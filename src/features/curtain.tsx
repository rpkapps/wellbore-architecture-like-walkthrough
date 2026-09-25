import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { App } from '../ui/app';
import { Note, SelectField, SliderField } from '../ui/controls';
import { ProvBadge } from '../ui/prov';
import { Rev, SCENE } from '../ui/signal';
import { CURVES, CURVE_BY_KEY, resample } from './curves';
import type { FeatureModule } from './registry';

/**
 * Log curtain: a ribbon hanging off the trajectory with one log drawn as a
 * filled, colour-coded curve. The ribbon stands vertically above laterals and
 * turns to face sideways where the hole is vertical, so it is readable from
 * the field overview as well as from chase views.
 */
export class CurtainFeature implements FeatureModule {
  readonly id = 'curtain' as const;
  readonly rev = new Rev(SCENE);
  curve = 'GR';
  width = 45;
  private group = new THREE.Group();

  constructor(private app: App) {
    this.group.name = 'log-curtain';
  }

  enable() {
    this.app.engine.scene.add(this.group);
    this.rebuild();
  }

  disable() {
    this.app.engine.scene.remove(this.group);
    this.clear();
  }

  onWell() {
    this.rebuild();
  }

  settings() {
    const w = this.app.engine.activeWell;
    const def = CURVE_BY_KEY.get(this.curve)!;
    return (
      <>
        <SelectField
          label="Log"
          value={this.curve}
          onChange={(v) => {
            this.curve = v;
            this.rebuild();
          }}
          options={CURVES.map((c) => {
            const ok = w ? !!c.get(w) : true;
            return { id: c.key, label: `${c.label}${ok ? '' : ' — not on this well'}`, isDisabled: !ok };
          })}
        />
        <SliderField
          label="Curtain height"
          minValue={10}
          maxValue={200}
          step={5}
          value={this.width}
          format={(v) => `${v} m`}
          onChange={(v) => {
            this.width = v;
            this.rebuild();
          }}
        />
        <Note>
          <ProvBadge prov={def.prov} /> {def.label}, {def.range}. Width of the fill = value; colour = value.
        </Note>
      </>
    );
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      if (c instanceof CSS2DObject) c.element.remove();
    }
  }

  rebuild() {
    this.clear();
    this.rev.bump();
    const e = this.app.engine;
    const w = e.activeWell;
    const wb = e.wellbore;
    const def = CURVE_BY_KEY.get(this.curve);
    if (!w || !wb || !def) return;
    const data = def.get(w);
    if (!data) {
      this.app.toast(`Log curtain: ${def.label} is not available on ${w.name}`);
      return;
    }
    const pts = resample(data.depth, data.values, 1).filter((p) => p.md <= w.tdMD);
    if (pts.length < 2) return;
    // stable offset direction: vertical above inclined hole, a fixed horizontal side where the hole is vertical
    const t = w.trajectory;
    const dx = t.ew[t.md.length - 1] - t.ew[0];
    const dn = t.ns[t.md.length - 1] - t.ns[0];
    const fallback = new THREE.Vector3(dn, 0, dx);
    if (fallback.lengthSq() < 1) fallback.set(1, 0, 0);
    fallback.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const pos: number[] = [];
    const col: number[] = [];
    const bgPos: number[] = [];
    const edge: number[] = [];
    const W = this.width;
    for (const p of pts) {
      const f = wb.frameAt(p.md);
      const upP = up.clone().addScaledVector(f.tan, -f.tan.y);
      const L = upP.length();
      const side = fallback.clone().addScaledVector(f.tan, -fallback.dot(f.tan));
      if (side.lengthSq() < 1e-6) side.copy(f.nor);
      side.normalize();
      const k = THREE.MathUtils.smoothstep(L, 0.2, 0.5);
      const dir = side.multiplyScalar(1 - k).addScaledVector(L > 1e-4 ? upP.divideScalar(L) : upP, k).normalize();
      const r0 = f.radius * 1.4 + 1;
      const a = f.pos.clone().addScaledVector(dir, r0);
      const amp = def.amp(p.v);
      const b = f.pos.clone().addScaledVector(dir, r0 + W * Math.max(0.02, amp));
      const top = f.pos.clone().addScaledVector(dir, r0 + W);
      const c = def.color(p.v, this.app.colormapName);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      col.push(c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, c[0], c[1], c[2]);
      bgPos.push(a.x, a.y, a.z, top.x, top.y, top.z);
      edge.push(b.x, b.y, b.z);
    }
    const strip = (arr: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const idx: number[] = [];
      const n = arr.length / 6;
      for (let i = 0; i < n - 1; i++) {
        // break the ribbon across gaps in the log
        if (pts[i + 1].md - pts[i].md > 5) continue;
        idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      g.setIndex(idx);
      return g;
    };
    const bg = new THREE.Mesh(strip(bgPos), new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
    bg.renderOrder = 52;
    const fg = strip(pos);
    fg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    fill.renderOrder = 53;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    line.renderOrder = 54;
    this.group.add(bg, fill, line);
    const el = document.createElement('div');
    el.className = 'label3d curtain';
    el.innerHTML = `<b>${def.label}</b><span>${def.range} · ${def.prov}</span>`;
    const o = new CSS2DObject(el);
    o.position.set(bgPos[bgPos.length - 3], bgPos[bgPos.length - 2], bgPos[bgPos.length - 1]);
    this.group.add(o);
  }
}
