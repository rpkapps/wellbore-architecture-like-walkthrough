import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WellboreAssembly } from './wellbore';

export type NavMode = 'guided' | 'explore';
export type GuidedView = 'tunnel' | 'chase' | 'orbit';
export type ExploreView = 'fly' | 'orbit';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Flight {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  dur: number;
  done?: () => void;
}

/**
 * Camera behaviour for the guided walkthrough (camera bound to the well path)
 * and free exploration (fly-through with WASD + mouse, or orbit).
 */
export class CameraRig {
  mode: NavMode = 'guided';
  guidedView: GuidedView = 'chase';
  exploreView: ExploreView = 'orbit';
  md = 0;
  targetMd: number | null = null;
  playing = false;
  speed = 45; // m MD per second
  flySpeed = 60;
  readonly orbit: OrbitControls;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private flight: Flight | null = null;
  private lookTarget = new THREE.Vector3();
  private smoothedPos = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();
  private initialized = false;
  private orbitOffset = new THREE.Vector3(-60, 30, 60);
  onMdChange?: (md: number) => void;
  onUserInput?: () => void;
  wellbore?: WellboreAssembly;
  mdMax = 1000;
  chaseDistance = 1;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxDistance = 30000;
    this.orbit.minDistance = 1;
    this.orbit.zoomSpeed = 1.1;
    this.orbit.enabled = false;
    this.orbit.addEventListener('start', () => this.onUserInput?.());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode === 'explore' && this.exploreView === 'fly' && e.button === 0) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        dom.setPointerCapture(e.pointerId);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.0032;
      this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch - dy * 0.0032));
      this.onUserInput?.();
    });
    dom.addEventListener('pointerup', () => (this.dragging = false));
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.mode === 'explore' && this.exploreView === 'fly') {
          this.flySpeed = Math.max(2, Math.min(3000, this.flySpeed * (e.deltaY > 0 ? 0.85 : 1.18)));
          e.preventDefault();
        } else if (this.mode === 'guided' && this.guidedView !== 'orbit') {
          // wheel scrubs along the well in guided mode
          this.playing = false;
          this.setMd(this.md + Math.sign(e.deltaY) * Math.max(2, this.speed * 0.25));
          e.preventDefault();
        }
      },
      { passive: false },
    );
  }

  setMd(md: number) {
    this.md = Math.max(0, Math.min(this.mdMax, md));
    this.onMdChange?.(this.md);
  }

  /** Animate along the well to a target depth (guided chapters, log-track clicks). */
  travelTo(md: number) {
    this.targetMd = Math.max(0, Math.min(this.mdMax, md));
    this.playing = false;
  }

  setMode(mode: NavMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.flight = null;
    if (mode === 'explore') {
      this.syncAnglesFromCamera();
      this.setExploreView(this.exploreView);
    } else {
      this.orbit.enabled = this.guidedView === 'orbit';
      this.initialized = false;
    }
  }

  setGuidedView(v: GuidedView) {
    this.guidedView = v;
    if (this.mode === 'guided') {
      this.orbit.enabled = v === 'orbit';
      if (v === 'orbit' && this.wellbore) {
        const f = this.wellbore.frameAt(this.md);
        this.orbit.target.copy(f.pos);
        const d = Math.max(40, f.radius * 18);
        this.orbitOffset.set(-d, d * 0.5, d);
        this.camera.position.copy(f.pos).add(this.orbitOffset);
      }
      this.initialized = false;
    }
  }

  setExploreView(v: ExploreView) {
    this.exploreView = v;
    if (this.mode !== 'explore') return;
    if (v === 'orbit') {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const dist = Math.max(50, this.orbit.target.distanceTo(this.camera.position));
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, dist);
      this.orbit.enabled = true;
    } else {
      this.orbit.enabled = false;
      this.syncAnglesFromCamera();
    }
  }

  private syncAnglesFromCamera() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  }

  /** Smooth cinematic flight to a viewpoint (works in every mode). */
  /** reduce motion: camera moves become (almost) instant */
  instantMoves = false;

  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 2.2, done?: () => void) {
    if (this.instantMoves) dur = 0.01;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const curTarget = this.orbit.enabled ? this.orbit.target.clone() : this.camera.position.clone().addScaledVector(dir, pos.distanceTo(target));
    this.flight = { fromPos: this.camera.position.clone(), fromTarget: curTarget, toPos: pos.clone(), toTarget: target.clone(), t: 0, dur, done };
  }

  get isFlying() {
    return !!this.flight;
  }

  update(dt: number) {
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.dur;
      const k = easeInOut(Math.min(1, f.t));
      // arc the path slightly upward for long flights
      const lift = Math.sin(k * Math.PI) * Math.min(600, f.fromPos.distanceTo(f.toPos) * 0.18);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k).y += lift;
      this.lookTarget.lerpVectors(f.fromTarget, f.toTarget, k);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.lookTarget);
      if (f.t >= 1) {
        this.flight = null;
        this.orbit.target.copy(f.toTarget);
        this.syncAnglesFromCamera();
        this.smoothedPos.copy(this.camera.position);
        this.smoothedLook.copy(f.toTarget);
        f.done?.();
      }
      return;
    }
    if (this.mode === 'guided') this.updateGuided(dt);
    else this.updateExplore(dt);
  }

  private updateGuided(dt: number) {
    const wb = this.wellbore;
    if (!wb) return;
    if (this.targetMd !== null) {
      const d = this.targetMd - this.md;
      const step = Math.sign(d) * Math.min(Math.abs(d), Math.max(Math.abs(d) * 2.2 * dt, 30 * dt));
      this.setMd(this.md + step);
      if (Math.abs(d) < 0.2) {
        this.setMd(this.targetMd);
        this.targetMd = null;
      }
    } else if (this.playing) {
      this.setMd(this.md + this.speed * dt);
      if (this.md >= this.mdMax) this.playing = false;
    }
    const f = wb.frameAt(this.md);
    const up = new THREE.Vector3(0, 1, 0);
    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    if (this.guidedView === 'tunnel') {
      const inner = wb.innerRadiusAt(this.md);
      const ahead = wb.frameAt(Math.min(this.mdMax, this.md + Math.max(8, inner * 6)));
      // hover slightly above the low side of the hole, looking down-hole
      const upPerp = up.clone().addScaledVector(f.tan, -up.dot(f.tan));
      if (upPerp.lengthSq() < 1e-3) upPerp.copy(f.nor);
      upPerp.normalize();
      desiredPos = f.pos
        .clone()
        .addScaledVector(upPerp, inner * 0.18)
        .addScaledVector(f.tan, -inner * 0.2);
      desiredLook = ahead.pos.clone().addScaledVector(upPerp, inner * 0.1);
    } else if (this.guidedView === 'chase') {
      const d = (30 + f.radius * 14) * this.chaseDistance;
      const upPerp = up.clone().addScaledVector(f.tan, -up.dot(f.tan));
      if (upPerp.lengthSq() < 1e-3) upPerp.set(0, 0, 1);
      upPerp.normalize();
      const side = new THREE.Vector3().crossVectors(f.tan, upPerp).normalize();
      // when the hole is near-vertical, look at it from the side; when horizontal, from above-behind
      const vertical = Math.abs(f.tan.y);
      desiredPos = f.pos
        .clone()
        .addScaledVector(f.tan, -d * (0.35 + 0.45 * (1 - vertical)))
        .addScaledVector(upPerp, d * (0.25 + 0.2 * (1 - vertical)))
        .addScaledVector(side, d * (0.55 + 0.35 * vertical));
      desiredLook = f.pos.clone().addScaledVector(f.tan, d * 0.15);
    } else {
      // orbit: keep the user's offset while the target follows the well
      this.orbitOffset.copy(this.camera.position).sub(this.orbit.target);
      this.orbit.target.copy(f.pos);
      this.camera.position.copy(f.pos).add(this.orbitOffset);
      this.orbit.update();
      return;
    }
    if (!this.initialized) {
      this.smoothedPos.copy(desiredPos);
      this.smoothedLook.copy(desiredLook);
      this.initialized = true;
    }
    const k = 1 - Math.exp(-dt * (this.guidedView === 'tunnel' ? 9 : 4.5));
    this.smoothedPos.lerp(desiredPos, k);
    this.smoothedLook.lerp(desiredLook, k);
    this.camera.position.copy(this.smoothedPos);
    const fwd = this.smoothedLook.clone().sub(this.smoothedPos).normalize();
    this.camera.up.set(0, 1, 0);
    if (Math.abs(fwd.y) > 0.97) this.camera.up.copy(f.nor.lengthSq() > 0 ? new THREE.Vector3(0, 0, -1) : up);
    this.camera.lookAt(this.smoothedLook);
  }

  private updateExplore(dt: number) {
    if (this.exploreView === 'orbit') {
      this.orbit.update();
      this.panWithKeys(dt);
      return;
    }
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const v = this.flySpeed * boost * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (this.keys.has('KeyE') || this.keys.has('Space')) move.y += 1;
    if (this.keys.has('KeyQ') || this.keys.has('KeyC')) move.y -= 1;
    if (move.lengthSq() > 0) {
      this.camera.position.addScaledVector(move.normalize(), v);
      this.onUserInput?.();
    }
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camera.position.clone().add(fwd));
  }

  private panWithKeys(dt: number) {
    const move = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (this.keys.has('KeyW')) move.add(dir);
    if (this.keys.has('KeyS')) move.sub(dir);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    const dist = this.camera.position.distanceTo(this.orbit.target);
    move.normalize().multiplyScalar(dist * 0.8 * dt * (this.keys.has('ShiftLeft') ? 3 : 1));
    this.camera.position.add(move);
    this.orbit.target.add(move);
  }
}
