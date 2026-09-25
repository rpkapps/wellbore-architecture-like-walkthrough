import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { RelayAdapter, RelayContext } from './adapter';
import { ADAPTERS } from './adapters';

/**
 * The BoreWalk relay: one small Node process between the browser and the
 * systems a browser cannot (or should not) reach directly. Browsers connect
 * over WebSocket, name a configured source and get its data as messages the
 * app's codecs read. Credentials live only in the relay's configuration.
 */
export const RelayConfig = z.object({
  port: z.number().int().default(8787),
  host: z.string().default('0.0.0.0'),
  /** access tokens a browser must present; empty = no check (local development only) */
  tokens: z.array(z.string()).default([]),
  /** page origins allowed to connect; empty = any */
  origins: z.array(z.string()).default([]),
  maxConnections: z.number().int().min(1).default(64),
  /** bytes a browser may lag behind before a source is paused */
  highWater: z
    .number()
    .int()
    .default(8 * 1024 * 1024),
  sources: z.record(z.string(), z.object({ type: z.string(), label: z.string().optional() }).passthrough()).default({}),
});
export type RelayConfig = z.output<typeof RelayConfig>;

/** "${NAME}" in any string of the config reads the environment variable NAME. */
export function interpolate<T>(v: T, env: Record<string, string | undefined> = process.env): T {
  if (typeof v === 'string') return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k: string) => env[k] ?? '') as T;
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)])) as T;
  return v;
}

export function loadConfig(path: string): RelayConfig {
  return RelayConfig.parse(interpolate(JSON.parse(readFileSync(path, 'utf8'))));
}

const PROTOCOL = 'borewalk-relay.v1';

function tokenOk(cfg: RelayConfig, token: unknown): boolean {
  if (!cfg.tokens.length) return true;
  if (typeof token !== 'string') return false;
  const t = Buffer.from(token);
  return cfg.tokens.some((k) => {
    const b = Buffer.from(k);
    return b.length === t.length && timingSafeEqual(b, t);
  });
}

function originOk(cfg: RelayConfig, origin: string | undefined): boolean {
  return !cfg.origins.length || (!!origin && cfg.origins.includes(origin));
}

function envelope(meta: Record<string, unknown>, payload: Uint8Array | string): Buffer {
  const text = typeof payload === 'string';
  const head = Buffer.from(JSON.stringify(text ? { ...meta, text: true } : meta));
  const body = text ? Buffer.from(payload) : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const out = Buffer.allocUnsafe(4 + head.length + body.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  body.copy(out, 4 + head.length);
  return out;
}

export interface RelayHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startRelay(cfg: RelayConfig, adapters: RelayAdapter<any, any>[] = ADAPTERS, log = (s: string) => console.log(s)): Promise<RelayHandle> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  const byType = new Map(adapters.map((a) => [a.type, a]));
  for (const [id, s] of Object.entries(cfg.sources)) {
    const a = byType.get(s.type);
    if (!a) throw new Error(`Source "${id}": unknown type "${s.type}" (known: ${[...byType.keys()].join(', ')}).`);
    const p = a.config.safeParse(s);
    if (!p.success) throw new Error(`Source "${id}": ${z.prettifyError(p.error)}`);
  }
  if (!cfg.tokens.length) log('relay: no access tokens configured — anyone who can reach this port can read the sources');

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const o = req.headers.origin;
    if (o && originOk(cfg, o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
  };

  const server = createServer((req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname === '/health') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, connections: wss.clients.size }));
    if (url.pathname === '/sources') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!tokenOk(cfg, token)) return void res.writeHead(401).end();
      const list = Object.entries(cfg.sources).map(([id, s]) => {
        const a = byType.get(s.type)!;
        const c = a.config.parse(s);
        return { id, type: s.type, label: s.label ?? id, adapter: a.label, params: z.toJSONSchema(a.params, { io: 'input', unrepresentable: 'any' }), info: a.describe?.(c) ?? {} };
      });
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    verifyClient: (info, cb) => {
      if (!originOk(cfg, info.origin)) return cb(false, 403, 'Origin not allowed');
      if (wss.clients.size >= cfg.maxConnections) return cb(false, 503, 'Too many connections');
      cb(true);
    },
    maxPayload: 1024 * 1024,
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const who = `${req.socket.remoteAddress ?? '?'}`;
    const abort = new AbortController();
    const control = (m: Record<string, unknown>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const fail = (text: string) => {
      control({ type: 'error', text, fatal: true });
      ws.close(1008, text.slice(0, 120));
    };
    const hello = setTimeout(() => fail('No hello within 10 s.'), 10_000);
    let started = false;
    ws.on('close', () => {
      clearTimeout(hello);
      abort.abort();
    });
    ws.on('message', (data, isBinary) => {
      if (started || isBinary) return;
      started = true;
      clearTimeout(hello);
      let m: { type?: string; token?: unknown; source?: unknown; params?: unknown };
      try {
        m = JSON.parse(String(data));
      } catch {
        return fail('Expected a JSON hello message.');
      }
      if (m.type !== 'hello') return fail('Expected a hello message.');
      if (!tokenOk(cfg, m.token)) return fail('Access token not accepted.');
      const id = String(m.source ?? '');
      const s = cfg.sources[id];
      if (!s) return fail(`No source "${id}" on this relay.`);
      const a = byType.get(s.type)!;
      const params = a.params.safeParse(m.params ?? {});
      if (!params.success) return fail(`Options for "${id}": ${z.prettifyError(params.error)}`);
      log(`relay: ${who} opened ${id} (${s.type})`);
      const ctx: RelayContext<unknown> = {
        params: params.data,
        signal: abort.signal,
        ready: (format, formatOptions, detail) => control({ type: 'ready', format, formatOptions, detail }),
        status: (state, detail) => control({ type: 'status', state, detail }),
        log: (text, level = 'info') => control({ type: 'log', text, level }),
        end: () => control({ type: 'end' }),
        send: async (payload, meta = {}) => {
          if (ws.readyState !== ws.OPEN) return;
          // the browser is behind: wait for its socket to drain (pauses Kafka, slows polls)
          while (ws.bufferedAmount > cfg.highWater && ws.readyState === ws.OPEN && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 25));
          if (ws.readyState === ws.OPEN) ws.send(envelope(meta, payload));
        },
      };
      a.open(a.config.parse(s), ctx).then(
        () => {
          if (ws.readyState === ws.OPEN) ws.close(1000, 'Source finished');
        },
        (e: unknown) => {
          if (abort.signal.aborted) return;
          const text = e instanceof Error ? e.message : String(e);
          log(`relay: ${id} failed for ${who}: ${text}`);
          fail(text);
        },
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      log(`relay: listening on ${cfg.host}:${port} with ${Object.keys(cfg.sources).length} source(s)`);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}

// run as a program: node relay/dist/relay.mjs [config.json]
const isMain = typeof process !== 'undefined' && process.argv[1] && /relay(\.m?js|\/server\.ts)$/.test(process.argv[1]);
if (isMain) {
  const path = process.argv[2] ?? process.env.RELAY_CONFIG ?? 'relay.config.json';
  startRelay(loadConfig(path)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
