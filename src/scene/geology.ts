import * as THREE from 'three';
import type { FieldModel } from '../data/dataset';
import { FORMATION_BY_ID, LITHO_INDEX, MODEL_HORIZONS } from '../data/stratigraphy';
import { sampleHorizon } from '../data/surfaces';
import type { HorizonGrid } from '../data/types';
import { createRockMaterial, type RockUniforms } from './rockMaterial';

export interface SectionBox {
  xMin: number;
  xMax: number;
  nMin: number;
  nMax: number;
  stripTo: number; // TVDSS (m): remove everything shallower than this
}

export interface LayerState {
  visible: boolean;
  opacity: number;
}

export interface SlabInfo {
  kind: 'formation';
  formationId: string;
  top: HorizonGrid;
  base: HorizonGrid | null;
}

/**
 * Regional geological block model: one closed solid per formation between two
 * interpolated horizons, clipped to an adjustable "section box" (as in BIM
 * section boxes). Cut faces are properly capped because each slab is rebuilt
 * from the horizon grids whenever the box changes.
 */
export class GeologyModel {
  readonly group = new THREE.Group();
  readonly meshes = new Map<string, THREE.Mesh>();
  readonly state = new Map<string, LayerState>();
  box: SectionBox;
  readonly fullBox: SectionBox;
  modelBase: number;
  private isolated: string | null = null;
  private highlight: string | null = null;

  constructor(private field: FieldModel) {
    this.group.name = 'geology';
    const e = field.extent;
    this.fullBox = { xMin: e.xMin, xMax: e.xMax, nMin: e.nMin, nMax: e.nMax, stripTo: 0 };
    this.box = { ...this.fullBox };
    const last = field.horizons[field.horizons.length - 1];
    let max = 0;
    for (const v of last.depth) max = Math.max(max, v);
    this.modelBase = Math.ceil((max + 250) / 50) * 50;
    // default presentation: overburden as tinted glass so the wells read through it, reservoir section solid
    const defaults: Record<string, number> = {
      nordland: 0.2,
      utsira: 0.22,
      hordaland: 0.14,
      ty: 0.18,
      ekofisk: 0.3,
      hod: 0.26,
      draupne: 0.55,
      heather: 0.5,
      hugin: 0.92,
      sleipner: 0.75,
      skagerrak: 0.8,
      smithbank: 0.85,
    };
    for (const id of MODEL_HORIZONS) this.state.set(id, { visible: true, opacity: defaults[id] ?? 1 });
    this.rebuild();
  }

  rebuild() {
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    const hs = this.field.horizons;
    const oldMats = new Map<string, THREE.Material>();
    for (const [id, m] of this.meshes) oldMats.set(id, m.material as THREE.Material);
    this.meshes.clear();
    for (let i = 0; i < hs.length; i++) {
      const top = hs[i];
      const base = hs[i + 1] ?? null;
      const geo = buildSlab(top, base, this.modelBase, this.box);
      if (!geo) continue;
      const f = FORMATION_BY_ID.get(top.id)!;
      const mat = (oldMats.get(top.id) as ReturnType<typeof createRockMaterial>) ?? createRockMaterial(LITHO_INDEX[f.lithology], f.color);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `formation:${top.id}`;
      mesh.userData = { kind: 'formation', formationId: top.id, top, base } satisfies SlabInfo;
      this.meshes.set(top.id, mesh);
      this.group.add(mesh);
    }
    this.applyState();
  }

  onBoxChange?: (b: SectionBox) => void;

  setBox(b: Partial<SectionBox>) {
    this.box = { ...this.box, ...b };
    this.rebuild();
    this.onBoxChange?.(this.box);
  }

  setLayer(id: string, s: Partial<LayerState>) {
    const cur = this.state.get(id);
    if (!cur) return;
    Object.assign(cur, s);
    this.applyState();
  }

  isolate(id: string | null) {
    this.isolated = id;
    this.applyState();
  }

  get isolatedId() {
    return this.isolated;
  }

  /** Recolour a formation's rock (the stratigraphy colour is changed by the caller). */
  setColor(id: string, hex: string) {
    const m = this.meshes.get(id);
    if (m) (m.material as THREE.Material & { userData: { uniforms: RockUniforms } }).userData.uniforms.uBase.value.set(hex);
  }

  setHighlight(id: string | null) {
    this.highlight = id;
    for (const [fid, m] of this.meshes) {
      (m.material as THREE.Material & { userData: { uniforms: RockUniforms } }).userData.uniforms.uHighlight.value = fid === id ? 1 : 0;
    }
  }

  setContours(on: boolean) {
    for (const m of this.meshes.values()) (m.material as THREE.Material & { userData: { uniforms: RockUniforms } }).userData.uniforms.uContours.value = on ? 1 : 0;
  }

  /** Global multiplier used in guided views (keeps the well visible). */
  globalOpacity = 1;
  forceTransparent = false;
  /** sun shadows: opaque slabs cast, every slab receives */
  shadows = false;
  /** called after visibility / opacity changes (e.g. to refresh the static shadow map) */
  onStateChange?: () => void;

  setGuided(on: boolean) {
    if (this.forceTransparent === on) return;
    this.forceTransparent = on;
    this.globalOpacity = on ? 0.7 : 1;
    this.applyState();
  }

  applyState() {
    for (const [id, m] of this.meshes) {
      const s = this.state.get(id)!;
      const mat = m.material as THREE.MeshStandardMaterial;
      let op = s.opacity * this.globalOpacity;
      let vis = s.visible;
      if (this.isolated && this.isolated !== id) {
        op = Math.min(op, 0.06);
      }
      if (op <= 0.01) vis = false;
      m.visible = vis;
      const transparent = op < 0.995 || this.forceTransparent;
      if (mat.transparent !== transparent) mat.needsUpdate = true;
      mat.transparent = transparent;
      mat.opacity = op;
      mat.depthWrite = !transparent;
      m.userData.transparent = transparent;
      m.castShadow = this.shadows && !transparent;
      m.receiveShadow = this.shadows;
    }
    if (this.highlight) this.setHighlight(this.highlight);
    this.sortForCamera(this.lastCamY, true);
    this.onStateChange?.();
  }

  private lastCamY = 0;

  /**
   * Stable back-to-front order for the (horizontally stacked) transparent slabs:
   * units farther from the camera's elevation draw first. Avoids the popping of
   * three.js' per-object distance sort while zooming.
   */
  sortForCamera(camY: number, force = false) {
    if (!force && Math.abs(camY - this.lastCamY) < 1) return;
    this.lastCamY = camY;
    const list = [...this.meshes.values()].filter((m) => m.userData.transparent);
    for (const m of list) {
      const bb = m.geometry.boundingBox ?? (m.geometry.computeBoundingBox(), m.geometry.boundingBox!);
      const top = bb.max.y;
      const bot = bb.min.y;
      m.userData.sortKey = camY > top ? camY - (top + bot) / 2 : camY < bot ? (top + bot) / 2 - camY : 0;
    }
    list.sort((a, b) => b.userData.sortKey - a.userData.sortKey);
    list.forEach((m, i) => (m.renderOrder = 2 + i * 0.01));
    for (const m of this.meshes.values()) if (!m.userData.transparent) m.renderOrder = 0;
  }
}

const BASE_GAP = 0.25; // m

/** Build a closed slab between two horizon grids clipped to the section box. */
function buildSlab(top: HorizonGrid, base: HorizonGrid | null, modelBase: number, box: SectionBox): THREE.BufferGeometry | null {
  const W = box.xMax - box.xMin;
  const H = box.nMax - box.nMin;
  if (W < 10 || H < 10) return null;
  const cell = Math.max(25, Math.max(W, H) / 110);
  const nx = Math.max(2, Math.round(W / cell) + 1);
  const nz = Math.max(2, Math.round(H / cell) + 1);
  const topD = (x: number, n: number) => sampleHorizon(top, x, n);
  const baseD = (x: number, n: number) => (base ? sampleHorizon(base, x, n) : modelBase);
  // effective top honours the overburden strip depth
  const effTop = (x: number, n: number) => Math.max(topD(x, n), box.stripTo);
  let anyThickness = false;
  const pos: number[] = [];
  const strat: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, n: number, s: number) => {
    pos.push(x, y, -n);
    strat.push(s);
    return pos.length / 3 - 1;
  };
  // top & bottom grids
  const topStart = 0;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = box.xMin + (ix / (nx - 1)) * W;
      const n = box.nMin + (iz / (nz - 1)) * H;
      const t = topD(x, n);
      const b = baseD(x, n);
      const et = Math.min(effTop(x, n), b);
      if (b - et > 0.3) anyThickness = true;
      push(x, -et, n, et - t);
    }
  if (!anyThickness) return null;
  const botStart = pos.length / 3;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = box.xMin + (ix / (nx - 1)) * W;
      const n = box.nMin + (iz / (nz - 1)) * H;
      const t = topD(x, n);
      const b = baseD(x, n);
      // sit the base a hair below the next unit's top so coincident horizons never z-fight
      push(x, -b - BASE_GAP, n, b - t);
    }
  for (let iz = 0; iz < nz - 1; iz++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // top faces up (+y); our z = -north so winding is flipped relative to (x, n)
      idx.push(topStart + a, topStart + b, topStart + c, topStart + b, topStart + d, topStart + c);
      idx.push(botStart + a, botStart + c, botStart + b, botStart + b, botStart + c, botStart + d);
    }
  // side walls: walk each edge, vertical subdivisions for lighting/banding
  const K = 8;
  const edge = (pts: [number, number][], outward: 1 | -1) => {
    const start = pos.length / 3;
    for (const [x, n] of pts) {
      const t = topD(x, n);
      const b = baseD(x, n);
      const et = Math.min(effTop(x, n), b);
      for (let k = 0; k <= K; k++) {
        const d = et + ((b - et) * k) / K;
        push(x, -d, n, d - t);
      }
    }
    for (let i = 0; i < pts.length - 1; i++)
      for (let k = 0; k < K; k++) {
        const a = start + i * (K + 1) + k;
        const b = a + 1;
        const c = a + (K + 1);
        const d = c + 1;
        if (outward === 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
  };
  const xs = (n: number) => Array.from({ length: nx }, (_, i) => [box.xMin + (i / (nx - 1)) * W, n] as [number, number]);
  const ns = (x: number) => Array.from({ length: nz }, (_, i) => [x, box.nMin + (i / (nz - 1)) * H] as [number, number]);
  edge(xs(box.nMin), -1); // south face (+z)
  edge(xs(box.nMax), 1); // north face (-z)
  edge(ns(box.xMin), 1); // west face (-x)
  edge(ns(box.xMax), -1); // east face (+x)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aStrat', new THREE.Float32BufferAttribute(strat, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // pinched / stripped units produce zero-area faces whose vertices get a zero normal;
  // a zero normal becomes NaN in the lighting and bloom spreads it into black blocks
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) {
    const x = nrm.getX(i),
      y = nrm.getY(i),
      z = nrm.getZ(i);
    const l = x * x + y * y + z * z;
    if (!(l > 1e-12) || !Number.isFinite(l)) nrm.setXYZ(i, 0, 1, 0);
  }
  g.computeBoundingSphere();
  return g;
}
