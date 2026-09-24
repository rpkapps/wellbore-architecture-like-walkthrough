import type { Curve, LogSet, Provenance } from './types';

export class LasError extends Error {}

interface HeaderLine {
  mnem: string;
  unit: string;
  value: string;
  desc: string;
}

function parseHeaderLine(line: string, firstColon = false): HeaderLine | null {
  // MNEM.UNIT  VALUE : DESCRIPTION  — the first '.' separates mnemonic, the LAST ':' separates description
  const dot = line.indexOf('.');
  if (dot < 0) return null;
  const mnem = line.slice(0, dot).trim();
  const rest = line.slice(dot + 1);
  const colon = firstColon ? rest.indexOf(':') : rest.lastIndexOf(':');
  const left = colon >= 0 ? rest.slice(0, colon) : rest;
  const desc = colon >= 0 ? rest.slice(colon + 1).trim() : '';
  // unit is the token immediately after the dot (no space); value is the remainder
  const m = /^(\S*)\s*(.*)$/.exec(left);
  const unit = m ? m[1] : '';
  const value = m ? m[2].trim() : left.trim();
  return { mnem, unit, value, desc };
}

const FEET = /^(f|ft|feet|foot|f\.?)$/i;

/**
 * Parse a LAS 1.2 / 2.0 file (wrapped or unwrapped). Depth is converted to
 * metres. Null values become NaN.
 */
export function parseLAS(text: string, source: string, provenance: Provenance = 'measured'): LogSet {
  const lines = text.split(/\r?\n/);
  let section = '';
  const header: Record<string, string> = {};
  const curveDefs: HeaderLine[] = [];
  let wrap = false;
  let nullValue = -999.25;
  let version = '2.0';
  const dataTokens: string[] = [];

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (raw.length === 0) continue;
    const c0 = raw.charCodeAt(0);
    if (c0 === 126 /* ~ */) {
      section = raw.charAt(1).toUpperCase();
      if (section === 'A') {
        // consume the rest of the file as data
        for (let j = li + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l || l.charCodeAt(0) === 35 /* # */) continue;
          if (l.charCodeAt(0) === 126) break;
          const toks = l.trim().split(/\s+/);
          for (const t of toks) if (t) dataTokens.push(t);
        }
        break;
      }
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (section === 'V' || section === 'W' || section === 'P' || section === 'C') {
      const h = parseHeaderLine(trimmed, section === 'C');
      if (!h) continue;
      if (section === 'V') {
        if (h.mnem.toUpperCase() === 'WRAP') wrap = /^y/i.test(h.value);
        if (h.mnem.toUpperCase() === 'VERS') version = h.value;
      } else if (section === 'W') {
        // LAS 1.2 puts values in the description column for some keys
        const val = h.value || h.desc;
        header[h.mnem.toUpperCase()] = val;
        if (h.mnem.toUpperCase() === 'NULL') {
          const v = parseFloat(h.value);
          if (Number.isFinite(v)) nullValue = v;
        }
      } else if (section === 'C') {
        curveDefs.push(h);
      } else if (section === 'P') {
        header['P:' + h.mnem.toUpperCase()] = `${h.value}${h.unit ? ' ' + h.unit : ''}`;
      }
    }
  }

  if (/^3/.test(version)) throw new LasError('LAS 3.0 files are not supported yet — export as LAS 2.0.');
  if (curveDefs.length < 2) throw new LasError('No ~Curve section with at least a depth and one log curve was found.');
  if (dataTokens.length === 0) throw new LasError('No ~ASCII data section found.');

  const nc = curveDefs.length;
  const nrows = Math.floor(dataTokens.length / nc);
  if (!wrap && dataTokens.length % nc !== 0) {
    // tolerate trailing junk but warn through header
    header['_WARNING'] = `Data token count (${dataTokens.length}) is not a multiple of curve count (${nc}).`;
  }
  const depthUnit = curveDefs[0].unit || header['STRT']?.split(' ')[0] || 'M';
  const toMetres = FEET.test(depthUnit) ? 0.3048 : 1;
  const depth = new Float64Array(nrows);
  const cols: Float32Array[] = curveDefs.slice(1).map(() => new Float32Array(nrows));
  const eps = Math.abs(nullValue) * 1e-6 + 1e-9;
  for (let r = 0; r < nrows; r++) {
    const base = r * nc;
    depth[r] = parseFloat(dataTokens[base]) * toMetres;
    for (let c = 1; c < nc; c++) {
      const v = parseFloat(dataTokens[base + c]);
      cols[c - 1][r] = !Number.isFinite(v) || Math.abs(v - nullValue) < eps ? NaN : v;
    }
  }
  // ensure increasing depth
  if (nrows > 1 && depth[0] > depth[nrows - 1]) {
    depth.reverse();
    for (const col of cols) col.reverse();
  }

  const curves = new Map<string, Curve>();
  curveDefs.slice(1).forEach((d, i) => {
    let mnem = d.mnem.toUpperCase() || `C${i + 1}`;
    while (curves.has(mnem)) mnem += '_';
    const vals = cols[i];
    let any = false;
    for (let k = 0; k < vals.length; k++)
      if (!Number.isNaN(vals[k])) {
        any = true;
        break;
      }
    if (!any) return; // skip empty curves
    const desc = d.desc.replace(/^\d+\s+/, '').replace(/:COMPOSITE.*$/, '').trim();
    curves.set(mnem, {
      mnemonic: mnem,
      unit: normaliseUnit(d.unit),
      description: desc || mnem,
      values: vals,
      provenance,
      source,
    });
  });

  return {
    wellName: header['WELL'] || source,
    depth,
    curves,
    header,
    source,
    provenance,
  };
}

function normaliseUnit(u: string): string {
  const s = u.trim();
  if (/^ohm[\.\-_]?m+$/i.test(s) || /^ohmm$/i.test(s)) return 'Ω·m';
  if (/^g\/cm3$/i.test(s) || /^g\/cc$/i.test(s)) return 'g/cm³';
  if (/^us\/ft$/i.test(s)) return 'µs/ft';
  if (/^inches$/i.test(s) || /^in$/i.test(s)) return 'in';
  if (/^v\/v$/i.test(s)) return 'v/v';
  if (/^api$/i.test(s) || /^gapi$/i.test(s)) return 'API';
  if (/^unknown$/i.test(s)) return '';
  return s;
}

/** Linear interpolation of a curve at a measured depth (NaN outside / in gaps). */
export function sampleCurve(depth: Float64Array, values: Float32Array, md: number): number {
  const n = depth.length;
  if (n === 0 || md < depth[0] || md > depth[n - 1]) return NaN;
  let lo = 0;
  let hi = n - 1;
  // fast path for regular sampling
  const step = (depth[n - 1] - depth[0]) / (n - 1);
  if (step > 0) {
    const guess = Math.min(n - 2, Math.max(0, Math.floor((md - depth[0]) / step)));
    if (depth[guess] <= md && depth[guess + 1] >= md) {
      lo = guess;
      hi = guess + 1;
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (depth[mid] <= md) lo = mid;
    else hi = mid;
  }
  const d0 = depth[lo];
  const d1 = depth[hi];
  const v0 = values[lo];
  const v1 = values[hi];
  if (Number.isNaN(v0)) return md - d0 < 0.5 * (d1 - d0) ? NaN : v1;
  if (Number.isNaN(v1)) return md - d0 < 0.5 * (d1 - d0) ? v0 : NaN;
  const t = d1 > d0 ? (md - d0) / (d1 - d0) : 0;
  return v0 + (v1 - v0) * t;
}

/** Curve aliases for resolving standard inputs regardless of vendor mnemonic. */
export const ALIASES: Record<string, string[]> = {
  GR: ['GR', 'GRC', 'SGR', 'CGR', 'GR_EDTC', 'GAMMA', 'HSGR', 'ECGR', 'GRD'],
  RT: ['RT', 'RDEP', 'RD', 'ILD', 'LLD', 'RESD', 'AT90', 'RLA5', 'RACELM', 'HDRS', 'RILD', 'DEEP'],
  RDEEP: ['RACELM', 'RACEHM', 'AT90', 'RLA5', 'LLD', 'ILD', 'RT', 'RD', 'RDEP'],
  RSHAL: ['RPCEHM', 'RPCELM', 'RXO', 'MSFL', 'RXOZ', 'AT10', 'RLA1', 'LLS', 'ILM', 'RMED', 'RS', 'SFL'],
  RHOB: ['RHOB', 'DEN', 'RHOZ', 'ZDEN', 'DENS', 'RHO'],
  NPHI: ['NPHI', 'NEU', 'TNPH', 'CNL', 'NPOR', 'PHIN', 'CNC', 'NPHI_LS'],
  DT: ['DT', 'DTC', 'AC', 'DTCO', 'DT4P', 'SONIC'],
  DTS: ['DTS', 'DTSM', 'ACS', 'DTSH', 'DT4S'],
  CALI: ['CALI', 'CAL', 'HCAL', 'C1', 'CALX', 'CALIPER', 'CAL1'],
  BS: ['BS', 'BIT', 'BITSIZE'],
  PEF: ['PEF', 'PE', 'PEFZ'],
  DRHO: ['DRHO', 'DCOR', 'HDRA'],
  ROP: ['ROP', 'ROPA'],
};

export function findCurve(set: LogSet | undefined, key: keyof typeof ALIASES | string): Curve | undefined {
  if (!set) return undefined;
  const list = ALIASES[key] ?? [key];
  for (const m of list) {
    const c = set.curves.get(m);
    if (c) return c;
  }
  return undefined;
}
