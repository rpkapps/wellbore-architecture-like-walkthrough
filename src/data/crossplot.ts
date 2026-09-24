import { findCurve } from './las';
import type { PetroParams, PetroResult } from './petro';
import type { LogSet, Zone } from './types';

/**
 * Petrophysical crossplots of one well:
 *
 *   'nd'      : density–neutron (NPHI vs RHOB, density axis reversed), with
 *               the clean-matrix line from the interpretation parameters
 *   'pickett' : log Rt vs log φ, with Archie iso-Sw lines
 *               Rt = a·Rw / (φ^m · Sw^n) — the water line (Sw = 1) should
 *               run along the wet sands when Rw and m are right
 *   'buckles' : φ vs Sw with bulk-volume-water hyperbolas (φ·Sw = const);
 *               points on one hyperbola are at irreducible saturation
 */
export type CrossplotKind = 'nd' | 'pickett' | 'buckles';

export interface XPoint {
  md: number;
  x: number;
  y: number;
  gr: number;
  sw: number;
  formationId: string;
}

export interface Axis {
  label: string;
  min: number;
  max: number;
  log?: boolean;
  reversed?: boolean;
}

export const CROSSPLOTS: Record<CrossplotKind, { label: string; x: Axis; y: Axis }> = {
  nd: {
    label: 'Density–neutron',
    x: { label: 'NPHI (v/v)', min: -0.05, max: 0.45 },
    y: { label: 'RHOB (g/cm³)', min: 1.9, max: 2.95, reversed: true },
  },
  pickett: {
    label: 'Pickett',
    x: { label: 'Deep resistivity Rt (Ω·m)', min: 0.1, max: 2000, log: true },
    y: { label: 'Effective porosity φ (v/v)', min: 0.01, max: 0.5, log: true },
  },
  buckles: {
    label: 'Buckles',
    x: { label: 'Water saturation Sw (v/v)', min: 0, max: 1 },
    y: { label: 'Effective porosity φ (v/v)', min: 0, max: 0.4 },
  },
};

function zoneLookup(zones: Zone[]): (md: number) => string {
  let k = 0;
  // callers walk MD upwards, so a moving cursor is enough
  return (md: number) => {
    if (!zones.length) return '';
    if (md < zones[k].topMD) k = 0;
    while (k < zones.length - 1 && md >= zones[k].baseMD) k++;
    return zones[k].formationId;
  };
}

/**
 * Points for a crossplot, optionally limited to an MD window. Samples without
 * the inputs a plot needs are skipped.
 */
export function crossplotPoints(
  kind: CrossplotKind,
  logs: LogSet,
  petro: PetroResult | undefined,
  zones: Zone[],
  opts: { fromMD?: number; toMD?: number; formationId?: string } = {},
): XPoint[] {
  const d = logs.depth;
  const gr = findCurve(logs, 'GR')?.values;
  const rhob = findCurve(logs, 'RHOB')?.values;
  const nphi = findCurve(logs, 'NPHI')?.values;
  const rt = findCurve(logs, 'RT')?.values;
  const phi = petro?.phie.values;
  const sw = petro?.sw.values;
  const fm = zoneLookup(zones);
  const out: XPoint[] = [];
  for (let i = 0; i < d.length; i++) {
    const md = d[i];
    if (opts.fromMD !== undefined && md < opts.fromMD) continue;
    if (opts.toMD !== undefined && md > opts.toMD) continue;
    const f = fm(md);
    if (opts.formationId && f !== opts.formationId) continue;
    let x = NaN;
    let y = NaN;
    if (kind === 'nd') {
      x = nphi ? nphi[i] : NaN;
      y = rhob ? rhob[i] : NaN;
    } else if (kind === 'pickett') {
      x = rt ? rt[i] : NaN;
      y = phi ? phi[i] : NaN;
      if (!(x > 0) || !(y > 0)) continue;
    } else {
      x = sw ? sw[i] : NaN;
      y = phi ? phi[i] : NaN;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ md, x, y, gr: gr ? gr[i] : NaN, sw: sw ? sw[i] : NaN, formationId: f });
  }
  return out;
}

/** Archie line of constant Sw on a Pickett plot: [Rt, φ] pairs across the porosity range. */
export function pickettLine(p: PetroParams, sw: number, phiMin = 0.01, phiMax = 0.5): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 24; k++) {
    const phi = phiMin * Math.pow(phiMax / phiMin, k / 24);
    out.push([(p.a * p.rw) / (Math.pow(phi, p.m) * Math.pow(sw, p.n)), phi]);
  }
  return out;
}

/** Clean-matrix line on the density–neutron plot: [NPHI, RHOB] pairs for φ = 0 … 0.45 (NPHI ≈ φ). */
export function matrixLine(p: PetroParams): [number, number][] {
  const out: [number, number][] = [];
  for (let phi = 0; phi <= 0.4501; phi += 0.05) out.push([phi, p.rhoMa - phi * (p.rhoMa - p.rhoFl)]);
  return out;
}

/** Bulk-volume-water hyperbola φ·Sw = bvw on a Buckles plot: [Sw, φ] pairs. */
export function bvwLine(bvw: number, phiMax = 0.4): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 40; k++) {
    const sw = 0.02 + (0.98 * k) / 40;
    const phi = bvw / sw;
    if (phi <= phiMax) out.push([sw, phi]);
  }
  return out;
}

/** Group selected sample depths into MD intervals (a gap wider than `gap` starts a new one). */
export function mdIntervals(mds: number[], gap = 1.5): { top: number; base: number; n: number }[] {
  const s = [...mds].sort((a, b) => a - b);
  const out: { top: number; base: number; n: number }[] = [];
  for (const md of s) {
    const last = out[out.length - 1];
    if (last && md - last.base <= gap) {
      last.base = md;
      last.n++;
    } else out.push({ top: md, base: md, n: 1 });
  }
  return out;
}
