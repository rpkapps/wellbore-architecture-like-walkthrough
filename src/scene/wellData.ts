import * as THREE from 'three';
import { findCurve, sampleCurve } from '../data/las';
import type { Well } from '../data/dataset';
import { FORMATIONS, LITHO_INDEX } from '../data/stratigraphy';
import { lut, type ColormapName } from '../data/colormap';

export const MISSING = -999;
export const DATA_STEP = 0.5;
const WIDTH = 1024;

/** Formation index used inside shaders. -1 = sea water, -2 = air. */
export function formationIndex(id: string): number {
  if (id === 'sea') return -1;
  if (id === 'air') return -2;
  return FORMATIONS.findIndex((f) => f.id === id);
}

export interface WellTextures {
  a: THREE.DataTexture;
  b: THREE.DataTexture;
  c: THREE.DataTexture;
  md0: number;
  count: number;
  width: number;
  step: number;
}

/**
 * Pack logs + interpretation along MD into float textures so that every
 * shader (borehole wall, invasion shells, fluid volume) samples the same data.
 */
export function buildWellTextures(well: Well): WellTextures {
  const md0 = 0;
  const md1 = well.tdMD;
  const count = Math.ceil((md1 - md0) / DATA_STEP) + 1;
  const rows = Math.ceil(count / WIDTH);
  const A = new Float32Array(WIDTH * rows * 4).fill(MISSING);
  const B = new Float32Array(WIDTH * rows * 4).fill(MISSING);
  const C = new Float32Array(WIDTH * rows * 4).fill(MISSING);
  const logs = well.logs;
  const deep = findCurve(logs, 'RT');
  const shallow = findCurve(logs, 'RSHAL');
  const gr = findCurve(logs, 'GR');
  const cali = findCurve(logs, 'CALI');
  const bs = findCurve(logs, 'BS');
  const rhob = findCurve(logs, 'RHOB');
  const nphi = findCurve(logs, 'NPHI');
  const p = well.petro;
  const d = logs?.depth;
  let zi = 0;
  for (let i = 0; i < count; i++) {
    const md = md0 + i * DATA_STEP;
    const o = i * 4;
    while (zi < well.zones.length - 1 && md >= well.zones[zi].baseMD) zi++;
    const zone = well.zones[zi];
    const fidx = zone ? formationIndex(zone.formationId) : MISSING;
    if (d) {
      const s = (c?: { values: Float32Array }) => (c ? sampleCurve(d, c.values, md) : NaN);
      const rd = s(deep);
      const rs = s(shallow);
      const g = s(gr);
      let cal = s(cali);
      if (!Number.isFinite(cal) || cal < 3 || cal > 40) cal = s(bs);
      A[o] = rd > 0 ? Math.log10(rd) : MISSING;
      A[o + 1] = rs > 0 ? Math.log10(rs) : rd > 0 ? Math.log10(rd) : MISSING;
      A[o + 2] = Number.isFinite(g) ? g : MISSING;
      A[o + 3] = Number.isFinite(cal) ? cal : MISSING;
      if (p) {
        const sw = s(p.sw);
        const ph = s(p.phie);
        const vs = s(p.vsh);
        B[o] = Number.isFinite(sw) ? sw : MISSING;
        B[o + 1] = Number.isFinite(ph) ? ph : MISSING;
        B[o + 2] = Number.isFinite(vs) ? vs : MISSING;
        // nearest-sample pay flag
        const k = nearestIndex(d, md);
        C[o] = k >= 0 && Math.abs(d[k] - md) < 1 ? p.pay[k] : MISSING;
      }
      C[o + 1] = Number.isFinite(s(rhob)) ? s(rhob) : MISSING;
      C[o + 2] = Number.isFinite(s(nphi)) ? s(nphi) : MISSING;
    }
    B[o + 3] = fidx;
  }
  const mk = (arr: Float32Array) => {
    const t = new THREE.DataTexture(arr, WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  return { a: mk(A), b: mk(B), c: mk(C), md0, count, width: WIDTH, step: DATA_STEP };
}

function nearestIndex(d: Float64Array, md: number): number {
  let lo = 0;
  let hi = d.length - 1;
  if (md < d[0] || md > d[hi]) return -1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (d[m] <= md) lo = m;
    else hi = m;
  }
  return md - d[lo] < d[hi] - md ? lo : hi;
}

export function makeLutTexture(name: ColormapName): THREE.DataTexture {
  const t = new THREE.DataTexture(lut(name), 256, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Uniform arrays describing formations (colour + lithology) for shaders. */
export function formationUniforms() {
  const colors: THREE.Color[] = [];
  const litho: number[] = [];
  for (let i = 0; i < 32; i++) {
    const f = FORMATIONS[i];
    colors.push(new THREE.Color(f ? f.color : '#555555'));
    litho.push(f ? LITHO_INDEX[f.lithology] : 6);
  }
  return { colors, litho };
}
