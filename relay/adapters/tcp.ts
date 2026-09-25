import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { z } from 'zod';
import { backoff, defineAdapter, sleep } from '../adapter';

/**
 * A raw TCP feed, typically WITS level 0 from a rig's data acquisition
 * system (or a serial-to-TCP bridge). Bytes are passed on as they arrive, in
 * pieces of at most `chunkMs`, and the browser's codec (WITS, CSV, key=value…)
 * reads the stream. Optionally sends a request line after connecting.
 */
export const tcpAdapter = defineAdapter({
  type: 'tcp',
  label: 'TCP stream (WITS level 0 and other line feeds)',
  config: z.object({
    type: z.literal('tcp'),
    label: z.string().optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    tls: z.boolean().default(false),
    format: z.string().default('wits0').describe('Codec the browser reads the stream with'),
    formatOptions: z.record(z.string(), z.unknown()).default({}),
    send: z.string().default('').describe('Text to send after connecting (e.g. a WITS request)'),
    chunkMs: z.number().int().min(10).max(5000).default(200),
  }),
  params: z.object({}),
  describe: (c) => ({ host: c.host, port: c.port, format: c.format }),
  async open(c, ctx) {
    let fails = 0;
    let announced = false;
    while (!ctx.signal.aborted) {
      const why = await new Promise<string>((resolve) => {
        const s: Socket = c.tls ? tlsConnect({ host: c.host, port: c.port, servername: c.host }) : connect({ host: c.host, port: c.port });
        let buf: Buffer[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = async () => {
          timer = undefined;
          if (!buf.length) return;
          const b = Buffer.concat(buf);
          buf = [];
          s.pause();
          await ctx.send(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), { ts: Date.now() });
          s.resume();
        };
        const abort = () => s.destroy();
        ctx.signal.addEventListener('abort', abort, { once: true });
        s.once(c.tls ? 'secureConnect' : 'connect', () => {
          fails = 0;
          if (!announced) ctx.ready(c.format, c.formatOptions, `${c.host}:${c.port}`);
          else ctx.status('live');
          announced = true;
          if (c.send) s.write(c.send.replace(/\\r/g, '\r').replace(/\\n/g, '\n'));
        });
        s.on('data', (d: Buffer) => {
          buf.push(d);
          timer ??= setTimeout(() => void flush(), c.chunkMs);
        });
        s.on('error', (e) => resolve(e.message));
        s.on('close', () => {
          ctx.signal.removeEventListener('abort', abort);
          void flush();
          resolve('Connection closed');
        });
      });
      if (ctx.signal.aborted) return;
      ctx.status('reconnecting', why);
      await sleep(backoff(fails++), ctx.signal);
    }
  },
});
