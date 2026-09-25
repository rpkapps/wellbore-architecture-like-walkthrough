import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { z } from 'zod';
import { MqttSession, topicMatches } from '../../src/connect/mqtt';
import { backoff, defineAdapter, sleep } from '../adapter';

/** MQTT brokers reachable only over TCP (1883 / 8883), with credentials kept on the relay. */
export const mqttAdapter = defineAdapter({
  type: 'mqtt',
  label: 'MQTT broker (TCP)',
  config: z.object({
    type: z.literal('mqtt'),
    label: z.string().optional(),
    host: z.string().min(1),
    port: z.number().int().default(1883),
    tls: z.boolean().default(false),
    username: z.string().default(''),
    password: z.string().default(''),
    topics: z.array(z.string().min(1)).min(1),
    qos: z.union([z.literal(0), z.literal(1)]).default(0),
    format: z.string().default('json').describe('Codec the browser reads payloads with'),
  }),
  params: z.object({ topics: z.array(z.string()).default([]).describe('A subset of the configured topic filters') }),
  describe: (c) => ({ host: c.host, topics: c.topics, format: c.format }),
  async open(c, ctx) {
    const topics = ctx.params.topics.length ? c.topics.filter((t) => ctx.params.topics.includes(t)) : c.topics;
    let fails = 0;
    let announced = false;
    while (!ctx.signal.aborted) {
      const why = await new Promise<string>((resolve) => {
        const s = c.tls ? tlsConnect({ host: c.host, port: c.port, servername: c.host }) : connect({ host: c.host, port: c.port });
        const session = new MqttSession(
          {
            clientId: `borewalk-relay-${Math.random().toString(36).slice(2, 10)}`,
            username: c.username || undefined,
            password: c.password || undefined,
            topics: topics.map((topic) => ({ topic, qos: c.qos })),
          },
          (b) => s.write(b),
        );
        session.onReady = () => {
          fails = 0;
          if (!announced) ctx.ready(c.format, {}, `${c.host} ${topics.join(', ')}`);
          else ctx.status('live');
          announced = true;
        };
        session.onError = (e) => {
          ctx.log(e.message, 'error');
          s.destroy();
        };
        session.onMessage = (m) => {
          if (!topics.some((t) => topicMatches(t, m.topic))) return;
          s.pause();
          void ctx.send(m.payload, { topic: m.topic, key: m.topic, ts: Date.now() }).then(() => s.resume());
        };
        const abort = () => {
          session.stop();
          s.destroy();
        };
        ctx.signal.addEventListener('abort', abort, { once: true });
        s.once(c.tls ? 'secureConnect' : 'connect', () => session.start());
        s.on('data', (d: Buffer) => session.feed(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
        s.on('error', (e) => resolve(e.message));
        s.on('close', () => {
          ctx.signal.removeEventListener('abort', abort);
          session.stop();
          resolve('Connection closed');
        });
      });
      if (ctx.signal.aborted) return;
      ctx.status('reconnecting', why);
      await sleep(backoff(fails++), ctx.signal);
    }
  },
});
