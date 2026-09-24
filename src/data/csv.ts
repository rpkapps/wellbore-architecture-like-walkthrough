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

// --------------------------------------------------------------------------- log CSV
export function logsFromTable(t: Table, source: string, wellName: string, provenance: Provenance = 'user'): LogSet {
  const di = findColumn(t.headers, ['DEPTH', 'MD', 'DEPT', 'MDM', 'MEASUREDDEPTH', 'DEPTHM']);
  if (di < 0) throw new Error('No depth column (DEPTH / MD / DEPT) found in CSV.');
  const wi = findColumn(t.headers, ['WELL', 'WELLNAME', 'UWI']);
  let rows = t.rows;
  if (wi >= 0) {
    const names = [...new Set(rows.map((r) => r[wi]))];
    if (names.length > 1) {
      const pick = names.find((n) => n === wellName) ?? names[0];
      rows = rows.filter((r) => r[wi] === pick);
      wellName = pick;
    } else if (names[0]) wellName = names[0];
  }
  const feet = /ft|feet/i.test(unitFromHeader(t.headers[di]));
  const depth = new Float64Array(rows.map((r) => num(r[di]) * (feet ? 0.3048 : 1)));
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
export function topsFromTable(t: Table, source: string, wellFilter?: string, provenance: Provenance = 'user'): Top[] {
  let ni = findColumn(t.headers, ['PICKS', 'PICK', 'FORMATION', 'NAME', 'TOP', 'SURFACE', 'HORIZON', 'ZONE', 'MARKER']);
  let mi = findColumn(t.headers, ['MD', 'DEPTH', 'TOPMD', 'MDTOP', 'TOPDEPTH', 'MEASUREDDEPTH']);
  const ti = findColumn(t.headers, ['TVD', 'TVDRKB', 'TVDDF']);
  const wi = findColumn(t.headers, ['WELL', 'WELLNAME', 'WELLBORE']);
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
  const out: Top[] = [];
  for (const r of t.rows) {
    if (wi >= 0 && wellFilter && !sameWell(r[wi], wellFilter)) continue;
    const md = num(r[mi]);
    if (!Number.isFinite(md) || !r[ni]) continue;
    out.push({
      name: r[ni],
      formationId: formationIdForPick(r[ni]),
      md,
      tvd: ti >= 0 ? num(r[ti]) : undefined,
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

export function surveyFromTable(t: Table): ParsedSurvey {
  const mi = findColumn(t.headers, ['MD', 'DEPTH', 'MEASUREDDEPTH', 'DEPT']);
  const ii = findColumn(t.headers, ['INC', 'INCL', 'INCLINATION', 'DEVI', 'ANGLE']);
  const ai = findColumn(t.headers, ['AZI', 'AZIM', 'AZIMUTH', 'AZ', 'HAZI', 'DIRECTION']);
  const ti = findColumn(t.headers, ['TVD']);
  const nsi = findColumn(t.headers, ['NS', 'NORTH', 'DY', 'NSOFFSET', 'N', 'Y']);
  const ewi = findColumn(t.headers, ['EW', 'EAST', 'DX', 'EWOFFSET', 'E', 'X']);
  if (mi < 0) throw new Error('Survey needs an MD column.');
  const hasAngles = ii >= 0 && ai >= 0;
  const hasPositions = ti >= 0 && nsi >= 0 && ewi >= 0;
  if (!hasAngles && !hasPositions) throw new Error('Survey needs INC + AZI columns, or TVD + NS + EW columns.');
  const stations: SurveyStation[] = t.rows
    .map((r) => ({
      md: num(r[mi]),
      inc: hasAngles ? num(r[ii]) : NaN,
      azi: hasAngles ? num(r[ai]) : NaN,
      tvd: ti >= 0 ? num(r[ti]) : NaN,
      ns: nsi >= 0 ? num(r[nsi]) : NaN,
      ew: ewi >= 0 ? num(r[ewi]) : NaN,
    }))
    .filter((s) => Number.isFinite(s.md))
    .sort((a, b) => a.md - b.md);
  return { stations, hasPositions, note: t.comments.join(' ') };
}

// --------------------------------------------------------------------------- production
export function productionFromTable(t: Table, source: string, wellFilter?: string, provenance: Provenance = 'user'): ProductionSeries {
  const c = (names: string[]) => findColumn(t.headers, names);
  const di = c(['DATEPRD', 'DATE', 'DAY', 'TIME', 'PERIOD']);
  const yi = c(['YEAR']);
  const mo = c(['MONTH']);
  const wi = c(['NPDWELLBORENAME', 'WELL', 'WELLBORENAME', 'WELLNAME']);
  const oi = c(['BOREOILVOL', 'OILSM3', 'OIL', 'QO', 'OILRATE', 'OILVOL']);
  const gi = c(['BOREGASVOL', 'GASSM3', 'GAS', 'QG', 'GASRATE', 'GASVOL']);
  const wti = c(['BOREWATVOL', 'WATERSM3', 'WATER', 'QW', 'WATERRATE', 'WATVOL']);
  const wii = c(['BOREWIVOL', 'WATERINJSM3', 'WI', 'WATERINJ', 'INJECTION']);
  const hi = c(['ONSTREAMHRS', 'HOURS', 'ONSTREAM', 'UPTIME']);
  const pi = c(['AVGDOWNHOLEPRESSURE', 'BHP', 'PBH']);
  const ti = c(['AVGDOWNHOLETEMPERATURE', 'BHT', 'TEMPERATURE']);
  const whi = c(['AVGWHPP', 'WHP', 'THP']);
  const chi = c(['AVGCHOKESIZEP', 'CHOKE']);
  if (di < 0 && (yi < 0 || mo < 0)) throw new Error('Production file needs a DATE column (or YEAR + MONTH).');
  if (oi < 0 && gi < 0 && wti < 0 && wii < 0) throw new Error('Production file needs oil, gas, water or injection columns.');
  const records: ProductionRecord[] = [];
  let wellName = wellFilter ?? '';
  for (const r of t.rows) {
    if (wi >= 0 && wellFilter && !sameWell(r[wi], wellFilter)) continue;
    if (wi >= 0 && !wellName) wellName = r[wi];
    let tm = NaN;
    if (di >= 0) tm = parseDate(r[di]);
    else tm = Date.UTC(num(r[yi]), num(r[mo]) - 1, 1);
    if (!Number.isFinite(tm)) continue;
    const v = (i: number) => (i >= 0 ? num(r[i]) : NaN);
    records.push({
      t: tm,
      hours: v(hi),
      oil: v(oi) || 0,
      gas: v(gi) || 0,
      water: v(wti) || 0,
      waterInj: v(wii) || 0,
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
