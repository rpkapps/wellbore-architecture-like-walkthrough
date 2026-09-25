/**
 * Apache Avro binary encoding, from a schema (JSON). Used by the Avro codec
 * (container files and messages), by the relay for Kafka topics behind a
 * Schema Registry, and by the ETP client, whose messages are Avro.
 *
 * Longs are read as JS numbers (exact up to 2^53, which covers epoch
 * microseconds). Enums read as their symbol, unions as the plain value of the
 * branch; to write a union branch explicitly pass `{ "<type name>": value }`.
 */
export type AvroSchema = string | { type: string | AvroSchema; [k: string]: unknown } | AvroSchema[];

interface Reader {
  buf: Uint8Array;
  dv: DataView;
  pos: number;
}
interface Writer {
  parts: number[];
}

export interface AvroType {
  name?: string;
  read(r: Reader): unknown;
  write(w: Writer, v: unknown): void;
  /** does a value fit this type (for choosing a union branch) */
  fits(v: unknown): boolean;
}

const td = new TextDecoder();
const te = new TextEncoder();

// ------------------------------------------------------------------ primitives

function readLong(r: Reader): number {
  let n = 0;
  let mult = 1;
  let b: number;
  do {
    if (r.pos >= r.buf.length) throw new Error('Avro: data ends inside a number.');
    b = r.buf[r.pos++];
    n += (b & 0x7f) * mult;
    mult *= 128;
  } while (b & 0x80);
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function writeLong(w: Writer, v: number) {
  let n = v >= 0 ? v * 2 : -v * 2 - 1;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    w.parts.push(b);
  } while (n > 0);
}

function readBytes(r: Reader): Uint8Array {
  const n = readLong(r);
  if (n < 0 || r.pos + n > r.buf.length) throw new Error('Avro: bad byte length.');
  const b = r.buf.subarray(r.pos, r.pos + n);
  r.pos += n;
  return b;
}

const PRIM: Record<string, AvroType> = {
  null: { read: () => null, write: () => {}, fits: (v) => v === null || v === undefined },
  boolean: { read: (r) => r.buf[r.pos++] !== 0, write: (w, v) => w.parts.push(v ? 1 : 0), fits: (v) => typeof v === 'boolean' },
  int: { read: readLong, write: (w, v) => writeLong(w, Math.trunc(Number(v))), fits: (v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 2 ** 31 },
  long: { read: readLong, write: (w, v) => writeLong(w, Math.trunc(Number(v))), fits: (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint' },
  float: {
    read: (r) => {
      r.pos += 4;
      return r.dv.getFloat32(r.pos - 4, true);
    },
    write: (w, v) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, Number(v), true);
      w.parts.push(...b);
    },
    fits: (v) => typeof v === 'number',
  },
  double: {
    read: (r) => {
      r.pos += 8;
      return r.dv.getFloat64(r.pos - 8, true);
    },
    write: (w, v) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, Number(v), true);
      w.parts.push(...b);
    },
    fits: (v) => typeof v === 'number',
  },
  bytes: {
    read: (r) => readBytes(r).slice(),
    write: (w, v) => {
      const b = v instanceof Uint8Array ? v : te.encode(String(v ?? ''));
      writeLong(w, b.length);
      for (let i = 0; i < b.length; i++) w.parts.push(b[i]);
    },
    fits: (v) => v instanceof Uint8Array,
  },
  string: {
    read: (r) => td.decode(readBytes(r)),
    write: (w, v) => {
      const b = te.encode(String(v ?? ''));
      writeLong(w, b.length);
      for (let i = 0; i < b.length; i++) w.parts.push(b[i]);
    },
    fits: (v) => typeof v === 'string',
  },
};

// ------------------------------------------------------------------ compiling a schema

export type Names = Map<string, AvroType>;

const fullName = (name: string, ns?: string) => (name.includes('.') || !ns ? name : `${ns}.${name}`);

export function compileSchema(schema: AvroSchema, names: Names = new Map(), ns?: string): AvroType {
  if (typeof schema === 'string') {
    if (PRIM[schema]) return PRIM[schema];
    const t = names.get(fullName(schema, ns)) ?? names.get(schema);
    if (!t) throw new Error(`Avro: unknown type "${schema}".`);
    return t;
  }
  if (Array.isArray(schema)) return union(schema.map((s) => compileSchema(s, names, ns)));
  const s = schema as Record<string, unknown> & { type: AvroSchema };
  if (typeof s.type !== 'string' || !['record', 'error', 'enum', 'array', 'map', 'fixed'].includes(s.type)) {
    // { "type": "int", "logicalType": … } and nested type objects
    return compileSchema(s.type, names, ns);
  }
  const space = typeof s.namespace === 'string' ? s.namespace : ns;
  const name = typeof s.name === 'string' ? fullName(s.name, space) : undefined;
  const innerNs = name && name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : space;
  switch (s.type) {
    case 'record':
    case 'error': {
      const fields: { name: string; type: AvroType; def?: unknown }[] = [];
      const t: AvroType = {
        name,
        read(r) {
          const o: Record<string, unknown> = {};
          for (const f of fields) o[f.name] = f.type.read(r);
          return o;
        },
        write(w, v) {
          const o = (v ?? {}) as Record<string, unknown>;
          for (const f of fields) f.type.write(w, o[f.name] === undefined ? f.def : o[f.name]);
        },
        fits: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array),
      };
      if (name) names.set(name, t); // before the fields: records may refer to themselves
      for (const f of s.fields as { name: string; type: AvroSchema; default?: unknown }[]) fields.push({ name: f.name, type: compileSchema(f.type, names, innerNs), def: f.default });
      return t;
    }
    case 'enum': {
      const symbols = s.symbols as string[];
      const t: AvroType = {
        name,
        read: (r) => symbols[readLong(r)],
        write: (w, v) => {
          const i = typeof v === 'number' ? v : symbols.indexOf(String(v));
          if (i < 0) throw new Error(`Avro: "${String(v)}" is not one of ${name}'s symbols.`);
          writeLong(w, i);
        },
        fits: (v) => typeof v === 'string' && symbols.includes(v),
      };
      if (name) names.set(name, t);
      return t;
    }
    case 'fixed': {
      const size = s.size as number;
      const t: AvroType = {
        name,
        read(r) {
          const b = r.buf.slice(r.pos, r.pos + size);
          r.pos += size;
          return b;
        },
        write(w, v) {
          const b = v instanceof Uint8Array ? v : new Uint8Array(size);
          for (let i = 0; i < size; i++) w.parts.push(b[i] ?? 0);
        },
        fits: (v) => v instanceof Uint8Array && v.length === size,
      };
      if (name) names.set(name, t);
      return t;
    }
    case 'array': {
      const items = compileSchema(s.items as AvroSchema, names, space);
      return {
        read(r) {
          const out: unknown[] = [];
          for (;;) {
            let n = readLong(r);
            if (n === 0) break;
            if (n < 0) {
              n = -n;
              readLong(r); // block size in bytes
            }
            for (let i = 0; i < n; i++) out.push(items.read(r));
          }
          return out;
        },
        write(w, v) {
          const a = (v ?? []) as unknown[];
          if (a.length) {
            writeLong(w, a.length);
            for (const x of a) items.write(w, x);
          }
          writeLong(w, 0);
        },
        fits: (v) => Array.isArray(v),
      };
    }
    case 'map': {
      const values = compileSchema(s.values as AvroSchema, names, space);
      return {
        read(r) {
          const out: Record<string, unknown> = {};
          for (;;) {
            let n = readLong(r);
            if (n === 0) break;
            if (n < 0) {
              n = -n;
              readLong(r);
            }
            for (let i = 0; i < n; i++) {
              const k = td.decode(readBytes(r));
              out[k] = values.read(r);
            }
          }
          return out;
        },
        write(w, v) {
          const e = Object.entries((v ?? {}) as Record<string, unknown>);
          if (e.length) {
            writeLong(w, e.length);
            for (const [k, x] of e) {
              PRIM.string.write(w, k);
              values.write(w, x);
            }
          }
          writeLong(w, 0);
        },
        fits: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
      };
    }
  }
  throw new Error(`Avro: unsupported schema ${JSON.stringify(schema).slice(0, 80)}`);
}

function branchName(t: AvroType): string {
  if (t.name) return t.name;
  for (const [k, p] of Object.entries(PRIM)) if (p === t) return k;
  return '';
}

function union(branches: AvroType[]): AvroType {
  return {
    read(r) {
      const i = readLong(r);
      const b = branches[i];
      if (!b) throw new Error(`Avro: union branch ${i} out of range.`);
      return b.read(r);
    },
    write(w, v) {
      // an explicit branch: { "long": 5 } or { "Energistics.….PassIndexedDepth": {…} }
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) {
        const keys = Object.keys(v);
        if (keys.length === 1) {
          const i = branches.findIndex((b) => {
            const n = branchName(b);
            return n === keys[0] || n.endsWith(`.${keys[0]}`);
          });
          if (i >= 0) {
            writeLong(w, i);
            branches[i].write(w, (v as Record<string, unknown>)[keys[0]]);
            return;
          }
        }
      }
      let i = branches.findIndex((b) => b.fits(v));
      if (i < 0 && typeof v === 'number') i = branches.findIndex((b) => b === PRIM.double || b === PRIM.float || b === PRIM.long);
      if (i < 0) throw new Error(`Avro: value does not fit the union (${JSON.stringify(v)?.slice(0, 60)}).`);
      writeLong(w, i);
      branches[i].write(w, v);
    },
    fits: (v) => branches.some((b) => b.fits(v)),
  };
}

// ------------------------------------------------------------------ public helpers

export function reader(buf: Uint8Array, pos = 0): Reader {
  return { buf, dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), pos };
}

export function encode(t: AvroType, value: unknown): Uint8Array {
  const w: Writer = { parts: [] };
  t.write(w, value);
  return Uint8Array.from(w.parts);
}

export function decode(t: AvroType, buf: Uint8Array, pos = 0): { value: unknown; end: number } {
  const r = reader(buf, pos);
  const value = t.read(r);
  return { value, end: r.pos };
}

/** Confluent Schema Registry framing: magic 0, a 4-byte schema id, then the payload (after message indexes for Protobuf). */
export function registryFrame(buf: Uint8Array): { schemaId: number; payload: Uint8Array } | null {
  if (buf.length < 5 || buf[0] !== 0) return null;
  const schemaId = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1);
  return { schemaId, payload: buf.subarray(5) };
}

/** Protobuf's message-index list after the schema id (zig-zag varints; a single 0 means the first message). */
export function protobufIndexes(payload: Uint8Array): { indexes: number[]; rest: Uint8Array } {
  const r = reader(payload);
  const n = readLong(r);
  const indexes = n === 0 ? [0] : Array.from({ length: n }, () => readLong(r));
  return { indexes, rest: payload.subarray(r.pos) };
}

// ------------------------------------------------------------------ object container files

const MAGIC = [0x4f, 0x62, 0x6a, 0x01]; // "Obj\1"

export function isContainer(b: Uint8Array): boolean {
  return b.length >= 4 && MAGIC.every((m, i) => b[i] === m);
}

/** Records of an Avro object container file (null and deflate codecs). */
export function readContainer(buf: Uint8Array, inflate: (b: Uint8Array) => Uint8Array): { schema: AvroSchema; records: unknown[] } {
  if (!isContainer(buf)) throw new Error('Not an Avro container file.');
  const r = reader(buf, 4);
  const meta = compileSchema({ type: 'map', values: 'bytes' }).read(r) as Record<string, Uint8Array>;
  const schema = JSON.parse(td.decode(meta['avro.schema'])) as AvroSchema;
  const codec = meta['avro.codec'] ? td.decode(meta['avro.codec']) : 'null';
  if (codec !== 'null' && codec !== 'deflate') throw new Error(`Avro container uses the "${codec}" codec, which is not supported (null and deflate are).`);
  const sync = buf.subarray(r.pos, r.pos + 16);
  r.pos += 16;
  const t = compileSchema(schema);
  const records: unknown[] = [];
  while (r.pos < buf.length) {
    const count = readLong(r);
    const size = readLong(r);
    let block = buf.subarray(r.pos, r.pos + size);
    r.pos += size;
    if (codec === 'deflate') block = inflate(block);
    const br = reader(block);
    for (let i = 0; i < count; i++) records.push(t.read(br));
    const s = buf.subarray(r.pos, r.pos + 16);
    r.pos += 16;
    if (s.some((x, i) => x !== sync[i])) throw new Error('Avro container: sync marker mismatch.');
  }
  return { schema, records };
}

/** Write a container file (null codec); used by tests and the relay's recorder. */
export function writeContainer(schema: AvroSchema, records: unknown[]): Uint8Array {
  const t = compileSchema(schema);
  const sync = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);
  const head = encode(compileSchema({ type: 'map', values: 'bytes' }), { 'avro.schema': te.encode(JSON.stringify(schema)), 'avro.codec': te.encode('null') });
  const body: number[] = [];
  const w: Writer = { parts: body };
  for (const rec of records) t.write(w, rec);
  const bw: Writer = { parts: [] };
  writeLong(bw, records.length);
  writeLong(bw, body.length);
  return Uint8Array.from([...MAGIC, ...head, ...sync, ...bw.parts, ...body, ...sync]);
}
