import { findCurve } from './las';
import type { Curve, LogSet, Zone } from './types';

/**
 * Deterministic petrophysical interpretation (all outputs provenance = 'calculated').
 *
 *   Vsh   : gamma-ray index, linear or Larionov
 *   PHIE  : density porosity  φD = (ρma − ρb)/(ρma − ρfl), optionally averaged with neutron,
 *           optionally shale-corrected
 *   Sw    : Archie  Sw = (a·Rw / (φ^m · Rt))^(1/n)   or Simandoux (shaly sand)
 *   So    : 1 − Sw (Volve Hugin is an undersaturated oil reservoir; no gas term)
 *   HCPV  : φ · So  (hydrocarbon-filled fraction of bulk rock)
 */
export interface PetroParams {
  grClean: number;
  grShale: number;
  vshMethod: 'linear' | 'larionov-older' | 'larionov-tertiary';
  rhoMa: number;
  rhoFl: number;
  porosityMethod: 'density' | 'neutron-density';
  shaleCorrection: boolean;
  phiShale: number;
  a: number;
  m: number;
  n: number;
  rw: number; // Ω·m at formation temperature
  rwTemp: number; // °C (informational: temperature at which Rw applies)
  satModel: 'archie' | 'simandoux';
  rsh: number;
  cutVsh: number;
  cutPhi: number;
  cutSw: number;
}

export const DEFAULT_PARAMS: PetroParams = {
  grClean: 12,
  grShale: 112,
  vshMethod: 'linear',
  rhoMa: 2.65,
  rhoFl: 1.0,
  porosityMethod: 'density',
  shaleCorrection: false,
  phiShale: 0.08,
  a: 1,
  m: 2,
  n: 2,
  rw: 0.025,
  rwTemp: 106,
  satModel: 'archie',
  rsh: 2.0,
  cutVsh: 0.4,
  cutPhi: 0.1,
  cutSw: 0.6,
};

/** Where each default came from — surfaced in the UI next to the value. */
export const PARAM_NOTES: Partial<Record<keyof PetroParams, string>> = {
  grClean: 'Auto: P5 of GR over the density-logged interval',
  grShale: 'Auto: P95 of GR over the density-logged interval',
  rhoMa: 'Quartz sandstone matrix. Reproduces Equinor CPI porosity (r = 0.98) on 15/9-F-11 A',
  rhoFl: 'Mud-filtrate density in the invaded zone',
  rw: 'Calibrated: Archie-implied Rw matching Equinor CPI Sw on 15/9-F-11 A and F-1 C (median 0.024–0.026 Ω·m)',
  rwTemp: 'Measured: median downhole gauge temperature, Volve producers 2008–2016',
  a: 'Archie tortuosity factor',
  m: 'Cementation exponent',
  n: 'Saturation exponent',
};

export interface PetroResult {
  vsh: Curve;
  phie: Curve;
  sw: Curve;
  so: Curve;
  bvw: Curve;
  hcpv: Curve;
  net: Uint8Array;
  pay: Uint8Array;
  inputs: { gr?: string; rt?: string; rhob?: string; nphi?: string };
  available: boolean;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export function autoGrLimits(logs: LogSet): { clean: number; shale: number } | null {
  const gr = findCurve(logs, 'GR');
  const rhob = findCurve(logs, 'RHOB');
  if (!gr) return null;
  const vals: number[] = [];
  for (let i = 0; i < gr.values.length; i++) {
    const g = gr.values[i];
    if (Number.isNaN(g)) continue;
    if (rhob && Number.isNaN(rhob.values[i])) continue;
    vals.push(g);
  }
  if (vals.length < 50) return null;
  vals.sort((x, y) => x - y);
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  return { clean: Math.round(q(0.05) * 10) / 10, shale: Math.round(q(0.95) * 10) / 10 };
}

export function vshFromGR(gr: number, p: PetroParams): number {
  const igr = clamp((gr - p.grClean) / (p.grShale - p.grClean || 1), 0, 1);
  if (p.vshMethod === 'larionov-older') return clamp(0.33 * (Math.pow(2, 2 * igr) - 1), 0, 1);
  if (p.vshMethod === 'larionov-tertiary') return clamp(0.083 * (Math.pow(2, 3.7 * igr) - 1), 0, 1);
  return igr;
}

export function porosity(rhob: number, nphi: number, vsh: number, p: PetroParams): number {
  let phi = (p.rhoMa - rhob) / (p.rhoMa - p.rhoFl);
  if (p.porosityMethod === 'neutron-density' && Number.isFinite(nphi)) phi = Math.sqrt((phi * phi + nphi * nphi) / 2);
  if (p.shaleCorrection && Number.isFinite(vsh)) phi -= vsh * p.phiShale;
  return clamp(phi, 0, 0.45);
}

export function waterSaturation(rt: number, phi: number, vsh: number, p: PetroParams): number {
  if (!(rt > 0) || !(phi > 0.005)) return NaN;
  if (p.satModel === 'simandoux' && Number.isFinite(vsh) && vsh > 0.01) {
    // Modified Simandoux: 1/Rt = φ^m·Sw²/(a·Rw·(1−Vsh)) + Vsh·Sw/Rsh, solved for Sw (n = 2), rescaled for n ≠ 2
    const c = (1 - vsh) * p.a * p.rw / Math.pow(phi, p.m);
    const d = vsh / p.rsh;
    const swQ = (c / 2) * (Math.sqrt(d * d + 4 * Math.pow(phi, p.m) / (p.a * p.rw * (1 - vsh) * rt)) - d);
    return clamp(Math.pow(Math.max(swQ, 0), 2 / p.n), 0, 1);
  }
  return clamp(Math.pow((p.a * p.rw) / (Math.pow(phi, p.m) * rt), 1 / p.n), 0, 1);
}

function mk(mnemonic: string, unit: string, description: string, n: number): Curve {
  return { mnemonic, unit, description, values: new Float32Array(n).fill(NaN), provenance: 'calculated', source: 'Calculated in-app' };
}

export function interpret(logs: LogSet, p: PetroParams): PetroResult {
  const n = logs.depth.length;
  const gr = findCurve(logs, 'GR');
  const rt = findCurve(logs, 'RT');
  const rhob = findCurve(logs, 'RHOB');
  const nphi = findCurve(logs, 'NPHI');
  const vsh = mk('VSH_CALC', 'v/v', 'Shale volume from GR index', n);
  const phie = mk('PHIE_CALC', 'v/v', 'Effective porosity (density)', n);
  const sw = mk('SW_CALC', 'v/v', `Water saturation (${p.satModel === 'archie' ? 'Archie' : 'Simandoux'})`, n);
  const so = mk('SO_CALC', 'v/v', 'Oil saturation = 1 − Sw', n);
  const bvw = mk('BVW_CALC', 'v/v', 'Bulk volume water φ·Sw', n);
  const hcpv = mk('HCPV_CALC', 'v/v', 'Hydrocarbon pore volume φ·(1 − Sw)', n);
  const net = new Uint8Array(n);
  const pay = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const g = gr ? gr.values[i] : NaN;
    const v = Number.isFinite(g) ? vshFromGR(g, p) : NaN;
    vsh.values[i] = v;
    const rb = rhob ? rhob.values[i] : NaN;
    if (!Number.isFinite(rb)) continue;
    const ph = porosity(rb, nphi ? nphi.values[i] : NaN, v, p);
    phie.values[i] = ph;
    const r = rt ? rt.values[i] : NaN;
    const s = waterSaturation(r, ph, v, p);
    sw.values[i] = s;
    if (Number.isFinite(s)) {
      so.values[i] = 1 - s;
      bvw.values[i] = ph * s;
      hcpv.values[i] = ph * (1 - s);
    }
    const isNet = (Number.isFinite(v) ? v <= p.cutVsh : true) && ph >= p.cutPhi;
    net[i] = isNet ? 1 : 0;
    pay[i] = isNet && Number.isFinite(s) && s <= p.cutSw ? 1 : 0;
  }
  return {
    vsh,
    phie,
    sw,
    so,
    bvw,
    hcpv,
    net,
    pay,
    inputs: { gr: gr?.mnemonic, rt: rt?.mnemonic, rhob: rhob?.mnemonic, nphi: nphi?.mnemonic },
    available: !!(rhob && rt),
  };
}

export interface ZoneSummary {
  zone: Zone;
  gross: number; // m MD
  net: number;
  pay: number;
  ntg: number;
  phiAvg: number; // pay-averaged
  swAvg: number; // pore-volume weighted over pay
  hcColumn: number; // Σ φ·So·Δmd over pay (m)
  rtAvg: number; // geometric mean
  coverage: number; // fraction of the zone with porosity data
}

export function summariseZones(logs: LogSet, res: PetroResult, zones: Zone[]): ZoneSummary[] {
  const d = logs.depth;
  const rt = findCurve(logs, 'RT');
  const out: ZoneSummary[] = [];
  for (const z of zones) {
    let gross = 0, net = 0, pay = 0, phiS = 0, swS = 0, pvS = 0, hc = 0, lr = 0, lrN = 0, cov = 0;
    for (let i = 1; i < d.length; i++) {
      if (d[i] < z.topMD || d[i] > z.baseMD) continue;
      const dz = d[i] - d[i - 1];
      if (dz <= 0 || dz > 5) continue;
      gross += dz;
      const ph = res.phie.values[i];
      if (Number.isFinite(ph)) cov += dz;
      if (rt && rt.values[i] > 0) {
        lr += Math.log(rt.values[i]);
        lrN++;
      }
      if (res.net[i]) net += dz;
      if (res.pay[i]) {
        pay += dz;
        const s = res.sw.values[i];
        phiS += ph * dz;
        swS += s * ph * dz;
        pvS += ph * dz;
        hc += ph * (1 - s) * dz;
      }
    }
    out.push({
      zone: z,
      gross,
      net,
      pay,
      ntg: gross > 0 ? net / gross : 0,
      phiAvg: pay > 0 ? phiS / pay : NaN,
      swAvg: pvS > 0 ? swS / pvS : NaN,
      hcColumn: hc,
      rtAvg: lrN ? Math.exp(lr / lrN) : NaN,
      coverage: gross > 0 ? cov / gross : 0,
    });
  }
  return out;
}

/** Continuous pay intervals (for highlighting and "isolate pay" mode). */
export function payIntervals(depth: Float64Array, pay: Uint8Array, minThickness = 0.5): { top: number; base: number }[] {
  const out: { top: number; base: number }[] = [];
  let start = -1;
  for (let i = 0; i <= depth.length; i++) {
    const on = i < depth.length && pay[i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const top = depth[start];
      const base = depth[i - 1];
      if (base - top >= minThickness) {
        const last = out[out.length - 1];
        if (last && top - last.base < 1.0) last.base = base; // merge across tiny gaps
        else out.push({ top, base });
      }
      start = -1;
    }
  }
  return out;
}
