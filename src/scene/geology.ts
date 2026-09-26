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
 * from the horizon grids whenever the box changes; the rebuild writes into the
 * slabs' existing buffers, so a drag of the box costs a vertex update per
 * frame, not new geometry.
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

  /** Every slab's mesh, kept while a unit is stripped away so its material and buffers are reused when it comes back. */
  private slabs = new Map<string, THREE.Mesh>();
  /** node counts the slab buffers are laid out for */
  private grid: { nx: number; nz: number } | null = null;

  /**
   * Rebuild the slabs for the current box. The buffers keep their size while
   * the grid's node counts do, so the vertices are rewritten in place and the
   * GPU buffers updated rather than reallocated. `preview` (a box being
   * dragged) keeps the current counts so every step of the drag is such an
   * update; the drag's end rebuilds at the box's own resolution.
   */
  rebuild(preview = false) {
    const hs = this.field.horizons;
    const box = this.box;
    const want = slabGrid(box);
    const grid = want && preview && this.grid ? this.grid : want;
    const relayout = !grid || !this.grid || grid.nx !== this.grid.nx || grid.nz !== this.grid.nz;
    this.grid = grid;
    this.meshes.clear();
    // each horizon is sampled once: it is the top of one slab and the base of the one above
    const depth = grid ? hs.map((h) => sampleBoxGrid(h, box, grid.nx, grid.nz)) : [];
    for (let i = 0; i < hs.length; i++) {
      const top = hs[i];
      let mesh = this.slabs.get(top.id);
      const old = mesh && !relayout ? slabArrays(mesh.geometry) : undefined;
      const bounds = new THREE.Box3();
      const arrays = grid ? writeSlab(depth[i], depth[i + 1] ?? null, this.modelBase, box, grid.nx, grid.nz, old, bounds) : null;
      if (!arrays) {
        if (mesh) this.group.remove(mesh);
        continue;
      }
      if (!mesh) {
        const f = FORMATION_BY_ID.get(top.id)!;
        mesh = new THREE.Mesh(slabGeometry(arrays, bounds), createRockMaterial(LITHO_INDEX[f.lithology], f.color));
        mesh.name = `formation:${top.id}`;
        mesh.userData = { kind: 'formation', formationId: top.id, top, base: hs[i + 1] ?? null } satisfies SlabInfo;
        this.slabs.set(top.id, mesh);
      } else if (!old) {
        mesh.geometry.dispose();
        mesh.geometry = slabGeometry(arrays, bounds);
      } else {
        const g = mesh.geometry;
        g.attributes.position.needsUpdate = true;
        g.attributes.normal.needsUpdate = true;
        g.attributes.aStrat.needsUpdate = true;
        setBounds(g, bounds);
      }
      this.meshes.set(top.id, mesh);
      if (mesh.parent !== this.group) this.group.add(mesh);
    }
    // a unit stripped away while the counts changed: its buffers no longer fit
    if (relayout)
      for (const [id, m] of this.slabs)
        if (!this.meshes.has(id)) {
          m.geometry.dispose();
          m.geometry = new THREE.BufferGeometry();
        }
    this.applyState();
  }

  onBoxChange?: (b: SectionBox) => void;

  /** Move the section box; `preview` while it is dragged (see `rebuild`). */
  setBox(b: Partial<SectionBox>, preview = false) {
    this.box = { ...this.box, ...b };
    this.rebuild(preview);
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
/** vertical subdivisions of the cut faces, for lighting and banding */
const WALL_K = 8;

/** Grid node counts of the slabs for a section box: about 110 cells along its long side, never finer than 25 m. */
export function slabGrid(box: SectionBox): { nx: number; nz: number } | null {
  const W = box.xMax - box.xMin;
  const H = box.nMax - box.nMin;
  if (W < 10 || H < 10) return null;
  const cell = Math.max(25, Math.max(W, H) / 110);
  return { nx: Math.max(2, Math.round(W / cell) + 1), nz: Math.max(2, Math.round(H / cell) + 1) };
}

/** A horizon's depth at every grid node of the box, row-major [iz * nx + ix]. */
export function sampleBoxGrid(h: HorizonGrid, box: SectionBox, nx: number, nz: number): Float64Array {
  const W = box.xMax - box.xMin;
  const H = box.nMax - box.nMin;
  const d = new Float64Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    const n = box.nMin + (iz / (nz - 1)) * H;
    for (let ix = 0; ix < nx; ix++) d[iz * nx + ix] = sampleHorizon(h, box.xMin + (ix / (nx - 1)) * W, n);
  }
  return d;
}

/** The vertex and index arrays of one slab; their sizes depend only on the grid's node counts. */
export interface SlabArrays {
  position: Float32Array;
  normal: Float32Array;
  strat: Float32Array;
  index: Uint16Array | Uint32Array;
}

/** The typed arrays behind a slab geometry, to write the next box into; undefined for an empty placeholder. */
function slabArrays(g: THREE.BufferGeometry): SlabArrays | undefined {
  const p = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!p || !g.index) return undefined;
  return {
    position: p.array as Float32Array,
    normal: g.getAttribute('normal').array as Float32Array,
    strat: g.getAttribute('aStrat').array as Float32Array,
    index: g.index.array as Uint16Array | Uint32Array,
  };
}

/** Bounds known from the build (a sphere around the box: as good for culling and ray tests, and no pass over the vertices). */
function setBounds(g: THREE.BufferGeometry, b: THREE.Box3) {
  g.boundingBox = (g.boundingBox ?? new THREE.Box3()).copy(b);
  g.boundingSphere = b.getBoundingSphere(g.boundingSphere ?? new THREE.Sphere());
}

function slabGeometry(a: SlabArrays, bounds: THREE.Box3): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  g.setAttribute('aStrat', new THREE.BufferAttribute(a.strat, 1));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  setBounds(g, bounds);
  return g;
}

/** A slab's index: it depends only on the node counts, so it is written once per grid. */
function slabIndex(nx: number, nz: number, vertices: number): Uint16Array | Uint32Array {
  const K = WALL_K;
  const count = 12 * (nx - 1) * (nz - 1) + 6 * K * 2 * (nx - 1 + nz - 1);
  const idx = vertices > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  let o = 0;
  const botStart = nx * nz;
  for (let iz = 0; iz < nz - 1; iz++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // top faces up (+y); our z = -north so winding is flipped relative to (x, n)
      idx[o++] = a;
      idx[o++] = b;
      idx[o++] = c;
      idx[o++] = b;
      idx[o++] = d;
      idx[o++] = c;
      idx[o++] = botStart + a;
      idx[o++] = botStart + c;
      idx[o++] = botStart + b;
      idx[o++] = botStart + b;
      idx[o++] = botStart + c;
      idx[o++] = botStart + d;
    }
  // side walls, in the order south (+z), north (-z), west (-x), east (+x)
  let start = 2 * nx * nz;
  const walls: [number, 1 | -1][] = [
    [nx, -1],
    [nx, 1],
    [nz, 1],
    [nz, -1],
  ];
  for (const [len, outward] of walls) {
    for (let i = 0; i < len - 1; i++)
      for (let k = 0; k < K; k++) {
        const a = start + i * (K + 1) + k;
        const b = a + 1;
        const c = a + (K + 1);
        const d = c + 1;
        if (outward === 1) {
          idx[o++] = a;
          idx[o++] = c;
          idx[o++] = b;
          idx[o++] = b;
          idx[o++] = c;
          idx[o++] = d;
        } else {
          idx[o++] = a;
          idx[o++] = b;
          idx[o++] = c;
          idx[o++] = b;
          idx[o++] = d;
          idx[o++] = c;
        }
      }
    start += len * (K + 1);
  }
  return idx;
}

/**
 * A closed slab between two horizons clipped to the section box: the top and
 * base grids and the four cut faces, with the top honouring the overburden
 * strip depth. Depths come pre-sampled at the box's grid nodes (`top`, and
 * `base` or the flat model base), so a horizon is sampled once for both slabs
 * it bounds and the cut faces reuse the grid's edge nodes.
 *
 * Writes into `out` when given (arrays of the same node counts), so dragging
 * the box updates the GPU buffers in place instead of allocating new ones;
 * returns null (with `out` partly written) when the unit has no thickness
 * inside the box. `bounds` receives the slab's bounding box.
 */
export function writeSlab(
  top: Float64Array,
  base: Float64Array | null,
  modelBase: number,
  box: SectionBox,
  nx: number,
  nz: number,
  out?: SlabArrays,
  bounds?: THREE.Box3,
): SlabArrays | null {
  const K = WALL_K;
  const W = box.xMax - box.xMin;
  const H = box.nMax - box.nMin;
  const s = box.stripTo;
  const nv = 2 * nx * nz + 2 * (nx + nz) * (K + 1);
  const arrays: SlabArrays = out ?? { position: new Float32Array(nv * 3), normal: new Float32Array(nv * 3), strat: new Float32Array(nv), index: slabIndex(nx, nz, nv) };
  const { position: pos, strat } = arrays;
  const xAt = (ix: number) => box.xMin + (ix / (nx - 1)) * W;
  const nAt = (iz: number) => box.nMin + (iz / (nz - 1)) * H;
  const baseAt = (i: number) => (base ? base[i] : modelBase);
  // effective top honours the overburden strip depth
  const effTop = (t: number, b: number) => Math.min(Math.max(t, s), b);
  let v = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  const push = (x: number, y: number, n: number, st: number) => {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = -n;
    strat[v++] = st;
  };
  // top & bottom grids
  let anyThickness = false;
  for (let iz = 0; iz < nz; iz++) {
    const n = nAt(iz);
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const t = top[i];
      const b = baseAt(i);
      const et = effTop(t, b);
      if (b - et > 0.3) anyThickness = true;
      push(xAt(ix), -et, n, et - t);
    }
  }
  if (!anyThickness) return null;
  for (let iz = 0; iz < nz; iz++) {
    const n = nAt(iz);
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const b = baseAt(i);
      // sit the base a hair below the next unit's top so coincident horizons never z-fight
      push(xAt(ix), -b - BASE_GAP, n, b - top[i]);
    }
  }
  // side walls along the grid's edge nodes, vertical subdivisions for lighting/banding
  const wall = (ix0: number, iz0: number, dix: number, diz: number, len: number) => {
    for (let j = 0; j < len; j++) {
      const ix = ix0 + dix * j;
      const iz = iz0 + diz * j;
      const i = iz * nx + ix;
      const t = top[i];
      const b = baseAt(i);
      const et = effTop(t, b);
      const x = xAt(ix);
      const n = nAt(iz);
      for (let k = 0; k <= K; k++) {
        const d = et + ((b - et) * k) / K;
        push(x, -d, n, d - t);
      }
    }
  };
  wall(0, 0, 1, 0, nx); // south face (+z)
  wall(0, nz - 1, 1, 0, nx); // north face (-z)
  wall(0, 0, 0, 1, nz); // west face (-x)
  wall(nx - 1, 0, 0, 1, nz); // east face (+x)
  vertexNormals(pos, arrays.index, arrays.normal);
  // x and north span the box exactly (its corners are grid nodes); as stored in float32
  const f = Math.fround;
  bounds?.min.set(f(box.xMin), f(yMin), f(-box.nMax));
  bounds?.max.set(f(box.xMax), f(yMax), f(-box.nMin));
  return arrays;
}

/**
 * Area-weighted vertex normals, as three.js' `computeVertexNormals` makes
 * them, straight on the typed arrays (several times faster than going
 * through its attribute accessors). Pinched or stripped units produce
 * zero-area faces whose vertices get a zero normal; a zero normal becomes
 * NaN in the lighting and bloom spreads it into black blocks, so those point up.
 */
function vertexNormals(pos: Float32Array, idx: ArrayLike<number>, nrm: Float32Array) {
  nrm.fill(0);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const bx = pos[b];
    const by = pos[b + 1];
    const bz = pos[b + 2];
    const cbx = pos[c] - bx;
    const cby = pos[c + 1] - by;
    const cbz = pos[c + 2] - bz;
    const abx = pos[a] - bx;
    const aby = pos[a + 1] - by;
    const abz = pos[a + 2] - bz;
    const x = cby * abz - cbz * aby;
    const y = cbz * abx - cbx * abz;
    const z = cbx * aby - cby * abx;
    nrm[a] += x;
    nrm[a + 1] += y;
    nrm[a + 2] += z;
    nrm[b] += x;
    nrm[b + 1] += y;
    nrm[b + 2] += z;
    nrm[c] += x;
    nrm[c + 1] += y;
    nrm[c + 2] += z;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const x = nrm[i];
    const y = nrm[i + 1];
    const z = nrm[i + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0 && Number.isFinite(l)) {
      const k = 1 / l;
      nrm[i] = x * k;
      nrm[i + 1] = y * k;
      nrm[i + 2] = z * k;
    } else {
      nrm[i] = 0;
      nrm[i + 1] = 1;
      nrm[i + 2] = 0;
    }
  }
}
