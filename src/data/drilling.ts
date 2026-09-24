import { findCurve } from './las';
import type { LogSet, Zone } from './types';

export interface RopZone {
  formationId: string;
  name: string;
  topMD: number;
  baseMD: number;
  meanRop: number; // m/h, footage-weighted (harmonic mean of ROP)
  hours: number; // on-bottom drilling hours for the logged footage
  footage: number; // m with ROP readings
}

export const ROP_RANGE = { min: 1, max: 100 }; // m/h, log colour scale

/**
 * On-bottom drilling time from the ROP log: Σ ΔMD / ROP. The footage-weighted
 * mean ROP is footage / time (a harmonic mean — the right average for speeds).
 */
export function ropByZone(logs: LogSet, zones: Zone[]): RopZone[] {
  const rop = findCurve(logs, 'ROP');
  if (!rop) return [];
  const d = logs.depth;
  const out: RopZone[] = [];
  for (const z of zones) {
    if (z.formationId === 'air' || z.formationId === 'sea') continue;
    let hours = 0;
    let footage = 0;
    for (let i = 1; i < d.length; i++) {
      if (d[i] < z.topMD || d[i] >= z.baseMD) continue;
      const v = rop.values[i];
      if (!(v > 0.05) || v > 1000) continue;
      const dmd = d[i] - d[i - 1];
      if (!(dmd > 0) || dmd > 5) continue;
      hours += dmd / v;
      footage += dmd;
    }
    if (footage < 1) continue;
    out.push({ formationId: z.formationId, name: z.name, topMD: z.topMD, baseMD: z.baseMD, meanRop: footage / hours, hours, footage });
  }
  return out;
}

export function hasRop(logs?: LogSet): boolean {
  const r = findCurve(logs, 'ROP');
  if (!r) return false;
  let n = 0;
  for (const v of r.values) if (v > 0) n++;
  return n > 50;
}
