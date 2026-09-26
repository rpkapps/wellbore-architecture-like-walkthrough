import { inflateSync } from 'fflate';
import { z } from 'zod';
import { batchesFromRecords, columnFromCells, type Batch, type Column } from '../batch';
import { compileSchema, decode, isContainer, readContainer, registryFrame, type AvroSchema, type AvroType } from '../avro';
import { defineCodec } from '../plugin';
import { whole } from './files';

/** Avro records (and nested values) as plain JSON-able records. */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return Array.from(v.subarray(0, 64)).join(',');
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Uint8Array) ? plain(x) : plain(x)]));
  return v;
}

// ------------------------------------------------------------------ Avro

const AvroOptions = z.object({
  schema: z.string().max(200_000).default('').describe('The Avro schema (JSON), for messages that carry no schema'),
  registryUrl: z.string().url().or(z.literal('')).default('').describe('Schema Registry URL, for messages framed with a schema id'),
});

export const avroCodec = defineCodec<z.output<typeof AvroOptions>>({
  id: 'avro',
  label: 'Avro',
  description: 'Avro object container files (.avro, null or deflate), or Avro messages with a given schema or a Confluent Schema Registry id.',
  extensions: ['avro'],
  mime: ['avro/binary', 'application/avro'],
  options: AvroOptions,
  sniff: (head) => (isContainer(head) ? 0.95 : 0),
  create(o, ctx) {
    const given = o.schema.trim() ? compileSchema(JSON.parse(o.schema) as AvroSchema) : null;
    const fromRegistry = new Map<number, Promise<AvroType>>();
    const registry = (id: number) => {
      if (!o.registryUrl) throw new Error('Message has a Schema Registry id but no registry URL is set.');
      let p = fromRegistry.get(id);
      if (!p) {
        p = fetch(`${o.registryUrl.replace(/\/$/, '')}/schemas/ids/${id}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Schema Registry: ${r.status} for schema ${id}`))))
          .then((j: { schema: string; schemaType?: string }) => {
            if (j.schemaType && j.schemaType !== 'AVRO') throw new Error(`Schema ${id} is ${j.schemaType}; read it through the relay.`);
            return compileSchema(JSON.parse(j.schema) as AvroSchema);
          });
        fromRegistry.set(id, p);
      }
      return p;
    };
    const message = async (b: Uint8Array): Promise<Batch[]> => {
      if (isContainer(b)) return batchesFromRecords(readContainer(b, inflateSync).records.map(plain));
      const framed = registryFrame(b);
      if (framed && o.registryUrl) return batchesFromRecords([plain(decode(await registry(framed.schemaId), framed.payload).value)]);
      if (!given) {
        ctx.log('Avro message without a schema: set one in the format options.', 'error');
        return [];
      }
      const out: unknown[] = [];
      let pos = 0;
      // several records back to back are allowed
      while (pos < b.length) {
        const r = decode(given, b, pos);
        out.push(plain(r.value));
        if (r.end <= pos) break;
        pos = r.end;
      }
      return batchesFromRecords(out);
    };
    return whole((b) => message(b));
  },
});

// ------------------------------------------------------------------ Parquet

function toColumn(name: string, values: ArrayLike<unknown>, unit?: string): Column {
  const n = values.length;
  let sample: unknown;
  for (let i = 0; i < n && sample === undefined; i++) if (values[i] !== null && values[i] !== undefined) sample = values[i];
  if (sample instanceof Date) return { name, unit: 'ms', description: 'time', values: Float64Array.from({ length: n }, (_, i) => (values[i] instanceof Date ? (values[i] as Date).getTime() : NaN)) };
  if (typeof sample === 'number' || typeof sample === 'bigint' || typeof sample === 'boolean' || sample === undefined)
    return { name, unit, values: Float64Array.from({ length: n }, (_, i) => (values[i] === null || values[i] === undefined ? NaN : Number(values[i]))) };
  return columnFromCells(
    name,
    Array.from({ length: n }, (_, i) => (values[i] === null || values[i] === undefined ? '' : typeof values[i] === 'object' ? JSON.stringify(values[i]) : String(values[i]))),
    { unit },
  );
}

export const parquetCodec = defineCodec<{ columns: string[] }>({
  id: 'parquet',
  label: 'Parquet',
  description: 'Apache Parquet files (all common compressions), as data lakes, OSDU and pandas write them. Read column by column.',
  extensions: ['parquet', 'pq'],
  mime: ['application/vnd.apache.parquet', 'application/x-parquet'],
  options: z.object({ columns: z.array(z.string()).default([]).describe('Only these columns (empty: all)') }),
  sniff: (head) => (head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31 ? 0.95 : 0),
  create(o) {
    return whole(async (bytes) => {
      // the reader loads on first use, so it costs nothing until a Parquet file arrives
      const { parquetRead, parquetMetadata } = await import('hyparquet');
      const { compressors } = await import('hyparquet-compressors');
      const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const metadata = parquetMetadata(file);
      const n = Number(metadata.num_rows);
      const chunks = new Map<string, { start: number; data: ArrayLike<unknown> }[]>();
      await parquetRead({
        file,
        metadata,
        compressors,
        columns: o.columns.length ? o.columns : undefined,
        onChunk: (c) => {
          const list = chunks.get(c.columnName) ?? [];
          list.push({ start: c.rowStart, data: c.columnData as ArrayLike<unknown> });
          chunks.set(c.columnName, list);
        },
      });
      const columns: Column[] = [];
      for (const [name, list] of chunks) {
        const all: unknown[] = new Array(n);
        for (const ch of list) for (let i = 0; i < ch.data.length && ch.start + i < n; i++) all[ch.start + i] = ch.data[i];
        columns.push(toColumn(name, all));
      }
      const meta = Object.fromEntries((metadata.key_value_metadata ?? []).filter((e) => e.value && e.value.length < 2000).map((e) => [e.key, e.value ?? '']));
      return columns.length ? [{ columns, meta }] : [];
    });
  },
});

// ------------------------------------------------------------------ Arrow IPC

export const arrowCodec = defineCodec<Record<string, never>>({
  id: 'arrow',
  label: 'Apache Arrow',
  description: 'Arrow IPC files and streams (Feather v2), as DuckDB, Polars and Arrow Flight gateways produce them.',
  extensions: ['arrow', 'feather', 'arrows', 'ipc'],
  mime: ['application/vnd.apache.arrow.stream', 'application/vnd.apache.arrow.file'],
  options: z.object({}),
  sniff(head) {
    const file = head[0] === 0x41 && head[1] === 0x52 && head[2] === 0x52 && head[3] === 0x4f && head[4] === 0x57 && head[5] === 0x31; // ARROW1
    const stream = head[0] === 0xff && head[1] === 0xff && head[2] === 0xff && head[3] === 0xff; // continuation marker
    return file ? 0.95 : stream ? 0.6 : 0;
  },
  create() {
    return whole(async (bytes) => {
      const { tableFromIPC, Type } = await import('apache-arrow');
      const t = tableFromIPC(bytes);
      const columns: Column[] = [];
      for (const f of t.schema.fields) {
        const v = t.getChild(f.name);
        if (!v) continue;
        const n = v.length;
        const unit = f.metadata.get('unit') ?? f.metadata.get('uom') ?? undefined;
        if (f.typeId === Type.Timestamp || f.typeId === Type.Date) {
          // Arrow JS gives epoch milliseconds for dates and timestamps
          columns.push({
            name: f.name,
            unit: 'ms',
            description: 'time',
            values: Float64Array.from({ length: n }, (_, i) => {
              const x = v.get(i) as unknown;
              return x === null ? NaN : x instanceof Date ? x.getTime() : Number(x);
            }),
          });
        } else {
          const arr: unknown[] = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = v.get(i);
          columns.push(toColumn(f.name, arr, unit));
        }
      }
      const meta = Object.fromEntries(t.schema.metadata);
      return columns.length ? [{ columns, meta }] : [];
    });
  },
});
