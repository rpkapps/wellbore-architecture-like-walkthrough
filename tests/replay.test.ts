import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRegistry } from '../src/connect/builtins';
import type { Frame, LogFrame } from '../src/connect/frames';
import { REPLAY_OFFSETS } from '../src/connect/offsets';
import { ConnectorConfig, Outbox, Pipeline } from '../src/connect/pipeline';
import { LiveLog } from '../src/connect/store';

it('a replayed well arrives in small deliveries and its live log has no gaps', async () => {
  const root = join(process.cwd(), 'public/data/volve');
  const srv = createServer(async (req, res) => {
    try {
      res.end(await readFile(join(root, decodeURIComponent(new URL(req.url!, 'http://x').pathname))));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  (globalThis as { self?: unknown }).self = { location: { href: base } };
  const frames: Frame[] = [];
  const stop = new AbortController();
  const box = new Outbox(
    (f) => {
      frames.push(...f);
      box.ack();
    },
    { flushMs: 16 },
  );
  const cfg = ConnectorConfig.parse({
    id: 'r',
    name: 'r',
    transport: { id: 'replay', options: { baseUrl: base, speed: 240, fromMd: 4170 } },
    steps: [{ id: 'map' }, { id: 'units' }, { id: 'time-to-depth', options: { step: 0.1524, offsets: REPLAY_OFFSETS } }],
  });
  const p = new Pipeline(createRegistry(), cfg, box, { status() {}, log() {} });
  setTimeout(() => stop.abort(), 9000);
  await p.run(stop.signal);
  srv.close();
  const logs = frames.filter((f): f is LogFrame => f.kind === 'log' && f.index === 'depth');
  const live = new LiveLog(undefined, 'x');
  for (const f of logs) live.merge(f.key, f.channels, f.step);
  const v = live.view('w');
  // every channel is continuous from the start (less its sensor offset) to its last reading
  const gaps: string[] = [];
  for (const name of ['ROPA', 'GR', 'RDEP']) {
    const vals = v.curves.get(name)!.values;
    let last = -1;
    for (let i = 0; i < v.depth.length; i++) if (!Number.isNaN(vals[i])) last = i;
    let s = -1;
    for (let i = 0; i <= last; i++) {
      if (v.depth[i] < 4171) continue;
      const nan = Number.isNaN(vals[i]);
      if (nan && s < 0) s = i;
      if (!nan && s >= 0) {
        gaps.push(`${name} ${v.depth[s].toFixed(2)}–${v.depth[i].toFixed(2)}`);
        s = -1;
      }
    }
  }
  expect(v.depth[v.depth.length - 1]).toBeGreaterThan(4185);
  expect(gaps).toEqual([]);
}, 30000);
