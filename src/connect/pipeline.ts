import { z } from 'zod';
import { column, head, isNumeric, pick, rowCount, type Batch } from './batch';
import { assemble, findRole, sampleCount, transferables, type Frame, type LogChannel, type LogFrame } from './frames';
import { toBytes, type Chunk, type ChunkMeta, type Decoder, type PluginContext, type PluginRegistry, type TransformStep, type TransportSink, type TransportState } from './plugin';

/** A connection, as saved and as an assistant would create it. */
export const ConnectorConfig = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  transport: z.object({ id: z.string(), options: z.unknown().default({}) }),
  format: z.object({ id: z.string().default('auto'), options: z.unknown().default({}) }).default({ id: 'auto', options: {} }),
  steps: z.array(z.object({ id: z.string(), options: z.unknown().default({}), enabled: z.boolean().default(true) })).default([]),
  /** where rows without a well name go: the active well, a named well, or a new well */
  target: z.object({ mode: z.enum(['auto', 'active', 'well', 'new']).default('auto'), well: z.string().default('') }).default({ mode: 'auto', well: '' }),
  /** how often the worker hands data to the page, milliseconds */
  flushMs: z.number().int().min(16).max(5000).default(100),
  /** module URLs of custom plugins this connection needs */
  plugins: z.array(z.string()).default([]),
});
export type ConnectorConfig = z.output<typeof ConnectorConfig>;
export type ConnectorInput = z.input<typeof ConnectorConfig>;

export interface Stats {
  bytes: number;
  messages: number;
  rows: number;
  samples: number;
  frames: number;
  lastAt: number;
  /** the newest time index seen (epoch ms) and the deepest depth (m) */
  lastTime: number;
  lastDepth: number;
}

// ------------------------------------------------------------------ outbox

/**
 * Collects frames and hands them to the page at most every `flushMs`, and
 * never more than `maxInFlight` batches the page has not yet acknowledged.
 * While the page is busy, new frames merge into the pending ones (log frames
 * of the same well and index concatenate), so a burst becomes one delivery
 * instead of a queue. `ready()` resolves once there is room, which lets a
 * source that can wait (a file, a poll) slow down instead of piling up.
 */
export class Outbox {
  private pending: Frame[] = [];
  private pendingSamples = 0;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters: (() => void)[] = [];
  paused = false;

  constructor(
    private readonly post: (frames: Frame[], transfer: ArrayBuffer[]) => void,
    private readonly opts: { flushMs: number; maxInFlight?: number; highWater?: number },
  ) {}

  add(frames: Frame[]) {
    for (const f of frames) {
      this.pendingSamples += sampleCount(f);
      if (f.kind === 'log') {
        const i = this.pending.findIndex((p) => p.kind === 'log' && p.well === f.well && p.index === f.index);
        if (i >= 0) {
          this.pending[i] = mergeLogs(this.pending[i] as LogFrame, f);
          continue;
        }
      }
      this.pending.push(f);
    }
    this.schedule();
  }

  ack() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.schedule();
  }

  /** after a pause: deliver what collected meanwhile */
  kick() {
    this.schedule();
  }

  /** resolves when the pending data is below the high-water mark */
  ready(): Promise<void> {
    if (this.pendingSamples < (this.opts.highWater ?? 2_000_000)) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** send everything now (end of stream), regardless of the rate limit */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.send();
  }

  private schedule() {
    if (this.timer || !this.pending.length || this.paused) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inFlight < (this.opts.maxInFlight ?? 2)) this.send();
    }, this.opts.flushMs);
  }

  private send() {
    if (!this.pending.length || this.paused) return;
    const frames = this.pending;
    this.pending = [];
    this.pendingSamples = 0;
    this.inFlight++;
    this.post(frames, [...new Set(frames.flatMap(transferables))]);
    for (const w of this.waiters.splice(0)) w();
  }
}

/** Two log frames of one well and index as one: rows appended, channels united (NaN where a frame had none). */
export function mergeLogs(a: LogFrame, b: LogFrame): LogFrame {
  const n = a.key.length + b.key.length;
  const key = new Float64Array(n);
  key.set(a.key);
  key.set(b.key, a.key.length);
  const names = [...new Set([...a.channels.map((c) => c.name), ...b.channels.map((c) => c.name)])];
  const channels: LogChannel[] = names.map((name) => {
    const ca = a.channels.find((c) => c.name === name);
    const cb = b.channels.find((c) => c.name === name);
    const values = new Float32Array(n).fill(NaN);
    if (ca) values.set(ca.values);
    if (cb) values.set(cb.values, a.key.length);
    return { name, unit: (ca ?? cb)!.unit, description: (ca ?? cb)!.description, values };
  });
  // keep index order when the second frame goes back in time (re-sent rows)
  if (b.key.length && a.key.length && b.key[0] < a.key[a.key.length - 1]) {
    const order = [...key.keys()].sort((x, y) => key[x] - key[y]);
    return { ...a, key: Float64Array.from(order, (i) => key[i]), channels: channels.map((c) => ({ ...c, values: Float32Array.from(order, (i) => c.values[i]) })) };
  }
  return { ...a, key, channels, step: a.step ?? b.step };
}

// ------------------------------------------------------------------ pipeline

export interface PipelineEvents {
  status(state: TransportState, detail?: string): void;
  log(text: string, level: 'info' | 'warn' | 'error'): void;
  /** raw batches straight from the codec, and after the steps (for previews) */
  batches?(raw: Batch[], out: Batch[]): void;
}

/**
 * One connection: transport → codec → steps → frames → outbox. Runs in a
 * worker, but has no worker dependency itself (the tests drive it directly).
 */
export class Pipeline {
  readonly stats: Stats = { bytes: 0, messages: 0, rows: 0, samples: 0, frames: 0, lastAt: 0, lastTime: -Infinity, lastDepth: -Infinity };
  private decoder: Decoder | null = null;
  private lastCodec: string | null = null;
  private codecId: string;
  private codecOptions: unknown;
  private announced: { id: string; options?: unknown } | null = null;
  /** each step, with one instance per well: a step's state (an open depth bin, a window) never mixes wells */
  private steps: { make: () => TransformStep; byWell: Map<string, TransformStep> }[] = [];
  private problems = new Set<string>();
  private ctx: PluginContext;
  private chain: Promise<void> = Promise.resolve();
  private resume: (() => void) | null = null;
  private pausedFlag = false;

  constructor(
    private readonly registry: PluginRegistry,
    private readonly config: ConnectorConfig,
    private readonly outbox: Outbox,
    private readonly events: PipelineEvents,
  ) {
    this.ctx = { log: (t, l = 'info') => events.log(t, l) };
    this.codecId = config.format.id;
    this.codecOptions = config.format.options;
    for (const s of config.steps) {
      if (!s.enabled) continue;
      const t = registry.transform(s.id);
      const options = t.options.parse(s.options ?? {});
      this.steps.push({ make: () => t.create(options, this.ctx), byWell: new Map() });
    }
  }

  /** which codec read the data, once known */
  get codec() {
    return this.lastCodec;
  }

  set paused(p: boolean) {
    this.pausedFlag = p;
    this.outbox.paused = p;
    if (!p) {
      this.resume?.();
      this.resume = null;
      this.outbox.kick();
    }
  }

  async run(signal: AbortSignal) {
    const t = this.registry.transport(this.config.transport.id);
    const options = t.options.parse(this.config.transport.options ?? {});
    const sink: TransportSink = {
      data: (chunk, meta) => this.enqueue(() => this.onChunk(chunk, meta, t.defaultCodec)),
      batches: (b) => this.enqueue(() => this.process(b)),
      status: (s, d) => this.events.status(s, d),
      log: (text, level = 'info') => this.events.log(text, level),
      format: (id, opts) => {
        this.announced = { id, options: opts };
      },
    };
    sink.next = () => this.enqueue(() => this.endStream());
    sink.cursor = () => this.stats;
    this.events.status('connecting');
    try {
      await t.open(options, sink, signal);
      await this.enqueue(() => this.finish());
      if (!signal.aborted) this.events.status(t.live ? 'idle' : 'done');
    } catch (e) {
      if (signal.aborted) return;
      await this.enqueue(() => this.finish()).catch(() => {});
      this.events.status('error', e instanceof Error ? e.message : String(e));
    }
  }

  /** Work runs one piece at a time, in arrival order, and waits while paused or while the page is behind. */
  private enqueue(fn: () => Promise<void> | void): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.pausedFlag) await new Promise<void>((r) => (this.resume = r));
      await fn();
      await this.outbox.ready();
    });
    this.chain = next.catch((e) => this.events.log(e instanceof Error ? e.message : String(e), 'error'));
    return next;
  }

  private async onChunk(chunk: Chunk, meta: ChunkMeta, fallback?: string) {
    this.stats.bytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    this.stats.messages++;
    this.stats.lastAt = Date.now();
    if (!this.decoder) this.open(chunk, meta, fallback);
    const out = await this.decoder!.push(chunk, meta);
    await this.process(out);
  }

  private open(chunk: Chunk, meta: ChunkMeta, fallback?: string) {
    let id = this.codecId;
    let options = this.codecOptions;
    if (id === 'auto') {
      const found = this.registry.sniff(toBytes(chunk).subarray(0, 4096), { name: meta.name, contentType: meta.contentType });
      if (this.announced && (!found || found.score < 0.9)) {
        id = this.announced.id;
        options = this.announced.options ?? {};
      } else if (found) {
        id = found.codec.id;
        options = {};
      } else if (fallback) {
        id = fallback;
        options = {};
      } else throw new Error(`Could not tell the format of ${meta.name ?? 'the data'}. Choose one in the connector.`);
      this.events.log(`Reading ${meta.name ? `${meta.name} ` : ''}as ${this.registry.codec(id).label}.`, 'info');
    }
    const c = this.registry.codec(id);
    this.codecId = id;
    this.lastCodec = id;
    this.decoder = c.create(c.options.parse(options ?? {}), this.ctx);
  }

  /** the current file or resource ended: finish its decoder, start fresh for the next */
  private async endStream() {
    if (!this.decoder) return;
    const out = (await this.decoder.end?.()) ?? [];
    this.decoder = null;
    if (this.config.format.id === 'auto') this.codecId = 'auto';
    await this.process(out);
  }

  private async finish() {
    await this.endStream();
    // flush each step, passing what it releases through the steps after it
    for (let i = 0; i < this.steps.length; i++) {
      for (const [well, step] of this.steps[i].byWell) {
        const released = (step.flush?.() ?? []).map((b) => (well && !b.well && !b.wellColumn ? { ...b, well } : b));
        if (released.length) await this.process(released, i + 1);
      }
    }
    this.outbox.flush();
  }

  /** Run step `i` on a batch, well by well; what a step emits keeps its well's name. */
  private applyStep(i: number, b: Batch): Batch[] {
    const st = this.steps[i];
    const run = (well: string, x: Batch) => {
      let step = st.byWell.get(well);
      if (!step) st.byWell.set(well, (step = st.make()));
      return step.apply(x).map((o) => (well && !o.well && !o.wellColumn ? { ...o, well } : o));
    };
    if (b.well) return run(b.well, b);
    const wc = b.wellColumn ? column(b, b.wellColumn) : findRole(b, 'well', (c) => !isNumeric(c));
    if (!wc || isNumeric(wc)) return run('', b);
    const names = wc.values as string[];
    const first = names[0] ?? '';
    if (names.every((n) => n === first)) return run(first, { ...b, well: first || undefined, wellColumn: first ? undefined : b.wellColumn });
    // several wells in one batch (a shared topic): one run per well, in order of appearance
    const out: Batch[] = [];
    for (const name of [...new Set(names)]) {
      const keep = new Uint8Array(names.length);
      names.forEach((n, k) => (keep[k] = +(n === name)));
      out.push(...run(name, { ...pick(b, keep), well: name || undefined, wellColumn: undefined }));
    }
    return out;
  }

  async process(raw: Batch[], from = 0) {
    if (!raw.length) return;
    let batches = raw;
    for (let i = from; i < this.steps.length; i++) batches = batches.flatMap((b) => this.applyStep(i, b));
    this.events.batches?.(from === 0 ? raw : [], batches);
    const frames: Frame[] = [];
    for (const b of batches) {
      this.stats.rows += rowCount(b);
      const r = assemble(b);
      if (r.problem && !this.problems.has(r.problem)) {
        this.problems.add(r.problem);
        this.events.log(
          `${r.problem} Columns: ${head(b, 0)
            .columns.map((c) => c.name)
            .join(', ')}.`,
          'warn',
        );
      }
      for (const f of r.frames) {
        this.stats.samples += sampleCount(f);
        if (f.kind === 'log' && f.key.length) {
          const last = f.key[f.key.length - 1];
          if (f.index === 'time') this.stats.lastTime = Math.max(this.stats.lastTime, last);
          else this.stats.lastDepth = Math.max(this.stats.lastDepth, last);
        }
      }
      frames.push(...r.frames);
    }
    this.stats.frames += frames.length;
    if (frames.length) this.outbox.add(frames);
  }
}
