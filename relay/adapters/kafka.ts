import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compileSchema, decode, protobufIndexes, registryFrame, type AvroSchema, type AvroType } from '../../src/connect/avro';
import { defineAdapter, From, parseFrom } from '../adapter';

/**
 * Kafka topics. Each browser connection gets its own consumer group (so
 * nothing is committed on anyone's behalf) and starts where it asks: the
 * latest records, the earliest, or a time ("6h" back, a date) found with
 * offsets-by-timestamp. Values are JSON, Avro or Protobuf behind a
 * Confluent-compatible Schema Registry, or plain text (CSV, WITS…). Structured
 * values are decoded here and reach the browser as JSON lines, one message
 * per fetched batch; the consumer pauses while the browser is behind.
 */
const Sasl = z.object({ mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']), username: z.string(), password: z.string() });

const KafkaConfig = z.object({
  type: z.literal('kafka'),
  label: z.string().optional(),
  brokers: z.array(z.string().min(1)).min(1),
  clientId: z.string().default('borewalk-relay'),
  ssl: z.boolean().default(false),
  sasl: Sasl.optional(),
  topics: z.array(z.string().min(1)).min(1),
  value: z.enum(['auto', 'json', 'avro', 'protobuf', 'text']).default('auto').describe('How record values are encoded'),
  /** for text values: the codec the browser reads them with (csv, wits0, key-value…) */
  textFormat: z.string().default('csv'),
  schemaRegistry: z.object({ url: z.string().url(), username: z.string().optional(), password: z.string().optional() }).optional(),
  /** a JSON field (dotted path) or "key" naming the well of each record, for the well filter */
  wellField: z.string().default('key'),
  maxBatchRecords: z.number().int().min(1).default(5000),
});
type KafkaConfig = z.output<typeof KafkaConfig>;

const KafkaParams = z.object({
  from: From,
  topics: z.array(z.string()).default([]).describe('A subset of the source’s topics (empty: all)'),
  well: z.string().default('').describe('Only records of this well (matched on the key or the configured field)'),
});

// ------------------------------------------------------------------ the client, injectable for tests

export interface KafkaLike {
  consumer(o: { groupId: string }): {
    connect(): Promise<void>;
    subscribe(o: { topics: string[]; fromBeginning: boolean }): Promise<void>;
    run(o: { autoCommit: boolean; eachBatch: (p: EachBatch) => Promise<void> }): Promise<void>;
    seek(o: { topic: string; partition: number; offset: string }): void;
    disconnect(): Promise<void>;
  };
  admin(): { connect(): Promise<void>; fetchTopicOffsetsByTimestamp(topic: string, ts?: number): Promise<{ partition: number; offset: string }[]>; disconnect(): Promise<void> };
}
export interface EachBatch {
  batch: { topic: string; partition: number; messages: { key: Buffer | null; value: Buffer | null; timestamp: string; offset: string }[] };
  heartbeat(): Promise<void>;
  resolveOffset(o: string): void;
  isRunning(): boolean;
}

export let kafkaFactory = async (c: KafkaConfig): Promise<KafkaLike> => {
  const { Kafka, logLevel } = await import('kafkajs');
  return new Kafka({ clientId: c.clientId, brokers: c.brokers, ssl: c.ssl, sasl: c.sasl as never, logLevel: logLevel.WARN }) as unknown as KafkaLike;
};
export const setKafkaFactory = (f: typeof kafkaFactory) => (kafkaFactory = f);

// ------------------------------------------------------------------ schema registry

type Decoded = (bytes: Uint8Array) => unknown;

function registry(c: KafkaConfig) {
  const cache = new Map<number, Promise<Decoded>>();
  const auth = c.schemaRegistry?.username ? { Authorization: `Basic ${Buffer.from(`${c.schemaRegistry.username}:${c.schemaRegistry.password ?? ''}`).toString('base64')}` } : undefined;
  return (id: number): Promise<Decoded> => {
    let p = cache.get(id);
    if (!p) {
      if (!c.schemaRegistry) throw new Error('Records carry a Schema Registry id, but no schemaRegistry is configured for this source.');
      p = (async () => {
        const r = await fetch(`${c.schemaRegistry!.url.replace(/\/$/, '')}/schemas/ids/${id}`, { headers: auth });
        if (!r.ok) throw new Error(`Schema Registry answered ${r.status} for schema ${id}.`);
        const j = (await r.json()) as { schema: string; schemaType?: string };
        const kind = j.schemaType ?? 'AVRO';
        if (kind === 'AVRO') {
          const t: AvroType = compileSchema(JSON.parse(j.schema) as AvroSchema);
          return (b: Uint8Array) => decode(t, b).value;
        }
        if (kind === 'PROTOBUF') {
          const pb = await import('protobufjs');
          const parsed = pb.parse(j.schema, { keepCase: true });
          const ns = parsed.package ? parsed.root.lookup(parsed.package) : parsed.root;
          const types = (n: unknown) => ((n as { nestedArray?: unknown[] }).nestedArray ?? []).filter((x): x is InstanceType<typeof pb.Type> => x instanceof pb.Type);
          return (b: Uint8Array) => {
            const { indexes, rest } = protobufIndexes(b);
            let t = types(ns)[indexes[0]];
            for (const i of indexes.slice(1)) t = types(t)[i];
            if (!t) throw new Error(`Protobuf schema ${id} has no message at index ${indexes.join('.')}.`);
            return t.toObject(t.decode(rest), { longs: Number, enums: String, bytes: String, defaults: false });
          };
        }
        if (kind === 'JSON') return (b: Uint8Array) => JSON.parse(Buffer.from(b).toString('utf8'));
        throw new Error(`Schema type ${kind} is not supported.`);
      })();
      cache.set(id, p);
    }
    return p;
  };
}

const at = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const plain = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v);

export const kafkaAdapter = defineAdapter({
  type: 'kafka',
  label: 'Kafka topics',
  config: KafkaConfig,
  params: KafkaParams,
  describe: (c) => ({ topics: c.topics, value: c.value, schemaRegistry: !!c.schemaRegistry }),
  async open(c, ctx) {
    const topics = ctx.params.topics.length ? ctx.params.topics.filter((t) => c.topics.includes(t)) : c.topics;
    if (!topics.length) throw new Error('None of the requested topics is configured on this source.');
    const kafka = await kafkaFactory(c);
    const consumer = kafka.consumer({ groupId: `borewalk-${randomUUID()}` });
    const schema = registry(c);
    const from = parseFrom(ctx.params.from);
    await consumer.connect();
    ctx.signal.addEventListener('abort', () => void consumer.disconnect().catch(() => {}), { once: true });
    await consumer.subscribe({ topics, fromBeginning: from === -1 });
    // a start time: find each partition's offset for it
    let seeks: { topic: string; partition: number; offset: string }[] = [];
    if (from !== null && from > 0) {
      const admin = kafka.admin();
      await admin.connect();
      for (const t of topics) for (const p of await admin.fetchTopicOffsetsByTimestamp(t, from)) seeks.push({ topic: t, partition: p.partition, offset: p.offset });
      await admin.disconnect();
    }
    const structured = c.value !== 'text';
    ctx.ready(structured ? 'json' : c.textFormat, {}, `${topics.join(', ')} from ${ctx.params.from}`);
    const wanted = ctx.params.well.trim().toUpperCase();
    let warned = false;

    const toRecord = async (m: EachBatch['batch']['messages'][number]): Promise<unknown> => {
      const v = m.value;
      if (!v) return null;
      const framed = registryFrame(v);
      if (framed && (c.value === 'auto' || c.value === 'avro' || c.value === 'protobuf')) return (await schema(framed.schemaId))(framed.payload);
      const text = v.toString('utf8');
      if (c.value === 'avro' || c.value === 'protobuf') throw new Error('Record without a Schema Registry frame on an Avro/Protobuf topic.');
      try {
        return JSON.parse(text);
      } catch {
        if (!warned) ctx.log('Some record values are not JSON; they were skipped. Set value: "text" for text topics.', 'warn');
        warned = true;
        return null;
      }
    };

    const run = consumer.run({
      autoCommit: false,
      eachBatch: async ({ batch, heartbeat, resolveOffset, isRunning }) => {
        if (seeks.length) return;
        const lines: string[] = [];
        const texts: string[] = [];
        for (const m of batch.messages) {
          if (!isRunning() || ctx.signal.aborted) break;
          const key = m.key?.toString('utf8') ?? '';
          if (structured) {
            const rec = await toRecord(m).catch((e: unknown) => {
              ctx.log(e instanceof Error ? e.message : String(e), 'error');
              return null;
            });
            if (rec && typeof rec === 'object') {
              const wellVal = c.wellField === 'key' ? key : String(at(rec, c.wellField) ?? '');
              if (wanted && wellVal.toUpperCase() !== wanted) continue;
              // keep the key and timestamp when the record does not say which well or when
              const o = Object.fromEntries(Object.entries(rec as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
              if (c.wellField === 'key' && key && !('well' in o)) o.well = key;
              if (!('time' in o) && !('timestamp' in o)) o.kafka_ts = Number(m.timestamp);
              lines.push(JSON.stringify(o));
            }
          } else if (m.value) {
            if (wanted && key.toUpperCase() !== wanted) continue;
            texts.push(m.value.toString('utf8'));
          }
          resolveOffset(m.offset);
          if (lines.length + texts.length >= c.maxBatchRecords) {
            await flush();
            await heartbeat();
          }
        }
        await flush();
        await heartbeat();

        async function flush() {
          const ts = Number(batch.messages[batch.messages.length - 1]?.timestamp ?? Date.now());
          if (lines.length) await ctx.send(lines.splice(0).join('\n'), { topic: batch.topic, ts });
          if (texts.length) await ctx.send(texts.splice(0).join(c.textFormat === 'wits0' ? '\r\n' : '\n'), { topic: batch.topic, ts });
        }
      },
    });
    if (seeks.length) {
      const s = seeks;
      seeks = [];
      for (const x of s) consumer.seek(x);
    }
    await run;
    // kafkajs's run() returns once the consumer is running: stay open until the browser leaves
    await new Promise<void>((r) => (ctx.signal.aborted ? r() : ctx.signal.addEventListener('abort', () => r(), { once: true })));
  },
});
