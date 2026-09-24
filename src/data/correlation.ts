import type { Trajectory } from './trajectory';
import type { Zone } from './types';

/**
 * Multi-well correlation: every well's logs and zones placed on a common
 * vertical axis, optionally flattened on one formation top.
 *
 *   'tvdss' : true vertical depth below MSL. Deviated and horizontal wells
 *             can go back up, so the axis uses the deepest TVDSS reached so
 *             far (a monotone envelope) and keeps only log samples on it —
 *             i.e. each well's first downward pass through the section.
 *   'md'    : measured depth, every sample kept (thicknesses are apparent).
 */
export type CorrDepthMode = 'tvdss' | 'md';

export interface CorrAxis {
  /** depth on the correlation axis for an MD */
  at(md: number): number;
  /** true when the sample at this MD lies on the first downward pass */
  onPass(md: number): boolean;
}

export function corrAxis(traj: Trajectory, mode: CorrDepthMode, datumElevation: number): CorrAxis {
  if (mode === 'md') return { at: (md) => md, onPass: () => true };
  const n = traj.md.length;
  const env = new Float64Array(n);
  let m = -Infinity;
  for (let i = 0; i < n; i++) {
    m = Math.max(m, traj.tvd[i]);
    env[i] = m - datumElevation;
  }
  const idx = (md: number) => Math.min(n - 1.000001, Math.max(0, (md - traj.md[0]) / traj.step));
  const lerp = (a: Float64Array, md: number) => {
    const f = idx(md);
    const i = Math.floor(f);
    return a[i] + (a[i + 1] - a[i]) * (f - i);
  };
  return {
    at: (md) => {
      // beyond the survey the well is assumed to continue straight down
      if (md > traj.mdEnd) return env[n - 1] + (md - traj.mdEnd) * Math.cos((traj.inc[n - 1] * Math.PI) / 180);
      return lerp(env, md);
    },
    onPass: (md) => {
      if (md > traj.mdEnd) return true;
      const tvdss = traj.at(md).tvd - datumElevation;
      return tvdss >= lerp(env, md) - 0.25;
    },
  };
}

export interface CorrZone {
  formationId: string;
  name: string;
  top: number;
  base: number;
}

/** Zones on the correlation axis; zones the well re-enters on its way back up are folded away. */
export function corrZones(zones: Zone[], axis: CorrAxis): CorrZone[] {
  const out: CorrZone[] = [];
  for (const z of zones) {
    if (z.formationId === 'air' || z.formationId === 'sea') continue;
    const top = axis.at(z.topMD);
    const base = axis.at(z.baseMD);
    if (base - top < 0.2) continue;
    const last = out[out.length - 1];
    if (last && last.formationId === z.formationId && top - last.base < 0.5) last.base = base;
    else out.push({ formationId: z.formationId, name: z.name, top, base });
  }
  return out;
}

/** Depth of the first top of a formation on the correlation axis, or null when the well never reaches it. */
export function corrDatum(zones: CorrZone[], formationId: string): number | null {
  return zones.find((z) => z.formationId === formationId)?.top ?? null;
}

/** Log samples on the correlation axis, decimated to `step` metres of axis depth. */
export function corrTrack(
  depth: Float64Array,
  values: Float32Array,
  axis: CorrAxis,
  step: number,
  from = -Infinity,
  to = Infinity,
): { md: number; d: number; v: number }[] {
  const out: { md: number; d: number; v: number }[] = [];
  let next = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const md = depth[i];
    const d = axis.at(md);
    if (d < from || d > to || d < next) continue;
    if (!axis.onPass(md)) continue;
    out.push({ md, d, v });
    next = d + step;
  }
  return out;
}
