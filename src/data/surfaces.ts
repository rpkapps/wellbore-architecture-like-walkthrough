import { FORMATION_BY_ID, MODEL_HORIZONS, formationIdForPick } from './stratigraphy';
import type { HorizonGrid, PickRow } from './types';

export interface ModelExtent {
  xMin: number; // east (m, local)
  xMax: number;
  nMin: number; // north (m, local)
  nMax: number;
}

/**
 * Regional structural surfaces interpolated from multi-well formation picks
 * (first observation of each pick per wellbore). Interpolator: least-squares
 * planar trend + inverse-distance-weighted residuals that relax back to the
 * trend away from control (background weight). Surfaces are then forced into
 * stratigraphic order. Status: 'interpreted model' — exact only at the picks.
 */
export function buildHorizons(
  picks: PickRow[],
  origin: { e: number; n: number },
  datumElevation: number,
  extent: ModelExtent,
  res = 96,
): HorizonGrid[] {
  const nx = res;
  const nz = res;
  const dx = (extent.xMax - extent.xMin) / (nx - 1);
  const dz = (extent.nMax - extent.nMin) / (nz - 1);
  const grids: HorizonGrid[] = [];
  for (const id of MODEL_HORIZONS) {
    const pts: { x: number; n: number; tvdss: number; well: string }[] = [];
    const seen = new Set<string>();
    for (const p of picks) {
      if (p.obs !== 1) continue;
      if (formationIdForPick(p.pick) !== id) continue;
      if (seen.has(p.well)) continue; // one control point per wellbore per horizon
      seen.add(p.well);
      const tvdss = Number.isFinite(p.tvdss) && p.tvdss > 0 ? p.tvdss : p.tvd - datumElevation;
      pts.push({ x: p.e - origin.e, n: p.n - origin.n, tvdss, well: p.well });
    }
    // de-duplicate sidetracks sharing the same point
    const uniq: typeof pts = [];
    for (const p of pts) if (!uniq.some((q) => Math.hypot(q.x - p.x, q.n - p.n) < 2)) uniq.push(p);
    const depth = new Float32Array(nx * nz);
    if (uniq.length === 0) {
      depth.fill(NaN);
    } else {
      const trend = fitPlane(uniq);
      const resid = uniq.map((p) => p.tvdss - (trend[0] + trend[1] * p.x + trend[2] * p.n));
      const R0 = 900; // background correlation length (m)
      for (let iz = 0; iz < nz; iz++) {
        const zN = extent.nMin + iz * dz;
        for (let ix = 0; ix < nx; ix++) {
          const x = extent.xMin + ix * dx;
          let ws = 1 / (R0 * R0);
          let vs = 0;
          for (let k = 0; k < uniq.length; k++) {
            const d2 = (uniq[k].x - x) ** 2 + (uniq[k].n - zN) ** 2 + 25;
            const w = 1 / (d2 * Math.sqrt(d2) / 60); // ~1/d^3 → sharper honouring of control
            ws += w;
            vs += w * resid[k];
          }
          depth[iz * nx + ix] = trend[0] + trend[1] * x + trend[2] * zN + vs / ws;
        }
      }
    }
    const f = FORMATION_BY_ID.get(id)!;
    grids.push({ id, name: f.name, nx, nz, x0: extent.xMin, z0: extent.nMin, dx, dz, depth, controlPoints: uniq });
  }
  // fill missing horizons (no picks) with the one above + nominal thickness, enforce ordering
  for (let h = 0; h < grids.length; h++) {
    const g = grids[h];
    if (Number.isNaN(g.depth[0])) {
      const prev = grids[h - 1];
      for (let i = 0; i < g.depth.length; i++) g.depth[i] = prev.depth[i] + 20;
    }
    if (h > 0) {
      const prev = grids[h - 1];
      for (let i = 0; i < g.depth.length; i++) if (g.depth[i] < prev.depth[i] + 0.5) g.depth[i] = prev.depth[i] + 0.5;
    }
  }
  return grids;
}

function fitPlane(pts: { x: number; n: number; tvdss: number }[]): [number, number, number] {
  const mean = pts.reduce((s, p) => s + p.tvdss, 0) / pts.length;
  if (pts.length < 4) return [mean, 0, 0];
  // normal equations for z = a + b x + c n
  let sx = 0, sn = 0, sxx = 0, snn = 0, sxn = 0, sz = 0, sxz = 0, snz = 0;
  for (const p of pts) {
    sx += p.x; sn += p.n; sxx += p.x * p.x; snn += p.n * p.n; sxn += p.x * p.n;
    sz += p.tvdss; sxz += p.x * p.tvdss; snz += p.n * p.tvdss;
  }
  const N = pts.length;
  const A = [
    [N, sx, sn],
    [sx, sxx, sxn],
    [sn, sxn, snn],
  ];
  const b = [sz, sxz, snz];
  const sol = solve3(A, b);
  if (!sol) return [mean, 0, 0];
  // guard against extreme dips from poorly conditioned data (> 15°)
  const dip = Math.atan(Math.hypot(sol[1], sol[2])) * (180 / Math.PI);
  return dip > 15 ? [mean, 0, 0] : sol;
}

function solve3(A: number[][], b: number[]): [number, number, number] | null {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return null;
  const col = (i: number) => A.map((r, k) => r.map((v, j) => (j === i ? b[k] : v)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/** Bilinear sample of a horizon grid at local (x = east, n = north). */
export function sampleHorizon(g: HorizonGrid, x: number, n: number): number {
  const fx = Math.min(g.nx - 1.0001, Math.max(0, (x - g.x0) / g.dx));
  const fz = Math.min(g.nz - 1.0001, Math.max(0, (n - g.z0) / g.dz));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const d = g.depth;
  const i00 = iz * g.nx + ix;
  return (
    d[i00] * (1 - tx) * (1 - tz) + d[i00 + 1] * tx * (1 - tz) + d[i00 + g.nx] * (1 - tx) * tz + d[i00 + g.nx + 1] * tx * tz
  );
}

/** Local structural dip (deg) and dip azimuth (deg from north) of a horizon. */
export function horizonDip(g: HorizonGrid, x: number, n: number): { dip: number; azi: number } {
  const h = Math.max(g.dx, g.dz);
  const dzdx = (sampleHorizon(g, x + h, n) - sampleHorizon(g, x - h, n)) / (2 * h);
  const dzdn = (sampleHorizon(g, x, n + h) - sampleHorizon(g, x, n - h)) / (2 * h);
  const dip = Math.atan(Math.hypot(dzdx, dzdn)) * (180 / Math.PI);
  let azi = Math.atan2(dzdx, dzdn) * (180 / Math.PI); // direction of increasing depth
  if (azi < 0) azi += 360;
  return { dip, azi };
}

/** Which model formation contains a point (x east, n north, tvdss). */
export function formationAt(grids: HorizonGrid[], x: number, n: number, tvdss: number): string | null {
  let current: string | null = null;
  for (const g of grids) {
    if (tvdss >= sampleHorizon(g, x, n)) current = g.id;
    else break;
  }
  return current;
}
