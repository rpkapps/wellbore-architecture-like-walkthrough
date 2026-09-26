import { z } from 'zod';
import { MqttSession, topicMatches } from './mqtt';
import { defineTransport, type TransportSink } from './plugin';

/**
 * The transports that run in the browser. Each keeps going until its
 * AbortSignal fires; the live ones reconnect with backoff. Anything that
 * needs credentials the browser should not hold, or a protocol a browser
 * cannot speak (Kafka, TCP, SOAP with CORS), goes through the relay.
 */

const Headers = z.record(z.string(), z.string()).default({}).describe('Request headers (e.g. Authorization); kept in this browser only');

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** 1 s, 2 s, 4 s … up to 30 s, with jitter. */
const backoff = (attempt: number) => Math.min(30000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

async function streamBody(res: Response, name: string, sink: TransportSink, signal: AbortSignal) {
  const type = res.headers.get('content-type') ?? undefined;
  if (!res.body) {
    await sink.data(new Uint8Array(await res.arrayBuffer()), { complete: false, name, contentType: type });
    return;
  }
  const reader = res.body.getReader();
  signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) break;
    await sink.data(value, { complete: false, name, contentType: type });
  }
}

// ------------------------------------------------------------------ files

/** Files handed over by the page (a picker or a drop); the worker receives the File objects. */
export const fileTransport = defineTransport<{ files: File[] }>({
  id: 'file',
  label: 'Files',
  description: 'Files from this computer (dropped or picked), read in the background in pieces, however large.',
  live: false,
  options: z.object({ files: z.array(z.custom<File>((f) => typeof Blob !== 'undefined' && f instanceof Blob)).default([]) }),
  async open(o, sink, signal) {
    for (const f of o.files) {
      if (signal.aborted) return;
      sink.status('live', f.name);
      const reader = f.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        await sink.data(value, { complete: false, name: f.name, contentType: f.type || undefined });
      }
      await sink.next?.();
    }
  },
});

// ------------------------------------------------------------------ one fetch

const UrlOptions = z.object({
  url: z.string().url().describe('Address of the file or API'),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: Headers,
  body: z.string().default('').describe('Request body for POST'),
});

export const urlTransport = defineTransport<z.output<typeof UrlOptions>>({
  id: 'url',
  label: 'URL',
  description: 'Fetch a file or an API response once (the server must allow this site: CORS).',
  live: false,
  options: UrlOptions,
  async open(o, sink, signal) {
    const res = await fetch(o.url, { method: o.method, headers: o.headers, body: o.method === 'POST' ? o.body : undefined, signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${o.url}`);
    sink.status('live');
    await streamBody(res, new URL(o.url).pathname.split('/').pop() || o.url, sink, signal);
  },
});

// ------------------------------------------------------------------ polling

const PollOptions = z.object({
  url: z.string().min(1).describe('Address to poll. {lastTime} (ISO), {lastTimeMs}, {lastDepth} and {now} are replaced, so only new data is asked for'),
  interval: z.number().min(0.2).max(86400).default(5).describe('Seconds between requests'),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: Headers,
  body: z.string().default('').describe('Request body for POST (the same placeholders work)'),
});

function fill(t: string, sink: TransportSink): string {
  const c = sink.cursor?.() ?? { lastTime: -Infinity, lastDepth: -Infinity };
  const lt = Number.isFinite(c.lastTime) ? c.lastTime : Date.now() - 3600_000;
  return t
    .replaceAll('{lastTime}', encodeURIComponent(new Date(lt).toISOString()))
    .replaceAll('{lastTimeMs}', String(Math.round(lt)))
    .replaceAll('{lastDepth}', Number.isFinite(c.lastDepth) ? String(c.lastDepth) : '0')
    .replaceAll('{now}', encodeURIComponent(new Date().toISOString()));
}

export const pollTransport = defineTransport<z.output<typeof PollOptions>>({
  id: 'poll',
  label: 'REST polling',
  description: 'Ask an HTTP API for new data every few seconds (conditional requests, so an unchanged answer costs nothing).',
  live: true,
  defaultCodec: 'json',
  options: PollOptions,
  async open(o, sink, signal) {
    let etag = '';
    let modified = '';
    let fails = 0;
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        const headers: Record<string, string> = { ...o.headers };
        if (etag) headers['If-None-Match'] = etag;
        if (modified) headers['If-Modified-Since'] = modified;
        const url = fill(o.url, sink);
        const res = await fetch(url, { method: o.method, headers, body: o.method === 'POST' ? fill(o.body, sink) : undefined, signal });
        if (res.status !== 304) {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          etag = res.headers.get('etag') ?? '';
          modified = res.headers.get('last-modified') ?? '';
          const body = new Uint8Array(await res.arrayBuffer());
          if (body.length) await sink.data(body, { complete: true, name: new URL(url, 'http://x').pathname, contentType: res.headers.get('content-type') ?? undefined, ts: Date.now() });
        }
        fails = 0;
        sink.status('live');
      } catch (e) {
        if (signal.aborted) return;
        sink.status('reconnecting', e instanceof Error ? e.message : String(e));
        await sleep(backoff(fails++), signal);
        continue;
      }
      await sleep(Math.max(0, o.interval * 1000 - (Date.now() - t0)), signal);
    }
  },
});

// ------------------------------------------------------------------ server-sent events

const SseOptions = z.object({
  url: z.string().url().describe('Event stream address'),
  events: z.array(z.string()).default([]).describe('Event names to read (empty: all)'),
  headers: Headers,
});

export const sseTransport = defineTransport<z.output<typeof SseOptions>>({
  id: 'sse',
  label: 'Server-sent events',
  description: 'An HTTP event stream (text/event-stream). Reconnects where it left off, and unlike EventSource can send an Authorization header.',
  live: true,
  defaultCodec: 'json',
  options: SseOptions,
  async open(o, sink, signal) {
    let lastId = '';
    let retry = 0;
    let fails = 0;
    while (!signal.aborted) {
      try {
        const res = await fetch(o.url, { headers: { Accept: 'text/event-stream', ...o.headers, ...(lastId ? { 'Last-Event-ID': lastId } : {}) }, signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
        sink.status('live');
        fails = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        let event = '';
        let data: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done || signal.aborted) break;
          buf += value;
          const lines = buf.split(/\r\n|\n|\r/);
          buf = lines.pop()!;
          for (const line of lines) {
            if (line === '') {
              if (data.length && (!o.events.length || o.events.includes(event || 'message'))) await sink.data(data.join('\n'), { complete: true, name: event || 'message', ts: Date.now() });
              event = '';
              data = [];
            } else if (line.startsWith(':')) continue;
            else {
              const i = line.indexOf(':');
              const field = i < 0 ? line : line.slice(0, i);
              const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
              if (field === 'data') data.push(val);
              else if (field === 'event') event = val;
              else if (field === 'id') lastId = val;
              else if (field === 'retry' && /^\d+$/.test(val)) retry = +val;
            }
          }
        }
        if (signal.aborted) return;
        sink.status('reconnecting', 'Stream closed');
        await sleep(retry || 1000, signal);
      } catch (e) {
        if (signal.aborted) return;
        sink.status('reconnecting', e instanceof Error ? e.message : String(e));
        await sleep(backoff(fails++), signal);
      }
    }
  },
});

// ------------------------------------------------------------------ WebSocket

const WsOptions = z.object({
  url: z
    .string()
    .regex(/^wss?:\/\//, 'Use a ws:// or wss:// address')
    .describe('WebSocket address'),
  protocols: z.array(z.string()).default([]).describe('Sub-protocols'),
  send: z.array(z.string()).default([]).describe('Messages to send after connecting (e.g. a subscribe request)'),
});

/** A WebSocket session until it closes; resolves on close, rejects on an error before opening. */
function socket(url: string, protocols: string[], signal: AbortSignal, onOpen: (ws: WebSocket) => void, onMessage: (d: string | Uint8Array) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols.length ? protocols : undefined);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    const abort = () => ws.close(1000);
    signal.addEventListener('abort', abort, { once: true });
    ws.onopen = () => {
      opened = true;
      onOpen(ws);
    };
    ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    ws.onerror = () => {
      if (!opened) reject(new Error(`Could not connect to ${url}`));
    };
    ws.onclose = (e) => {
      signal.removeEventListener('abort', abort);
      resolve(e.reason || `closed (${e.code})`);
    };
  });
}

export const websocketTransport = defineTransport<z.output<typeof WsOptions>>({
  id: 'websocket',
  label: 'WebSocket',
  description: 'Messages from a WebSocket server, text or binary; reconnects if the connection drops.',
  live: true,
  defaultCodec: 'json',
  options: WsOptions,
  async open(o, sink, signal) {
    let fails = 0;
    while (!signal.aborted) {
      try {
        const why = await socket(
          o.url,
          o.protocols,
          signal,
          (ws) => {
            fails = 0;
            sink.status('live');
            for (const m of o.send) ws.send(m);
          },
          (d) => void sink.data(d, { complete: true, ts: Date.now() }),
        );
        if (signal.aborted) return;
        sink.status('reconnecting', why);
      } catch (e) {
        if (signal.aborted) return;
        sink.status('reconnecting', e instanceof Error ? e.message : String(e));
      }
      await sleep(backoff(fails++), signal);
    }
  },
});

// ------------------------------------------------------------------ MQTT over WebSocket

const MqttOptionsSchema = z.object({
  url: z
    .string()
    .regex(/^wss?:\/\//, 'Use the broker’s ws:// or wss:// address (often …/mqtt)')
    .describe('Broker WebSocket address'),
  topics: z.array(z.string().min(1)).min(1).describe('Topics to subscribe to (+ and # wildcards work)'),
  qos: z
    .union([z.literal(0), z.literal(1)])
    .default(0)
    .describe('Delivery guarantee'),
  username: z.string().default(''),
  password: z.string().default(''),
  clientId: z.string().default('').describe('Client id (empty: generated)'),
});

export const mqttTransport = defineTransport<z.output<typeof MqttOptionsSchema>>({
  id: 'mqtt',
  label: 'MQTT',
  description: 'Subscribe to topics on an MQTT broker over WebSocket (Mosquitto, HiveMQ, EMQX, AWS IoT, Azure IoT…). Each message is read with the chosen format.',
  live: true,
  defaultCodec: 'json',
  options: MqttOptionsSchema,
  async open(o, sink, signal) {
    let fails = 0;
    const clientId = o.clientId || `borewalk-${Math.random().toString(36).slice(2, 10)}`;
    while (!signal.aborted) {
      let session: MqttSession | null = null;
      try {
        const why = await socket(
          o.url,
          ['mqtt'],
          signal,
          (ws) => {
            session = new MqttSession({ clientId, username: o.username || undefined, password: o.password || undefined, topics: o.topics.map((topic) => ({ topic, qos: o.qos })) }, (b) => ws.send(b));
            session.onReady = () => {
              fails = 0;
              sink.status('live');
            };
            session.onError = (e) => {
              sink.log(e.message, 'error');
              ws.close();
            };
            session.onMessage = (m) => {
              if (o.topics.some((t) => topicMatches(t, m.topic))) void sink.data(m.payload, { complete: true, name: m.topic, key: m.topic, ts: Date.now() });
            };
            session.start();
          },
          (d) => session?.feed(typeof d === 'string' ? new TextEncoder().encode(d) : d),
        );
        (session as MqttSession | null)?.stop();
        if (signal.aborted) return;
        sink.status('reconnecting', why);
      } catch (e) {
        if (signal.aborted) return;
        sink.status('reconnecting', e instanceof Error ? e.message : String(e));
      }
      await sleep(backoff(fails++), signal);
    }
  },
});

// ------------------------------------------------------------------ the relay

const RelayOptions = z.object({
  url: z
    .string()
    .regex(/^wss?:\/\//, 'Use the relay’s ws:// or wss:// address')
    .describe('Relay address, e.g. wss://relay.example.com'),
  token: z.string().default('').describe('Relay access token'),
  source: z.string().min(1).describe('A source configured on the relay (its id)'),
  params: z.record(z.string(), z.unknown()).default({}).describe('Options the relay allows per connection, e.g. {"from": "6h", "well": "F-12"}'),
});

/**
 * The relay speaks a small protocol: the page sends `hello` with its token,
 * the source and options; the relay answers `ready` with the format of what
 * follows, then sends each message as a binary envelope
 * (u32 header length, JSON header {topic, key, ts}, payload).
 */
export const relayTransport = defineTransport<z.output<typeof RelayOptions>>({
  id: 'relay',
  label: 'Relay',
  description:
    'A source behind the BoreWalk relay: Kafka topics (JSON, Avro or Protobuf with a Schema Registry), WITSML stores, ETP 1.1 / 1.2 servers, OSDU, WITS over TCP, MQTT over TCP, or an HTTP API. Credentials stay on the relay.',
  live: true,
  relay: true,
  options: RelayOptions,
  async open(o, sink, signal) {
    let fails = 0;
    const td = new TextDecoder();
    while (!signal.aborted) {
      let fatal = '';
      try {
        const why = await socket(
          o.url,
          ['borewalk-relay.v1'],
          signal,
          (ws) => ws.send(JSON.stringify({ type: 'hello', token: o.token, source: o.source, params: o.params })),
          (d) => {
            if (typeof d === 'string') {
              const m = JSON.parse(d) as { type: string; format?: string; formatOptions?: unknown; state?: string; detail?: string; text?: string; level?: 'info' | 'warn' | 'error'; fatal?: boolean };
              if (m.type === 'ready') {
                fails = 0;
                if (m.format) sink.format?.(m.format, m.formatOptions);
                sink.status('live', m.detail);
              } else if (m.type === 'status') sink.status((m.state as never) ?? 'live', m.detail);
              else if (m.type === 'log') sink.log(m.text ?? '', m.level ?? 'info');
              else if (m.type === 'error') {
                sink.log(m.text ?? 'Relay error', 'error');
                if (m.fatal) fatal = m.text ?? 'Relay error';
              } else if (m.type === 'end') void sink.next?.();
              return;
            }
            const n = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0);
            const h = JSON.parse(td.decode(d.subarray(4, 4 + n))) as { topic?: string; key?: string; ts?: number; text?: boolean; contentType?: string };
            const payload = d.subarray(4 + n);
            void sink.data(h.text ? td.decode(payload) : payload, { complete: true, name: h.topic, key: h.key, ts: h.ts, contentType: h.contentType });
          },
        );
        if (signal.aborted) return;
        if (fatal) throw new Error(fatal);
        sink.status('reconnecting', why);
      } catch (e) {
        if (signal.aborted) return;
        if (fatal) throw e;
        sink.status('reconnecting', e instanceof Error ? e.message : String(e));
      }
      await sleep(backoff(fails++), signal);
    }
  },
});

export { sleep, backoff };
