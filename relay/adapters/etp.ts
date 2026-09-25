import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { z } from 'zod';
import { compileSchema, decode, encode, type AvroSchema, type AvroType, type Names } from '../../src/connect/avro';
import { backoff, defineAdapter, From, parseFrom, sleep, type RelayContext } from '../adapter';
import etp11 from '../etp/etp11.json';
import etp12 from '../etp/etp12.json';

/**
 * An Energistics Transport Protocol client. ETP is WebSocket + Avro: every
 * binary WebSocket message is an Avro MessageHeader followed by the Avro body
 * of the message it names (protocol, messageType). ETP 1.2 subscribes to
 * channels with ChannelSubscribe (protocol 21), ETP 1.1 streams them with
 * ChannelStreaming (protocol 1). The relay is the client (the "customer" /
 * "consumer") and asks the server for the "store" / "producer" role.
 *
 * Rows go to the browser as NDJSON (the json codec): {"well", "time" (epoch ms)
 * or "DEPTH" (m), "<mnemonic> [<uom>]": value}, one send per ChannelData message
 * and log.
 */

// ------------------------------------------------------------------ messages

/** messageFlags. 1.2: FIN on every single message and on the last part of a multipart one; 1.1: MULTIPART on every part, FIN too on the last. */
const MULTIPART = 0x01;
const FIN = 0x02;
const COMPRESSED = 0x08;
const ACK_REQUESTED = 0x10;
const HEADER_EXTENSION = 0x20; // 1.2: a MessageHeaderExtension follows the header

/** a decoded Avro value (shapes are those of the schema files) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Decoded = any;

interface Header {
  protocol: number;
  messageType: number;
  correlationId: number;
  messageId: number;
  messageFlags: number;
}
interface Msg {
  header: Header;
  /** "<Protocol>.<Message>", e.g. "ChannelSubscribe.ChannelData"; '' for a message this client has no schema for */
  name: string;
  body: Decoded;
}

interface SchemaSet {
  version: string;
  messages: Record<string, { protocol?: number; messageType?: number; type: string }>;
  types: Record<string, unknown>;
}

interface Codec {
  v12: boolean;
  encode(name: string, body: unknown, h: { correlationId: number; messageId: number; messageFlags: number; protocol?: number }): Buffer;
  decode(buf: Uint8Array): Msg;
  isFinal(flags: number): boolean;
}

function makeCodec(set: SchemaSet): Codec {
  const names: Names = new Map();
  for (const s of Object.values(set.types)) compileSchema(s as AvroSchema, names);
  const types = new Map<string, AvroType>();
  const type = (name: string) => {
    let t = types.get(name);
    if (!t) {
      t = names.get(set.messages[name]?.type ?? '');
      if (!t) throw new Error(`ETP ${set.version}: no schema for ${name}.`);
      types.set(name, t);
    }
    return t;
  };
  const byKey = new Map<string, string>();
  for (const [name, m] of Object.entries(set.messages)) if (m.protocol !== undefined) byKey.set(`${m.protocol}/${m.messageType}`, name);
  const v12 = set.version === '1.2';
  const headerType = type('Datatypes.MessageHeader');
  const extension = v12 ? type('Datatypes.MessageHeaderExtension') : undefined;
  return {
    v12,
    encode(name, body, h) {
      const m = set.messages[name];
      const head = encode(headerType, { ...h, protocol: h.protocol ?? m.protocol, messageType: m.messageType });
      return Buffer.concat([head, encode(type(name), body)]);
    },
    decode(buf) {
      const d = decode(headerType, buf);
      const header = d.value as Header;
      let pos = d.end;
      if (extension && header.messageFlags & HEADER_EXTENSION) pos = decode(extension, buf, pos).end;
      // ProtocolException and Acknowledge may be sent in any protocol, with that protocol's number
      const name = header.messageType === 1000 ? 'Core.ProtocolException' : header.messageType === 1001 ? 'Core.Acknowledge' : (byKey.get(`${header.protocol}/${header.messageType}`) ?? '');
      if (!name) return { header, name, body: null };
      let body = buf.subarray(pos);
      if (header.messageFlags & COMPRESSED) body = gunzipSync(body);
      return { header, name, body: decode(type(name), body).value };
    },
    isFinal: (f) => (v12 ? (f & FIN) !== 0 : (f & MULTIPART) === 0 || (f & FIN) !== 0),
  };
}

const codecs = new Map<string, Codec>();
const codecFor = (version: '1.1' | '1.2') => {
  let c = codecs.get(version);
  if (!c) codecs.set(version, (c = makeCodec((version === '1.2' ? etp12 : etp11) as unknown as SchemaSet)));
  return c;
};

/** A failure a reconnect cannot fix (credentials, a refused session, no channels). */
class EtpRefused extends Error {}

function describeException(m: Msg): string {
  const b = m.body ?? {};
  if ('errorMessage' in b) return `${b.errorMessage} (code ${b.errorCode})`; // 1.1
  const all = [...(b.error ? [b.error] : []), ...Object.entries((b.errors ?? {}) as Record<string, { message: string; code: number }>).map(([k, e]) => ({ ...e, message: `${k}: ${e.message}` }))];
  return all.map((e: { message: string; code: number }) => `${e.message} (code ${e.code})`).join('; ') || 'unspecified error';
}

// ------------------------------------------------------------------ session

interface Pending {
  what: string;
  expects: Set<string>;
  /** parts go to the message handler (in order) instead of being collected */
  stream: boolean;
  /** also take ProtocolExceptions that carry no correlation id */
  session: boolean;
  parts: Msg[];
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(parts: Msg[]): void;
  reject(e: Error): void;
}

type Config = z.output<typeof Config>;

class EtpSession {
  onMessage: (m: Msg) => unknown = () => {};
  readonly closed: Promise<string>;
  failure?: Error;
  private lastId = 0;
  private pending = new Map<number, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private paused = false;

  static connect(c: Config, codec: Codec, signal: AbortSignal): Promise<EtpSession> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (c.auth.kind === 'basic') headers.Authorization = `Basic ${Buffer.from(`${c.auth.username ?? ''}:${c.auth.password ?? ''}`).toString('base64')}`;
      if (c.auth.kind === 'bearer') headers.Authorization = `Bearer ${c.auth.token ?? ''}`;
      const ws = new WebSocket(c.url, codec.v12 ? 'etp12.energistics.org' : 'energistics-tp', { headers, handshakeTimeout: 15_000 });
      const abort = () => ws.terminate();
      signal.addEventListener('abort', abort, { once: true });
      ws.on('error', (e) => reject(e));
      ws.on('unexpected-response', (req, res) => {
        const code = res.statusCode ?? 0;
        req.destroy();
        reject(
          code === 401 || code === 403
            ? new EtpRefused(
                `The ETP server at ${c.url} rejected the ${c.auth.kind === 'none' ? 'connection without credentials' : `${c.auth.kind} credentials`} (HTTP ${code}${res.statusMessage ? ` ${res.statusMessage}` : ''}).`,
              )
            : new Error(`The ETP server answered the WebSocket upgrade with HTTP ${code}${res.statusMessage ? ` ${res.statusMessage}` : ''}.`),
        );
      });
      ws.once('open', () => {
        signal.removeEventListener('abort', abort);
        resolve(new EtpSession(ws, codec, signal));
      });
    });
  }

  private constructor(
    private ws: WebSocket,
    private codec: Codec,
    signal: AbortSignal,
  ) {
    let why = 'The ETP server closed the connection';
    ws.on('error', (e) => (why = e.message));
    this.closed = new Promise((resolve) => {
      const done = (reason: string) => {
        signal.removeEventListener('abort', aborted);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(reason));
        }
        this.pending.clear();
        resolve(reason);
      };
      const aborted = () => done('Aborted');
      signal.addEventListener('abort', aborted, { once: true });
      ws.on('close', (code, reason) => done(this.failure?.message ?? `${why} (${code}${reason.length ? ` ${reason}` : ''})`));
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // ETP's optional JSON encoding is not requested
      const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      this.receive(buf);
    });
  }

  send(name: string, body: unknown, o: { correlationId?: number; protocol?: number; flags?: number } = {}): number {
    if (this.ws.readyState !== WebSocket.OPEN) return -1;
    // 1.2: the client's message ids are even (the server's odd)
    const messageId = (this.lastId += this.codec.v12 ? 2 : 1);
    this.ws.send(this.codec.encode(name, body, { correlationId: o.correlationId ?? 0, messageId, messageFlags: o.flags ?? (this.codec.v12 ? FIN : 0), protocol: o.protocol }));
    return messageId;
  }

  /** Sends a request and resolves with every part of the answer (responses and ProtocolExceptions) once the final one arrives. */
  request(name: string, body: unknown, o: { expects: string[]; stream?: boolean; session?: boolean; timeoutMs?: number }): Promise<Msg[]> {
    return new Promise((resolve, reject) => {
      const id = this.send(name, body);
      if (id < 0) return reject(new Error('The ETP connection is closed.'));
      const p: Pending = { what: name, expects: new Set(o.expects), stream: !!o.stream, session: !!o.session, parts: [], timeoutMs: o.timeoutMs ?? 30_000, resolve, reject };
      this.pending.set(id, p);
      this.arm(id, p);
    });
  }

  close(reason: string) {
    if (this.ws.readyState !== WebSocket.OPEN) return this.ws.terminate();
    this.send('Core.CloseSession', { reason });
    this.ws.close(1000, 'Session closed');
    setTimeout(() => this.ws.terminate(), 2000).unref();
  }

  fail(e: Error) {
    this.failure ??= e;
    this.ws.terminate();
  }

  private arm(id: number, p: Pending) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.pending.delete(id);
      p.reject(new Error(`No answer to ${p.what} within ${p.timeoutMs / 1000} s.`));
    }, p.timeoutMs);
  }

  private receive(buf: Uint8Array) {
    let m: Msg;
    try {
      m = this.codec.decode(buf);
    } catch (e) {
      return this.fail(new Error(`Cannot read a message from the ETP server: ${e instanceof Error ? e.message : e}`));
    }
    const h = m.header;
    if (h.messageFlags & ACK_REQUESTED && m.name !== 'Core.Acknowledge') this.send('Core.Acknowledge', {}, { correlationId: h.messageId, protocol: h.protocol });
    if (m.name === 'Core.Ping') return void this.send('Core.Pong', { currentDateTime: Date.now() * 1000 }, { correlationId: h.messageId });
    const hit = this.route(m);
    if (!hit) return this.enqueue(() => this.onMessage(m));
    const [id, p] = hit;
    if (p.stream && m.name !== 'Core.ProtocolException') this.enqueue(() => this.onMessage(m));
    else p.parts.push(m);
    if (!this.codec.isFinal(h.messageFlags)) return this.arm(id, p);
    clearTimeout(p.timer);
    this.pending.delete(id);
    // a streamed answer is complete once its parts have been handled
    if (p.stream) this.enqueue(() => p.resolve(p.parts));
    else p.resolve(p.parts);
  }

  private route(m: Msg): [number, Pending] | undefined {
    const err = m.name === 'Core.ProtocolException';
    const byId = this.pending.get(m.header.correlationId);
    if (byId && (err || byId.expects.has(m.name))) return [m.header.correlationId, byId];
    if (byId) return undefined;
    // servers that leave correlationId unset: the oldest request expecting this answer
    for (const e of this.pending) if (err ? e[1].session : e[1].expects.has(m.name)) return e;
    return undefined;
  }

  /** Handles messages in order; the socket is paused while the browser is behind (ctx.send is slow). */
  private enqueue(fn: () => unknown) {
    if (++this.queued > 64 && !this.paused) {
      this.paused = true;
      this.ws.pause();
    }
    this.chain = this.chain
      .then(fn)
      .catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        if (--this.queued < 16 && this.paused) {
          this.paused = false;
          this.ws.resume();
        }
      });
  }
}

// ------------------------------------------------------------------ channels and rows

type IndexKind = 'time' | 'depth' | 'tvd' | 'other';

interface Channel {
  id: number;
  uri: string;
  name: string;
  /** the NDJSON key of its values */
  column: string;
  kind: IndexKind;
  indexUom: string;
  indexName: string;
  /** 1.1: index values are integers × 10^-scale */
  scale: number;
  increasing: boolean;
  /** raw index values from the metadata */
  start: number | null;
  end: number | null;
  topic: string;
}

interface Item {
  channelId: number;
  index: number | null;
  value: unknown;
}

const LENGTH: Record<string, number> = { m: 1, ft: 0.3048, 'ft[US]': 1200 / 3937, ftUS: 1200 / 3937, cm: 0.01, mm: 0.001, km: 1000, in: 0.0254, dm: 0.1 };
const UNITLESS = /^(unitless|none|euc|1|dimensionless)?$/i;

const withUnit = (name: string, uom: string) => (UNITLESS.test(uom.trim()) ? name : `${name} [${uom.trim()}]`);

function indexCell(ch: Channel, raw: number): [string, number] {
  if (ch.kind === 'time') return ['time', raw / 1000]; // epoch microseconds
  const v = ch.scale > 0 ? raw / 10 ** ch.scale : ch.scale < 0 ? raw * 10 ** -ch.scale : raw;
  if (ch.kind === 'depth' || ch.kind === 'tvd') {
    const key = ch.kind === 'depth' ? 'DEPTH' : 'TVD';
    const f = LENGTH[ch.indexUom] ?? LENGTH[ch.indexUom.toLowerCase()];
    return f ? [key, Math.round(v * f * 1e6) / 1e6] : [withUnit(key, ch.indexUom), v];
  }
  return [withUnit(ch.indexName || 'INDEX', ch.indexUom), v];
}

const scalar = (v: unknown) => (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined);

/** A 1.2 IndexValue item: long (time), double (depth…) or PassIndexedDepth. */
function rawIndex(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'depth' in v) return Number((v as { depth: number }).depth);
  return null;
}

const isChannelUri = (u: string) => /\.Channel\([^)]*\)\/?$/i.test(u) || /\/(channel|logCurveInfo)\([^)]*\)\/?$/i.test(u);

/** The log a channel URI belongs to (1.1 URIs are paths: …/log(L)/logCurveInfo(GR)), or "channels". */
function channelBase(uri: string): string {
  const parent = uri.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  return /\/(log|channelSet|[a-z0-9]+\.(Log|ChannelSet))\([^)]*\)$/i.test(parent) ? parent : 'channels';
}

/** Channels of several index kinds under one log: one topic per kind, so each table has one index. */
function assignTopics(chs: Channel[]) {
  const kinds = new Map<string, Set<IndexKind>>();
  for (const ch of chs) {
    if (!kinds.has(ch.topic)) kinds.set(ch.topic, new Set());
    kinds.get(ch.topic)!.add(ch.kind);
  }
  for (const ch of chs) if (kinds.get(ch.topic)!.size > 1) ch.topic = `${ch.topic} (${ch.kind})`;
}

function pick(all: Channel[], mnemonics: string[], what: string): Channel[] {
  const unique = [...new Map(all.map((ch) => [ch.id, ch])).values()];
  if (!unique.length) throw new EtpRefused(`The ETP server returned no channels for ${what}.`);
  if (!mnemonics.length) return unique;
  const want = new Set(mnemonics.map((n) => n.toLowerCase()));
  const out = unique.filter((ch) => want.has(ch.name.toLowerCase()));
  if (!out.length) throw new EtpRefused(`None of ${mnemonics.join(', ')} is among the channels (${unique.map((c) => c.name).join(', ')}).`);
  return out;
}

interface State {
  announced: boolean;
  /** last raw index seen per channel URI: resumes after a reconnect and drops repeats */
  last: Map<string, number>;
}

async function emit(ctx: RelayContext<Params>, well: string | undefined, channels: Map<number, Channel>, items: Item[], st: State) {
  const topics = new Map<string, Map<string, Record<string, unknown>>>();
  for (const it of items) {
    const ch = channels.get(it.channelId);
    if (!ch || it.index === null || !Number.isFinite(it.index)) continue;
    const prev = st.last.get(ch.uri);
    if (ch.increasing && prev !== undefined && it.index <= prev) continue;
    st.last.set(ch.uri, it.index);
    const v = scalar(it.value);
    if (v === undefined) continue;
    const [key, at] = indexCell(ch, it.index);
    let rows = topics.get(ch.topic);
    if (!rows) topics.set(ch.topic, (rows = new Map()));
    let row = rows.get(`${key}=${at}`);
    if (!row) rows.set(`${key}=${at}`, (row = well ? { well, [key]: at } : { [key]: at }));
    row[ch.column] = v;
  }
  for (const [topic, rows] of topics) {
    let text = '';
    for (const r of rows.values()) text += `${JSON.stringify(r)}\n`;
    await ctx.send(text, { topic, contentType: 'application/x-ndjson' });
  }
}

/** Where a channel starts: null = new data only, else a raw index value. */
function startOf(ch: Channel, from: number | null, st: State): number | null {
  const last = st.last.get(ch.uri);
  if (last !== undefined) return last;
  if (from === null) return null;
  if (from >= 0 && ch.kind === 'time') return from * 1000;
  return ch.start ?? 0; // earliest, or a time span on a depth channel: all of it
}

// ------------------------------------------------------------------ ETP 1.2

const V12 = { major: 1, minor: 2, revision: 0, patch: 0 };
const uuid = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return new Uint8Array(b);
};

function channel12(rec: Decoded, base: string): Channel {
  const idx = rec.indexes?.[0] ?? {};
  const k = String(idx.indexKind ?? 'DateTime');
  const kind: IndexKind = k === 'DateTime' ? 'time' : k === 'MeasuredDepth' || k === 'PassIndexedDepth' ? 'depth' : k === 'TrueVerticalDepth' ? 'tvd' : 'other';
  return {
    id: rec.id,
    uri: rec.uri,
    name: rec.channelName,
    column: withUnit(rec.channelName, rec.uom ?? ''),
    kind,
    indexUom: idx.uom ?? idx.interval?.uom ?? '',
    indexName: idx.name ?? '',
    scale: 0,
    increasing: idx.direction !== 'Decreasing' && idx.direction !== 'Unordered',
    start: rawIndex(idx.interval?.startIndex?.item),
    end: rawIndex(idx.interval?.endIndex?.item),
    topic: base,
  };
}

const indexValue = (ch: Channel, raw: number | null) => ({ item: raw === null ? null : ch.kind === 'time' ? { long: Math.round(raw) } : { double: raw } });

async function start12(sess: EtpSession, c: Config, ctx: RelayContext<Params>, from: number | null, st: State, channels: Map<number, Channel>, announce: (n: number) => void) {
  const replies = await sess.request(
    'Core.RequestSession',
    {
      applicationName: c.applicationName,
      applicationVersion: '1.0',
      clientInstanceId: uuid(),
      // the roles the server is asked to play: this client is the customer of a store
      requestedProtocols: [21, 3].map((protocol) => ({ protocol, protocolVersion: V12, role: 'store', protocolCapabilities: {} })),
      supportedDataObjects: ['witsml20.*', 'witsml21.*', 'eml21.*', 'eml23.*'].map((qualifiedType) => ({ qualifiedType, dataObjectCapabilities: {} })),
      supportedCompression: [],
      supportedFormats: ['xml'],
      currentDateTime: Date.now() * 1000,
      earliestRetainedChangeTime: 0,
      serverAuthorizationRequired: false,
      endpointCapabilities: {},
    },
    { expects: ['Core.OpenSession'], session: true },
  );
  const open = replies.find((m) => m.name === 'Core.OpenSession');
  if (!open) throw new EtpRefused(`The ETP server refused the session: ${replies.map(describeException).join('; ')}`);
  const offered = new Set<number>(open.body.supportedProtocols.map((p: { protocol: number }) => p.protocol));
  if (!offered.has(21)) throw new EtpRefused(`The ETP server does not offer ChannelSubscribe (protocol 21) as a store; it offers protocols ${[...offered].join(', ')}.`);
  ctx.log(`ETP 1.2 session open with ${open.body.applicationName} ${open.body.applicationVersion}`);

  const wanted: { uri: string; base: string }[] = [];
  for (const uri of c.uris) {
    if (isChannelUri(uri)) {
      wanted.push({ uri, base: channelBase(uri) });
      continue;
    }
    if (!offered.has(3)) throw new EtpRefused(`"${uri}" is not a channel URI, and the ETP server does not offer Discovery (protocol 3) to find the channels under it.`);
    // a wellbore is referenced by its channels (they are its sources); a log or channel set refers to its channels (targets)
    const family = /(witsml2\d)\./i.exec(uri)?.[1] ?? 'witsml20';
    const scopes = /(^|\/|\.)(well|wellbore)\([^)]*\)\/?$/i.test(uri) ? ['sources', 'targets'] : ['targets', 'sources'];
    let found: string[] = [];
    for (const scope of scopes) {
      const parts = await sess.request(
        'Discovery.GetResources',
        {
          context: { uri, depth: 2, dataObjectTypes: [`${family}.Channel`], navigableEdges: 'Primary', includeSecondaryTargets: false, includeSecondarySources: false },
          scope,
          countObjects: false,
          storeLastWriteFilter: null,
          activeStatusFilter: null,
          includeEdges: false,
        },
        { expects: ['Discovery.GetResourcesResponse'] },
      );
      for (const p of parts) if (p.name === 'Core.ProtocolException') ctx.log(`Discovery of ${uri}: ${describeException(p)}`, 'warn');
      found = parts.flatMap((p) => (p.name === 'Discovery.GetResourcesResponse' ? p.body.resources.map((r: { uri: string }) => r.uri) : [])).filter(isChannelUri);
      if (found.length) break;
    }
    if (!found.length) ctx.log(`No channels found under ${uri}.`, 'warn');
    wanted.push(...found.map((u) => ({ uri: u, base: uri })));
  }
  if (!wanted.length) throw new EtpRefused(`No channels found under ${c.uris.join(', ')}.`);

  const parts = await sess.request(
    'ChannelSubscribe.GetChannelMetadata',
    { uris: Object.fromEntries(wanted.map((w, i) => [String(i), w.uri])) },
    { expects: ['ChannelSubscribe.GetChannelMetadataResponse'] },
  );
  const all: Channel[] = [];
  for (const p of parts) {
    if (p.name === 'Core.ProtocolException') ctx.log(`Channel metadata: ${describeException(p)}`, 'warn');
    else for (const [key, rec] of Object.entries(p.body.metadata)) all.push(channel12(rec, wanted[+key]?.base ?? channelBase((rec as { uri: string }).uri)));
  }
  const list = pick(all, ctx.params.channels, c.uris.join(', '));
  assignTopics(list);
  for (const ch of list) channels.set(ch.id, ch);
  announce(list.length);

  // history first (GetRanges), then the subscription from where it ended
  const starts = new Map(list.map((ch) => [ch.id, startOf(ch, from, st)]));
  const nowUs = Date.now() * 1000;
  const ranged = list.filter((ch) => starts.get(ch.id) !== null && (ch.kind === 'time' || ch.end !== null));
  if (ranged.length) {
    const channelRanges = ranged.map((ch) => ({
      channelIds: [ch.id],
      interval: { startIndex: indexValue(ch, starts.get(ch.id)!), endIndex: indexValue(ch, ch.kind === 'time' ? nowUs : ch.end), uom: ch.indexUom, depthDatum: '' },
      secondaryIntervals: [],
    }));
    const got = await sess.request('ChannelSubscribe.GetRanges', { requestUuid: uuid(), channelRanges }, { expects: ['ChannelSubscribe.GetRangesResponse'], stream: true, timeoutMs: 120_000 });
    for (const p of got) ctx.log(`Channel history: ${describeException(p)}`, 'warn');
    for (const ch of ranged) if (!st.last.has(ch.uri)) starts.set(ch.id, ch.kind === 'time' ? nowUs : ch.end);
  }
  const subs = Object.fromEntries(
    list.map((ch, i) => [String(i), { channelId: ch.id, startIndex: indexValue(ch, st.last.get(ch.uri) ?? starts.get(ch.id) ?? null), dataChanges: false, requestLatestIndexCount: null }]),
  );
  // data flows before (or without) SubscribeChannelsResponse; only its errors matter
  sess.request('ChannelSubscribe.SubscribeChannels', { channels: subs }, { expects: ['ChannelSubscribe.SubscribeChannelsResponse'], timeoutMs: 600_000 }).then(
    (answer) => {
      const errors = answer.filter((m) => m.name === 'Core.ProtocolException');
      for (const e of errors) ctx.log(`Subscription: ${describeException(e)}`, 'warn');
      if (errors.length && !answer.some((m) => m.name === 'ChannelSubscribe.SubscribeChannelsResponse' && Object.keys(m.body.success).length))
        sess.fail(new EtpRefused(`The ETP server refused the subscription: ${errors.map(describeException).join('; ')}`));
    },
    () => {},
  );
}

async function handle12(m: Msg, ctx: RelayContext<Params>, c: Config, channels: Map<number, Channel>, st: State) {
  switch (m.name) {
    case 'ChannelSubscribe.ChannelData':
    case 'ChannelSubscribe.GetRangesResponse':
      return emit(
        ctx,
        c.well,
        channels,
        (m.body.data as { channelId: number; indexes: { item: unknown }[]; value: { item: unknown } }[]).map((d) => ({
          channelId: d.channelId,
          index: rawIndex(d.indexes[0]?.item),
          value: d.value?.item,
        })),
        st,
      );
    case 'ChannelSubscribe.SubscriptionsStopped': {
      const ids = Object.values(m.body.channelIds as Record<string, number>);
      for (const id of ids) channels.delete(id);
      ctx.log(`The ETP server stopped ${ids.length} subscription(s): ${m.body.reason}`, 'warn');
      if (!channels.size) ctx.status('idle', `Subscriptions stopped: ${m.body.reason}`);
      return;
    }
    case 'ChannelSubscribe.RangeReplaced':
      return ctx.log(`The ETP server replaced data of ${m.body.channelIds.length} channel(s); earlier rows may be out of date.`, 'warn');
    case 'ChannelSubscribe.ChannelsTruncated':
      return ctx.log(`The ETP server truncated ${m.body.channels.length} channel(s).`, 'warn');
    case 'Core.ProtocolException':
      return ctx.log(`ETP server: ${describeException(m)}`, 'warn');
    case 'Core.CloseSession':
      return ctx.log(`The ETP server closed the session${m.body.reason ? `: ${m.body.reason}` : ''}.`, 'warn');
  }
}

// ------------------------------------------------------------------ ETP 1.1

function channel11(rec: Decoded, base: string): Channel {
  const idx = rec.indexes?.[0] ?? {};
  return {
    id: rec.channelId,
    uri: rec.channelUri,
    name: rec.channelName,
    column: withUnit(rec.channelName, rec.uom ?? ''),
    kind: idx.indexType === 'Time' ? 'time' : 'depth',
    indexUom: idx.uom ?? '',
    indexName: idx.mnemonic ?? '',
    scale: idx.indexType === 'Time' ? 0 : (idx.scale ?? 0),
    increasing: idx.direction !== 'Decreasing',
    start: rec.startIndex ?? null,
    end: rec.endIndex ?? null,
    topic: base,
  };
}

async function start11(sess: EtpSession, c: Config, ctx: RelayContext<Params>, from: number | null, st: State, channels: Map<number, Channel>, announce: (n: number) => void) {
  const replies = await sess.request(
    'Core.RequestSession',
    {
      applicationName: c.applicationName,
      applicationVersion: '1.0',
      // the server is asked to be the producer; this client consumes
      requestedProtocols: [{ protocol: 1, protocolVersion: { major: 1, minor: 1, revision: 0, patch: 0 }, role: 'producer', protocolCapabilities: {} }],
      supportedObjects: [],
      supportedCompression: '',
    },
    { expects: ['Core.OpenSession'], session: true },
  );
  const open = replies.find((m) => m.name === 'Core.OpenSession');
  if (!open) throw new EtpRefused(`The ETP server refused the session: ${replies.map(describeException).join('; ')}`);
  const offered = new Set<number>(open.body.supportedProtocols.map((p: { protocol: number }) => p.protocol));
  if (!offered.has(1)) throw new EtpRefused(`The ETP server does not offer ChannelStreaming (protocol 1) as a producer; it offers protocols ${[...offered].join(', ')}.`);
  ctx.log(`ETP 1.1 session open with ${open.body.applicationName} ${open.body.applicationVersion}`);

  sess.send('ChannelStreaming.Start', { maxMessageRate: c.maxMessageRate ?? 1000, maxDataItems: c.maxDataItems ?? 10_000 });
  const all: Channel[] = [];
  // one ChannelDescribe per URI, so each channel is known to belong to its log
  for (const uri of c.uris) {
    const parts = await sess.request('ChannelStreaming.ChannelDescribe', { uris: [uri] }, { expects: ['ChannelStreaming.ChannelMetadata'] });
    for (const p of parts) {
      if (p.name === 'Core.ProtocolException') ctx.log(`Channels of ${uri}: ${describeException(p)}`, 'warn');
      else for (const rec of p.body.channels) all.push(channel11(rec, isChannelUri(uri) ? channelBase(uri) : uri));
    }
  }
  const list = pick(all, ctx.params.channels, c.uris.join(', '));
  assignTopics(list);
  for (const ch of list) channels.set(ch.id, ch);
  announce(list.length);
  // StreamingStartIndex: null = from the latest value, int = the last n values, long = from this index
  sess.send('ChannelStreaming.ChannelStreamingStart', {
    channels: list.map((ch) => {
      const s = startOf(ch, from, st);
      return { channelId: ch.id, startIndex: { item: s === null ? null : { long: Math.round(s) } }, receiveChangeNotification: false };
    }),
  });
}

async function handle11(m: Msg, ctx: RelayContext<Params>, c: Config, channels: Map<number, Channel>, st: State) {
  switch (m.name) {
    case 'ChannelStreaming.ChannelData':
      return emit(
        ctx,
        c.well,
        channels,
        (m.body.data as { channelId: number; indexes: number[]; value: { item: unknown } }[]).map((d) => ({ channelId: d.channelId, index: d.indexes[0] ?? null, value: d.value?.item })),
        st,
      );
    case 'ChannelStreaming.ChannelRemove':
      channels.delete(m.body.channelId);
      return ctx.log(`The ETP server removed channel ${m.body.channelId}${m.body.removeReason ? `: ${m.body.removeReason}` : ''}.`, 'warn');
    case 'ChannelStreaming.ChannelStatusChange':
      return ctx.log(`Channel ${channels.get(m.body.channelId)?.name ?? m.body.channelId} is now ${m.body.status}.`);
    case 'Core.ProtocolException':
      return ctx.log(`ETP server: ${describeException(m)}`, 'warn');
    case 'Core.CloseSession':
      return ctx.log(`The ETP server closed the session${m.body.reason ? `: ${m.body.reason}` : ''}.`, 'warn');
  }
}

// ------------------------------------------------------------------ adapter

async function runSession(c: Config, ctx: RelayContext<Params>, from: number | null, st: State, connected: () => void): Promise<string> {
  const codec = codecFor(c.version);
  const sess = await EtpSession.connect(c, codec, ctx.signal);
  const channels = new Map<number, Channel>();
  sess.onMessage = (m) => (codec.v12 ? handle12 : handle11)(m, ctx, c, channels, st);
  const onAbort = () => sess.close('The browser disconnected from the relay.');
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const announce = (n: number) => {
    const detail = `${n} channel${n === 1 ? '' : 's'} over ETP ${c.version} from ${new URL(c.url).host}`;
    if (st.announced) ctx.status('live', detail);
    else ctx.ready('json', {}, detail);
    st.announced = true;
  };
  try {
    await (codec.v12 ? start12 : start11)(sess, c, ctx, from, st, channels, announce);
    connected();
    const reason = await sess.closed;
    if (sess.failure instanceof EtpRefused) throw sess.failure;
    return reason;
  } catch (e) {
    if (!ctx.signal.aborted) sess.fail(e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

const Auth = z
  .object({
    kind: z.enum(['none', 'basic', 'bearer']).default('none'),
    username: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
  })
  .default({ kind: 'none' })
  .describe('Sent as the Authorization header of the WebSocket upgrade');

const Config = z
  .object({
    type: z.literal('etp'),
    label: z.string().optional(),
    url: z.string().regex(/^wss?:\/\/\S+$/i, 'An ETP server URL starts with ws:// or wss://'),
    version: z.enum(['1.2', '1.1']).default('1.2'),
    auth: Auth,
    uris: z.array(z.string().min(1)).min(1).describe('Channel URIs, or logs / channel sets / wellbores whose channels to stream'),
    well: z.string().optional().describe('Well name stamped on every row'),
    applicationName: z.string().default('BoreWalk relay'),
    maxMessageRate: z.number().int().min(0).optional().describe('ETP 1.1 Start.maxMessageRate'),
    maxDataItems: z.number().int().min(1).optional().describe('ETP 1.1 Start.maxDataItems'),
  })
  .superRefine((c, x) => {
    if (c.auth.kind === 'basic' && !c.auth.username) x.addIssue({ code: 'custom', path: ['auth', 'username'], message: 'Basic authentication needs a username' });
    if (c.auth.kind === 'bearer' && !c.auth.token) x.addIssue({ code: 'custom', path: ['auth', 'token'], message: 'Bearer authentication needs a token' });
  });

const Params = z.object({
  from: From,
  channels: z.array(z.string()).default([]).describe('Only these mnemonics (empty: all channels)'),
});
type Params = z.output<typeof Params>;

export const etpAdapter = defineAdapter({
  type: 'etp',
  label: 'ETP 1.1 / 1.2 server',
  config: Config,
  params: Params,
  describe: (c) => {
    const u = new URL(c.url);
    u.username = u.password = '';
    return { url: u.toString(), version: c.version, uris: c.uris, well: c.well };
  },
  async open(c, ctx) {
    const from = parseFrom(ctx.params.from);
    const st: State = { announced: false, last: new Map() };
    let attempt = 0;
    while (!ctx.signal.aborted) {
      let why: string;
      try {
        why = await runSession(c, ctx, from, st, () => (attempt = 0));
      } catch (e) {
        if (ctx.signal.aborted) return;
        if (e instanceof EtpRefused) throw e;
        why = e instanceof Error ? e.message : String(e);
      }
      if (ctx.signal.aborted) return;
      ctx.status('reconnecting', why);
      await sleep(backoff(attempt++), ctx.signal);
    }
  },
});
