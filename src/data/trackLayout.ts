import { RES_RANGE } from './colormap';
import { ROP_RANGE } from './drilling';
import { ALIASES, findCurve } from './las';
import type { PetroResult } from './petro';
import type { LogSet } from './types';

/**
 * Layout of the well-log panel: which tracks are shown, in what order, and
 * how each curve is scaled. The six built-in tracks are the default; users
 * can hide and reorder them, change scales and colours, and add tracks for
 * any curve the well has (measured logs, Equinor CPI or calculated curves).
 */

export interface Scale {
  min: number;
  max: number;
  log?: boolean;
}

export type PetroKey = 'vsh' | 'phie' | 'sw' | 'so' | 'bvw' | 'hcpv';

export interface CurveSpec {
  key: string; // alias key or mnemonic
  label: string;
  color: string;
  scale: Scale;
  dash?: number[];
  width?: number;
  source?: 'logs' | 'petro' | 'cpi';
  petroKey?: PetroKey;
  cpiKey?: string;
  /** look the mnemonic up as written instead of through the vendor aliases */
  exact?: boolean;
  /** unit shown in the readout of added curves */
  unit?: string;
}

export type TrackFill = 'gr' | 'nd' | 'sw' | 'vsh-phi' | 'res-strip' | 'shade';

export interface TrackSpec {
  id: string;
  title: string;
  flex: number;
  prov: 'measured' | 'calculated' | 'interpreted' | 'mixed';
  curves: CurveSpec[];
  grid?: 'linear' | 'log';
  fill?: TrackFill;
  /** added by the user (can be deleted; skipped when the well lacks its curves) */
  custom?: boolean;
  hidden?: boolean;
}

export const MAX_CURVES_PER_TRACK = 3;

export const DEFAULT_TRACKS: TrackSpec[] = [
  {
    id: 'gr',
    title: 'Gamma · Caliper',
    flex: 1,
    prov: 'measured',
    fill: 'gr',
    curves: [
      { key: 'GR', label: 'GR', color: '#9be27a', scale: { min: 0, max: 150 } },
      { key: 'CALI', label: 'CALI', color: '#d9dde2', scale: { min: 6, max: 16 }, dash: [3, 2], width: 1 },
      { key: 'BS', label: 'BS', color: '#6d7986', scale: { min: 6, max: 16 }, dash: [1, 2], width: 1 },
    ],
  },
  {
    id: 'res',
    title: 'Resistivity',
    flex: 1.2,
    prov: 'measured',
    grid: 'log',
    fill: 'res-strip',
    curves: [
      { key: 'RT', label: 'RT deep', color: '#ff8a65', scale: { min: RES_RANGE.min, max: RES_RANGE.max, log: true }, width: 1.6 },
      { key: 'RSHAL', label: 'R shallow', color: '#ffd166', scale: { min: RES_RANGE.min, max: RES_RANGE.max, log: true }, dash: [3, 2], width: 1 },
    ],
  },
  {
    id: 'nd',
    title: 'Density · Neutron',
    flex: 1.05,
    prov: 'measured',
    fill: 'nd',
    curves: [
      { key: 'RHOB', label: 'RHOB', color: '#ff6b81', scale: { min: 1.95, max: 2.95 } },
      { key: 'NPHI', label: 'NPHI', color: '#5aa9e6', scale: { min: 0.45, max: -0.15 }, dash: [4, 2] },
    ],
  },
  {
    id: 'dt',
    title: 'Sonic',
    flex: 0.8,
    prov: 'measured',
    curves: [
      { key: 'DT', label: 'DTC', color: '#c792ea', scale: { min: 140, max: 40 } },
      { key: 'DTS', label: 'DTS', color: '#82aaff', scale: { min: 340, max: 90 }, dash: [3, 2], width: 1 },
    ],
  },
  {
    id: 'vp',
    title: 'Vsh · Porosity',
    flex: 0.95,
    prov: 'calculated',
    fill: 'vsh-phi',
    curves: [
      { key: 'VSH_CALC', label: 'VSH', color: '#b8bec6', scale: { min: 0, max: 1 }, source: 'petro', petroKey: 'vsh', width: 1 },
      { key: 'PHIE_CALC', label: 'PHIE', color: '#7fe3ff', scale: { min: 0.5, max: 0 }, source: 'petro', petroKey: 'phie' },
    ],
  },
  {
    id: 'sw',
    title: 'Saturation',
    flex: 1.05,
    prov: 'mixed',
    fill: 'sw',
    curves: [
      { key: 'SW_CALC', label: 'Sw calc', color: '#6fb6ff', scale: { min: 0, max: 1 }, source: 'petro', petroKey: 'sw', width: 1.5 },
      { key: 'SW', label: 'Sw CPI', color: '#b8a2ff', scale: { min: 0, max: 1 }, source: 'cpi', cpiKey: 'SW', dash: [3, 2], width: 1.2 },
    ],
  },
];

export function defaultLayout(): TrackSpec[] {
  return structuredClone(DEFAULT_TRACKS);
}

// ------------------------------------------------------------------ curves a well offers

export interface WellCurves {
  logs?: LogSet;
  cpi?: LogSet;
  petro?: PetroResult;
}

export interface CurveOption {
  id: string; // `${source}:${key}`
  source: 'logs' | 'cpi' | 'petro';
  key: string;
  label: string;
  unit: string;
  description: string;
}

const PETRO_CURVES: { key: PetroKey; label: string; unit: string; description: string }[] = [
  { key: 'vsh', label: 'VSH calc', unit: 'v/v', description: 'Shale volume from the GR index' },
  { key: 'phie', label: 'PHIE calc', unit: 'v/v', description: 'Effective porosity' },
  { key: 'sw', label: 'Sw calc', unit: 'v/v', description: 'Water saturation' },
  { key: 'so', label: 'So calc', unit: 'v/v', description: 'Oil saturation (1 − Sw)' },
  { key: 'bvw', label: 'BVW calc', unit: 'v/v', description: 'Bulk volume water (φ·Sw)' },
  { key: 'hcpv', label: 'HCPV calc', unit: 'v/v', description: 'Hydrocarbon pore volume (φ·So)' },
];

/** Every curve of a well that can go in a track, grouped by source. */
export function availableCurves(w: WellCurves): CurveOption[] {
  const out: CurveOption[] = [];
  const add = (source: 'logs' | 'cpi', set?: LogSet) => {
    if (!set) return;
    for (const c of set.curves.values()) {
      if (!c.values.some(Number.isFinite)) continue;
      out.push({ id: `${source}:${c.mnemonic}`, source, key: c.mnemonic, label: c.mnemonic.replace(/\.UNKNOWN$/i, ''), unit: c.unit, description: c.description });
    }
  };
  add('logs', w.logs);
  add('cpi', w.cpi);
  if (w.petro?.available)
    for (const p of PETRO_CURVES) out.push({ id: `petro:${p.key}`, source: 'petro', key: p.key, label: p.label, unit: p.unit, description: p.description });
  return out;
}

/** Depth + values of a curve spec on a well, or null when the well does not have it. */
export function resolveCurve(w: WellCurves, spec: CurveSpec): { depth: Float64Array; values: Float32Array } | null {
  if (!w.logs && spec.source !== 'cpi') return null;
  if (spec.source === 'petro') {
    const p = w.petro;
    if (!p || !spec.petroKey || !w.logs) return null;
    return { depth: w.logs.depth, values: p[spec.petroKey].values };
  }
  if (spec.source === 'cpi') {
    const c = w.cpi?.curves.get(spec.cpiKey ?? spec.key);
    return c ? { depth: w.cpi!.depth, values: c.values } : null;
  }
  const c = spec.exact ? w.logs!.curves.get(spec.key) : findCurve(w.logs, spec.key);
  return c ? { depth: w.logs!.depth, values: c.values } : null;
}

/** True when the well has at least one curve of the track. */
export function trackHasData(w: WellCurves, t: TrackSpec): boolean {
  return t.curves.some((c) => resolveCurve(w, c) !== null);
}

/** Tracks to draw for a well: hidden ones removed, and user tracks (or, optionally, any track) without data skipped. */
export function visibleTracks(layout: TrackSpec[], w: WellCurves | undefined, hideEmpty = false): TrackSpec[] {
  return layout.filter((t) => !t.hidden && (!w || !(t.custom || hideEmpty) || trackHasData(w, t)));
}

// ------------------------------------------------------------------ automatic scales

function canonical(mnemonic: string): string | null {
  const m = mnemonic.toUpperCase().replace(/\.UNKNOWN$/, '');
  if (ALIASES[m]) return m;
  for (const [k, list] of Object.entries(ALIASES)) if (list.includes(m)) return k;
  return null;
}

const KNOWN: Record<string, Scale> = {
  GR: { min: 0, max: 150 },
  RT: { min: RES_RANGE.min, max: RES_RANGE.max, log: true },
  RDEEP: { min: RES_RANGE.min, max: RES_RANGE.max, log: true },
  RSHAL: { min: RES_RANGE.min, max: RES_RANGE.max, log: true },
  RHOB: { min: 1.95, max: 2.95 },
  NPHI: { min: 0.45, max: -0.15 },
  DT: { min: 140, max: 40 },
  DTS: { min: 340, max: 90 },
  CALI: { min: 6, max: 16 },
  BS: { min: 6, max: 16 },
  PEF: { min: 0, max: 10 },
  DRHO: { min: -0.15, max: 0.15 },
  ROP: { min: ROP_RANGE.min / 10, max: ROP_RANGE.max * 2, log: true },
};

export function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * A sensible default scale for a curve: the conventional range for known
 * mnemonics, otherwise a rounded P2–P98 range of the data (logarithmic when
 * the data are positive and span more than ~2 decades).
 */
export function autoScale(mnemonic: string, unit: string, values: ArrayLike<number>): Scale {
  const m = mnemonic.toUpperCase().replace(/\.UNKNOWN$/, '');
  const c = canonical(m);
  if (c && KNOWN[c]) return { ...KNOWN[c] };
  if (/OHM/i.test(unit) || /^(RES|ILD|ILM|LLD|LLS|MSFL|RXO|RD|RM|RS)/.test(m)) return { ...KNOWN.RT };
  if (/^(KLOG|PERM|KH|KV|KINT)/.test(m) || /\bmD\b|^md$/i.test(unit)) return { min: 0.01, max: 10000, log: true };
  if (/FLAG/.test(m)) return { min: 0, max: 1 };
  if (/^(PHI|POR)/.test(m)) return { min: 0.5, max: 0 };
  if (/^(SW|SO|SXO|VSH|VCL|BVW|HCPV)/.test(m)) return { min: 0, max: 1 };
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]);
  if (!v.length) return { min: 0, max: 1 };
  v.sort((a, b) => a - b);
  const lo = percentile(v, 0.02);
  const hi = percentile(v, 0.98);
  if (lo > 0 && hi / lo >= 100) return { min: 10 ** Math.floor(Math.log10(lo)), max: 10 ** Math.ceil(Math.log10(hi)), log: true };
  if (hi - lo < 1e-9) return { min: lo - (Math.abs(lo) || 1) * 0.1, max: hi + (Math.abs(hi) || 1) * 0.1 };
  const st = niceStep((hi - lo) / 5);
  return { min: Math.floor(lo / st) * st, max: Math.ceil(hi / st) * st };
}

const PALETTE = ['#ffd166', '#7fe3ff', '#ff8fa3', '#9be27a', '#c792ea', '#f4a261', '#82aaff', '#e6e6e6'];

/** Curve spec for a curve the user picked, with an automatic scale and a colour not used in the track yet. */
export function specForOption(w: WellCurves, opt: CurveOption, taken: string[] = []): CurveSpec {
  const color = PALETTE.find((c) => !taken.includes(c)) ?? PALETTE[taken.length % PALETTE.length];
  const base: CurveSpec = { key: opt.key, label: opt.label, color, scale: { min: 0, max: 1 }, unit: opt.unit, width: 1.3 };
  if (opt.source === 'petro') Object.assign(base, { source: 'petro', petroKey: opt.key as PetroKey });
  else if (opt.source === 'cpi') Object.assign(base, { source: 'cpi', cpiKey: opt.key });
  else Object.assign(base, { source: 'logs', exact: true });
  const data = resolveCurve(w, base);
  const scaleKey = opt.source === 'petro' ? opt.key.toUpperCase() : opt.key;
  base.scale = autoScale(scaleKey, opt.unit, data?.values ?? []);
  return base;
}

/** A new user track holding one curve. */
export function newTrack(w: WellCurves, opt: CurveOption, existing: TrackSpec[]): TrackSpec {
  let n = 1;
  while (existing.some((t) => t.id === `user-${n}`)) n++;
  const prov = opt.source === 'petro' ? 'calculated' : opt.source === 'cpi' ? 'interpreted' : 'measured';
  const spec = specForOption(w, opt);
  return { id: `user-${n}`, title: opt.label, flex: 0.8, prov, curves: [spec], grid: spec.scale.log ? 'log' : 'linear', custom: true };
}

// ------------------------------------------------------------------ persistence

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate a stored layout; anything malformed falls back to the default layout. */
export function parseLayout(raw: unknown): TrackSpec[] {
  if (!Array.isArray(raw) || !raw.length) return defaultLayout();
  const out: TrackSpec[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return defaultLayout();
    const r = t as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.title !== 'string' || !Array.isArray(r.curves) || !r.curves.length) return defaultLayout();
    const curves: CurveSpec[] = [];
    for (const c of r.curves as Record<string, unknown>[]) {
      const s = c?.scale as Record<string, unknown> | undefined;
      if (typeof c?.key !== 'string' || typeof c.color !== 'string' || !s || !isNum(s.min) || !isNum(s.max) || s.min === s.max) return defaultLayout();
      if (s.log && (s.min <= 0 || s.max <= 0)) return defaultLayout();
      curves.push(c as unknown as CurveSpec);
    }
    out.push({
      id: r.id,
      title: r.title,
      flex: isNum(r.flex) && r.flex > 0.2 && r.flex < 4 ? r.flex : 1,
      prov: (['measured', 'calculated', 'interpreted', 'mixed'] as const).find((p) => p === r.prov) ?? 'measured',
      curves: curves.slice(0, MAX_CURVES_PER_TRACK),
      grid: r.grid === 'log' ? 'log' : 'linear',
      fill: (['gr', 'nd', 'sw', 'vsh-phi', 'res-strip', 'shade'] as const).find((f) => f === r.fill),
      custom: r.custom === true,
      hidden: r.hidden === true,
    });
  }
  // built-in tracks are never lost: re-add any that a stored layout is missing
  for (const d of DEFAULT_TRACKS) if (!out.some((t) => t.id === d.id)) out.push({ ...structuredClone(d), hidden: true });
  return out;
}

/** Move a track one place up (−1) or down (+1). */
export function moveTrack(layout: TrackSpec[], id: string, dir: -1 | 1): TrackSpec[] {
  const i = layout.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= layout.length) return layout;
  const out = [...layout];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
