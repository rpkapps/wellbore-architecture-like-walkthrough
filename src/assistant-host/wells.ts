import type { FieldModel, Well } from '../data/dataset';
import { ALIASES, findCurve, sampleCurve } from '../data/las';
import type { Curve, LogSet } from '../data/types';

/*
 * Pure helpers the data tools share: finding a well or a curve from what a
 * model writes ("F-11 B", "15/9-F-11B", "gamma ray"), sampling curves over
 * depth windows, and rounding numbers so datasets stay compact.
 */

/** Letters and digits only, upper case: "15/9-F-11 B" → "159F11B". */
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Without the licence-block prefix: "159F11B" → "F11B". */
const short = (s: string) => norm(s).replace(/^159/, '');

/** A column key for a well that any chart or CSS variable accepts ("F11B"). */
export const wellKey = (w: Well) => short(w.id) || 'W';

/** A number rounded to `d` decimals; NaN and infinities become null (JSON has no NaN). */
export function round(v: number | undefined | null, d = 2): number | null {
  if (v === undefined || v === null || !Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** A number to `n` significant digits (log values span decades), null when not finite. */
export function sig(v: number | undefined | null, n = 4): number | null {
  if (v === undefined || v === null || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Number(v.toPrecision(n));
}

/** The wells a tool may name: every well of the field (the further Volve wells too: their data is there). */
export function findWell(field: FieldModel, key: string): Well {
  const k = norm(key);
  const ks = short(key);
  const w =
    field.wells.find((x) => x.id === key) ??
    field.wells.find((x) => norm(x.id) === k || norm(x.name) === k) ??
    field.wells.find((x) => short(x.id) === ks || short(x.name) === ks);
  if (!w) throw new Error(`No well "${key}". Wells: ${field.wells.map((x) => `${x.id} (${x.name})`).join(', ')}.`);
  return w;
}

/** TVDSS (m below mean sea level, positive down) at a measured depth of a well. */
export const tvdssAt = (field: FieldModel, w: Well, md: number) => w.trajectory.at(md).tvd - field.meta.datumElevation;

/** A curve a tool can read, wherever it lives: the measured logs, the operator's CPI, or this app's interpretation. */
export interface CurveRef {
  /** the column key in datasets (the mnemonic; `CPI_<mnemonic>` when the logs have one of the same name) */
  key: string;
  mnemonic: string;
  unit: string;
  description: string;
  provenance: string;
  source: 'logs' | 'cpi' | 'interpretation';
  depth: Float64Array;
  values: Float32Array;
  /** spans decades (resistivity): averaged geometrically, plotted on a log scale */
  log: boolean;
}

const isLog = (unit: string) => /ohm|Ω/i.test(unit);

const fromCurve = (c: Curve, depth: Float64Array, source: CurveRef['source'], key = c.mnemonic): CurveRef => ({
  key,
  mnemonic: c.mnemonic,
  unit: c.unit,
  description: c.description,
  provenance: c.provenance,
  source,
  depth,
  values: c.values,
  log: isLog(c.unit),
});

const INTERP: [key: string, field: 'vsh' | 'phie' | 'sw' | 'so' | 'bvw' | 'hcpv', description: string][] = [
  ['VSH', 'vsh', 'Shale volume from GR (calculated)'],
  ['PHIE', 'phie', 'Effective porosity (calculated)'],
  ['SW', 'sw', 'Water saturation, Archie / Simandoux (calculated)'],
  ['SO', 'so', 'Oil saturation 1 − Sw (calculated)'],
  ['BVW', 'bvw', 'Bulk volume water φ·Sw (calculated)'],
  ['HCPV', 'hcpv', 'Hydrocarbon pore volume fraction φ·So (calculated)'],
];

const flagCache = new WeakMap<Uint8Array, Float32Array>();
const flagCurve = (f: Uint8Array) => flagCache.get(f) ?? flagCache.set(f, Float32Array.from(f)).get(f)!;

/** Every curve of a (loaded) well: logs first, then CPI, then the interpretation (VSH, PHIE, SW, SO, BVW, HCPV, NET, PAY). */
export function availableCurves(w: Well): CurveRef[] {
  const out: CurveRef[] = [];
  if (w.logs) for (const c of w.logs.curves.values()) out.push(fromCurve(c, w.logs.depth, 'logs'));
  if (w.cpi) for (const c of w.cpi.curves.values()) out.push(fromCurve(c, w.cpi.depth, 'cpi', w.logs?.curves.has(c.mnemonic) ? `CPI_${c.mnemonic}` : c.mnemonic));
  const p = w.petro;
  if (p && w.logs && p.available) {
    for (const [key, f, description] of INTERP) out.push({ ...fromCurve(p[f], w.logs.depth, 'interpretation', key), mnemonic: key, description });
    const d = w.logs.depth;
    out.push({ key: 'NET', mnemonic: 'NET', unit: 'flag', description: 'Net reservoir flag (Vsh and porosity cut-offs, calculated)', provenance: 'calculated', source: 'interpretation', depth: d, values: flagCurve(p.net), log: false });
    out.push({ key: 'PAY', mnemonic: 'PAY', unit: 'flag', description: 'Net pay flag (net and Sw cut-off, calculated)', provenance: 'calculated', source: 'interpretation', depth: d, values: flagCurve(p.pay), log: false });
  }
  return out;
}

/** Words people use for curves, to the alias or key that finds them. */
const WORDS: Record<string, string> = {
  GAMMA: 'GR',
  GAMMARAY: 'GR',
  RESISTIVITY: 'RDEEP',
  DEEPRESISTIVITY: 'RDEEP',
  RES: 'RDEEP',
  SHALLOWRESISTIVITY: 'RSHAL',
  DENSITY: 'RHOB',
  BULKDENSITY: 'RHOB',
  NEUTRON: 'NPHI',
  NEUTRONPOROSITY: 'NPHI',
  SONIC: 'DT',
  SHEARSONIC: 'DTS',
  CALIPER: 'CALI',
  BITSIZE: 'BS',
  POROSITY: 'PHIE',
  SATURATION: 'SW',
  WATERSATURATION: 'SW',
  OILSATURATION: 'SO',
  SHALEVOLUME: 'VSH',
  VSHALE: 'VSH',
  VCL: 'VSH',
  NETPAY: 'PAY',
};

/** A curve of a well by mnemonic, standard alias (GR, RT, RDEEP, RHOB, NPHI, DT…), CPI name or word; throws listing what there is. */
export function resolveCurve(w: Well, name: string, all = availableCurves(w)): CurveRef {
  const k = norm(name);
  const exact = all.find((c) => norm(c.key) === k) ?? all.find((c) => norm(c.mnemonic) === k);
  if (exact) return exact;
  const alias = WORDS[k] ?? k;
  const byKey = all.find((c) => c.key === alias);
  if (byKey) return byKey;
  if (ALIASES[alias]) {
    const found = findCurve(w.logs, alias) ?? findCurve(w.cpi, alias);
    const ref = found && all.find((c) => c.values === found.values);
    if (ref) return ref;
  }
  if (!all.length) throw new Error(`${w.name} has no log curves (survey${w.productionMonthly.length ? ' and production' : ''} only).`);
  throw new Error(`${w.name} has no curve "${name}". Curves: ${all.map((c) => c.key).join(', ')}. Standard aliases: ${Object.keys(ALIASES).join(', ')}.`);
}

/** The first index whose depth is ≥ x (depths ascending). */
export function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A curve's value over [a, b) m MD: the mean of the samples in it (geometric
 * for resistivity), or the value interpolated at its middle when no sample
 * falls inside (a step finer than the curve's own sampling). NaN without data.
 */
export function blockValue(c: CurveRef, a: number, b: number): number {
  const d = c.depth;
  let s = 0;
  let n = 0;
  for (let i = lowerBound(d, a); i < d.length && d[i] < b; i++) {
    const v = c.values[i];
    if (!Number.isFinite(v) || (c.log && v <= 0)) continue;
    s += c.log ? Math.log(v) : v;
    n++;
  }
  if (n) return c.log ? Math.exp(s / n) : s / n;
  return sampleCurve(d, c.values, (a + b) / 2);
}

/** Where a curve has data: its first and last finite sample (m MD), or null. */
export function coverage(c: CurveRef): { fromMd: number; toMd: number } | null {
  let i = 0;
  let j = c.values.length - 1;
  while (i <= j && !Number.isFinite(c.values[i])) i++;
  while (j >= i && !Number.isFinite(c.values[j])) j--;
  return i <= j ? { fromMd: c.depth[i], toMd: c.depth[j] } : null;
}

/** The p-th quantile (0–1) of ascending values, linearly interpolated. */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const x = (n - 1) * p;
  const i = Math.floor(x);
  const t = x - i;
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * t : sorted[i];
}

/** Summary statistics of the finite samples of a curve between two depths. */
export function curveStats(c: CurveRef, from: number, to: number) {
  const d = c.depth;
  const vals: number[] = [];
  let s = 0;
  let ls = 0;
  let ln = 0;
  for (let i = lowerBound(d, from); i < d.length && d[i] <= to; i++) {
    const v = c.values[i];
    if (!Number.isFinite(v)) continue;
    vals.push(v);
    s += v;
    if (v > 0) {
      ls += Math.log(v);
      ln++;
    }
  }
  const sorted = Float64Array.from(vals).sort();
  const n = sorted.length;
  return {
    n,
    min: n ? sorted[0] : NaN,
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: n ? sorted[n - 1] : NaN,
    mean: n ? s / n : NaN,
    geomean: ln ? Math.exp(ls / ln) : NaN,
  };
}

/** The logs a well has, loaded or not: its LAS file or curves it was given. */
export const hasLogs = (w: Well) => !!(w.logs || w.lasFile);

/** The set of logs a depth range is clamped to (the logs, else the trajectory). */
export function depthRange(w: Well, logs?: LogSet): [number, number] {
  if (logs && logs.depth.length) return [logs.depth[0], logs.depth[logs.depth.length - 1]];
  return [w.trajectory.mdStart, w.trajectory.mdEnd];
}

/** yyyy-mm of an epoch-ms date (UTC). */
export const isoMonth = (t: number) => new Date(t).toISOString().slice(0, 7);
/** yyyy-mm-dd of an epoch-ms date (UTC). */
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** An ISO date or month ("2012", "2012-03", "2012-03-15") as epoch ms at its start; throws on anything else. */
export function parseIsoDate(s: string, end = false): number {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not a date: use yyyy, yyyy-mm or yyyy-mm-dd.`);
  const y = +m[1];
  const mo = m[2] ? +m[2] - 1 : end ? 11 : 0;
  if (!end) return Date.UTC(y, mo, m[3] ? +m[3] : 1);
  // the end of the period named: the last day of the year or month, or that day
  return m[3] ? Date.UTC(y, mo, +m[3]) : Date.UTC(y, mo + 1, 0);
}

/** Lets the page paint between chunks of work (between wells). */
export const yieldToPage = () => new Promise<void>((r) => setTimeout(r));
