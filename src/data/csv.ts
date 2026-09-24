import type { Curve, LogSet, PickRow, ProductionRecord, ProductionSeries, Provenance, SurveyStation, Top } from './types';
import { formationIdForPick } from './stratigraphy';

export interface Table {
  headers: string[];
  rows: string[][];
  comments: string[];
}

/** Minimal RFC-4180 style CSV parser with delimiter sniffing and '#' comments. */
export function parseCSV(text: string): Table {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/);
  const comments: string[] = [];
  const body: string[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    if (/^\s*#/.test(l)) comments.push(l.replace(/^\s*#\s?/, ''));
    else body.push(l);
  }
  if (body.length === 0) return { headers: [], rows: [], comments };
  const first = body[0];
  const counts: [string, number][] = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ' ';
  const split = (line: string): string[] => {
    if (delim === ' ') return line.trim().split(/\s+/);
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const rows = body.map(split);
  // header present if the first row has any non-numeric token that is not empty
  const firstRow = rows[0];
  const isNum = (t: string | undefined) => t !== undefined && t !== '' && Number.isFinite(Number(t));
  const textFirst = firstRow.filter((t) => t !== '' && !isNum(t)).length;
  const hasHeader =
    textFirst > 0 &&
    (rows.length === 1 || firstRow.every((t) => !isNum(t)) || firstRow.some((t, i) => !isNum(t) && t !== '' && isNum(rows[1][i])));
  if (hasHeader) return { headers: firstRow, rows: rows.slice(1), comments };
  return { headers: firstRow.map((_, i) => `COL${i + 1}`), rows, comments };
}

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

export function findColumn(headers: string[], candidates: string[]): number {
  const h = headers.map(norm);
  for (const c of candidates) {
    const i = h.indexOf(norm(c));
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const nc = norm(c);
    if (nc.length < 2) continue;
    const i = h.findIndex((x) => x.startsWith(nc));
    if (i >= 0) return i;
  }
  return -1;
}

function unitFromHeader(h: string): string {
  const m = /[\(\[]([^\)\]]+)[\)\]]/.exec(h);
  return m ? m[1] : '';
}

const num = (s: string | undefined) => {
  if (s === undefined || s === '') return NaN;
  const v = Number(s.replace(/\s/g, ''));
  return Number.isFinite(v) && v !== -999.25 && v !== -9999 ? v : NaN;
};

/** Column aliases shared by file-type detection and the importers. */
export const COLS = {
  depth: ['DEPTH', 'MD', 'DEPT', 'MDM', 'MEASUREDDEPTH', 'DEPTHM', 'DEPTHMD'],
  well: ['WELL', 'WELLNAME', 'UWI', 'WELLBORE', 'WLBNAME', 'NPDWELLBORENAME', 'WELLBORENAME'],
  topName: ['LSUNAME', 'PICKS', 'PICK', 'FORMATION', 'NAME', 'TOP', 'SURFACE', 'HORIZON', 'ZONE', 'MARKER'],
  topMd: ['LSUTOPDEPTH', 'MD', 'DEPTH', 'TOPMD', 'MDTOP', 'TOPDEPTH', 'MEASUREDDEPTH'],
  inc: ['INC', 'INCL', 'INCLINATION', 'DEVI', 'DEVIATION', 'ANGLE'],
  azi: ['AZI', 'AZIM', 'AZIMUTH', 'AZ', 'HAZI', 'DIRECTION'],
  date: ['DATEPRD', 'DATE', 'DAY', 'TIME', 'PERIOD'],
  year: ['PRFYEAR', 'YEAR'],
  month: ['PRFMONTH', 'MONTH'],
  oil: ['BOREOILVOL', 'PRFPRDOILNETMILLSM3', 'OILSM3', 'OIL', 'QO', 'OILRATE', 'OILVOL'],
  gas: ['BOREGASVOL', 'PRFPRDGASNETBILLSM3', 'GASSM3', 'GAS', 'QG', 'GASRATE', 'GASVOL'],
  water: ['BOREWATVOL', 'PRFPRDPRODUCEDWATERINFIELDMILLSM3', 'WATERSM3', 'WATER', 'QW', 'WATERRATE', 'WATVOL'],
  waterInj: ['BOREWIVOL', 'WATERINJSM3', 'WATERINJ', 'WI', 'INJECTION'],
};

/**
 * Pick the rows' well that matches the target well: exact match, the only well
 * in the file, or a name that is a prefix of the other (e.g. production reported
 * as "15/9-F-11" for wellbore "15/9-F-11 B"). Returns null when ambiguous.
 */
export function chooseWell(names: string[], target?: string): string | null {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 0) return null;
  if (uniq.length === 1) return uniq[0];
  if (!target) return null;
  const k = (s: string) => s.toUpperCase().replace(/^NO\s+/, '').replace(/[^A-Z0-9]/g, '');
  const tk = k(target);
  const exact = uniq.find((n) => k(n) === tk);
  if (exact) return exact;
  const pref = uniq.filter((n) => tk.startsWith(k(n)) || k(n).startsWith(tk)).sort((a, b) => k(b).length - k(a).length);
  return pref[0] ?? null;
}

function wellError(names: string[], target?: string): Error {
  const list = [...new Set(names)].slice(0, 12).join(', ');
  return new Error(`File contains several wells (${list}${new Set(names).size > 12 ? ', …' : ''}) and none matches "${target ?? ''}". Rename the well or use "Create new well".`);
}

/** Depth multiplier: explicit override, else from a unit in the header, else metres. */
function depthScaleFor(header: string, override?: number): number {
  if (override) return override;
  return /\b(ft|feet|foot)\b/i.test(unitFromHeader(header)) ? 0.3048 : 1;
}

// --------------------------------------------------------------------------- log CSV
/**
 * @param strict when true (adding to an existing well) a multi-well file must contain that well;
 *               otherwise the first well in the file is used.
 */
export function logsFromTable(t: Table, source: string, wellName: string, provenance: Provenance = 'user', depthScale?: number, strict = false): LogSet {
  const di = findColumn(t.headers, COLS.depth);
  if (di < 0) throw new Error('No depth column (DEPTH / MD / DEPT) found in CSV.');
  const wi = findColumn(t.headers, COLS.well);
  let rows = t.rows;
  if (wi >= 0) {
    const names = rows.map((r) => r[wi]);
    const pick = chooseWell(names, wellName) ?? (strict ? null : names[0]);
    if (!pick) throw wellError(names, wellName);
    rows = rows.filter((r) => r[wi] === pick);
    wellName = pick;
  }
  const scale = depthScaleFor(t.headers[di], depthScale);
  const depth = new Float64Array(rows.map((r) => num(r[di]) * scale));
  const curves = new Map<string, Curve>();
  t.headers.forEach((h, i) => {
    if (i === di || i === wi) return;
    const vals = new Float32Array(rows.map((r) => num(r[i])));
    if (!vals.some((v) => !Number.isNaN(v))) return;
    const mnem = h.replace(/[\(\[].*$/, '').trim().toUpperCase() || `C${i}`;
    curves.set(mnem, { mnemonic: mnem, unit: unitFromHeader(h), description: h, values: vals, provenance, source });
  });
  // sort by depth
  const idx = [...depth.keys()].filter((k) => Number.isFinite(depth[k])).sort((a, b) => depth[a] - depth[b]);
  const d2 = new Float64Array(idx.map((k) => depth[k]));
  for (const c of curves.values()) c.values = new Float32Array(idx.map((k) => c.values[k]));
  return { wellName, depth: d2, curves, header: { WELL: wellName }, source, provenance };
}

// --------------------------------------------------------------------------- tops
export function topsFromTable(t: Table, source: string, wellFilter?: string, provenance: Provenance = 'user', depthScale?: number): Top[] {
  let ni = findColumn(t.headers, COLS.topName);
  let mi = findColumn(t.headers, COLS.topMd);
  const ti = findColumn(t.headers, ['TVD', 'TVDRKB', 'TVDDF']);
  const wi = findColumn(t.headers, COLS.well);
  const oi = findColumn(t.headers, ['OBS', 'OBSERVATION']);
  if (ni < 0 || mi < 0) {
    // headerless "NAME,DEPTH"
    if (t.headers.length >= 2 && t.headers[0].startsWith('COL')) {
      ni = 0;
      mi = 1;
    } else if (t.headers.length === 2 && !Number.isFinite(Number(t.headers[0])) && Number.isFinite(Number(t.headers[1]))) {
      // header was actually the first data line
      t = { ...t, rows: [t.headers, ...t.rows] };
      ni = 0;
      mi = 1;
    } else throw new Error('Tops file needs a formation name column and a depth (MD) column.');
  }
  const scale = mi >= 0 && !t.headers[mi].startsWith('COL') ? depthScaleFor(t.headers[mi], depthScale) : depthScale ?? 1;
  let pickWell: string | null = null;
  if (wi >= 0) {
    const names = t.rows.map((r) => r[wi]);
    pickWell = chooseWell(names, wellFilter);
    if (!pickWell) throw wellError(names, wellFilter);
  }
  const out: Top[] = [];
  for (const r of t.rows) {
    if (pickWell !== null && r[wi] !== pickWell) continue;
    const md = num(r[mi]) * scale;
    if (!Number.isFinite(md) || !r[ni]) continue;
    out.push({
      name: r[ni],
      formationId: formationIdForPick(r[ni]),
      md,
      tvd: ti >= 0 ? num(r[ti]) * scale : undefined,
      obs: oi >= 0 ? num(r[oi]) : undefined,
      source,
      provenance,
    });
  }
  return out.sort((a, b) => a.md - b.md);
}

export function sameWell(a: string, b: string): boolean {
  const k = (s: string) => s.toUpperCase().replace(/^NO\s+/, '').replace(/[^A-Z0-9]/g, '');
  return k(a) === k(b);
}

export function picksFromTable(t: Table): PickRow[] {
  const c = (names: string[]) => findColumn(t.headers, names);
  const wi = c(['WELL']);
  const pi = c(['PICKS', 'PICK', 'SURFACE']);
  const oi = c(['OBS']);
  const mi = c(['DEPTH', 'MD']);
  const ti = c(['TVD']);
  const si = c(['TVDSS']);
  const ei = c(['EASTING', 'X', 'E']);
  const ni = c(['NORTHING', 'Y', 'N']);
  if ([wi, pi, mi, ti, ei, ni].some((i) => i < 0)) throw new Error('Picks table needs WELL, PICKS, DEPTH, TVD, EASTING, NORTHING');
  return t.rows
    .map((r) => ({
      well: r[wi],
      pick: r[pi],
      obs: oi >= 0 ? num(r[oi]) || 1 : 1,
      md: num(r[mi]),
      tvd: num(r[ti]),
      tvdss: si >= 0 ? Math.abs(num(r[si])) : NaN,
      e: num(r[ei]),
      n: num(r[ni]),
    }))
    .filter((p) => Number.isFinite(p.md) && Number.isFinite(p.e) && Number.isFinite(p.n));
}

// --------------------------------------------------------------------------- survey
export interface ParsedSurvey {
  stations: SurveyStation[];
  hasPositions: boolean;
  note: string;
}

export function surveyFromTable(t: Table, depthScale?: number): ParsedSurvey {
  const mi = findColumn(t.headers, ['MD', 'DEPTH', 'MEASUREDDEPTH', 'DEPT']);
  const ii = findColumn(t.headers, COLS.inc);
  const ai = findColumn(t.headers, COLS.azi);
  const ti = findColumn(t.headers, ['TVD']);
  const nsi = findColumn(t.headers, ['NS', 'NORTH', 'DY', 'NSOFFSET', 'N', 'Y']);
  const ewi = findColumn(t.headers, ['EW', 'EAST', 'DX', 'EWOFFSET', 'E', 'X']);
  if (mi < 0) throw new Error('Survey needs an MD column.');
  const hasAngles = ii >= 0 && ai >= 0;
  const hasPositions = ti >= 0 && nsi >= 0 && ewi >= 0;
  if (!hasAngles && !hasPositions) throw new Error('Survey needs INC + AZI columns, or TVD + NS + EW columns.');
  const k = depthScaleFor(t.headers[mi], depthScale);
  const stations: SurveyStation[] = t.rows
    .map((r) => ({
      md: num(r[mi]) * k,
      inc: hasAngles ? num(r[ii]) : NaN,
      azi: hasAngles ? num(r[ai]) : NaN,
      tvd: ti >= 0 ? num(r[ti]) * k : NaN,
      ns: nsi >= 0 ? num(r[nsi]) * k : NaN,
      ew: ewi >= 0 ? num(r[ewi]) * k : NaN,
    }))
    .filter((s) => Number.isFinite(s.md))
    .sort((a, b) => a.md - b.md);
  return { stations, hasPositions, note: t.comments.join(' ') };
}

// --------------------------------------------------------------------------- production
export function productionFromTable(t: Table, source: string, wellFilter?: string, provenance: Provenance = 'user'): ProductionSeries {
  const c = (names: string[]) => findColumn(t.headers, names);
  const di = c(COLS.date);
  const yi = c(COLS.year);
  const mo = c(COLS.month);
  const wi = c(['NPDWELLBORENAME', 'WELL', 'WELLBORENAME', 'WELLNAME', 'PRFINFORMATIONCARRIER', 'FIELD']);
  const oi = c(COLS.oil);
  const gi = c(COLS.gas);
  const wti = c(COLS.water);
  const wii = c(COLS.waterInj);
  const hi = c(['ONSTREAMHRS', 'HOURS', 'ONSTREAM', 'UPTIME']);
  const pi = c(['AVGDOWNHOLEPRESSURE', 'BHP', 'PBH']);
  const ti = c(['AVGDOWNHOLETEMPERATURE', 'BHT', 'TEMPERATURE']);
  const whi = c(['AVGWHPP', 'WHP', 'THP']);
  const chi = c(['AVGCHOKESIZEP', 'CHOKE']);
  if (di < 0 && (yi < 0 || mo < 0)) throw new Error('Production file needs a DATE column (or YEAR + MONTH).');
  if (oi < 0 && gi < 0 && wti < 0 && wii < 0) throw new Error('Production file needs oil, gas, water or injection columns.');
  // FactPages-style volume columns are reported in million / billion Sm3
  const unitScale = (i: number) => (i < 0 ? 1 : /bill/i.test(t.headers[i]) ? 1e9 : /mill/i.test(t.headers[i]) ? 1e6 : 1);
  const [so, sg, sw, swi] = [unitScale(oi), unitScale(gi), unitScale(wti), unitScale(wii)];
  let pickWell: string | null = null;
  if (wi >= 0) {
    const names = t.rows.map((r) => r[wi]).filter((n) => n && n !== 'Wellbore name');
    pickWell = chooseWell(names, wellFilter) ?? (wellFilter ? null : names[0] ?? null);
    if (!pickWell) throw wellError(names, wellFilter);
  }
  const records: ProductionRecord[] = [];
  const wellName = pickWell ?? wellFilter ?? '';
  for (const r of t.rows) {
    if (pickWell !== null && r[wi] !== pickWell) continue;
    let tm = NaN;
    if (di >= 0) tm = parseDate(r[di]);
    else tm = Date.UTC(num(r[yi]), num(r[mo]) - 1, 1);
    if (!Number.isFinite(tm)) continue;
    const v = (i: number) => (i >= 0 ? num(r[i]) : NaN);
    records.push({
      t: tm,
      hours: v(hi),
      oil: (v(oi) || 0) * so,
      gas: (v(gi) || 0) * sg,
      water: (v(wti) || 0) * sw,
      waterInj: (v(wii) || 0) * swi,
      bhp: v(pi) > 0 ? v(pi) : undefined,
      bht: v(ti) > 0 ? v(ti) : undefined,
      whp: v(whi) > 0 ? v(whi) : undefined,
      choke: v(chi) > 0 ? v(chi) : undefined,
    });
  }
  records.sort((a, b) => a.t - b.t);
  const daily = records.length > 2 && median(records.slice(1).map((r, i) => r.t - records[i].t)) < 5 * 86400e3;
  return { wellName, period: daily ? 'daily' : 'monthly', records, source, provenance };
}

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function parseDate(s: string): number {
  if (!s) return NaN;
  // Excel serial day numbers (dates read from .xlsx cells)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const v = Number(s);
    if (v > 20000 && v < 80000) return Math.round((Math.floor(v) - 25569) * 86400e3);
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/.exec(s); // dd/mm/yyyy (European, as used by Volve)
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = /^(\d{4})[\/.](\d{1,2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** Aggregate daily records into calendar months. */
export function toMonthly(series: ProductionSeries): ProductionRecord[] {
  if (series.period === 'monthly') return series.records;
  const map = new Map<number, ProductionRecord & { n: number; bhpN: number; bhtN: number }>();
  for (const r of series.records) {
    const d = new Date(r.t);
    const k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    let m = map.get(k);
    if (!m) {
      m = { t: k, hours: 0, oil: 0, gas: 0, water: 0, waterInj: 0, n: 0, bhp: 0, bht: 0, bhpN: 0, bhtN: 0 };
      map.set(k, m);
    }
    m.hours += r.hours || 0;
    m.oil += r.oil;
    m.gas += r.gas;
    m.water += r.water;
    m.waterInj += r.waterInj;
    if (r.bhp) {
      m.bhp! += r.bhp;
      m.bhpN++;
    }
    if (r.bht) {
      m.bht! += r.bht;
      m.bhtN++;
    }
    m.n++;
  }
  return [...map.values()]
    .sort((a, b) => a.t - b.t)
    .map((m) => ({
      t: m.t,
      hours: m.hours,
      oil: m.oil,
      gas: m.gas,
      water: m.water,
      waterInj: m.waterInj,
      bhp: m.bhpN ? m.bhp! / m.bhpN : undefined,
      bht: m.bhtN ? m.bht! / m.bhtN : undefined,
    }));
}
