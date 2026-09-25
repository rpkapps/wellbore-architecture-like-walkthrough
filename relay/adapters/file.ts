import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { defineAdapter, sleep } from '../adapter';

/**
 * Plays a recorded feed from a file on the relay at a steady pace: lines of
 * CSV, JSON, key=value or WITS records. For demos, and for testing a codec
 * and its steps against a real capture before the real source is available.
 */
export const fileAdapter = defineAdapter({
  type: 'file',
  label: 'Recorded feed (file on the relay)',
  config: z.object({
    type: z.literal('file'),
    label: z.string().optional(),
    path: z.string().min(1),
    format: z.string().default('csv'),
    formatOptions: z.record(z.string(), z.unknown()).default({}),
    /** lines (or WITS records) per second; 0 sends the whole file at once */
    rate: z.number().min(0).default(10),
    loop: z.boolean().default(false),
    /** lines at the top sent first as one message (a CSV header) */
    headerLines: z.number().int().min(0).default(0),
  }),
  params: z.object({ speed: z.number().min(0.1).max(1000).default(1).describe('Playback speed') }),
  describe: (c) => ({ format: c.format, rate: c.rate }),
  async open(c, ctx) {
    const text = await readFile(c.path, 'utf8');
    ctx.ready(c.format, c.formatOptions, c.path.split(/[\\/]/).pop());
    if (!c.rate) {
      await ctx.send(text);
      ctx.end();
      return;
    }
    // WITS records are "&&" … "!!" blocks; everything else goes line by line
    const units = c.format === 'wits0' ? (text.match(/&&[\s\S]*?!!\r?\n?/g) ?? []) : text.split(/\r?\n/).filter((l) => l.trim());
    const head = units.slice(0, c.headerLines);
    const body = units.slice(c.headerLines);
    const sep = c.format === 'wits0' ? '' : '\n';
    do {
      if (head.length) await ctx.send(head.join(sep) + sep);
      const perTick = Math.max(1, Math.round((c.rate * ctx.params.speed) / 4));
      for (let i = 0; i < body.length && !ctx.signal.aborted; i += perTick) {
        await ctx.send(body.slice(i, i + perTick).join(sep) + sep, { ts: Date.now() });
        await sleep(250, ctx.signal);
      }
      if (c.loop) ctx.end();
    } while (c.loop && !ctx.signal.aborted);
  },
});
