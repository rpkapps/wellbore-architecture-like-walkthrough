import type { Trajectory } from './trajectory';
import type { Top } from './types';

const D2R = Math.PI / 180;

/**
 * Simplified systematic MWD error model in the spirit of ISCWSA: three
 * fully-correlated error sources propagated along the survey and combined as a
 * covariance in north / east / vertical.
 *
 *   σ_inc   inclination bias (sensor misalignment, BHA sag)          0.1°
 *   σ_azi   azimuth bias (declination, drill-string interference)   0.5°
 *   σ_depth depth scale error (pipe stretch, tally)                  1 ‰ of MD
 *
 * For trajectories reconstructed through formation-pick coordinates an extra
 * allowance grows with distance from the nearest pick (the path is exact at
 * the picks, less certain between them).
 */
export interface ErrorModel {
  sigInc: number; // degrees
  sigAzi: number; // degrees
  sigDepth: number; // fraction of MD
  reconPerM: number; // m of lateral allowance per m of MD from the nearest pick
  reconMax: number; // cap (m)
}

export const DEFAULT_ERROR_MODEL: ErrorModel = { sigInc: 0.1, sigAzi: 0.5, sigDepth: 0.001, reconPerM: 0.03, reconMax: 15 };

export interface Ellipse {
  md: number;
  /** semi-axes (1σ, metres) in the plane perpendicular to the hole */
  major: number;
  minor: number;
  /** unit vectors of the axes in north / east / down */
  majorDir: [number, number, number];
  minorDir: [number, number, number];
  /** 1σ vertical (TVD) uncertainty */
  vertical: number;
  /** 1σ horizontal (radial) uncertainty */
  horizontal: number;
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3, k = 1): V3 => [a[0] - b[0] * k, a[1] - b[1] * k, a[2] - b[2] * k];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function uncertaintyAlong(
  traj: Trajectory,
  every = 10,
  model: ErrorModel = DEFAULT_ERROR_MODEL,
  opts: { reconstructedFrom?: number; picks?: Top[] } = {},
): Ellipse[] {
  const out: Ellipse[] = [];
  // accumulated error vectors (N, E, D) per unit bias
  let eInc: V3 = [0, 0, 0];
  let eAzi: V3 = [0, 0, 0];
  const s = traj.step;
  const pickMds = (opts.picks ?? []).map((p) => p.md).sort((a, b) => a - b);
  const reconFrom = opts.reconstructedFrom ?? Infinity;
  let next = traj.mdStart;
  for (let i = 0; i < traj.md.length; i++) {
    const inc = traj.inc[i] * D2R;
    const azi = traj.azi[i] * D2R;
    const dInc: V3 = [Math.cos(inc) * Math.cos(azi), Math.cos(inc) * Math.sin(azi), -Math.sin(inc)];
    const dAzi: V3 = [-Math.sin(inc) * Math.sin(azi), Math.sin(inc) * Math.cos(azi), 0];
    if (i > 0) {
      eInc = [eInc[0] + dInc[0] * s, eInc[1] + dInc[1] * s, eInc[2] + dInc[2] * s];
      eAzi = [eAzi[0] + dAzi[0] * s, eAzi[1] + dAzi[1] * s, eAzi[2] + dAzi[2] * s];
    }
    const md = traj.md[i];
    if (md + 1e-6 < next && i !== traj.md.length - 1) continue;
    next = md + every;
    const eDep: V3 = [traj.ns[i] - traj.ns[0], traj.ew[i] - traj.ew[0], traj.tvd[i] - traj.tvd[0]];
    const si = model.sigInc * D2R;
    const sa = model.sigAzi * D2R;
    const vecs: [V3, number][] = [
      [eInc, si],
      [eAzi, sa],
      [eDep, model.sigDepth],
    ];
    // covariance C = Σ σ² e eᵀ
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const [e, sg] of vecs) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] += sg * sg * e[r] * e[c];
    // reconstruction allowance: isotropic in the plane perpendicular to the hole
    let recon = 0;
    if (md > reconFrom) {
      let dist = md - reconFrom;
      for (const p of pickMds) dist = Math.min(dist, Math.abs(p - md));
      recon = Math.min(model.reconMax, dist * model.reconPerM + 1);
    }
    const t: V3 = [Math.sin(inc) * Math.cos(azi), Math.sin(inc) * Math.sin(azi), Math.cos(inc)];
    // basis perpendicular to the hole: u = high side, v = right side
    let u = sub([0, 0, -1], t, dot([0, 0, -1], t));
    if (Math.hypot(...u) < 1e-3) u = [1, 0, 0];
    u = norm(u);
    const v = norm(cross(t, u));
    const Cu = (a: V3, b: V3) => {
      let r = 0;
      for (let i2 = 0; i2 < 3; i2++) for (let j = 0; j < 3; j++) r += a[i2] * C[i2 * 3 + j] * b[j];
      return r;
    };
    const a = Cu(u, u) + recon * recon;
    const b = Cu(u, v);
    const d = Cu(v, v) + recon * recon;
    // eigen-decomposition of the 2×2 covariance
    const tr = (a + d) / 2;
    const det = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
    const l1 = tr + det;
    const l2 = Math.max(0, tr - det);
    const ang = 0.5 * Math.atan2(2 * b, a - d);
    const majorDir = norm([u[0] * Math.cos(ang) + v[0] * Math.sin(ang), u[1] * Math.cos(ang) + v[1] * Math.sin(ang), u[2] * Math.cos(ang) + v[2] * Math.sin(ang)]);
    const minorDir = norm(cross(t, majorDir));
    const horizontal = Math.sqrt(Math.max(0, C[0] + C[4]) + recon * recon);
    const vertical = Math.sqrt(Math.max(0, C[8]) + recon * recon * Math.sin(inc) ** 2);
    out.push({ md, major: Math.sqrt(l1), minor: Math.sqrt(l2), majorDir, minorDir, vertical, horizontal });
  }
  return out;
}

export function ellipseAt(list: Ellipse[], md: number): Ellipse | null {
  if (!list.length) return null;
  let best = list[0];
  for (const e of list) if (Math.abs(e.md - md) < Math.abs(best.md - md)) best = e;
  return best;
}
