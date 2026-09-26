import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { z } from 'zod';
import { encode, compileSchema } from '../src/connect/avro';
import { createRegistry } from '../src/connect/builtins';
import type { Frame, LogFrame } from '../src/connect/frames';
import { publishPacket } from '../src/connect/mqtt';
import { ConnectorConfig, Outbox, Pipeline } from '../src/connect/pipeline';
import { interpolate, RelayConfig, startRelay, type RelayHandle } from '../relay/server';
import { fileAdapter } from '../relay/adapters/file';
import { kafkaAdapter, setKafkaFactory, type EachBatch, type KafkaLike } from '../relay/adapters/kafka';
import { mqttAdapter } from '../relay/adapters/mqtt';
import { tcpAdapter } from '../relay/adapters/tcp';
import { httpAdapter } from '../relay/adapters/http';
import { parseFrom } from '../relay/adapter';

const ADAPTERS = [fileAdapter, kafkaAdapter, mqttAdapter, tcpAdapter, httpAdapter];
let relay: RelayHandle | null = null;
afterEach(async () => {
  await relay?.close();
  relay = null;
});

/** Run the browser side (relay transport → codec → steps → frames) against the relay until `enough` says so. */
async function browse(source: string, params: Record<string, unknown>, enough: (frames: Frame[]) => boolean, token = 'secret', steps: unknown[] = []) {
  const frames: Frame[] = [];
  const logs: string[] = [];
  const stop = new AbortController();
  const box = new Outbox(
    (f) => {
      frames.push(...f);
      box.ack();
      if (enough(frames)) stop.abort();
    },
    { flushMs: 5 },
  );
  const cfg = ConnectorConfig.parse({ id: 't', name: 't', transport: { id: 'relay', options: { url: `ws://127.0.0.1:${relay!.port}`, token, source, params } }, steps });
  const p = new Pipeline(createRegistry(), cfg, box, { status: (s, d) => s === 'error' && logs.push(d ?? ''), log: (t) => logs.push(t) });
  const timer = setTimeout(() => stop.abort(), 5000);
  await p.run(stop.signal);
  clearTimeout(timer);
  return { frames, logs, codec: p.codec };
}

const rows = (frames: Frame[], index: 'time' | 'depth') => frames.filter((f): f is LogFrame => f.kind === 'log' && f.index === index).reduce((s, f) => s + f.key.length, 0);

describe('relay', () => {
  it('reads config with environment variables and parses start points', () => {
    expect(interpolate({ a: '${X}/y', b: ['${X}'] }, { X: 'v' })).toEqual({ a: 'v/y', b: ['v'] });
    expect(parseFrom('latest')).toBeNull();
    expect(parseFrom('earliest')).toBe(-1);
    expect(parseFrom('2h', 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(() => parseFrom('soon')).toThrow();
  });

  it('streams a recorded CSV feed through the relay into the browser pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    const lines = ['TIME,DBTM,DMEA,ROPA', ...Array.from({ length: 40 }, (_, i) => `2024-01-01T00:00:${String(i).padStart(2, '0')}Z,${2500 + i * 0.1},${2500 + i * 0.1},20`)];
    writeFileSync(join(dir, 'rig.csv'), lines.join('\n'));
    relay = await startRelay(RelayConfig.parse({ port: 0, tokens: ['secret'], sources: { rig: { type: 'file', path: join(dir, 'rig.csv'), rate: 400, headerLines: 1 } } }), ADAPTERS, () => {});
    const r = await browse('rig', { speed: 10 }, (f) => rows(f, 'time') >= 40, 'secret', [{ id: 'time-to-depth', options: { step: 0.5, keepTime: true } }]);
    expect(r.codec).toBe('csv');
    expect(rows(r.frames, 'time')).toBe(40);
    expect(rows(r.frames, 'depth')).toBeGreaterThan(0);
  });

  it('refuses a wrong token and an unknown source', async () => {
    relay = await startRelay(RelayConfig.parse({ port: 0, tokens: ['secret'], sources: {} }), ADAPTERS, () => {});
    const bad = await browse('rig', {}, () => false, 'nope');
    expect(bad.logs.join(' ')).toMatch(/token not accepted/i);
    const missing = await browse('rig', {}, () => false, 'secret');
    expect(missing.logs.join(' ')).toMatch(/no source "rig"/i);
  });

  it('lists sources without their credentials', async () => {
    relay = await startRelay(
      RelayConfig.parse({
        port: 0,
        tokens: ['t'],
        sources: { k: { type: 'kafka', label: 'Rig A', brokers: ['b:9092'], topics: ['rig'], sasl: { mechanism: 'plain', username: 'u', password: 'p4ss' } } },
      }),
      ADAPTERS,
      () => {},
    );
    const res = await fetch(`http://127.0.0.1:${relay.port}/sources`, { headers: { Authorization: 'Bearer t' } });
    const text = await res.text();
    expect(text).toContain('Rig A');
    expect(text).not.toContain('p4ss');
    expect((await fetch(`http://127.0.0.1:${relay.port}/sources`)).status).toBe(401);
  });

  it('decodes Avro Kafka records via a Schema Registry and filters by well', async () => {
    const schema = {
      type: 'record',
      name: 'Reading',
      fields: [
        { name: 'time', type: 'long' },
        { name: 'DBTM', type: 'double' },
        { name: 'ROPA', type: 'double' },
      ],
    };
    // a tiny HTTP schema registry
    const { createServer } = await import('node:http');
    const http = createServer((req, res) => {
      if (req.url === '/schemas/ids/3') res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ schema: JSON.stringify(schema) }));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const regPort = (http.address() as { port: number }).port;
    const t = compileSchema(schema);
    const msg = (i: number, well: string) => ({
      key: Buffer.from(well),
      value: Buffer.from([0, 0, 0, 0, 3, ...encode(t, { time: 1700000000000 + i * 1000, DBTM: 2500 + i, ROPA: 20 })]),
      timestamp: String(1700000000000 + i * 1000),
      offset: String(i),
    });
    let handler: ((p: EachBatch) => Promise<void>) | null = null;
    const fake: KafkaLike = {
      consumer: () => ({
        connect: async () => {},
        subscribe: async () => {},
        run: async (o) => {
          handler = o.eachBatch;
          setTimeout(() => {
            void handler!({
              batch: { topic: 'rig', partition: 0, messages: [msg(0, 'F-12'), msg(1, 'F-11'), msg(2, 'F-12')] },
              heartbeat: async () => {},
              resolveOffset: () => {},
              isRunning: () => true,
            });
          }, 20);
        },
        seek: () => {},
        disconnect: async () => {},
      }),
      admin: () => ({ connect: async () => {}, fetchTopicOffsetsByTimestamp: async () => [], disconnect: async () => {} }),
    };
    setKafkaFactory(async () => fake);
    relay = await startRelay(
      RelayConfig.parse({ port: 0, sources: { k: { type: 'kafka', brokers: ['x:1'], topics: ['rig'], value: 'auto', schemaRegistry: { url: `http://127.0.0.1:${regPort}` } } } }),
      ADAPTERS,
      () => {},
    );
    const r = await browse('k', { well: 'F-12' }, (f) => rows(f, 'time') >= 2, '');
    http.close();
    const f = r.frames.find((x): x is LogFrame => x.kind === 'log')!;
    expect(f.well).toBe('F-12');
    expect(Array.from(f.key)).toEqual([1700000000000, 1700000002000]);
    expect(f.channels.find((c) => c.name === 'DBTM')!.values[1]).toBe(2502);
  });

  it('relays WITS level 0 over TCP', async () => {
    const rec = (i: number) => `&&\r\n0105240301\r\n0106${String(120000 + i)}\r\n0108${2500 + i / 10}\r\n0110${2500 + i / 10}\r\n!!\r\n`;
    const rig = createNet((s) => {
      let i = 0;
      const t = setInterval(() => s.write(rec(i++)), 5);
      s.on('close', () => clearInterval(t));
      s.on('error', () => clearInterval(t));
    });
    await new Promise<void>((r) => rig.listen(0, '127.0.0.1', () => r()));
    relay = await startRelay(RelayConfig.parse({ port: 0, sources: { wits: { type: 'tcp', host: '127.0.0.1', port: (rig.address() as { port: number }).port, chunkMs: 20 } } }), ADAPTERS, () => {});
    const r = await browse('wits', {}, (f) => rows(f, 'time') >= 10, '');
    rig.close();
    expect(r.codec).toBe('wits0');
    expect(rows(r.frames, 'time')).toBeGreaterThanOrEqual(10);
  });

  it('subscribes to an MQTT broker over TCP', async () => {
    const broker = createNet((s) => {
      s.on('data', (d) => {
        if (d[0] === 0x10) s.write(Uint8Array.from([0x20, 2, 0, 0]));
        if (d[0] === 0x82) {
          s.write(Uint8Array.from([0x90, 3, 0, 1, 0]));
          for (let i = 0; i < 5; i++) s.write(publishPacket('rig/f12', JSON.stringify({ time: 1700000000000 + i * 1000, well: 'F-12', SPPA: 200 + i })));
        }
      });
      s.on('error', () => {});
    });
    await new Promise<void>((r) => broker.listen(0, '127.0.0.1', () => r()));
    relay = await startRelay(
      RelayConfig.parse({ port: 0, sources: { m: { type: 'mqtt', host: '127.0.0.1', port: (broker.address() as { port: number }).port, topics: ['rig/#'] } } }),
      ADAPTERS,
      () => {},
    );
    const r = await browse('m', {}, (f) => rows(f, 'time') >= 5, '');
    broker.close();
    expect(rows(r.frames, 'time')).toBe(5);
  });

  it('closes the source when the browser goes away', async () => {
    let aborted = false;
    const probe = {
      ...fileAdapter,
      type: 'probe',
      config: z.object({ type: z.literal('probe') }).passthrough(),
      open: async (_c: unknown, ctx: { signal: AbortSignal; ready: (f: string) => void }) => {
        ctx.ready('json');
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => ((aborted = true), r())));
      },
    };
    relay = await startRelay(RelayConfig.parse({ port: 0, sources: { p: { type: 'probe', path: 'x' } } }), [probe as never], () => {});
    const ws = new WsClient(`ws://127.0.0.1:${relay.port}`, 'borewalk-relay.v1');
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', source: 'p' }));
    await new Promise((r) => ws.on('message', r));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });
});
