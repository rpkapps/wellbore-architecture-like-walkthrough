import { z } from 'zod';

/**
 * A relay source type (Kafka, WITSML, ETP, OSDU, TCP, MQTT, HTTP). The
 * operator configures sources on the relay — with their credentials, which
 * never reach the browser — and a browser connection names a source and
 * passes the few per-connection options the adapter allows (`params`).
 *
 * An adapter reads from its system and hands the relay messages in a format
 * the browser's codecs read (it announces which with `ready`). It awaits
 * `send`, which resolves once the browser's socket has room: that is the
 * backpressure that pauses a Kafka consumer or slows a poll.
 */
export interface RelayContext<P> {
  params: P;
  signal: AbortSignal;
  /** the source is connected; `format` is the codec id for what follows (json, witsml, wits0, csv…) */
  ready(format: string, formatOptions?: unknown, detail?: string): void;
  send(payload: Uint8Array | string, meta?: { topic?: string; key?: string; ts?: number; contentType?: string }): Promise<void>;
  status(state: 'live' | 'reconnecting' | 'idle', detail?: string): void;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** the current resource is complete (the browser finishes decoding it and starts afresh) */
  end(): void;
}

export interface RelayAdapter<C = unknown, P = unknown> {
  type: string;
  label: string;
  /** server-side configuration, with credentials */
  config: z.ZodType<C>;
  /** what a browser may choose per connection */
  params: z.ZodType<P>;
  /** what the browser may see about a configured source (never credentials) */
  describe?(config: C): Record<string, unknown>;
  open(config: C, ctx: RelayContext<P>): Promise<void>;
}

export const defineAdapter = <C, P>(a: RelayAdapter<C, P>) => a;

/** "6h", "30m", "2d", an ISO date, "earliest" or "latest" → epoch ms, -1 (earliest) or null (latest). */
export function parseFrom(from: string | undefined, now = Date.now()): number | null {
  if (!from || from === 'latest') return null;
  if (from === 'earliest') return -1;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(from.trim());
  if (m) return now - +m[1] * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2] as 's']!;
  const t = Date.parse(from);
  if (Number.isFinite(t)) return t;
  throw new Error(`Cannot read "${from}" as a start point: use latest, earliest, a duration like 6h, or a date.`);
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export const backoff = (attempt: number) => Math.min(30000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

export const From = z.string().default('latest').describe('Where to start: latest, earliest, a duration back (6h, 2d) or a date');
