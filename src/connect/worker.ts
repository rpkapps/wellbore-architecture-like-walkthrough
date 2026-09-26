/// <reference lib="webworker" />
import { head, type Batch } from './batch';
import { createRegistry, loadPluginModule } from './builtins';
import { assemble, type Frame } from './frames';
import { ConnectorConfig, Outbox, Pipeline } from './pipeline';
import type { TransportState } from './plugin';

/**
 * One worker per connection: the transport, the codec and the steps all run
 * here, off the page's thread. The page receives finished frames (with their
 * buffers transferred, not copied) and acknowledges each delivery.
 */
export type ToWorker =
  | { type: 'start'; config: unknown; files?: File[] }
  | { type: 'preview'; config: unknown; files?: File[]; rows?: number; timeoutMs?: number }
  | { type: 'describe'; plugins?: string[] }
  | { type: 'ack' }
  | { type: 'pause'; paused: boolean }
  | { type: 'stop' };

export interface PreviewResult {
  codec: string | null;
  raw: ReturnType<typeof head>[];
  out: ReturnType<typeof head>[];
  frames: { kind: Frame['kind']; well?: string; index?: string; rows: number; channels?: string[]; from?: number; to?: number }[];
  logs: { text: string; level: string }[];
  error?: string;
}

export type FromWorker =
  | { type: 'frames'; frames: Frame[] }
  | { type: 'status'; state: TransportState; detail?: string }
  | { type: 'log'; text: string; level: 'info' | 'warn' | 'error' }
  | { type: 'stats'; stats: Pipeline['stats']; codec: string | null }
  | { type: 'preview'; result: PreviewResult }
  | { type: 'describe'; plugins: ReturnType<ReturnType<typeof createRegistry>['describe']>; error?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const registry = createRegistry();
let pipeline: Pipeline | null = null;
let outbox: Outbox | null = null;
const abort = new AbortController();

async function withPlugins(urls: string[]) {
  for (const u of urls) await loadPluginModule(u, registry);
}

function parse(config: unknown, files?: File[]) {
  const c = ConnectorConfig.parse(config);
  if (files?.length) c.transport.options = { ...(c.transport.options as object), files };
  return c;
}

async function start(config: unknown, files?: File[]) {
  const c = parse(config, files);
  await withPlugins(c.plugins);
  outbox = new Outbox((frames, transfer) => post({ type: 'frames', frames }, transfer), { flushMs: c.flushMs });
  pipeline = new Pipeline(registry, c, outbox, {
    status: (state, detail) => post({ type: 'status', state, detail }),
    log: (text, level) => post({ type: 'log', text, level }),
  });
  const timer = setInterval(() => pipeline && post({ type: 'stats', stats: pipeline.stats, codec: pipeline.codec }), 1000);
  await pipeline.run(abort.signal);
  clearInterval(timer);
  post({ type: 'stats', stats: pipeline.stats, codec: pipeline.codec });
}

/** Run a connection briefly and report what it would produce: the decoded columns, the columns after the steps, and the frames. */
async function preview(config: unknown, files: File[] | undefined, rows: number, timeoutMs: number): Promise<PreviewResult> {
  const c = parse(config, files);
  await withPlugins(c.plugins);
  const raw: Batch[] = [];
  const out: Batch[] = [];
  const logs: PreviewResult['logs'] = [];
  const frames: PreviewResult['frames'] = [];
  const stop = new AbortController();
  let seen = 0;
  const box = new Outbox(() => box.ack(), { flushMs: 1_000_000 });
  const p = new Pipeline(registry, c, box, {
    status: (state, detail) => state === 'error' && logs.push({ text: detail ?? 'Error', level: 'error' }),
    log: (text, level) => logs.push({ text, level }),
    batches: (r, o) => {
      if (raw.length < 4) raw.push(...r.slice(0, 4 - raw.length));
      if (out.length < 6) out.push(...o.slice(0, 6 - out.length));
      for (const b of o) {
        for (const f of assemble(b).frames) {
          if (frames.length < 12)
            frames.push({
              kind: f.kind,
              well: f.well,
              index: f.kind === 'log' ? f.index : undefined,
              rows: f.kind === 'log' ? f.key.length : f.kind === 'production' ? f.t.length : f.md.length,
              channels: f.kind === 'log' ? f.channels.map((x) => x.name) : undefined,
              from: f.kind === 'log' ? f.key[0] : f.kind === 'survey' || f.kind === 'tops' ? f.md[0] : f.t[0],
              to: f.kind === 'log' ? f.key[f.key.length - 1] : f.kind === 'survey' || f.kind === 'tops' ? f.md[f.md.length - 1] : f.t[f.t.length - 1],
            });
        }
        seen += b.columns[0]?.values.length ?? 0;
      }
      if (seen >= rows) stop.abort();
    },
  });
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  let error: string | undefined;
  try {
    await p.run(stop.signal);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  clearTimeout(timer);
  return { codec: p.codec, raw: raw.map((b) => head(b, 8)), out: out.map((b) => head(b, 8)), frames, logs, error: error ?? logs.find((l) => l.level === 'error')?.text };
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'start':
        await start(m.config, m.files);
        break;
      case 'preview':
        post({ type: 'preview', result: await preview(m.config, m.files, m.rows ?? 200, m.timeoutMs ?? 6000) });
        break;
      case 'describe':
        try {
          await withPlugins(m.plugins ?? []);
          post({ type: 'describe', plugins: registry.describe() });
        } catch (err) {
          post({ type: 'describe', plugins: registry.describe(), error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'ack':
        outbox?.ack();
        break;
      case 'pause':
        if (pipeline) pipeline.paused = m.paused;
        break;
      case 'stop':
        abort.abort();
        outbox?.flush();
        break;
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (m.type === 'preview') post({ type: 'preview', result: { codec: null, raw: [], out: [], frames: [], logs: [], error: text } });
    else post({ type: 'status', state: 'error', detail: text });
  }
};
