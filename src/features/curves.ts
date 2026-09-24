import type { Well } from '../data/dataset';
import { findCurve } from '../data/las';
import { colormap, saturationColor, RES_RANGE, type ColormapName, type RGB } from '../data/colormap';
import { ROP_RANGE } from '../data/drilling';

export interface CurveDef {
  key: string;
  label: string;
  unit: string;
  range: string;
  prov: 'measured' | 'calculated';
  /** depth + values of the curve on this well, or null */
  get(w: Well): { depth: Float64Array; values: Float32Array } | null;
  /** 0..1 amplitude for the filled curve */
  amp(v: number): number;
  color(v: number, cmap: ColormapName): RGB;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const logs = (key: string) => (w: Well) => {
  const c = findCurve(w.logs, key);
  return c && w.logs ? { depth: w.logs.depth, values: c.values } : null;
};
const petro = (key: 'sw' | 'phie' | 'vsh') => (w: Well) => (w.petro && w.logs && w.petro.available ? { depth: w.logs.depth, values: w.petro[key].values } : null);

export function ropRgb(v: number): RGB {
  const t = clamp01(Math.log10(Math.max(v, 0.01)) / Math.log10(ROP_RANGE.max));
  const a: RGB = [0.13, 0.04, 0.32];
  const b: RGB = [0.72, 0.16, 0.42];
  const c: RGB = [0.98, 0.55, 0.2];
  const d: RGB = [0.99, 0.95, 0.62];
  return t < 0.33 ? mix(a, b, t / 0.33) : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33) : mix(c, d, (t - 0.66) / 0.34);
}

export const CURVES: CurveDef[] = [
  {
    key: 'GR',
    label: 'Gamma ray',
    unit: 'API',
    range: '0–150 API',
    prov: 'measured',
    get: logs('GR'),
    amp: (v) => clamp01(v / 150),
    color: (v) => mix([0.95, 0.83, 0.38], [0.32, 0.38, 0.27], clamp01(v / 130)),
  },
  {
    key: 'RT',
    label: 'Deep resistivity',
    unit: 'Ω·m',
    range: `${RES_RANGE.min}–${RES_RANGE.max} Ω·m (log)`,
    prov: 'measured',
    get: logs('RT'),
    amp: (v) => clamp01((Math.log10(Math.max(v, 1e-3)) - Math.log10(RES_RANGE.min)) / (Math.log10(RES_RANGE.max) - Math.log10(RES_RANGE.min))),
    color: (v, cm) => colormap(cm, clamp01((Math.log10(Math.max(v, 1e-3)) - Math.log10(RES_RANGE.min)) / (Math.log10(RES_RANGE.max) - Math.log10(RES_RANGE.min)))),
  },
  {
    key: 'SO',
    label: 'Oil saturation (1 − Sw)',
    unit: 'v/v',
    range: '0–1',
    prov: 'calculated',
    get: petro('sw'),
    amp: (v) => clamp01(1 - v),
    color: (v) => saturationColor(v),
  },
  {
    key: 'PHIE',
    label: 'Effective porosity',
    unit: 'v/v',
    range: '0–0.35',
    prov: 'calculated',
    get: petro('phie'),
    amp: (v) => clamp01(v / 0.35),
    color: (v) => mix([0.25, 0.3, 0.38], [0.36, 0.78, 1.0], clamp01(v / 0.3)),
  },
  {
    key: 'RHOB',
    label: 'Bulk density',
    unit: 'g/cm³',
    range: '1.95–2.95 g/cm³',
    prov: 'measured',
    get: logs('RHOB'),
    amp: (v) => clamp01((v - 1.95) / 1.0),
    color: (v) => mix([0.95, 0.45, 0.35], [0.35, 0.2, 0.55], clamp01((v - 2.0) / 0.9)),
  },
  {
    key: 'NPHI',
    label: 'Neutron porosity',
    unit: 'v/v',
    range: '0–0.45',
    prov: 'measured',
    get: logs('NPHI'),
    amp: (v) => clamp01(v / 0.45),
    color: (v) => mix([0.3, 0.6, 0.35], [0.4, 0.75, 1.0], clamp01(v / 0.45)),
  },
  {
    key: 'DT',
    label: 'Sonic (compressional)',
    unit: 'µs/ft',
    range: '40–140 µs/ft',
    prov: 'measured',
    get: logs('DT'),
    amp: (v) => clamp01((v - 40) / 100),
    color: (v) => mix([0.95, 0.9, 0.7], [0.55, 0.25, 0.7], clamp01((v - 50) / 90)),
  },
  {
    key: 'ROP',
    label: 'Rate of penetration',
    unit: 'm/h',
    range: '1–100 m/h (log)',
    prov: 'measured',
    get: logs('ROP'),
    amp: (v) => clamp01(Math.log10(Math.max(v, 0.1)) / 2),
    color: (v) => ropRgb(v),
  },
];

export const CURVE_BY_KEY = new Map(CURVES.map((c) => [c.key, c]));

/** Decimate a curve to regular steps between two depths, skipping nulls (NaN). */
export function resample(depth: Float64Array, values: Float32Array, step: number): { md: number; v: number }[] {
  const out: { md: number; v: number }[] = [];
  let next = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] < next) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    out.push({ md: depth[i], v });
    next = depth[i] + step;
  }
  return out;
}
