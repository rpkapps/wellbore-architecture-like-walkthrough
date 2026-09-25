import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PickResult } from '../scene/engine';
import { Button } from '@tecton/react/components/button';
import { RulerIcon } from 'lucide-react';
import type { App } from '../ui/app';
import { Note } from '../ui/controls';
import { fmt } from '../ui/dom';
import { Signal, useSignal } from '../ui/signal';
import type { FeatureModule } from './registry';

interface MPoint {
  p: THREE.Vector3;
  md?: number;
  kind: string;
}

/** What the measuring tool is waiting for: nothing (off), the first point or the second one. */
type MeasureStep = 'off' | 'first' | 'second';

/** Two-click distance measurement with horizontal / vertical / azimuth breakdown. */
export class MeasureFeature implements FeatureModule {
  readonly id = 'measure' as const;
  readonly step = new Signal<MeasureStep>('off');
  private group = new THREE.Group();
  private pending: MPoint | null = null;
  private markers: THREE.Mesh[] = [];
  private handler = (p: PickResult | null, ev: PointerEvent) => this.onPick(p ?? this.seaHit(ev));
  private keyHandler = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea, [role="listbox"], [role="menu"]')) return;
    if (e.key === 'm' || e.key === 'M') this.setActive(!this.active);
    else if (e.key === 'Escape' && this.active) this.setActive(false);
  };

  constructor(private app: App) {
    this.group.name = 'measure';
  }

  get active(): boolean {
    return this.step.value !== 'off';
  }

  enable() {
    this.app.addTool({ id: 'measure', label: 'Measure (M)', icon: <RulerIcon />, onAction: () => this.setActive(this.step.value === 'off'), isActive: () => this.step.value !== 'off', watch: this.step });
    this.app.engine.scene.add(this.group);
    this.app.clickHandlers.push(this.handler);
    window.addEventListener('keydown', this.keyHandler);
  }

  disable() {
    this.setActive(false);
    this.clear();
    this.app.removeTool('measure');
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
    return (
      <>
        <Note>Press M or the ruler button, then click two points on anything in the scene. Esc stops measuring; measurements stay until cleared.</Note>
        <div>
          <Button variant="outline" size="xs" onPress={() => this.clear()}>
            Clear measurements
          </Button>
        </div>
      </>
    );
  }

  setActive(on: boolean) {
    this.pending = null;
    this.step.set(on ? 'first' : 'off');
    if (on) this.app.addHud({ id: 'measure', render: () => <MeasureHint m={this} /> });
    else this.app.removeHud('measure');
    this.app.engine.renderer.domElement.classList.toggle('measuring', on);
  }

  private syncStep() {
    if (this.active) this.step.set(this.pending ? 'second' : 'first');
  }

  clear() {
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
    this.syncStep();
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
      this.syncStep();
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
    this.syncStep();
    return true;
  }
}

/** Top-bar ruler button; shows as pressed while measuring. */

/** HUD hint while measuring: which point to click next, Clear and Done. */
function MeasureHint({ m }: { m: MeasureFeature }) {
  const step = useSignal(m.step);
  if (step === 'off') return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="flex-1">{step === 'second' ? 'Click the second point' : 'Measure — click the first point'}</span>
      <Button variant="ghost" size="xs" onPress={() => m.clear()}>
        Clear
      </Button>
      <Button variant="secondary" size="xs" onPress={() => m.setActive(false)}>
        Done
      </Button>
    </div>
  );
}
