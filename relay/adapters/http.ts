import { z } from 'zod';
import { backoff, defineAdapter, sleep } from '../adapter';

/**
 * An HTTP API the browser cannot call itself: it needs a secret header, or
 * does not allow the page's origin (CORS). Covers historians and REST APIs
 * such as the PI Web API (e.g. …/streams/{webId}/recorded?startTime={lastTime}).
 * Polls, or fetches once when `interval` is 0. {lastTime} and {now} are
 * replaced as in the browser's polling transport.
 */
export const httpAdapter = defineAdapter({
  type: 'http',
  label: 'HTTP API (server-side)',
  config: z.object({
    type: z.literal('http'),
    label: z.string().optional(),
    url: z.string().min(1),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().default(''),
    interval: z.number().min(0).default(10),
    format: z.string().default('json').describe('Codec the browser reads responses with'),
    formatOptions: z.record(z.string(), z.unknown()).default({}),
    /** a JSON path to the newest timestamp in a response, to fill {lastTime} next time */
    cursor: z.string().default(''),
  }),
  params: z.object({ from: z.string().default('1h').describe('How far back the first request reaches (a duration like 6h)') }),
  describe: (c) => ({ url: c.url.replace(/[?#].*$/, ''), interval: c.interval, format: c.format }),
  async open(c, ctx) {
    const m = /^(\d+)(m|h|d)$/.exec(ctx.params.from);
    let last = Date.now() - (m ? +m[1] * { m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as 'm'] : 3.6e6);
    let fails = 0;
    let etag = '';
    let announced = false;
    const fill = (s: string) => s.replaceAll('{lastTime}', encodeURIComponent(new Date(last).toISOString())).replaceAll('{now}', encodeURIComponent(new Date().toISOString()));
    while (!ctx.signal.aborted) {
      const t0 = Date.now();
      try {
        const res = await fetch(fill(c.url), {
          method: c.method,
          headers: { ...c.headers, ...(etag ? { 'If-None-Match': etag } : {}) },
          body: c.method === 'POST' ? fill(c.body) : undefined,
          signal: ctx.signal,
        });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`The API refused the relay's credentials (${res.status}).`), { fatal: true });
        if (res.status !== 304) {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          etag = res.headers.get('etag') ?? '';
          const buf = new Uint8Array(await res.arrayBuffer());
          if (!announced) ctx.ready(c.format, c.formatOptions, c.url.replace(/[?#].*$/, ''));
          announced = true;
          if (buf.length) await ctx.send(buf, { contentType: res.headers.get('content-type') ?? undefined, ts: Date.now() });
          if (c.cursor) {
            try {
              const j = JSON.parse(Buffer.from(buf).toString('utf8'));
              const v = c.cursor.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), j);
              const t = typeof v === 'number' ? v : Date.parse(String(v));
              if (Number.isFinite(t)) last = t;
            } catch {
              /* not JSON: keep the previous cursor */
            }
          } else last = t0;
        }
        fails = 0;
        ctx.status('live');
      } catch (e) {
        if (ctx.signal.aborted) return;
        if ((e as { fatal?: boolean }).fatal) throw e;
        ctx.status('reconnecting', e instanceof Error ? e.message : String(e));
        await sleep(backoff(fails++), ctx.signal);
        continue;
      }
      if (!c.interval) return;
      await sleep(Math.max(0, c.interval * 1000 - (Date.now() - t0)), ctx.signal);
    }
  },
});
