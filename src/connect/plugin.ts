import { z } from 'zod';
import type { Batch } from './batch';

/**
 * Connectors are made of three kinds of plugin, and the built-in ones are
 * registered exactly like a custom one would be:
 *
 * - a **transport** says how data arrives (a file, a URL, polling, SSE, a
 *   WebSocket, MQTT, the relay for Kafka / WITSML / ETP / OSDU, a replay);
 * - a **codec** reads a format (CSV, JSON, LAS, WITSML, DLIS, Parquet…) into
 *   batches;
 * - a **transform** reshapes batches (mapping, units, time to depth…).
 *
 * Every plugin declares its options as a Zod schema, which gives the connect
 * dialog its form, an assistant its tool input, and the saved config its
 * validation. All of it runs in a worker; nothing here touches the page.
 */

/** A message (WebSocket frame, SSE event, Kafka record, HTTP response) or a piece of a byte stream. */
export type Chunk = string | Uint8Array;

export interface ChunkMeta {
  /** the chunk is a whole message; otherwise it continues a stream until `end()` */
  complete: boolean;
  /** file name, topic, event name, URL: helps a codec (and format detection) */
  name?: string;
  contentType?: string;
  key?: string;
  /** when the source produced it (epoch ms) */
  ts?: number;
}

export interface PluginContext {
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
}

// ------------------------------------------------------------------ codecs

export interface Decoder {
  push(chunk: Chunk, meta: ChunkMeta): Batch[] | Promise<Batch[]>;
  /** the stream ended: return whatever is still buffered */
  end?(): Batch[] | Promise<Batch[]>;
}

export interface Codec<O = unknown> {
  kind: 'codec';
  id: string;
  label: string;
  description: string;
  extensions?: string[];
  mime?: string[];
  /** how sure (0–1) the codec is that it can read data starting like this */
  sniff?(head: Uint8Array, text: string | null, meta: { name?: string; contentType?: string }): number;
  options: z.ZodType<O>;
  create(options: O, ctx: PluginContext): Decoder;
}

// ------------------------------------------------------------------ transforms

export interface TransformStep {
  apply(b: Batch): Batch[];
  /** the stream ended: emit anything held back (an open depth bin, a sort window) */
  flush?(): Batch[];
}

export interface Transform<O = unknown> {
  kind: 'transform';
  id: string;
  label: string;
  description: string;
  options: z.ZodType<O>;
  create(options: O, ctx: PluginContext): TransformStep;
}

// ------------------------------------------------------------------ transports

export type TransportState = 'connecting' | 'live' | 'reconnecting' | 'idle' | 'done' | 'error';

export interface TransportSink {
  /** hand over a chunk; awaiting it lets the pipeline slow a source that can wait (a file, a poll) */
  data(chunk: Chunk, meta: ChunkMeta): Promise<void>;
  /** batches a transport decoded itself (a replay, a relay that already decoded Avro) */
  batches?(b: Batch[]): Promise<void>;
  status(state: TransportState, detail?: string): void;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** a format the source announced (the relay says "json", a replay says "json") */
  format?(codecId: string, options?: unknown): void;
  /** the current file or resource is complete: the next data starts a new one (and is sniffed again) */
  next?(): Promise<void>;
  /** the newest time (epoch ms) and deepest depth (m) delivered so far, for incremental polling */
  cursor?(): { lastTime: number; lastDepth: number };
}

export interface Transport<O = unknown> {
  kind: 'transport';
  id: string;
  label: string;
  description: string;
  /** keeps delivering until stopped (a stream), rather than ending (a file, one fetch) */
  live: boolean;
  /** the codec to use when the user leaves the format on automatic and nothing can be sniffed */
  defaultCodec?: string;
  /** reached through the BoreWalk relay (Kafka, WITSML, ETP, OSDU, TCP) */
  relay?: boolean;
  options: z.ZodType<O>;
  open(options: O, sink: TransportSink, signal: AbortSignal): Promise<void>;
}

export type Plugin = Codec<any> | Transform<any> | Transport<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const defineCodec = <O>(c: Omit<Codec<O>, 'kind'>): Codec<O> => ({ kind: 'codec', ...c });
export const defineTransform = <O>(t: Omit<Transform<O>, 'kind'>): Transform<O> => ({ kind: 'transform', ...t });
export const defineTransport = <O>(t: Omit<Transport<O>, 'kind'>): Transport<O> => ({ kind: 'transport', ...t });

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class PluginRegistry {
  private readonly items = new Map<string, Plugin>();

  register(...plugins: Plugin[]): this {
    for (const p of plugins) {
      if (!p || !['codec', 'transform', 'transport'].includes(p.kind)) throw new Error('Not a plugin: expected a codec, transform or transport.');
      if (!ID.test(p.id)) throw new Error(`Invalid plugin id "${p.id}".`);
      if (!(p.options instanceof z.ZodType)) throw new Error(`Plugin ${p.id} needs a Zod options schema.`);
      this.items.set(`${p.kind}:${p.id}`, p);
    }
    return this;
  }

  codec(id: string): Codec<unknown> {
    return this.need('codec', id) as Codec<unknown>;
  }
  transform(id: string): Transform<unknown> {
    return this.need('transform', id) as Transform<unknown>;
  }
  transport(id: string): Transport<unknown> {
    return this.need('transport', id) as Transport<unknown>;
  }
  has(kind: Plugin['kind'], id: string) {
    return this.items.has(`${kind}:${id}`);
  }

  list<K extends Plugin['kind']>(kind: K): Extract<Plugin, { kind: K }>[] {
    return [...this.items.values()].filter((p): p is Extract<Plugin, { kind: K }> => p.kind === kind);
  }

  /** Best codec for the first bytes of a source, or null. */
  sniff(head: Uint8Array, meta: { name?: string; contentType?: string }): { codec: Codec<unknown>; score: number } | null {
    const text = looksText(head) ? new TextDecoder().decode(head) : null;
    let best: { codec: Codec<unknown>; score: number } | null = null;
    for (const c of this.list('codec')) {
      let s = 0;
      try {
        s = c.sniff?.(head, text, meta) ?? 0;
      } catch {
        s = 0;
      }
      const ext = meta.name && /\.([a-z0-9]+)(\?.*)?$/i.exec(meta.name)?.[1]?.toLowerCase();
      if (ext && c.extensions?.includes(ext)) s = Math.max(s, 0.6);
      if (meta.contentType && c.mime?.some((m) => meta.contentType!.toLowerCase().startsWith(m))) s = Math.max(s, 0.55);
      if (s > (best?.score ?? 0)) best = { codec: c, score: s };
    }
    return best && best.score >= 0.3 ? best : null;
  }

  /** Everything a form or an assistant needs: ids, labels and JSON Schemas of the options. */
  describe() {
    return [...this.items.values()].map((p) => ({
      kind: p.kind,
      id: p.id,
      label: p.label,
      description: p.description,
      ...(p.kind === 'transport' ? { live: p.live, relay: !!p.relay } : {}),
      ...(p.kind === 'codec' ? { extensions: p.extensions ?? [] } : {}),
      options: z.toJSONSchema(p.options, { unrepresentable: 'any', io: 'input' }),
    }));
  }

  private need(kind: Plugin['kind'], id: string): Plugin {
    const p = this.items.get(`${kind}:${id}`);
    if (!p) throw new Error(`No ${kind} called "${id}".`);
    return p;
  }
}

/** Mostly printable UTF-8 / ASCII in the first bytes. */
export function looksText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 512);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.05;
}

export const toBytes = (c: Chunk): Uint8Array => (typeof c === 'string' ? new TextEncoder().encode(c) : c);
