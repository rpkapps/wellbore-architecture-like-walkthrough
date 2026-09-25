import * as THREE from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/** A label on screen after a render: where it was placed and its measured size. */
interface Placed {
  el: HTMLElement;
  /** layer px of the anchor, and the anchor's fraction of the label box */
  x: number;
  y: number;
  cx: number;
  cy: number;
  d2: number;
  order: number;
}

/** What was last written to a label's style (writing an unchanged value still invalidates style). */
interface Written {
  transform: string;
  z: string;
  vis: string;
  cls: string;
  rank: number;
}

const vp = new THREE.Matrix4();
const v = new THREE.Vector3();
const camPos = new THREE.Vector3();

/** Decluttering order by label kind: measurements, the well, the platform and contacts first. */
function kindRank(c: DOMTokenList): number {
  if (c.contains('measure')) return 0;
  if (c.contains('well')) return 1;
  if (c.contains('platform')) return 2;
  if (c.contains('owc')) return 3;
  if (c.contains('gs')) return 4;
  if (c.contains('shoe')) return 5;
  if (c.contains('ctx')) return 8;
  if (c.contains('tick')) return 9;
  return 6;
}

/**
 * three's CSS2DRenderer, keeping what it computes: the screen position of
 * every label it places. Decluttering then needs only each label's size, which
 * is measured once and kept current by a ResizeObserver, so a frame never
 * reads layout back (getBoundingClientRect on every label forced a synchronous
 * style and layout of the whole document on every rendered frame). Style
 * properties are written only when their value changes. (No onBeforeRender /
 * onAfterRender callbacks: nothing in the app uses them on labels.)
 */
export class LabelRenderer {
  readonly domElement = document.createElement('div');
  private w = 1;
  private h = 1;
  private placed: Placed[] = [];
  private written = new WeakMap<HTMLElement, Written>();
  private sizes = new WeakMap<HTMLElement, { w: number; h: number }>();
  private observed = new Set<HTMLElement>();
  private ro: ResizeObserver | null = null;
  private sweep = 0;
  /** a label changed size after it was placed: decluttering has to run again */
  onSizeChange?: () => void;

  constructor() {
    this.domElement.style.overflow = 'hidden';
    if (typeof ResizeObserver !== 'undefined')
      this.ro = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const b = e.borderBoxSize?.[0];
          const w = b ? b.inlineSize : el.offsetWidth;
          const h = b ? b.blockSize : el.offsetHeight;
          const old = this.sizes.get(el);
          // hidden (display: none) reads 0 × 0: measure again when it shows
          if (!w && !h) this.sizes.delete(el);
          else if (!old || Math.abs(old.w - w) > 0.5 || Math.abs(old.h - h) > 0.5) {
            this.sizes.set(el, { w, h });
            changed = true;
          }
        }
        if (changed) this.onSizeChange?.();
      });
  }

  getSize() {
    return { width: this.w, height: this.h };
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.domElement.style.width = `${w}px`;
    this.domElement.style.height = `${h}px`;
  }

  /** `updateMatrices`: false when the WebGL render of this frame already updated the scene graph. */
  render(scene: THREE.Scene, camera: THREE.Camera, updateMatrices = true) {
    if (updateMatrices && scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (updateMatrices && camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    this.placed.length = 0;
    this.visit(scene, camera);
    // nearer labels on top (CSS2DRenderer's z-order)
    const p = this.placed;
    p.sort((a, b) => a.order - b.order || a.d2 - b.d2);
    for (let i = 0; i < p.length; i++) {
      const z = String(p.length - i);
      const s = this.state(p[i].el);
      if (s.z !== z) p[i].el.style.zIndex = s.z = z;
    }
    if (++this.sweep % 240 === 0) for (const el of this.observed) if (!el.isConnected) this.unobserve(el);
  }

  private state(el: HTMLElement): Written {
    let s = this.written.get(el);
    if (!s) this.written.set(el, (s = { transform: '', z: '', vis: el.style.visibility, cls: '', rank: 6 }));
    return s;
  }

  private hide(o: THREE.Object3D) {
    if ((o as { isCSS2DObject?: boolean }).isCSS2DObject) {
      const st = (o as CSS2DObject).element.style;
      if (st.display !== 'none') st.display = 'none';
    }
    for (const c of o.children) this.hide(c);
  }

  private visit(o: THREE.Object3D, camera: THREE.Camera) {
    if (!o.visible) return this.hide(o);
    if ((o as { isCSS2DObject?: boolean }).isCSS2DObject) {
      const obj = o as CSS2DObject;
      const el = obj.element;
      v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(vp);
      const shown = v.z >= -1 && v.z <= 1 && o.layers.test(camera.layers);
      if (el.style.display !== (shown ? '' : 'none')) el.style.display = shown ? '' : 'none';
      if (shown) {
        const cx = obj.center.x;
        const cy = obj.center.y;
        // a tenth of a pixel is below what text rendering shows, and keeps still labels unwritten
        const x = Math.round((v.x * 0.5 + 0.5) * this.w * 10) / 10;
        const y = Math.round((-v.y * 0.5 + 0.5) * this.h * 10) / 10;
        const t = `translate(${-100 * cx}%, ${-100 * cy}%) translate(${x}px, ${y}px) rotate(${-obj.rotation2D}rad)`;
        const s = this.state(el);
        if (s.transform !== t) {
          if (!s.transform) el.style.transformOrigin = `${100 * cx}% ${100 * cy}%`;
          el.style.transform = s.transform = t;
        }
        if (el.parentNode !== this.domElement) this.domElement.appendChild(el);
        this.placed.push({ el, x, y, cx, cy, d2: camPos.distanceToSquared(v.setFromMatrixPosition(o.matrixWorld)), order: -o.renderOrder });
      }
    }
    for (const c of o.children) this.visit(c, camera);
  }

  private unobserve(el: HTMLElement) {
    this.ro?.unobserve(el);
    this.observed.delete(el);
    this.sizes.delete(el);
  }

  /** The label's kind rank, from its class (cached until the class changes). */
  private rank(el: HTMLElement, s: Written): number {
    const cls = el.className;
    if (s.cls !== cls) {
      s.cls = cls;
      const label = el.classList.contains('label3d') ? el : el.querySelector<HTMLElement>('.label3d');
      s.rank = label ? kindRank(label.classList) : -1;
    }
    return s.rank;
  }

  private setVisible(el: HTMLElement, s: Written, on: boolean) {
    const vis = on ? '' : 'hidden';
    if (s.vis !== vis) el.style.visibility = s.vis = vis;
  }

  /**
   * Scene labels must not pile up: the ones on screen are placed by
   * importance (measurements, the well, the platform and contacts first,
   * closer before farther) and any that would overlap one already placed is
   * hidden. "few" keeps only the essential kinds; "all" shows every label.
   */
  declutter(mode: 'all' | 'near' | 'few') {
    const p = this.placed;
    if (mode === 'all') {
      for (const q of p) this.setVisible(q.el, this.state(q.el), true);
      return;
    }
    // sizes of labels not seen before: read in one batch (a single layout), then kept by the observer
    for (const q of p)
      if (!this.sizes.has(q.el)) {
        const w = q.el.offsetWidth;
        const h = q.el.offsetHeight;
        if (w || h) this.sizes.set(q.el, { w, h });
        if (this.ro && !this.observed.has(q.el)) {
          this.ro.observe(q.el);
          this.observed.add(q.el);
        }
      }
    const shown: { q: Placed; s: Written; r: number }[] = [];
    // p is sorted nearest first: its index orders labels of one kind by distance
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      const s = this.state(q.el);
      const k = this.rank(q.el, s);
      if (k < 0) continue;
      if (mode === 'few' && k >= 4) {
        this.setVisible(q.el, s, false);
        continue;
      }
      shown.push({ q, s, r: k * 1e6 + i });
    }
    shown.sort((a, b) => a.r - b.r);
    const boxes: number[] = [];
    const pad = 3;
    for (const { q, s } of shown) {
      const sz = this.sizes.get(q.el);
      if (!sz) {
        this.setVisible(q.el, s, true);
        continue;
      }
      const l = q.x - q.cx * sz.w;
      const t = q.y - q.cy * sz.h;
      const r = l + sz.w;
      const b = t + sz.h;
      let hit = false;
      for (let j = 0; j < boxes.length && !hit; j += 4) hit = l < boxes[j + 2] + pad && r > boxes[j] - pad && t < boxes[j + 3] + pad && b > boxes[j + 1] - pad;
      this.setVisible(q.el, s, !hit);
      if (!hit) boxes.push(l, t, r, b);
    }
  }
}
