import { sampleHorizon } from './surfaces';
import type { HorizonGrid, ProductionRecord } from './types';

/**
 * Plan-view helpers: structure contours of a horizon grid, where a well path
 * crosses a horizon, and production accumulated up to a date.
 */

/** Depth range (TVDSS) of a horizon grid. */
export function horizonRange(g: HorizonGrid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of g.depth) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Marching-squares contour of a horizon grid at one depth. Returns line
 * segments as a flat array [x1, n1, x2, n2, …] in local metres (x = east).
 */
export function contourSegments(g: HorizonGrid, level: number): number[] {
  const out: number[] = [];
  const { nx, nz, depth: D } = g;
  const X = (ix: number) => g.x0 + ix * g.dx;
  const N = (iz: number) => g.z0 + iz * g.dz;
  // crossing point on an edge between two grid nodes
  const cross = (x1: number, n1: number, v1: number, x2: number, n2: number, v2: number): [number, number] => {
    const t = (level - v1) / (v2 - v1 || 1e-9);
    return [x1 + (x2 - x1) * t, n1 + (n2 - n1) * t];
  };
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = D[iz * nx + ix]; // (ix, iz)
      const b = D[iz * nx + ix + 1]; // (ix+1, iz)
      const c = D[(iz + 1) * nx + ix + 1]; // (ix+1, iz+1)
      const d = D[(iz + 1) * nx + ix]; // (ix, iz+1)
      if (![a, b, c, d].every(Number.isFinite)) continue;
      const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = X(ix);
      const x1 = X(ix + 1);
      const n0 = N(iz);
      const n1 = N(iz + 1);
      const eAB = () => cross(x0, n0, a, x1, n0, b);
      const eBC = () => cross(x1, n0, b, x1, n1, c);
      const eCD = () => cross(x1, n1, c, x0, n1, d);
      const eDA = () => cross(x0, n1, d, x0, n0, a);
      const seg = (p: [number, number], q: [number, number]) => out.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1:
        case 14:
          seg(eDA(), eAB());
          break;
        case 2:
        case 13:
          seg(eAB(), eBC());
          break;
        case 3:
        case 12:
          seg(eDA(), eBC());
          break;
        case 4:
        case 11:
          seg(eBC(), eCD());
          break;
        case 6:
        case 9:
          seg(eAB(), eCD());
          break;
        case 7:
        case 8:
          seg(eCD(), eDA());
          break;
        case 5:
        case 10: {
          // saddle: decide by the cell centre
          const centre = (a + b + c + d) / 4 > level;
          if ((code === 5) === centre) {
            seg(eDA(), eCD());
            seg(eAB(), eBC());
          } else {
            seg(eDA(), eAB());
            seg(eBC(), eCD());
          }
          break;
        }
      }
    }
  }
  return out;
}

/** Sampled well path: a Trajectory or a context well (MD, TVD below the datum, local north / east). */
export interface PathArrays {
  md: ArrayLike<number>;
  tvd: ArrayLike<number>;
  ns: ArrayLike<number>;
  ew: ArrayLike<number>;
}

/** First point where a well path passes below a horizon, or null when it never reaches it. */
export function horizonCrossing(traj: PathArrays, g: HorizonGrid, datumElevation: number): { md: number; ew: number; ns: number; tvdss: number } | null {
  let prev = NaN;
  for (let i = 0; i < traj.md.length; i++) {
    const tvdss = traj.tvd[i] - datumElevation;
    const diff = tvdss - sampleHorizon(g, traj.ew[i], traj.ns[i]);
    if (diff >= 0) {
      if (i === 0) return null;
      const t = Number.isFinite(prev) ? prev / (prev - diff || 1) : 1;
      const L = (a: ArrayLike<number>) => a[i - 1] + (a[i] - a[i - 1]) * t;
      return { md: L(traj.md), ew: L(traj.ew), ns: L(traj.ns), tvdss: L(traj.tvd) - datumElevation };
    }
    prev = diff;
  }
  return null;
}

export interface ProductionState {
  /** cumulative volumes up to and including the month containing t (Sm³) */
  cumOil: number;
  cumGas: number;
  cumWater: number;
  cumInj: number;
  /** rates in the month containing t (Sm³/day), 0 when shut in */
  oilRate: number;
  waterRate: number;
  injRate: number;
  /** water cut of that month, or NaN when nothing was produced */
  waterCut: number;
  /** false before first production / injection */
  started: boolean;
}

const DAY = 86400000;

/** Production state of one well at time t, from monthly (or daily) records sorted by time. */
export function productionAt(records: ProductionRecord[], t: number): ProductionState {
  const s: ProductionState = { cumOil: 0, cumGas: 0, cumWater: 0, cumInj: 0, oilRate: 0, waterRate: 0, injRate: 0, waterCut: NaN, started: false };
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.t > t) break;
    s.cumOil += r.oil || 0;
    s.cumGas += r.gas || 0;
    s.cumWater += r.water || 0;
    s.cumInj += r.waterInj || 0;
    if ((r.oil || 0) + (r.water || 0) + (r.waterInj || 0) > 0) s.started = true;
    const next = records[i + 1];
    if (!next || next.t > t) {
      // the last record at or before t: its rates apply only while t is inside its period
      // (daily or monthly; months with no record are shut-in months)
      const prev = records[i - 1];
      const daily = prev ? r.t - prev.t < 27 * DAY : false;
      const d0 = new Date(r.t);
      const monthEnd = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1);
      const len = Math.min(next ? next.t - r.t : Infinity, daily ? DAY : monthEnd - r.t);
      const days = Math.max(1, Math.round(len / DAY));
      if (t < r.t + len) {
        s.oilRate = (r.oil || 0) / days;
        s.waterRate = (r.water || 0) / days;
        s.injRate = (r.waterInj || 0) / days;
        const liq = (r.oil || 0) + (r.water || 0);
        s.waterCut = liq > 0 ? (r.water || 0) / liq : NaN;
      }
    }
  }
  return s;
}

/** Time span covered by a set of production series (epoch ms). */
export function productionSpan(series: Iterable<ProductionRecord[]>): { t0: number; t1: number } | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const rs of series)
    for (const r of rs) {
      if ((r.oil || 0) + (r.water || 0) + (r.waterInj || 0) <= 0) continue;
      t0 = Math.min(t0, r.t);
      t1 = Math.max(t1, r.t);
    }
  return Number.isFinite(t0) ? { t0, t1 } : null;
}
