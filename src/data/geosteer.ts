import { sampleHorizon } from './surfaces';
import type { Trajectory } from './trajectory';
import type { HorizonGrid, Top, Zone } from './types';

export type SteerStatus = 'above' | 'in' | 'below';

export interface SteerSample {
  md: number;
  tvdss: number;
  ew: number;
  ns: number;
  inc: number;
  top: number; // TVDSS of the target top at the well's (x, y) — tied or model, see profile.source
  base: number; // TVDSS of the target base
  topModel: number; // regional picks model, untied
  baseModel: number;
  dTop: number; // tvdss − top  (> 0: below the top)
  dBase: number; // base − tvdss (> 0: above the base)
  status: SteerStatus;
}

export type SurfaceSource = 'tied' | 'model';

export interface TiePoint {
  md: number;
  tvdss: number;
  which: 'top' | 'base';
  residual: number; // well − model (m)
}

export interface SteerProfile {
  targetId: string;
  source: SurfaceSource;
  ties: TiePoint[];
  baseId: string | null;
  samples: SteerSample[];
  /** MD window covering the approach to and travel within the target */
  window: { from: number; to: number } | null;
  /** measured-depth footage in / above / below the target over the window */
  footage: { in: number; above: number; below: number };
  /** formation picks on this wellbore where the well enters or leaves the target */
  crossings: { md: number; name: string; kind: 'enter' | 'exit' }[];
}

/** Base of a model unit = top of the next horizon in the stratigraphic list. */
export function baseHorizonOf(horizons: HorizonGrid[], targetId: string): HorizonGrid | null {
  const i = horizons.findIndex((h) => h.id === targetId);
  return i >= 0 ? horizons[i + 1] ?? null : null;
}

/**
 * Vertical distance from the well to the top and base of the target unit,
 * sampled along MD. Distances are true vertical (TVD) — for the ≤ 5° dips at
 * Volve, true stratigraphic distance differs by < 0.4 %.
 *
 * Surfaces: the regional picks model is smooth (one control point per
 * wellbore and horizon), so on its own it cannot follow a thin, faulted
 * reservoir along a 1.5 km lateral. In 'tied' mode — what a geosteerer does —
 * the model is corrected along the well so it passes through every formation
 * boundary this wellbore actually crossed (from its picks), interpolating the
 * correction linearly in MD between crossings.
 */
export function steerProfile(
  traj: Trajectory,
  horizons: HorizonGrid[],
  datumElevation: number,
  targetId: string,
  tops: Top[] = [],
  opts: { step?: number; approach?: number; zones?: Zone[]; source?: SurfaceSource } = {},
): SteerProfile {
  const step = opts.step ?? 2;
  const approach = opts.approach ?? 80;
  const source: SurfaceSource = opts.source ?? (opts.zones ? 'tied' : 'model');
  const ti = horizons.findIndex((h) => h.id === targetId);
  const top = horizons[ti];
  const base = baseHorizonOf(horizons, targetId);
  const samples: SteerSample[] = [];
  const empty: SteerProfile = { targetId, source, ties: [], baseId: null, samples, window: null, footage: { in: 0, above: 0, below: 0 }, crossings: [] };
  if (!top) return empty;
  // tie points from formation boundaries crossed by the well
  const ties: TiePoint[] = [];
  if (opts.zones) {
    const order = (id: string) => horizons.findIndex((h) => h.id === id);
    const z = opts.zones.filter((q) => order(q.formationId) >= 0);
    for (let k = 1; k < z.length; k++) {
      const a = order(z[k - 1].formationId);
      const b = order(z[k].formationId);
      if (a === b) continue;
      const md = z[k].topMD;
      if (md > traj.mdEnd) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const p = traj.at(md);
      const tvdss = p.tvd - datumElevation;
      // every horizon with index in (lo, hi] sits at this crossing
      if (ti > lo && ti <= hi) ties.push({ md, tvdss, which: 'top', residual: tvdss - sampleHorizon(top, p.ew, p.ns) });
      if (base && ti + 1 > lo && ti + 1 <= hi) ties.push({ md, tvdss, which: 'base', residual: tvdss - sampleHorizon(base, p.ew, p.ns) });
    }
  }
  const resid = (which: 'top' | 'base', md: number) => {
    if (source !== 'tied') return 0;
    const t = ties.filter((q) => q.which === which);
    if (!t.length) return 0;
    if (md <= t[0].md) return t[0].residual;
    for (let k = 1; k < t.length; k++)
      if (md <= t[k].md) {
        const f = (md - t[k - 1].md) / (t[k].md - t[k - 1].md || 1);
        return t[k - 1].residual + (t[k].residual - t[k - 1].residual) * f;
      }
    return t[t.length - 1].residual;
  };
  const zones = opts.zones ?? [];
  const zOrder = (id: string) => horizons.findIndex((h) => h.id === id);
  let zi = 0;
  for (let md = traj.mdStart; md <= traj.mdEnd + 1e-6; md += step) {
    const p = traj.at(Math.min(md, traj.mdEnd));
    const tvdss = p.tvd - datumElevation;
    const tm = sampleHorizon(top, p.ew, p.ns);
    const bm = base ? sampleHorizon(base, p.ew, p.ns) : tm + 200;
    let t = tm + resid('top', md);
    let b = Math.max(t + 0.3, bm + resid('base', md));
    if (source === 'tied' && zones.length) {
      // between crossings the surfaces must keep the well in the unit its picks say it is in
      while (zi < zones.length - 1 && md >= zones[zi].baseMD) zi++;
      const z = zones[zi];
      const zo = zOrder(z.formationId);
      if (zo >= 0 && ties.length) {
        const d = Math.max(0, Math.min(3, 0.15 * Math.min(md - z.topMD, z.baseMD - md)));
        {
          if (zo < ti) t = Math.max(t, tvdss + d);
          else if (zo === ti) {
            t = Math.min(t, tvdss - d);
            b = Math.max(b, tvdss + d);
          } else b = Math.min(b, tvdss - d);
          if (zo > ti) t = Math.min(t, b - 0.3);
          else b = Math.max(b, t + 0.3);
        }
      }
    }
    if (source === 'tied')
      for (const q of ties)
        if (Math.abs(q.md - md) <= step / 2) {
          // exact at the crossings
          if (q.which === 'top') {
            t = q.tvdss;
            b = Math.max(b, t + 0.3);
          } else {
            b = q.tvdss;
            t = Math.min(t, b - 0.3);
          }
        }
    const dTop = tvdss - t;
    const dBase = b - tvdss;
    const status: SteerStatus = dTop < 0 ? 'above' : dBase < 0 ? 'below' : 'in';
    samples.push({ md, tvdss, ew: p.ew, ns: p.ns, inc: p.inc, top: t, base: b, topModel: tm, baseModel: bm, dTop, dBase, status });
  }
  // window: from the first sample within `approach` m above the top to TD
  let from = -1;
  for (const s of samples)
    if (s.dTop > -approach) {
      from = s.md;
      break;
    }
  const window = from >= 0 ? { from, to: samples[samples.length - 1].md } : null;
  const footage = { in: 0, above: 0, below: 0 };
  if (window) for (const s of samples) if (s.md >= window.from) footage[s.status] += step;
  // formation picks that mark entries / exits of the target
  const crossings: SteerProfile['crossings'] = [];
  const sorted = [...tops].sort((a, b) => a.md - b.md);
  let inside = false;
  for (const t of sorted) {
    if (t.formationId === targetId && !inside) {
      crossings.push({ md: t.md, name: t.name, kind: 'enter' });
      inside = true;
    } else if (t.formationId !== targetId && inside) {
      crossings.push({ md: t.md, name: t.name, kind: 'exit' });
      inside = false;
    }
  }
  return { targetId, source, ties, baseId: base?.id ?? null, samples, window, footage, crossings };
}

export function steerAt(p: SteerProfile, md: number): SteerSample | null {
  const s = p.samples;
  if (!s.length) return null;
  const step = s.length > 1 ? s[1].md - s[0].md : 1;
  const i = Math.max(0, Math.min(s.length - 1, Math.round((md - s[0].md) / step)));
  return s[i];
}

export const STATUS_COLOR: Record<SteerStatus, string> = {
  in: '#5fe0a0',
  above: '#ffc35a',
  below: '#ff7a8a',
};
