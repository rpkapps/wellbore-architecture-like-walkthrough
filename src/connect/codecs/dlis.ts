import { z } from 'zod';
import type { Batch, Column, IndexType } from '../batch';
import { defineCodec, type PluginContext } from '../plugin';
import { whole } from './files';

/**
 * DLIS (API RP66 version 1) reader. One pass over the file: the storage unit
 * label, visible records, logical record segments (reassembled, trailers
 * stripped, encrypted records skipped), EFLR sets (template defaults,
 * invariant and absent attributes) and FDATA frames, decoded straight into
 * growing Float64Arrays per channel.
 *
 * Choices where the standard leaves room:
 * - the index is the frame's first channel when it has an INDEX-TYPE; without
 *   one, rows are indexed by a FRAMENO column (typed 'depth', as a plain order);
 * - an index is 'time' for a TIME index type, a DTIME channel or a time unit,
 *   'depth' otherwise. Only DTIME samples are absolute, so only they become
 *   epoch ms (unit 'ms'); relative times (s, ms since the start) keep their
 *   values and unit;
 * - array channels (DIMENSION > 1: images, waveforms) are skipped and listed
 *   in `meta.skipped`; validated floats (FSING1/2, FDOUB1/2) read as their
 *   value, complex ones as their real part, text and references as NaN;
 * - -999.25 reads as NaN; checksums are stripped, not verified.
 */

/** Representation codes (RP66 v1 appendix B). */
export const RC = {
  FSHORT: 1,
  FSINGL: 2,
  FSING1: 3,
  FSING2: 4,
  ISINGL: 5,
  VSINGL: 6,
  FDOUBL: 7,
  FDOUB1: 8,
  FDOUB2: 9,
  CSINGL: 10,
  CDOUBL: 11,
  SSHORT: 12,
  SNORM: 13,
  SLONG: 14,
  USHORT: 15,
  UNORM: 16,
  ULONG: 17,
  UVARI: 18,
  IDENT: 19,
  ASCII: 20,
  DTIME: 21,
  ORIGIN: 22,
  OBNAME: 23,
  OBJREF: 24,
  ATTREF: 25,
  STATUS: 26,
  UNITS: 27,
} as const;

/** Bytes per value by representation code; 0 = variable length. */
const SIZE = [0, 2, 4, 8, 12, 4, 4, 8, 16, 24, 8, 16, 1, 2, 4, 1, 2, 4, 0, 0, 0, 8, 0, 0, 0, 0, 1, 0];

/** The usual absent-value marker of logging software (RP66 itself has none). */
const ABSENT = -999.25;

export interface ObName {
  origin: number;
  copy: number;
  name: string;
}
export interface ObjRef {
  type: string;
  name: ObName;
  label?: string;
}
export type Value = number | string | ObName | ObjRef;

/** Reads RP66 values from bytes [pos, end). */
export class Cursor {
  readonly dv: DataView;
  constructor(
    readonly b: Uint8Array,
    public pos = 0,
    public end = b.length,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  need(n: number) {
    if (this.pos + n > this.end) throw new RangeError('DLIS: a record ends inside a value.');
  }
  ushort(): number {
    this.need(1);
    return this.b[this.pos++];
  }
  uvari(): number {
    this.need(1);
    const b = this.b;
    const p = this.pos;
    const x = b[p];
    if (x < 0x80) {
      this.pos = p + 1;
      return x;
    }
    if (x < 0xc0) {
      this.need(2);
      this.pos = p + 2;
      return ((x & 0x3f) << 8) | b[p + 1];
    }
    this.need(4);
    this.pos = p + 4;
    return (x & 0x3f) * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
  }
  chars(n: number): string {
    this.need(n);
    let s = '';
    const b = this.b;
    for (let i = this.pos, e = this.pos + n; i < e; i++) s += String.fromCharCode(b[i]);
    this.pos += n;
    return s;
  }
  ident(): string {
    return this.chars(this.ushort());
  }
  ascii(): string {
    return this.chars(this.uvari());
  }
  obname(): ObName {
    const origin = this.uvari();
    const copy = this.ushort();
    return { origin, copy, name: this.ident() };
  }

  /** A sample as a number: floats, integers, DTIME as epoch ms, STATUS as 0/1; text and references read as NaN. */
  num(rc: number): number {
    const size = SIZE[rc];
    if (size) {
      this.need(size);
      const p = this.pos;
      this.pos = p + size;
      return fixed(this.dv, this.b, p, rc);
    }
    this.skip(rc);
    return rc === RC.UVARI || rc === RC.ORIGIN ? this.lastUvari : NaN;
  }
  private lastUvari = NaN;

  /** Moves past one value. */
  skip(rc: number) {
    const size = SIZE[rc];
    if (size) {
      this.need(size);
      this.pos += size;
      return;
    }
    switch (rc) {
      case RC.UVARI:
      case RC.ORIGIN:
        this.lastUvari = this.uvari();
        return;
      case RC.IDENT:
      case RC.UNITS:
        this.need(1);
        this.need(1 + this.b[this.pos]);
        this.pos += 1 + this.b[this.pos];
        return;
      case RC.ASCII: {
        const n = this.uvari();
        this.need(n);
        this.pos += n;
        return;
      }
      case RC.OBNAME:
        this.uvari();
        this.pos++;
        this.skip(RC.IDENT);
        return;
      case RC.OBJREF:
        this.skip(RC.IDENT);
        this.skip(RC.OBNAME);
        return;
      case RC.ATTREF:
        this.skip(RC.IDENT);
        this.skip(RC.OBNAME);
        this.skip(RC.IDENT);
        return;
      default:
        throw new Error(`DLIS: unknown representation code ${rc}.`);
    }
  }

  /** Any value, for EFLR attributes (validated floats read as their value, complex numbers as their real part). */
  value(rc: number): Value {
    switch (rc) {
      case RC.UVARI:
      case RC.ORIGIN:
        return this.uvari();
      case RC.IDENT:
      case RC.UNITS:
        return this.ident();
      case RC.ASCII:
        return this.ascii();
      case RC.OBNAME:
        return this.obname();
      case RC.OBJREF:
        return { type: this.ident(), name: this.obname() };
      case RC.ATTREF:
        return { type: this.ident(), name: this.obname(), label: this.ident() };
      default:
        if (!SIZE[rc]) throw new Error(`DLIS: unknown representation code ${rc}.`);
        return this.num(rc);
    }
  }
}

/** A fixed-size value at `p`. */
function fixed(dv: DataView, b: Uint8Array, p: number, rc: number): number {
  switch (rc) {
    case RC.FSHORT:
      return fshort(dv.getUint16(p));
    case RC.FSINGL:
    case RC.FSING1:
    case RC.FSING2:
    case RC.CSINGL:
      return dv.getFloat32(p);
    case RC.ISINGL:
      return ibm32(dv.getUint32(p));
    case RC.VSINGL:
      return vax32(b, p);
    case RC.FDOUBL:
    case RC.FDOUB1:
    case RC.FDOUB2:
    case RC.CDOUBL:
      return dv.getFloat64(p);
    case RC.SSHORT:
      return dv.getInt8(p);
    case RC.SNORM:
      return dv.getInt16(p);
    case RC.SLONG:
      return dv.getInt32(p);
    case RC.USHORT:
    case RC.STATUS:
      return b[p];
    case RC.UNORM:
      return dv.getUint16(p);
    case RC.ULONG:
      return dv.getUint32(p);
    case RC.DTIME:
      return dtime(dv, b, p);
    default:
      return NaN;
  }
}

/** FSHORT: 12-bit two's-complement fraction and 4-bit exponent. */
export function fshort(w: number): number {
  let m = w >> 4;
  if (m & 0x800) m -= 0x1000;
  return (m / 2048) * 2 ** (w & 15);
}

/** ISINGL: IBM System/360 single (sign, base-16 exponent excess 64, 24-bit fraction). */
export function ibm32(w: number): number {
  const f = w & 0xffffff;
  const v = (f / 0x1000000) * 16 ** (((w >>> 24) & 0x7f) - 64);
  return w >>> 31 ? -v : v;
}

/** VSINGL: VAX F-float, stored as two little-endian 16-bit words (exponent excess 128, hidden bit 0.1f). */
export function vax32(b: Uint8Array, p: number): number {
  const w = ((b[p + 1] << 24) | (b[p] << 16) | (b[p + 3] << 8) | b[p + 2]) >>> 0;
  const e = (w >>> 23) & 0xff;
  if (e === 0) return w >>> 31 ? NaN : 0; // sign with zero exponent is VAX's reserved operand
  const v = (0.5 + (w & 0x7fffff) / 0x1000000) * 2 ** (e - 128);
  return w >>> 31 ? -v : v;
}

/** DTIME as epoch ms. The time-zone nibble (local standard, local daylight, GMT) is ignored: times read as UTC. */
function dtime(dv: DataView, b: Uint8Array, p: number): number {
  return Date.UTC(1900 + b[p], (b[p + 1] & 15) - 1, b[p + 2], b[p + 3], b[p + 4], b[p + 5], dv.getUint16(p + 6));
}

// ------------------------------------------------------------------ EFLRs

export interface Attr {
  count: number;
  rc: number;
  units: string;
  /** null = absent */
  value: Value[] | null;
}
export interface DlisObject {
  name: ObName;
  attrs: Map<string, Attr>;
}
export interface DlisSet {
  type: string;
  name: string;
  objects: DlisObject[];
}

const ROLE_ABSATR = 0;
const ROLE_INVATR = 2;
const ROLE_OBJECT = 3;

/** An explicitly formatted logical record: a set, its template, then objects whose attributes follow the template. */
export function parseEflr(c: Cursor): DlisSet {
  const d = c.ushort();
  if (d >> 5 < 5) throw new Error('DLIS: an EFLR does not start with a set component.');
  const type = d & 0x10 ? c.ident() : '';
  const name = d & 0x08 ? c.ident() : '';
  const template: { label: string; attr: Attr; invariant: boolean }[] = [];
  while (c.pos < c.end && c.b[c.pos] >> 5 !== ROLE_OBJECT) {
    const a = c.ushort();
    const label = a & 0x10 ? c.ident() : '';
    const attr = readAttr(c, a, { count: 1, rc: RC.IDENT, units: '', value: null });
    template.push({ label, attr, invariant: a >> 5 === ROLE_INVATR });
  }
  const objects: DlisObject[] = [];
  while (c.pos < c.end) {
    const o = c.ushort();
    if (o >> 5 !== ROLE_OBJECT) throw new Error('DLIS: expected an object component.');
    const obj: DlisObject = { name: o & 0x10 ? c.obname() : { origin: 0, copy: 0, name: '' }, attrs: new Map() };
    for (const t of template) {
      if (t.invariant || c.pos >= c.end || c.b[c.pos] >> 5 === ROLE_OBJECT) {
        // invariant attributes are not repeated in objects; attributes left out take the template's defaults
        obj.attrs.set(t.label, t.attr);
        continue;
      }
      const a = c.ushort();
      if (a >> 5 === ROLE_ABSATR) continue;
      if (a & 0x10) c.ident();
      obj.attrs.set(t.label, readAttr(c, a, t.attr));
    }
    // attributes beyond the template: read past them
    while (c.pos < c.end && c.b[c.pos] >> 5 !== ROLE_OBJECT) {
      const a = c.ushort();
      if (a >> 5 === ROLE_ABSATR) continue;
      if (a & 0x10) c.ident();
      readAttr(c, a, { count: 1, rc: RC.IDENT, units: '', value: null });
    }
    objects.push(obj);
  }
  return { type, name, objects };
}

/** Characteristics C, R, U, V after the label; missing ones come from `def`. */
function readAttr(c: Cursor, a: number, def: Attr): Attr {
  const count = a & 0x08 ? c.uvari() : def.count;
  const rc = a & 0x04 ? c.ushort() : def.rc;
  const units = a & 0x02 ? c.ident() : def.units;
  let value = def.value;
  if (a & 0x01) {
    value = new Array(count);
    for (let i = 0; i < count; i++) value[i] = c.value(rc);
  }
  if (count === 0) value = null;
  return { count, rc, units, value };
}

const key = (n: ObName) => `${n.origin}:${n.copy}:${n.name}`;
const isObName = (v: Value): v is ObName => typeof v === 'object' && 'origin' in v;

function text(v: Value | undefined, rc = 0): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return rc === RC.DTIME ? new Date(v).toISOString().replace('.000Z', 'Z') : String(v);
  return isObName(v) ? v.name : v.name.name;
}

const attrText = (o: DlisObject | undefined, label: string) => {
  const a = o?.attrs.get(label);
  return a?.value ? a.value.map((v) => text(v, a.rc)).join(', ') : '';
};

// ------------------------------------------------------------------ logical files and frames

interface Channel {
  name: string;
  rc: number;
  /** elements per sample (product of DIMENSION) */
  count: number;
  units: string;
  long?: Value;
}

interface Frame {
  obj: DlisObject;
  name: string;
  channels: ObName[];
  indexType: string;
  wanted: boolean;
  /** decoding plan, made at the first FDATA */
  plan?: { rc: Int32Array; count: Int32Array; col: Int32Array; rowBytes: number } | null;
  /** columns of the plan, in output order (FRAMENO first when the frame has no index channel) */
  cols: { ch?: Channel; name: string }[];
  skipped: string[];
  data: Float64Array[];
  rows: number;
}

interface LogicalFile {
  header?: DlisObject;
  origin?: DlisObject;
  channels: Map<string, Channel>;
  frames: Frame[];
  byKey: Map<string, Frame>;
  longNames: Map<string, DlisObject>;
}

const newFile = (): LogicalFile => ({ channels: new Map(), frames: [], byKey: new Map(), longNames: new Map() });

const LENGTH_UNITS = /^(\d*\.?\d+ ?)?(m|cm|mm|km|dm|ft|f|in|yd|usft)$/i;
const TIME_UNITS = /^(\d*\.?\d+ ?)?(s|sec|ms|msec|us|ns|min|h|hr|hour|d|day)s?$/i;

/**
 * Depth unless the frame says time: an INDEX-TYPE naming TIME, a DTIME index
 * or a time unit. BOREHOLE-DEPTH, VERTICAL-DEPTH and the DRIFT types (lengths
 * along a path) are depth, as is a length unit or anything unknown.
 */
function indexKind(indexType: string, ch: Channel | undefined): IndexType {
  const t = indexType.toUpperCase();
  if (ch?.rc === RC.DTIME || t.includes('TIME')) return 'time';
  if (t.includes('DEPTH') || t.includes('DRIFT') || LENGTH_UNITS.test(ch?.units ?? '')) return 'depth';
  return TIME_UNITS.test(ch?.units ?? '') ? 'time' : 'depth';
}

/** The storage unit label's version field reads "V1." at byte 4. */
const isSul = (b: Uint8Array, p: number) => p + 9 <= b.length && b[p + 4] === 0x56 && b[p + 5] === 0x31 && b[p + 6] === 0x2e;
const isVr = (b: Uint8Array, p: number) => p + 4 <= b.length && b[p + 2] === 0xff && b[p + 3] === 0x01 && ((b[p] << 8) | b[p + 1]) >= 4;

/** Tape Image Format: 12-byte little-endian markers (type, previous, next) around the data. */
function isTif(b: Uint8Array, p = 0): boolean {
  if (p + 12 > b.length) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = dv.getUint32(p, true);
  const next = dv.getUint32(p + 8, true);
  return (type === 0 || type === 1) && dv.getUint32(p + 4, true) <= p && next > p + 12;
}

function untif(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: [number, number][] = [];
  let n = 0;
  for (let p = 0; p + 12 <= b.length; ) {
    const type = dv.getUint32(p, true);
    const next = Math.min(dv.getUint32(p + 8, true), b.length);
    if (next <= p) break;
    if (type === 0) {
      parts.push([p + 12, next]);
      n += next - p - 12;
    }
    p = next;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const [s, e] of parts) {
    out.set(b.subarray(s, e), o);
    o += e - s;
  }
  return out;
}

/** Every frame of every logical file in a DLIS file, one batch each. */
export function decodeDlis(bytes: Uint8Array, opts: { frame?: string } = {}, log: PluginContext['log'] = () => {}): Batch[] {
  const buf = isTif(bytes) && (isSul(bytes, 12) || isVr(bytes, 12)) ? untif(bytes) : bytes;
  let start: number;
  if (buf.length >= 80 && isSul(buf, 0)) start = 80;
  else if (isVr(buf, 0)) start = 0;
  else throw new Error('Not a DLIS (RP66 v1) file: no storage unit label or visible record at the start.');

  const want = (opts.frame ?? '').trim().toUpperCase();
  const files: LogicalFile[] = [];
  let lf = newFile();
  files.push(lf);
  const main = new Cursor(buf);
  const dv = main.dv;
  let encrypted = 0;
  let orphans = 0;

  // ---- FDATA
  let lastName = new Uint8Array(0);
  let lastFrame: Frame | undefined;

  const plan = (f: Frame) => {
    const rcs: number[] = [];
    const counts: number[] = [];
    const cols: number[] = [];
    let rowBytes = 0;
    f.cols = [];
    const noIndex = !f.indexType;
    if (noIndex) f.cols.push({ name: 'FRAMENO' });
    const used = new Set<string>(noIndex ? ['FRAMENO'] : []);
    for (const ref of f.channels) {
      const ch = lf.channels.get(key(ref));
      if (!ch || !ch.rc || ch.rc >= SIZE.length) {
        log(`DLIS frame ${f.name}: channel ${ref.name} is ${ch ? `in representation code ${ch.rc}` : 'not described'}, so its frames cannot be read.`, 'warn');
        return null;
      }
      rcs.push(ch.rc);
      counts.push(ch.count);
      rowBytes = rowBytes >= 0 && SIZE[ch.rc] ? rowBytes + SIZE[ch.rc] * ch.count : -1;
      if (ch.count !== 1) {
        // arrays (images, waveforms) do not fit a column: they are skipped, not cut to their first element
        cols.push(-1);
        f.skipped.push(ch.name);
        continue;
      }
      let name = ch.name;
      for (let k = 2; used.has(name); k++) name = `${ch.name}_${k}`;
      used.add(name);
      cols.push(f.cols.length);
      f.cols.push({ ch, name });
    }
    if (f.skipped.length) log(`DLIS frame ${f.name}: skipped array channels ${f.skipped.join(', ')}.`);
    if (!f.cols.length) return null;
    f.data = f.cols.map(() => new Float64Array(1024));
    return { rc: Int32Array.from(rcs), count: Int32Array.from(counts), col: Int32Array.from(cols), rowBytes };
  };

  const fdata = (c: Cursor) => {
    // the frame's OBNAME: compared as bytes with the previous record's before decoding it
    const n0 = c.pos;
    c.skip(RC.OBNAME);
    const n1 = c.pos;
    let f = lastFrame;
    let same = n1 - n0 === lastName.length;
    for (let i = 0; same && i < lastName.length; i++) same = c.b[n0 + i] === lastName[i];
    if (!same) {
      lastName = c.b.slice(n0, n1);
      c.pos = n0;
      f = lf.byKey.get(key(c.obname()));
      lastFrame = f;
    }
    if (!f || !f.wanted) return;
    if (f.plan === undefined) f.plan = plan(f);
    const p = f.plan;
    if (!p) return;
    const frameNo = c.uvari();
    if (p.rowBytes >= 0 && c.end - c.pos < p.rowBytes) return;
    let r = f.rows;
    if (r === f.data[0].length) {
      f.data = f.data.map((a) => {
        const g = new Float64Array(a.length * 2);
        g.set(a);
        return g;
      });
    }
    const data = f.data;
    let o = 0;
    if (!f.indexType) data[o++][r] = frameNo;
    const { rc, count, col } = p;
    try {
      for (let s = 0; s < rc.length; s++) {
        const k = col[s];
        if (k >= 0) {
          const v = c.num(rc[s]);
          data[k][r] = v === ABSENT ? NaN : v;
        } else if (SIZE[rc[s]]) {
          c.need(SIZE[rc[s]] * count[s]);
          c.pos += SIZE[rc[s]] * count[s];
        } else for (let e = 0; e < count[s]; e++) c.skip(rc[s]);
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return; // a frame cut short: drop the row
    }
    f.rows = ++r;
  };

  // ---- EFLRs
  const eflr = (c: Cursor) => {
    let set: DlisSet;
    try {
      set = parseEflr(c);
    } catch (e) {
      log(`DLIS: skipped an unreadable EFLR (${(e as Error).message})`, 'warn');
      return;
    }
    switch (set.type) {
      case 'FILE-HEADER':
        if (lf.header || lf.origin || lf.channels.size || lf.frames.length) files.push((lf = newFile()));
        lastFrame = undefined;
        lastName = new Uint8Array(0);
        lf.header = set.objects[0];
        break;
      case 'ORIGIN':
        lf.origin ??= set.objects[0];
        break;
      case 'CHANNEL':
        for (const o of set.objects) {
          const dims = o.attrs.get('DIMENSION')?.value;
          const count = dims ? dims.reduce<number>((m, d) => m * (typeof d === 'number' ? d : 1), 1) : 1;
          const rc = o.attrs.get('REPRESENTATION-CODE')?.value?.[0];
          lf.channels.set(key(o.name), {
            name: o.name.name,
            rc: typeof rc === 'number' ? rc : 0,
            count,
            units: attrText(o, 'UNITS'),
            long: o.attrs.get('LONG-NAME')?.value?.[0],
          });
        }
        break;
      case 'FRAME':
        for (const o of set.objects) {
          const f: Frame = {
            obj: o,
            name: o.name.name,
            channels: (o.attrs.get('CHANNELS')?.value ?? []).filter(isObName),
            indexType: attrText(o, 'INDEX-TYPE'),
            wanted: !want || o.name.name.trim().toUpperCase() === want,
            cols: [],
            skipped: [],
            data: [],
            rows: 0,
          };
          lf.frames.push(f);
          lf.byKey.set(key(o.name), f);
        }
        break;
      case 'LONG-NAME':
        for (const o of set.objects) lf.longNames.set(key(o.name), o);
        break;
    }
  };

  const record = (c: Cursor, isEflr: boolean, type: number) => {
    if (isEflr) eflr(c);
    else if (type === 0) fdata(c);
    // other IFLRs: NOFORMAT (1), EOD (127) and private types carry no channel data
  };

  // ---- visible records and logical record segments
  let cur: { eflr: boolean; type: number; encrypted: boolean; parts: number[] } | null = null;
  const finish = () => {
    const r = cur!;
    cur = null;
    if (r.encrypted) return;
    const n = r.parts.reduce((s, _, i) => (i % 2 ? s + r.parts[i] - r.parts[i - 1] : s), 0);
    const joined = new Uint8Array(n);
    for (let i = 0, o = 0; i < r.parts.length; i += 2) {
      joined.set(buf.subarray(r.parts[i], r.parts[i + 1]), o);
      o += r.parts[i + 1] - r.parts[i];
    }
    record(new Cursor(joined), r.eflr, r.type);
  };

  const segment = (s: number, e: number, attr: number, type: number) => {
    const enc = (attr & 0x10) !== 0;
    if (attr & 0x08 && e - s >= 2) s += Math.max(dv.getUint16(s), 2); // encryption packet (its size counts itself)
    if (attr & 0x02) e -= 2; // trailing length
    if (attr & 0x04) e -= 2; // checksum
    if (attr & 0x01 && !enc && e > s) e -= buf[e - 1]; // padding; its last byte is the pad count
    if (e < s) e = s;
    const first = !(attr & 0x40);
    const last = !(attr & 0x20);
    if (first) {
      if (cur) log('DLIS: a logical record ended without its last segment.', 'warn');
      cur = null;
      if (enc) encrypted++;
      if (last) {
        if (enc) return;
        main.pos = s;
        main.end = e;
        record(main, (attr & 0x80) !== 0, type);
        return;
      }
      cur = { eflr: (attr & 0x80) !== 0, type, encrypted: enc, parts: [] };
    } else if (!cur) {
      orphans++;
      return;
    }
    cur.parts.push(s, e);
    if (last) finish();
  };

  let p = start;
  while (p + 4 <= buf.length) {
    if (!isVr(buf, p)) {
      if (buf.length - p >= 80 && isSul(buf, p)) {
        p += 80; // a further storage unit
        continue;
      }
      let zeros = true;
      for (let i = p; zeros && i < buf.length; i++) zeros = buf[i] === 0;
      if (!zeros) log(`DLIS: no visible record at byte ${p}; the rest of the file is ignored.`, 'warn');
      break;
    }
    const len = dv.getUint16(p);
    const vend = p + len;
    if (vend > buf.length) log('DLIS: the file ends inside a visible record.', 'warn');
    const end = Math.min(vend, buf.length);
    let q = p + 4;
    while (q + 4 <= end) {
      const slen = dv.getUint16(q);
      if (slen < 4 || q + slen > end) {
        log(`DLIS: a malformed logical record segment at byte ${q}.`, 'warn');
        break;
      }
      try {
        segment(q + 4, q + slen, buf[q + 2], buf[q + 3]);
      } catch (e) {
        log(`DLIS: skipped a logical record (${(e as Error).message})`, 'warn');
      }
      q += slen;
    }
    p = vend;
  }
  if (cur) log('DLIS: the file ends inside a logical record.', 'warn');
  if (encrypted) log(`DLIS: skipped ${encrypted} encrypted logical record${encrypted > 1 ? 's' : ''}.`);
  if (orphans) log(`DLIS: skipped ${orphans} segment${orphans > 1 ? 's' : ''} without a first segment.`, 'warn');

  // ---- batches
  const out: Batch[] = [];
  files.forEach((file, i) => {
    const o = file.origin;
    const meta: Record<string, string> = {};
    const put = (k: string, v: string) => {
      if (v) meta[k] = v;
    };
    put('well', attrText(o, 'WELL-NAME'));
    put('wellId', attrText(o, 'WELL-ID'));
    put('field', attrText(o, 'FIELD-NAME'));
    put('company', attrText(o, 'COMPANY'));
    put('fileId', attrText(o, 'FILE-ID'));
    put('fileSetName', attrText(o, 'FILE-SET-NAME'));
    put('fileNumber', attrText(o, 'FILE-NUMBER'));
    put('producer', attrText(o, 'PRODUCER-NAME'));
    put('product', [attrText(o, 'PRODUCT'), attrText(o, 'VERSION')].filter(Boolean).join(' '));
    put('creationTime', attrText(o, 'CREATION-TIME'));
    put('runNumber', attrText(o, 'RUN-NUMBER'));
    put('fileHeader', attrText(file.header, 'ID'));
    put('logicalFile', String(i + 1));
    const well = attrText(o, 'WELL-NAME') || undefined;
    const longName = (v: Value | undefined): string | undefined => {
      if (v === undefined) return undefined;
      if (typeof v === 'string') return v.trim() || undefined;
      const ref = isObName(v) ? v : typeof v === 'object' ? v.name : undefined;
      const ln = ref && file.longNames.get(key(ref));
      if (!ln) return text(v) || undefined;
      const parts = [...ln.attrs.values()].flatMap((a) => (a.value ?? []).map((x) => text(x, a.rc))).filter(Boolean);
      return parts.join(' ') || ref.name;
    };
    for (const f of file.frames) {
      if (!f.wanted || !f.rows) continue;
      const indexCh = f.indexType ? f.cols[0]?.ch : undefined;
      const columns: Column[] = f.cols.map((c, j) => ({
        name: c.name,
        unit: c.ch ? (c.ch.rc === RC.DTIME ? 'ms' : c.ch.units || undefined) : undefined,
        description: c.ch ? longName(c.ch.long) : 'frame number',
        values: f.data[j].length === f.rows ? f.data[j] : f.data[j].slice(0, f.rows),
      }));
      const fm: Record<string, string> = { ...meta, frame: f.name };
      const put2 = (k: string, v: string) => {
        if (v) fm[k] = v;
      };
      put2('frameDescription', attrText(f.obj, 'DESCRIPTION'));
      put2('indexType', f.indexType);
      put2('direction', attrText(f.obj, 'DIRECTION'));
      put2('spacing', [attrText(f.obj, 'SPACING'), f.obj.attrs.get('SPACING')?.units ?? ''].filter(Boolean).join(' '));
      put2('skipped', f.skipped.join(', '));
      out.push({
        kind: 'channels',
        index: { column: columns[0].name, type: f.indexType ? indexKind(f.indexType, indexCh) : 'depth' },
        well,
        columns,
        meta: fm,
      });
    }
  });
  if (want && !out.length) {
    const names = files.flatMap((f) => f.frames.map((x) => x.name));
    log(`DLIS: no frame called "${opts.frame}" (frames: ${names.join(', ') || 'none'}).`, 'warn');
  }
  return out;
}

export const dlisCodec = defineCodec<{ frame: string }>({
  id: 'dlis',
  label: 'DLIS (RP66 v1)',
  description:
    'Digital Log Interchange Standard files: one table per frame, indexed by its depth or time channel (DTIME read as epoch ms, relative times kept in their unit), well name from the ORIGIN. Array channels (images, waveforms) are skipped.',
  extensions: ['dlis'],
  options: z.object({ frame: z.string().default('').describe('Only the frame with this name (empty: every frame)') }),
  sniff(head) {
    const at = (p: number) => head.length >= p + 15 && isSul(head, p) && head[p + 7] === 0x30 && head[p + 8] === 0x30;
    const record = (p: number) => String.fromCharCode(...head.subarray(p + 9, p + 15)) === 'RECORD';
    if (at(0)) return record(0) ? 0.98 : 0.9;
    if (isTif(head) && at(12)) return 0.95;
    // no label: a visible record whose first segment is at least the 16-byte minimum
    return isVr(head, 0) && head.length >= 8 && head[4] * 256 + head[5] >= 16 ? 0.4 : 0;
  },
  create(o, ctx) {
    return whole((bytes) => decodeDlis(bytes, o, ctx.log));
  },
});
