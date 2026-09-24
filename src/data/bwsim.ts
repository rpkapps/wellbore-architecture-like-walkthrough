/**
 * BoreWalk simulation package (.bwsim): a compact, single-file web format for
 * reservoir-simulation grids and results, written by scripts/prepare_sim.py
 * from Eclipse / OPM Flow output (GRDECL or EGRID + INIT + UNRST + UNSMRY).
 *
 *   bytes 0..7   "BWSIM1\0\0"
 *   bytes 8..11  uint32 LE header length L
 *   bytes 12..   UTF-8 JSON header (L bytes, space padded)
 *   then         binary blocks; header offsets are relative to the data
 *                start = 12 + L rounded up to a multiple of 4
 *
 * Cells are stored as boxes (centre + size) in the package's local
 * coordinates (east / north of the field origin, TVDSS down), quantised.
 */
export interface BlockRef {
  offset: number;
  type: 'u8' | 'u16' | 'i16' | 'f32';
  /** value = raw * scale + add */
  scale?: number;
  add?: number;
}

export interface PropRef extends BlockRef {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  log?: boolean;
  /** raw value marking "no value" */
  nodata?: number;
  /** stored as log10 of the value (e.g. permeability) */
  encoded?: 'log10';
}

export interface DynamicProp {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  log?: boolean;
  steps: BlockRef[]; // one per date
}

export interface SimSeries {
  /** epoch ms per summary sample */
  t: number[];
  /** vectors (e.g. FOPT, FOPR, FWCT, FPR) */
  field: Record<string, number[]>;
  wells?: Record<string, Record<string, number[]>>;
}

export interface SimHeader {
  name: string;
  source: string;
  note: string;
  provenance: 'calculated' | 'interpreted' | 'user';
  dims: [number, number, number];
  nActive: number;
  cells: { cx: BlockRef; cy: BlockRef; cz: BlockRef; sx: BlockRef; sy: BlockRef; sz: BlockRef; i: BlockRef; j: BlockRef; k: BlockRef };
  static: PropRef[];
  dates: string[]; // ISO dates of the dynamic steps
  dynamic: DynamicProp[];
  summary?: SimSeries;
  summaryNote?: string;
}

export interface SimModel {
  header: SimHeader;
  n: number;
  center: Float32Array; // xyz per cell (x = east, y = north, z = TVDSS)
  size: Float32Array;
  ijk: Uint8Array | Uint16Array; // i, j, k per cell
  /** decoded static property */
  prop(key: string): Float32Array | null;
  /** decoded dynamic property at a step */
  step(key: string, index: number): Float32Array | null;
}

const MAGIC = 'BWSIM1';

let BASE = 0;
function view(buf: ArrayBuffer, ref: BlockRef, n: number, base = BASE): ArrayLike<number> {
  const o = base + ref.offset;
  switch (ref.type) {
    case 'u8':
      return new Uint8Array(buf, o, n);
    case 'u16':
      return new Uint16Array(buf, o, n);
    case 'i16':
      return new Int16Array(buf, o, n);
    default:
      return new Float32Array(buf, o, n);
  }
}

function decode(buf: ArrayBuffer, ref: BlockRef, n: number, nodata?: number, base = BASE): Float32Array {
  const raw = view(buf, ref, n, base);
  const s = ref.scale ?? 1;
  const a = ref.add ?? 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = nodata !== undefined && raw[i] === nodata ? NaN : raw[i] * s + a;
  return out;
}

/** Gunzip if the bytes are gzip (hosts that already decoded Content-Encoding pass through). */
export async function maybeGunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

/** Read a .bwsim or .bwsim.gz package. */
export async function readBwsimAny(buf: ArrayBuffer): Promise<SimModel> {
  return readBwsim(await maybeGunzip(buf));
}

export function isBwsim(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const m = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
  return m === MAGIC;
}

export function readBwsim(buf: ArrayBuffer): SimModel {
  if (!isBwsim(buf)) throw new Error('Not a BoreWalk simulation package (.bwsim). Convert Eclipse / OPM output with scripts/prepare_sim.py.');
  const L = new DataView(buf).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, L))) as SimHeader;
  const base = Math.ceil((12 + L) / 4) * 4;
  BASE = base;
  const n = header.nActive;
  const c = header.cells;
  const cx = decode(buf, c.cx, n);
  const cy = decode(buf, c.cy, n);
  const cz = decode(buf, c.cz, n);
  const sx = decode(buf, c.sx, n);
  const sy = decode(buf, c.sy, n);
  const sz = decode(buf, c.sz, n);
  const center = new Float32Array(n * 3);
  const size = new Float32Array(n * 3);
  for (let q = 0; q < n; q++) {
    center[q * 3] = cx[q];
    center[q * 3 + 1] = cy[q];
    center[q * 3 + 2] = cz[q];
    size[q * 3] = sx[q];
    size[q * 3 + 1] = sy[q];
    size[q * 3 + 2] = sz[q];
  }
  const big = Math.max(...header.dims) > 255;
  const ijk = big ? new Uint16Array(n * 3) : new Uint8Array(n * 3);
  const ci = view(buf, c.i, n);
  const cj = view(buf, c.j, n);
  const ck = view(buf, c.k, n);
  for (let q = 0; q < n; q++) {
    ijk[q * 3] = ci[q];
    ijk[q * 3 + 1] = cj[q];
    ijk[q * 3 + 2] = ck[q];
  }
  const cache = new Map<string, Float32Array>();
  return {
    header,
    n,
    center,
    size,
    ijk,
    prop(key) {
      const p = header.static.find((s) => s.key === key);
      if (!p) return null;
      const k = `s:${key}`;
      if (!cache.has(k)) {
        const v = decode(buf, p, n, p.nodata, base);
        if (p.encoded === 'log10') for (let q = 0; q < n; q++) v[q] = Math.pow(10, v[q]);
        cache.set(k, v);
      }
      return cache.get(k)!;
    },
    step(key, index) {
      const d = header.dynamic.find((s) => s.key === key);
      if (!d || !d.steps[index]) return null;
      return decode(buf, d.steps[index], n, 255, base);
    },
  };
}

/** Build a .bwsim file (used by tests and by in-browser converters). */
export function writeBwsim(header: Omit<SimHeader, 'cells' | 'static' | 'dynamic'> & { static: Omit<PropRef, 'offset' | 'type'>[]; dynamic: Omit<DynamicProp, 'steps'>[] }, cells: { cx: Float32Array; cy: Float32Array; cz: Float32Array; sx: Float32Array; sy: Float32Array; sz: Float32Array; i: Uint8Array; j: Uint8Array; k: Uint8Array }, stat: Record<string, Float32Array>, dyn: Record<string, Float32Array[]>): ArrayBuffer {
  const blocks: Uint8Array[] = [];
  const refs: BlockRef[] = [];
  let off = 0;
  const add = (arr: Uint8Array, ref: Omit<BlockRef, 'offset'>) => {
    const pad = (4 - (off % 4)) % 4;
    if (pad) {
      blocks.push(new Uint8Array(pad));
      off += pad;
    }
    const r = { ...ref, offset: off };
    blocks.push(arr);
    off += arr.byteLength;
    refs.push(r);
    return r;
  };
  const f32 = (a: Float32Array) => add(new Uint8Array(a.buffer.slice(0)), { type: 'f32' });
  const u8q = (a: Float32Array, min: number, max: number) => {
    const q = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) q[i] = Number.isFinite(a[i]) ? Math.round(Math.max(0, Math.min(254, ((a[i] - min) / (max - min || 1)) * 254))) : 255;
    return add(q, { type: 'u8', scale: (max - min) / 254, add: min });
  };
  const c = {
    cx: f32(cells.cx),
    cy: f32(cells.cy),
    cz: f32(cells.cz),
    sx: f32(cells.sx),
    sy: f32(cells.sy),
    sz: f32(cells.sz),
    i: add(cells.i, { type: 'u8' }),
    j: add(cells.j, { type: 'u8' }),
    k: add(cells.k, { type: 'u8' }),
  };
  const st = header.static.map((p) => ({ ...p, ...u8q(stat[p.key], p.min, p.max), nodata: 255 }));
  const dy = header.dynamic.map((p) => ({ ...p, steps: dyn[p.key].map((a) => u8q(a, p.min, p.max)) }));
  const full = { ...header, cells: c, static: st, dynamic: dy } as SimHeader;
  const hdr = new TextEncoder().encode(JSON.stringify(full));
  const dataStart = Math.ceil((12 + hdr.length) / 4) * 4;
  const out = new Uint8Array(dataStart + off);
  out.set(new TextEncoder().encode('BWSIM1\0\0'), 0);
  new DataView(out.buffer).setUint32(8, dataStart - 12, true);
  out.fill(0x20, 12, dataStart);
  out.set(hdr, 12);
  let p = dataStart;
  for (const b of blocks) {
    out.set(b, p);
    p += b.byteLength;
  }
  return out.buffer;
}
