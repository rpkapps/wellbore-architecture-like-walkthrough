import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { FieldModel } from '../src/data/dataset';
import { sampleHorizon } from '../src/data/surfaces';
import type { HorizonGrid } from '../src/data/types';
import { GeologyModel, sampleBoxGrid, slabGrid, writeSlab, type SectionBox } from '../src/scene/geology';

/** Three dipping horizons over a 4 × 2 km extent; the middle unit pinches out to the east. */
function horizons(): HorizonGrid[] {
  const nx = 41;
  const nz = 21;
  const x0 = -1000;
  const z0 = 0;
  const dx = 100;
  const dz = 100;
  const make = (id: string, f: (x: number, n: number) => number): HorizonGrid => {
    const depth = new Float32Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) depth[iz * nx + ix] = f(x0 + ix * dx, z0 + iz * dz);
    return { id, name: id, nx, nz, x0, z0, dx, dz, depth, controlPoints: [] };
  };
  const a = (x: number, n: number) => 800 + 0.05 * x + 40 * Math.sin(n / 300);
  const b = (x: number, n: number) => Math.max(a(x, n) + 0.5, 1400 - 0.2 * x + 20 * Math.cos(x / 250 + n / 400));
  const c = (x: number, n: number) => b(x, n) + 300 + 0.03 * n;
  return [make('nordland', a), make('hordaland', b), make('hugin', c)];
}

/** The slab builder as it was before it wrote into typed arrays: the reference for the geometry. */
function referenceSlab(top: HorizonGrid, base: HorizonGrid | null, modelBase: number, box: SectionBox): THREE.BufferGeometry | null {
  const W = box.xMax - box.xMin;
  const H = box.nMax - box.nMin;
  if (W < 10 || H < 10) return null;
  const cell = Math.max(25, Math.max(W, H) / 110);
  const nx = Math.max(2, Math.round(W / cell) + 1);
  const nz = Math.max(2, Math.round(H / cell) + 1);
  const topD = (x: number, n: number) => sampleHorizon(top, x, n);
  const baseD = (x: number, n: number) => (base ? sampleHorizon(base, x, n) : modelBase);
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
      push(x, -b - 0.25, n, b - t);
    }
  for (let iz = 0; iz < nz - 1; iz++)
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
      idx.push(botStart + a, botStart + c, botStart + b, botStart + b, botStart + c, botStart + d);
    }
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
  edge(xs(box.nMin), -1);
  edge(xs(box.nMax), 1);
  edge(ns(box.xMin), 1);
  edge(ns(box.xMax), -1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aStrat', new THREE.Float32BufferAttribute(strat, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) {
    const l = nrm.getX(i) ** 2 + nrm.getY(i) ** 2 + nrm.getZ(i) ** 2;
    if (!(l > 1e-12) || !Number.isFinite(l)) nrm.setXYZ(i, 0, 1, 0);
  }
  return g;
}

const MODEL_BASE = 2600;
const boxes: SectionBox[] = [
  { xMin: -1000, xMax: 3000, nMin: 0, nMax: 2000, stripTo: 0 },
  { xMin: -400, xMax: 1300, nMin: 350, nMax: 1210, stripTo: 0 },
  { xMin: 200, xMax: 900, nMin: 100, nMax: 1900, stripTo: 1100 },
  { xMin: -1000, xMax: 3000, nMin: 0, nMax: 2000, stripTo: 2400 },
];

function expectSame(g: THREE.BufferGeometry | null, a: ReturnType<typeof writeSlab>) {
  expect(a === null).toBe(g === null);
  if (!g || !a) return;
  expect(Array.from(a.index)).toEqual(Array.from(g.index!.array));
  const close = (x: ArrayLike<number>, y: ArrayLike<number>, tol: number) => {
    expect(x.length).toBe(y.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    expect(worst).toBeLessThanOrEqual(tol);
  };
  close(a.position, g.getAttribute('position').array, 0);
  close(a.strat, g.getAttribute('aStrat').array, 0);
  close(a.normal, g.getAttribute('normal').array, 1e-6);
}

describe('section box slabs', () => {
  const hs = horizons();
  it('match the reference geometry for full, trimmed and stripped boxes', () => {
    for (const box of boxes) {
      const { nx, nz } = slabGrid(box)!;
      const depth = hs.map((h) => sampleBoxGrid(h, box, nx, nz));
      for (let i = 0; i < hs.length; i++) expectSame(referenceSlab(hs[i], hs[i + 1] ?? null, MODEL_BASE, box), writeSlab(depth[i], depth[i + 1] ?? null, MODEL_BASE, box, nx, nz));
    }
  });

  it('rewrite the same buffers while a drag keeps the grid, and rebuild at the box resolution when it ends', () => {
    const field = { extent: { xMin: -1000, xMax: 3000, nMin: 0, nMax: 2000 }, horizons: hs } as unknown as FieldModel;
    const geo = new GeologyModel(field);
    const before = new Map([...geo.meshes].map(([id, m]) => [id, m.geometry]));
    const count = geo.meshes.get('hugin')!.geometry.getAttribute('position').count;
    geo.setBox({ xMax: 1800, nMin: 600 }, true);
    for (const [id, m] of geo.meshes) expect(m.geometry).toBe(before.get(id));
    expect(geo.meshes.get('hugin')!.geometry.getAttribute('position').count).toBe(count);
    // stripped away mid-drag and back: the unit reappears with its buffers
    geo.setBox({ stripTo: 2000 }, true);
    expect(geo.meshes.has('nordland')).toBe(false);
    geo.setBox({ stripTo: 0 }, true);
    expect(geo.meshes.get('nordland')!.geometry).toBe(before.get('nordland'));
    // the drag's end: the box's own resolution, the same vertices a fresh build makes
    geo.setBox({});
    const box = geo.box;
    for (const [id, m] of geo.meshes) {
      const i = hs.findIndex((h) => h.id === id);
      const ref = referenceSlab(hs[i], hs[i + 1] ?? null, geo.modelBase, box)!;
      expect(m.geometry.getAttribute('position').count).toBe(ref.getAttribute('position').count);
      expect(Array.from(m.geometry.getAttribute('position').array)).toEqual(Array.from(ref.getAttribute('position').array));
      // bounds come from the build, not a pass over the vertices: the same box
      ref.computeBoundingBox();
      expect(m.geometry.boundingBox!.min.distanceTo(ref.boundingBox!.min)).toBeLessThan(1e-3);
      expect(m.geometry.boundingBox!.max.distanceTo(ref.boundingBox!.max)).toBeLessThan(1e-3);
      expect(m.geometry.boundingSphere!.containsPoint(ref.boundingBox!.max)).toBe(true);
    }
  });
});
