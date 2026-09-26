import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
/** radians per pixel of a rotating drag */
const ROTATE_SPEED = 0.005;
/** the view never tilts past this from the horizontal (about 86°), so it cannot flip over */
const MAX_ELEVATION = 1.5;
/** how fast a released rotation glides to a stop (s) */
const GLIDE_TAU = 0.1;
/** closest the wheel brings the camera to the point it zooms toward (m) */
const MIN_ZOOM_DISTANCE = 2;

type Drag = { kind: 'rotate' | 'pan'; id: number; x: number; y: number; pivot: THREE.Vector3; plane: THREE.Plane; t: number };

/**
 * Explore's orbit navigation, as in Onshape, Fusion or Google Earth: what is
 * under the pointer is what the view turns around, zooms toward and drags.
 *
 * - Left drag rotates around the point under the pointer when the button went
 *   down (a small dot marks it), or the view's centre over empty space; let
 *   go mid-swing and it glides briefly to a stop, nothing more.
 * - Right or middle drag (or Shift / Ctrl + left) pans: the point grabbed
 *   stays under the pointer.
 * - The wheel zooms toward the point under the pointer, a share of the
 *   distance per notch, so it slows as it nears a surface; kept going, it
 *   passes through at a steady pace instead of stalling; over empty space, and when zooming out, it moves straight along the
 *   view instead, so the scene never slides off the screen.
 * - The view's centre stays within the scene's extent and the camera within
 *   a few scene sizes of it: the scene cannot be lost.
 *
 * It moves the camera and the orbit centre (`target`), which the orbit
 * controls then look along; their own mouse input is off while this is.
 */
export class ExploreNav {
  /** the point of the scene under a pointer position */
  pickPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;
  /** the scene's extent (the model block, the platform) */
  bounds?: () => THREE.Box3 | null;
  onInput?: () => void;
  /** the marker showed or hid: draw a frame */
  requestRender?: () => void;
  /**
   * The pivot's marker, a dot of a fixed size on screen drawn in the scene
   * itself (the engine adds it), so it moves in step with the frame and
   * shows over everything.
   */
  readonly marker: THREE.Points;

  private drag: Drag | null = null;
  /** a released rotation still turning (rad / s), around `glidePivot` */
  private glide = { yaw: 0, pitch: 0, pivot: new THREE.Vector3() };
  private moveVel = { yaw: 0, pitch: 0 };
  private zoom = { pending: 0, anchor: new THREE.Vector3(), toward: false };
  private raycaster = new THREE.Raycaster();
  /** The last point zoomed toward or turned / dragged about: what is being looked at. */
  private focus: THREE.Vector3 | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private target: THREE.Vector3,
    private dom: HTMLElement,
    private active: () => boolean,
  ) {
    this.marker = pivotMarker();
    dom.addEventListener('pointerdown', (e) => this.down(e));
    dom.addEventListener('pointermove', (e) => this.move(e));
    dom.addEventListener('pointerup', (e) => this.up(e));
    dom.addEventListener('pointercancel', (e) => this.up(e));
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  /** Stop whatever is moving the view (a flight or another mode takes over). */
  stop() {
    this.drag = null;
    this.glide.yaw = this.glide.pitch = 0;
    this.zoom.pending = 0;
    this.focus = null;
    this.showMarker(null);
  }

  /** How far away what is being looked at is: the point last zoomed to or turned about while it is ahead, else the view's centre. */
  lookDistance(): number {
    const cam = this.camera.position;
    if (this.focus) {
      const ahead = this.focus.clone().sub(cam).dot(this.camera.getWorldDirection(new THREE.Vector3()));
      if (ahead > 0) return this.focus.distanceTo(cam);
    }
    return this.target.distanceTo(cam);
  }

  // ------------------------------------------------------------------ input

  private down(e: PointerEvent) {
    if (!this.active() || this.drag || (e.pointerType === 'touch' && !e.isPrimary)) return;
    const pan = e.button === 2 || e.button === 1 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey));
    if (!pan && e.button !== 0) return;
    this.glide.yaw = this.glide.pitch = 0;
    const hit = this.pickPoint?.(e.clientX, e.clientY) ?? null;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    // rotate around what is under the pointer, or the view's centre; pan the grabbed point
    // (over empty space: the point on the plane through the view's centre)
    if (hit) this.focus = hit.clone();
    const pivot = hit ?? (pan ? this.onPlane(e, new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, this.target)) : null) ?? this.target.clone();
    this.drag = { kind: pan ? 'pan' : 'rotate', id: e.pointerId, x: e.clientX, y: e.clientY, pivot, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, pivot), t: performance.now() };
    this.moveVel.yaw = this.moveVel.pitch = 0;
    this.dom.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!dx && !dy) return;
    d.x = e.clientX;
    d.y = e.clientY;
    const now = performance.now();
    if (d.kind === 'rotate') {
      if (!this.marker.visible) this.showMarker(d.pivot);
      const yaw = -dx * ROTATE_SPEED;
      const pitch = -dy * ROTATE_SPEED;
      this.rotate(d.pivot, yaw, pitch);
      // the pace of the last moves, for the glide on release
      const dt = Math.max(1, now - d.t) / 1000;
      this.moveVel.yaw = this.moveVel.yaw * 0.5 + (yaw / dt) * 0.5;
      this.moveVel.pitch = this.moveVel.pitch * 0.5 + (pitch / dt) * 0.5;
    } else {
      // the grabbed point back under the pointer
      const q = this.onPlane(e, d.plane);
      if (q) {
        const delta = d.pivot.clone().sub(q);
        const lim = this.camera.position.distanceTo(d.pivot) * 0.5;
        if (delta.length() > lim) delta.setLength(lim);
        this.camera.position.add(delta);
        this.target.add(delta);
      }
    }
    d.t = now;
    this.keepInBounds();
    this.onInput?.();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    // still turning as the button came up: a short glide
    if (d.kind === 'rotate' && performance.now() - d.t < 60 && Math.hypot(this.moveVel.yaw, this.moveVel.pitch) > 0.3) {
      this.glide = { yaw: this.moveVel.yaw, pitch: this.moveVel.pitch, pivot: d.pivot };
    } else this.showMarker(null);
  }

  private wheel(e: WheelEvent) {
    if (!this.active()) return;
    e.preventDefault();
    // lines and pages as pixels; a notch of a mouse wheel (~100 px) is about 13 % of the distance
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const step = Math.max(-0.5, Math.min(0.5, px * 0.0012));
    const zoomIn = step < 0;
    const picked = zoomIn ? (this.pickPoint?.(e.clientX, e.clientY) ?? null) : null;
    const hit = zoomIn ? (picked ?? this.intoBounds(e)) : null;
    if (zoomIn) this.focus = picked;
    // a new direction or a new place: start from here
    if (Math.sign(step) !== Math.sign(this.zoom.pending)) this.zoom.pending = 0;
    this.zoom.toward = !!hit;
    if (hit) this.zoom.anchor.copy(hit);
    this.zoom.pending += step;
    this.glide.yaw = this.glide.pitch = 0;
    this.onInput?.();
  }

  // ------------------------------------------------------------------ per frame

  /** Apply the eased zoom and the glide; keep the view on the scene. */
  update(dt: number) {
    let moved = false;
    if (this.zoom.pending) {
      const step = Math.abs(this.zoom.pending) < 1e-4 ? this.zoom.pending : this.zoom.pending * Math.min(1, dt * 12);
      this.zoom.pending -= step;
      if (this.zoom.toward) this.scaleAbout(this.zoom.anchor, Math.exp(step));
      else this.dolly(Math.exp(step));
      moved = true;
    }
    const g = this.glide;
    if (g.yaw || g.pitch) {
      this.rotate(g.pivot, g.yaw * dt, g.pitch * dt);
      const k = Math.exp(-dt / GLIDE_TAU);
      g.yaw *= k;
      g.pitch *= k;
      if (Math.hypot(g.yaw, g.pitch) < 0.02) {
        g.yaw = g.pitch = 0;
        if (!this.drag) this.showMarker(null);
      }
      moved = true;
    }
    if (moved) this.keepInBounds();
  }

  // ------------------------------------------------------------------ moves

  /** Turn the view around a point: about the vertical, then tilt, never past MAX_ELEVATION. */
  private rotate(pivot: THREE.Vector3, yaw: number, pitch: number) {
    const cam = this.camera.position;
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const fwd = this.target.clone().sub(cam).normalize().applyQuaternion(qy);
    const elev = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    const tilt = THREE.MathUtils.clamp(elev + pitch, -MAX_ELEVATION, MAX_ELEVATION) - elev;
    const right = new THREE.Vector3().crossVectors(fwd, UP);
    const q = qy.clone();
    if (right.lengthSq() > 1e-8) q.premultiply(new THREE.Quaternion().setFromAxisAngle(right.normalize(), tilt));
    cam.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.target);
  }

  /**
   * Scale the camera and the view's centre about a point (k < 1 nears it).
   * Where that would bring the camera closer than MIN_ZOOM_DISTANCE, it goes
   * on through instead, at the pace the view's size gives, rather than stop.
   */
  private scaleAbout(a: THREE.Vector3, k: number) {
    const d = this.camera.position.distanceTo(a);
    if (k < 1 && d * k < MIN_ZOOM_DISTANCE) {
      const dir = a.clone().sub(this.camera.position);
      if (dir.lengthSq() < 1e-8) this.camera.getWorldDirection(dir);
      const step = dir.setLength(Math.max(1, this.camera.position.distanceTo(this.target)) * (1 - k) * 0.5);
      this.camera.position.add(step);
      this.target.add(step);
      return;
    }
    this.camera.position.sub(a).multiplyScalar(k).add(a);
    this.target.sub(a).multiplyScalar(k).add(a);
  }

  /** Move straight along the view, toward or away from its centre. */
  private dolly(k: number) {
    const off = this.camera.position.clone().sub(this.target);
    const d = off.length();
    const nd = Math.max(MIN_ZOOM_DISTANCE, d * k);
    this.camera.position.copy(this.target).add(off.setLength(nd));
  }

  /**
   * The view's centre stays inside the scene's extent (a little beyond it),
   * and the camera within about three scene sizes of the scene's middle.
   */
  private keepInBounds() {
    const b = this.bounds?.();
    if (!b || b.isEmpty()) return;
    const size = b.getSize(new THREE.Vector3());
    const box = b.clone().expandByVector(size.clone().multiplyScalar(0.15));
    if (!box.containsPoint(this.target)) {
      const c = box.clampPoint(this.target, new THREE.Vector3());
      const delta = c.sub(this.target);
      this.target.add(delta);
      this.camera.position.add(delta);
    }
    const mid = b.getCenter(new THREE.Vector3());
    const r = size.length() * 1.6;
    const off = this.camera.position.clone().sub(mid);
    if (off.length() > r) {
      this.camera.position.copy(mid).add(off.setLength(r));
      this.camera.lookAt(this.target);
    }
  }

  // ------------------------------------------------------------------ helpers

  private ray(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.raycaster.ray;
  }

  private onPlane(e: { clientX: number; clientY: number }, plane: THREE.Plane): THREE.Vector3 | null {
    return this.ray(e).intersectPlane(plane, new THREE.Vector3());
  }

  /** Where the pointer's ray enters the scene's extent (nothing drawn under the pointer, but the scene is there). */
  private intoBounds(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const b = this.bounds?.();
    return b && !b.isEmpty() ? this.ray(e).intersectBox(b, new THREE.Vector3()) : null;
  }

  private showMarker(p: THREE.Vector3 | null) {
    if (p) this.marker.position.copy(p);
    if (this.marker.visible === !!p) return;
    this.marker.visible = !!p;
    this.requestRender?.();
  }
}

/** A ring-and-dot marker 14 px across, over everything, untouched by tone mapping. */
function pivotMarker(): THREE.Points {
  const n = 64;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.arc(n / 2, n / 2, n / 2 - 1, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = n * 0.11;
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.33, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.1, 0, Math.PI * 2);
    g.fill();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const mat = new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const m = new THREE.Points(geo, mat);
  m.renderOrder = 1000;
  m.frustumCulled = false;
  m.visible = false;
  // never a click target
  m.raycast = () => {};
  return m;
}
