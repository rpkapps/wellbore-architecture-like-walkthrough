import { column, isNumeric, key, pick, rowCount, type Batch, type BatchKind, type Column, type IndexType } from './batch';
import { converter, dimension } from './units';

/**
 * What the worker hands the app: batches resolved into the data BoreWalk
 * draws. Depths are metres, times epoch milliseconds, angles degrees.
 */
export interface LogChannel {
  name: string;
  unit: string;
  description?: string;
  values: Float32Array;
}
export interface LogFrame {
  kind: 'log';
  well?: string;
  index: IndexType;
  key: Float64Array;
  channels: LogChannel[];
  /** the bin width the rows were made at (time to depth, resample), when a step set one */
  step?: number;
}
export interface SurveyFrame {
  kind: 'survey';
  well?: string;
  md: Float64Array;
  inc: Float64Array;
  azi: Float64Array;
  tvd?: Float64Array;
  ns?: Float64Array;
  ew?: Float64Array;
}
export interface TopsFrame {
  kind: 'tops';
  well?: string;
  names: string[];
  md: Float64Array;
  tvd?: Float64Array;
}
export interface ProductionFrame {
  kind: 'production';
  well?: string;
  t: Float64Array;
  oil?: Float64Array;
  gas?: Float64Array;
  water?: Float64Array;
  waterInj?: Float64Array;
  hours?: Float64Array;
  bhp?: Float64Array;
  whp?: Float64Array;
  bht?: Float64Array;
  choke?: Float64Array;
}
export type Frame = LogFrame | SurveyFrame | TopsFrame | ProductionFrame;

// ------------------------------------------------------------------ recognising columns

export const ROLE_NAMES = {
  time: ['TIME', 'DATETIME', 'TIMESTAMP', 'DATE_TIME', 'TS', 'INDEX_TIME', 'TIME_UTC', 'DTIM', 'TIME_STAMP', 'EVENTTIME', 'T'],
  depth: ['DEPTH', 'MD', 'DEPT', 'MDM', 'MEASUREDDEPTH', 'DEPTHM', 'DEPTHMD', 'TDEP', 'INDEX', 'DEPTH_MD'],
  well: ['WELL', 'WELLNAME', 'UWI', 'WELLBORE', 'WLBNAME', 'NPDWELLBORENAME', 'WELLBORENAME', 'WELL_ID', 'WELLID', 'UIDWELL', 'WELLBOREID'],
  inc: ['INC', 'INCL', 'INCLINATION', 'DEVI', 'DEVIATION', 'ANGLE'],
  azi: ['AZI', 'AZIM', 'AZIMUTH', 'AZ', 'HAZI', 'DIRECTION', 'AZITRUE'],
  tvd: ['TVD', 'TVDM', 'TRUEVERTICALDEPTH'],
  ns: ['NS', 'NORTH', 'DISPNS', 'NSOFFSET', 'N'],
  ew: ['EW', 'EAST', 'DISPEW', 'EWOFFSET', 'E'],
  topName: ['LSUNAME', 'PICKS', 'PICK', 'FORMATION', 'NAME', 'TOP', 'SURFACE', 'HORIZON', 'ZONE', 'MARKER', 'MARKERNAME'],
  date: ['DATEPRD', 'DATE', 'DAY', 'PERIOD', 'TIME', 'DATETIME'],
  oil: ['BOREOILVOL', 'OILSM3', 'OIL', 'QO', 'OILRATE', 'OILVOL'],
  gas: ['BOREGASVOL', 'GASSM3', 'GAS', 'QG', 'GASRATE', 'GASVOL'],
  water: ['BOREWATVOL', 'WATERSM3', 'WATER', 'QW', 'WATERRATE', 'WATVOL'],
  waterInj: ['BOREWIVOL', 'WATERINJSM3', 'WATERINJ', 'WI', 'INJECTION'],
  hours: ['ONSTREAMHRS', 'HOURS', 'ONSTREAM', 'UPTIME'],
  bhp: ['AVGDOWNHOLEPRESSURE', 'BHP', 'PBH'],
  bht: ['AVGDOWNHOLETEMPERATURE', 'BHT'],
  whp: ['AVGWHPP', 'WHP', 'THP'],
  choke: ['AVGCHOKESIZEP', 'CHOKE'],
  /** bit and hole depth on time-indexed rig data (WITS / WITSML mnemonics first) */
  bitDepth: ['DBTM', 'BITDEP', 'BDEP', 'BIT_DEPTH', 'BITDEPTH', 'DEPTBIT', 'DEPTH_BIT', 'DMEA_BIT', 'BITMD', 'BIT.DEPTH'],
  holeDepth: ['DMEA', 'HDTH', 'HOLEDEPTH', 'HOLE_DEPTH', 'DEPTH_HOLE', 'TDEPTH', 'HOLEMD'],
};
export type RoleName = keyof typeof ROLE_NAMES;

/** The column playing a role, by name (exact key first, then prefix). */
export function findRole(b: Batch, role: RoleName, filter: (c: Column) => boolean = () => true): Column | undefined {
  const names = ROLE_NAMES[role];
  const cols = b.columns.filter(filter);
  for (const n of names) {
    const c = cols.find((x) => key(x.name) === key(n));
    if (c) return c;
  }
  for (const n of names) {
    if (key(n).length < 3) continue;
    const c = cols.find((x) => key(x.name).startsWith(key(n)));
    if (c) return c;
  }
  return undefined;
}

const isTime = (c: Column) => isNumeric(c) && (c.unit === 'ms' || c.description === 'time');
const num = (c: Column): boolean => isNumeric(c);
const text = (c: Column): boolean => !isNumeric(c);

/**
 * Fill in what a batch is when its format did not say: survey stations,
 * production, tops, or channels indexed by time or depth. Mirrors the rules
 * the file importer uses, so a CSV reads the same either way.
 */
export function detect(input: Batch): Batch {
  let b = input;
  if (b.kind && (b.kind !== 'channels' || b.index)) return withWell(b);
  const has = (r: RoleName, f = num) => !!findRole(b, r, f);
  let time = b.columns.find(isTime) ?? findRole(b, 'time', isTime);
  if (!time) {
    // a numeric "time" column holding epoch seconds or milliseconds
    const t = findRole(b, 'time', num);
    const x = t && (t.values as Float64Array).find(Number.isFinite);
    if (t && x !== undefined && x > 1e8) {
      const k = x > 1e14 ? 1e-3 : x > 1e11 ? 1 : 1000;
      time = { ...t, unit: 'ms', description: 'time', values: k === 1 ? t.values : (t.values as Float64Array).map((v) => v * k) };
      b = { ...b, columns: b.columns.map((c) => (c === t ? time! : c)) };
    }
  }
  let kind: BatchKind | undefined = b.kind;
  if (!kind) {
    if ((has('date', isTime) || has('date', text)) && (has('oil') || has('gas') || has('water') || has('waterInj'))) kind = 'production';
    else if (has('inc') && has('azi') && has('depth')) kind = 'survey';
    else if (has('topName', text) && has('depth')) kind = 'tops';
    else kind = 'channels';
  }
  let index = b.index;
  if (kind === 'channels' && !index) {
    if (time) index = { column: time.name, type: 'time' };
    else {
      const d = findRole(b, 'depth', num);
      if (d) index = { column: d.name, type: 'depth' };
    }
  }
  return withWell({ ...b, kind, index });
}

function withWell(b: Batch): Batch {
  if (b.well || b.wellColumn) return b;
  const w = findRole(b, 'well', text);
  return w ? { ...b, wellColumn: w.name } : b;
}

// ------------------------------------------------------------------ batches to frames

const toMetres = (c: Column | undefined): Float64Array | undefined => {
  if (!c || !isNumeric(c)) return undefined;
  const v = c.values as Float64Array;
  const f = c.unit && dimension(c.unit) === 'length' ? converter(c.unit, 'm') : null;
  return f ? v.map(f) : v.slice();
};
const toDegrees = (c: Column | undefined): Float64Array | undefined => {
  if (!c || !isNumeric(c)) return undefined;
  const v = c.values as Float64Array;
  const f = c.unit && dimension(c.unit) === 'angle' ? converter(c.unit, 'deg') : null;
  return f ? v.map(f) : v.slice();
};

/**
 * Frames for the app from resolved batches: one per kind and well. Rows
 * without an index (or MD) are dropped; a batch that cannot be resolved
 * yields nothing and a reason.
 */
export function assemble(input: Batch): { frames: Frame[]; problem?: string } {
  const b = detect(input);
  if (!rowCount(b)) return { frames: [] };
  // one frame per well named in the rows
  if (b.wellColumn) {
    const wc = column(b, b.wellColumn);
    if (wc && !isNumeric(wc)) {
      const names = [...new Set(wc.values as string[])];
      if (names.length > 1 || names[0]) {
        const frames: Frame[] = [];
        let problem: string | undefined;
        for (const n of names) {
          const keep = new Uint8Array(wc.values.length);
          (wc.values as string[]).forEach((v, i) => (keep[i] = +(v === n)));
          const r = assemble({ ...pick(b, keep), wellColumn: undefined, well: n || b.well });
          frames.push(...r.frames);
          problem ??= r.problem;
        }
        return { frames, problem };
      }
    }
  }
  const well = b.well;
  switch (b.kind) {
    case 'survey': {
      const md = toMetres(findRole(b, 'depth', num));
      const inc = toDegrees(findRole(b, 'inc', num));
      const azi = toDegrees(findRole(b, 'azi', num));
      if (!md || !inc || !azi) return { frames: [], problem: 'Survey rows need MD, inclination and azimuth.' };
      return { frames: [{ kind: 'survey', well, md, inc, azi, tvd: toMetres(findRole(b, 'tvd', num)), ns: toMetres(findRole(b, 'ns', num)), ew: toMetres(findRole(b, 'ew', num)) }] };
    }
    case 'tops': {
      const nameCol = findRole(b, 'topName', text);
      const md = toMetres(findRole(b, 'depth', num));
      if (!nameCol || !md) return { frames: [], problem: 'Tops need a name and an MD column.' };
      return { frames: [{ kind: 'tops', well, names: nameCol.values as string[], md, tvd: toMetres(findRole(b, 'tvd', num)) }] };
    }
    case 'production': {
      const dc = findRole(b, 'date', isTime);
      if (!dc) return { frames: [], problem: 'Production rows need a date or time column.' };
      const g = (r: RoleName) => {
        const c = findRole(b, r, num);
        return c && isNumeric(c) && c !== dc ? (c.values as Float64Array).slice() : undefined;
      };
      return {
        frames: [
          {
            kind: 'production',
            well,
            t: (dc.values as Float64Array).slice(),
            oil: g('oil'),
            gas: g('gas'),
            water: g('water'),
            waterInj: g('waterInj'),
            hours: g('hours'),
            bhp: g('bhp'),
            whp: g('whp'),
            bht: g('bht'),
            choke: g('choke'),
          },
        ],
      };
    }
    default: {
      if (!b.index) return { frames: [], problem: 'Found no time or depth column to index the channels by. Map one in the connector.' };
      const ic = column(b, b.index.column);
      if (!ic || !isNumeric(ic)) return { frames: [], problem: `Index column "${b.index.column}" is missing or not numeric.` };
      const k = b.index.type === 'depth' ? toMetres(ic)! : ic.values;
      const channels: LogChannel[] = [];
      for (const c of b.columns) {
        if (c === ic || !isNumeric(c) || c.name === b.wellColumn) continue;
        channels.push({ name: c.name.replace(/\s*[([].*?[)\]]\s*$/, '').trim() || c.name, unit: c.unit ?? '', description: c.description, values: Float32Array.from(c.values) });
      }
      // rows must have an index; keep them in index order
      let sorted = true;
      let valid = true;
      for (let i = 0; i < k.length; i++) {
        if (!Number.isFinite(k[i])) valid = false;
        else if (i && k[i] < k[i - 1]) sorted = false;
      }
      const step = b.meta?.step ? Number(b.meta.step) || undefined : undefined;
      if (valid && sorted) return { frames: [{ kind: 'log', well, index: b.index.type, key: k === ic.values ? k.slice() : k, channels, step }] };
      const order = [...k.keys()].filter((i) => Number.isFinite(k[i])).sort((x, y) => k[x] - k[y]);
      return {
        frames: [
          {
            kind: 'log',
            well,
            index: b.index.type,
            step,
            key: Float64Array.from(order, (i) => k[i]),
            channels: channels.map((c) => ({ ...c, values: Float32Array.from(order, (i) => c.values[i]) })),
          },
        ],
      };
    }
  }
}

/** The buffers of a frame, to transfer to the main thread instead of copying. */
export function transferables(f: Frame): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a?: Float64Array | Float32Array) => a && a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && out.add(a.buffer);
  if (f.kind === 'log') {
    add(f.key);
    f.channels.forEach((c) => add(c.values));
  } else if (f.kind === 'survey') [f.md, f.inc, f.azi, f.tvd, f.ns, f.ew].forEach(add);
  else if (f.kind === 'tops') [f.md, f.tvd].forEach(add);
  else [f.t, f.oil, f.gas, f.water, f.waterInj, f.hours, f.bhp, f.whp, f.bht, f.choke].forEach(add);
  return [...out];
}

/** Number of values in a frame (for the rate shown per source). */
export function sampleCount(f: Frame): number {
  if (f.kind === 'log') return f.key.length * Math.max(1, f.channels.length);
  if (f.kind === 'tops') return f.names.length;
  if (f.kind === 'survey') return f.md.length;
  return f.t.length;
}
