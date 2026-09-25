/**
 * MQTT 3.1.1, the parts a subscriber needs: CONNECT, SUBSCRIBE, PUBLISH in
 * (QoS 0 and 1, acknowledged), PING and DISCONNECT. The byte transport is
 * pluggable: a WebSocket in the browser (brokers expose MQTT over WebSocket
 * on /mqtt) or a TCP socket in the relay.
 */
export interface MqttOptions {
  clientId: string;
  username?: string;
  password?: string;
  keepalive?: number; // seconds
  topics: { topic: string; qos: 0 | 1 }[];
}

export interface MqttMessage {
  topic: string;
  payload: Uint8Array;
  retain: boolean;
}

const te = new TextEncoder();
const td = new TextDecoder();

function str(s: string): number[] {
  const b = te.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function remaining(n: number): number[] {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

const packet = (type: number, body: number[]) => Uint8Array.from([type, ...remaining(body.length), ...body]);

export function connectPacket(o: MqttOptions): Uint8Array {
  let flags = 0x02; // clean session
  if (o.username) flags |= 0x80;
  if (o.password) flags |= 0x40;
  const ka = o.keepalive ?? 30;
  const body = [...str('MQTT'), 4, flags, ka >> 8, ka & 0xff, ...str(o.clientId)];
  if (o.username) body.push(...str(o.username));
  if (o.password) body.push(...str(o.password));
  return packet(0x10, body);
}

export function subscribePacket(id: number, topics: MqttOptions['topics']): Uint8Array {
  return packet(0x82, [id >> 8, id & 0xff, ...topics.flatMap((t) => [...str(t.topic), t.qos])]);
}

export const pingPacket = () => Uint8Array.from([0xc0, 0]);
export const disconnectPacket = () => Uint8Array.from([0xe0, 0]);
const pubackPacket = (id: number) => Uint8Array.from([0x40, 2, id >> 8, id & 0xff]);

export function publishPacket(topic: string, payload: Uint8Array | string, qos: 0 | 1 = 0, id = 1): Uint8Array {
  const p = typeof payload === 'string' ? te.encode(payload) : payload;
  const body = [...str(topic), ...(qos ? [id >> 8, id & 0xff] : []), ...p];
  return packet(0x30 | (qos << 1), body);
}

/** A client over any byte pipe: feed it what arrives, it writes replies through `send`. */
export class MqttSession {
  private buf = new Uint8Array(0);
  private timer: ReturnType<typeof setInterval> | undefined;
  onMessage: (m: MqttMessage) => void = () => {};
  onReady: () => void = () => {};
  onError: (e: Error) => void = () => {};

  constructor(
    private readonly o: MqttOptions,
    private readonly send: (b: Uint8Array) => void,
  ) {}

  start() {
    this.send(connectPacket(this.o));
  }

  stop() {
    clearInterval(this.timer);
    try {
      this.send(disconnectPacket());
    } catch {
      /* already closed */
    }
  }

  feed(chunk: Uint8Array) {
    const all = new Uint8Array(this.buf.length + chunk.length);
    all.set(this.buf);
    all.set(chunk, this.buf.length);
    let p = 0;
    while (p < all.length) {
      // fixed header: type byte, then 1–4 bytes of remaining length
      let len = 0;
      let mult = 1;
      let q = p + 1;
      let complete = false;
      for (let i = 0; i < 4 && q < all.length; i++, q++) {
        len += (all[q] & 0x7f) * mult;
        mult *= 128;
        if (!(all[q] & 0x80)) {
          complete = true;
          q++;
          break;
        }
      }
      if (!complete || q + len > all.length) break;
      this.handle(all[p], all.subarray(q, q + len));
      p = q + len;
    }
    this.buf = all.slice(p);
  }

  private handle(h: number, body: Uint8Array) {
    const type = h >> 4;
    switch (type) {
      case 2: {
        // CONNACK
        const code = body[1];
        if (code !== 0) {
          const why = ['', 'unacceptable protocol version', 'client id rejected', 'server unavailable', 'bad user name or password', 'not authorised'][code] ?? `code ${code}`;
          this.onError(new Error(`MQTT broker refused the connection: ${why}.`));
          return;
        }
        this.send(subscribePacket(1, this.o.topics));
        const ka = (this.o.keepalive ?? 30) * 1000;
        this.timer = setInterval(() => this.send(pingPacket()), Math.max(5000, ka * 0.75));
        break;
      }
      case 9: // SUBACK
        if ([...body.subarray(2)].some((c) => c === 0x80)) this.onError(new Error('MQTT broker refused a subscription (check the topic and permissions).'));
        this.onReady();
        break;
      case 3: {
        // PUBLISH
        const qos = (h >> 1) & 3;
        const tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        let o = 2 + tl;
        if (qos > 0) {
          const id = (body[o] << 8) | body[o + 1];
          o += 2;
          this.send(pubackPacket(id));
        }
        this.onMessage({ topic, payload: body.slice(o), retain: !!(h & 1) });
        break;
      }
    }
  }
}

/** MQTT topic filter matching (+ and #). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
