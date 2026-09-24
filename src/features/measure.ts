import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PickResult } from '../scene/engine';
import type { App } from '../ui/app';
import { fmt, h } from '../ui/dom';
import { I } from '../ui/icons';
import type { FeatureModule } from './registry';

interface MPoint {
  p: THREE.Vector3;
  md?: number;
  kind: string;
}

/** Two-click distance measurement with horizontal / vertical / azimuth breakdown. */
export class MeasureFeature implements FeatureModule {
  readonly id = 'measure' as const;
  active = false;
  private group = new THREE.Group();
  private pending: MPoint | null = null;
  private markers: THREE.Mesh[] = [];
  private btn: HTMLButtonElement;
  private chip = h('div', { class: 'measure-chip hidden' });
  private handler = (p: PickResult | null, ev: PointerEvent) => this.onPick(p ?? this.seaHit(ev));
  private keyHandler = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    if (e.key === 'm' || e.key === 'M') this.setActive(!this.active);
    else if (e.key === 'Escape' && this.active) this.setActive(false);
  };

  constructor(private app: App) {
    this.group.name = 'measure';
    this.btn = h('button', { class: 'btn icon ghost', title: 'Measure distance (M)', html: I.ruler }) as HTMLButtonElement;
    this.btn.onclick = () => this.setActive(!this.active);
    this.btn.style.display = 'none';
    app.toolSlot.append(this.btn);
    app.hudSlot.append(this.chip);
  }

  enable() {
    this.btn.style.display = '';
    this.app.engine.scene.add(this.group);
    this.app.clickHandlers.push(this.handler);
    window.addEventListener('keydown', this.keyHandler);
  }

  disable() {
    this.setActive(false);
    this.clear();
    this.btn.style.display = 'none';
    this.app.engine.scene.remove(this.group);
    this.app.clickHandlers = this.app.clickHandlers.filter((f) => f !== this.handler);
    window.removeEventListener('keydown', this.keyHandler);
  }

  frame() {
    // keep markers a constant size on screen
    const cam = this.app.engine.camera.position;
    for (const m of this.markers) m.scale.setScalar(Math.max(0.05, m.position.distanceTo(cam) * 0.006));
  }

  settings() {
    return h('div', { class: 'feat-note' }, 'Press M or the ruler button, then click two points on anything in the scene. Esc stops measuring; measurements stay until cleared.', h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn', onclick: () => this.clear() }, 'Clear measurements')));
  }

  setActive(on: boolean) {
    this.active = on;
    this.btn.classList.toggle('active', on);
    this.pending = null;
    this.chip.classList.toggle('hidden', !on);
    this.renderChip();
    this.app.engine.renderer.domElement.classList.toggle('measuring', on);
  }

  private renderChip() {
    this.chip.innerHTML = '';
    this.chip.append(
      h('span', {}, this.pending ? 'Click the second point' : 'Measure — click the first point'),
      h('button', { class: 'btn', onclick: () => this.clear() }, 'Clear'),
      h('button', { class: 'btn', onclick: () => this.setActive(false) }, 'Done'),
    );
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      if (c instanceof CSS2DObject) c.element.remove();
      c.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
    this.markers = [];
    this.pending = null;
    if (this.active) this.renderChip();
  }

  private marker(p: THREE.Vector3, color: number) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false }));
    m.position.copy(p);
    m.renderOrder = 90;
    this.group.add(m);
    this.markers.push(m);
  }

  /** Fallback when nothing is hit: the sea-level plane (open water around the block). */
  private seaHit(ev: PointerEvent): PickResult | null {
    if (!this.active) return null;
    const e = this.app.engine;
    const r = e.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), e.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit ? { kind: 'sea', point: hit, object: e.env.sea } : null;
  }

  private onPick(p: PickResult | null): boolean {
    if (!this.active) return false;
    if (!p) return true;
    const pt: MPoint = { p: p.point.clone(), md: p.md, kind: p.kind };
    if (!this.pending) {
      this.pending = pt;
      this.marker(pt.p, 0xffd27a);
      this.renderChip();
      return true;
    }
    const a = this.pending;
    const b = pt;
    this.pending = null;
    this.marker(b.p, 0xffd27a);
    const lg = new THREE.BufferGeometry().setFromPoints([a.p, b.p]);
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffd27a, depthTest: false, transparent: true }));
    line.renderOrder = 89;
    // vertical and horizontal legs (dashed)
    const corner = new THREE.Vector3(b.p.x, a.p.y, b.p.z);
    const legs = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([a.p, corner, corner, b.p]),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.5, depthTest: false }),
    );
    legs.computeLineDistances();
    legs.renderOrder = 88;
    this.group.add(line, legs);
    const d3 = a.p.distanceTo(b.p);
    const dh = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
    const dv = a.p.y - b.p.y; // positive = second point deeper
    let azi = (Math.atan2(b.p.x - a.p.x, -(b.p.z - a.p.z)) * 180) / Math.PI;
    if (azi < 0) azi += 360;
    const el = document.createElement('div');
    el.className = 'label3d measure';
    const dmd = a.md !== undefined && b.md !== undefined ? `<span>ΔMD ${fmt.n(Math.abs(b.md - a.md), 1)} m along the well</span>` : '';
    el.innerHTML = `<b>${fmt.n(d3, 1)} m</b><span>horizontal ${fmt.n(dh, 1)} m · vertical ${dv >= 0 ? '↓' : '↑'} ${fmt.n(Math.abs(dv), 1)} m · azimuth ${fmt.n(azi, 0)}°</span><span>TVDSS ${fmt.n(-a.p.y, 1)} → ${fmt.n(-b.p.y, 1)} m</span>${dmd}`;
    const lbl = new CSS2DObject(el);
    lbl.position.copy(a.p).lerp(b.p, 0.5);
    this.group.add(lbl);
    this.renderChip();
    return true;
  }
}
