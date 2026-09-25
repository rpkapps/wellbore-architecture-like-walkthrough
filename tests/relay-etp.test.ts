import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayContext } from '../relay/adapter';
import { etpAdapter } from '../relay/adapters/etp';
import etp11 from '../relay/etp/etp11.json';
import etp12 from '../relay/etp/etp12.json';
import { compileSchema, decode, encode, type AvroSchema, type Names } from '../src/connect/avro';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Msg {
  header: { protocol: number; messageType: number; correlationId: number; messageId: number; messageFlags: number };
  name: string;
  body: Body;
}
interface SchemaSet {
  messages: Record<string, { protocol?: number; messageType?: number; type: string }>;
  types: Record<string, unknown>;
}

const MULTIPART = 0x01;
const FIN = 0x02;
const ACK = 0x10;
const EXT = 0x20;

/** Framing for the fake servers, straight from the schema files: Avro MessageHeader + Avro body. */
function wire(json: unknown) {
  const set = json as SchemaSet;
  const names: Names = new Map();
  for (const s of Object.values(set.types)) compileSchema(s as AvroSchema, names);
  const type = (name: string) => names.get(set.messages[name].type)!;
  const byKey = new Map(Object.entries(set.messages).map(([n, m]) => [`${m.protocol}/${m.messageType}`, n]));
  return {
    enc(name: string, body: unknown, h: { correlationId: number; messageId: number; messageFlags: number }, extension?: unknown) {
      const m = set.messages[name];
      const head = encode(type('Datatypes.MessageHeader'), { protocol: m.protocol, messageType: m.messageType, ...h });
      return Buffer.concat([head, ...(extension ? [encode(type('Datatypes.MessageHeaderExtension'), extension)] : []), encode(type(name), body)]);
    },
    dec(buf: Uint8Array): Msg {
      const h = decode(type('Datatypes.MessageHeader'), buf);
      const header = h.value as Msg['header'];
      const name = header.messageType === 1001 ? 'Core.Acknowledge' : byKey.get(`${header.protocol}/${header.messageType}`)!;
      return { header, name, body: decode(type(name), buf, h.end).value };
    },
  };
}

type Send = (name: string, body: unknown, o?: { correlationId?: number; flags?: number; extension?: unknown }) => number;

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(r));
  }
});

async function fakeServer(version: '1.1' | '1.2', authorization: string, onMessage: (m: Msg, send: Send, ws: WebSocket, session: number) => void) {
  const w = wire(version === '1.2' ? etp12 : etp11);
  const sub = version === '1.2' ? 'etp12.energistics.org' : 'energistics-tp';
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (p) => (p.has(sub) ? sub : false),
    verifyClient: (info, cb) => (info.req.headers.authorization === authorization ? cb(true) : cb(false, 401, 'Unauthorized')),
  });
  servers.push(wss);
  await once(wss, 'listening');
  const got: Msg[] = [];
  let sessions = 0;
  wss.on('connection', (ws) => {
    const session = ++sessions;
    let id = version === '1.2' ? -1 : 0;
    const send: Send = (name, body, o = {}) => {
      id += version === '1.2' ? 2 : 1; // 1.2: the server's message ids are odd
      ws.send(w.enc(name, body, { correlationId: o.correlationId ?? 0, messageId: id, messageFlags: o.flags ?? (version === '1.2' ? FIN : 0) }, o.extension));
      return id;
    };
    ws.on('message', (data) => {
      const m = w.dec(data as Buffer);
      got.push(m);
      onMessage(m, send, ws, session);
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/etp`, got, sessions: () => sessions };
}

function fakeCtx(params: Record<string, unknown> = {}) {
  const ac = new AbortController();
  const rec = {
    ready: [] as unknown[][],
    sent: [] as { topic?: string; rows: Record<string, unknown>[] }[],
    status: [] as string[][],
    logs: [] as string[],
  };
  const ctx: RelayContext<Body> = {
    params: etpAdapter.params.parse(params),
    signal: ac.signal,
    ready: (...a) => void rec.ready.push(a),
    send: async (payload, meta) => {
      rec.sent.push({
        topic: meta?.topic,
        rows: String(payload)
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      });
    },
    status: (s, d = '') => void rec.status.push([s, d]),
    log: (t) => void rec.logs.push(t),
    end: () => {},
  };
  return { ctx, ac, rec, rows: (): Record<string, unknown>[] => rec.sent.flatMap((s) => s.rows.map((r) => ({ topic: s.topic, ...r }))) };
}

// ------------------------------------------------------------------ ETP 1.2

const V12 = { major: 1, minor: 2, revision: 0, patch: 0 };
const LOG = "eml:///dataspace('volve')/witsml20.Log(time-log)";
const CH = (id: string) => `eml:///dataspace('volve')/witsml20.Channel(${id})`;
const T1 = 1_700_000_000_000; // ms
const us = (ms: number) => ms * 1000;

const openSession12 = {
  applicationName: 'Fake store',
  applicationVersion: '0.1',
  serverInstanceId: new Uint8Array(16),
  supportedProtocols: [21, 3].map((protocol) => ({ protocol, protocolVersion: V12, role: 'store', protocolCapabilities: {} })),
  supportedDataObjects: [{ qualifiedType: 'witsml20.Channel', dataObjectCapabilities: {} }],
  supportedCompression: '',
  supportedFormats: ['xml'],
  currentDateTime: us(T1),
  earliestRetainedChangeTime: 0,
  sessionId: new Uint8Array(16),
  endpointCapabilities: {},
};

const resource = (uri: string) => ({
  uri,
  alternateUris: [],
  name: uri,
  sourceCount: null,
  targetCount: null,
  lastChanged: 0,
  storeLastWrite: 0,
  storeCreated: 0,
  activeStatus: 'Active',
  customData: {},
});

const CHANNELS12: Record<string, { id: number; name: string; uom: string; kind: string; indexUom: string; start: unknown; end: unknown }> = {
  [CH('dbtm')]: { id: 1, name: 'DBTM', uom: 'm', kind: 'DateTime', indexUom: 'us', start: { long: us(T1 - 86_400_000) }, end: { long: us(T1) } },
  [CH('ropa')]: { id: 2, name: 'ROPA', uom: 'm/h', kind: 'DateTime', indexUom: 'us', start: { long: us(T1 - 86_400_000) }, end: { long: us(T1) } },
  [CH('gr')]: { id: 3, name: 'GR', uom: 'gAPI', kind: 'MeasuredDepth', indexUom: 'ft', start: { double: 8000 }, end: { double: 8202 } },
};

function metadata12(uri: string) {
  const c = CHANNELS12[uri];
  return {
    uri,
    id: c.id,
    indexes: [
      {
        indexKind: c.kind,
        interval: { startIndex: { item: c.start }, endIndex: { item: c.end }, uom: c.indexUom, depthDatum: '' },
        direction: 'Increasing',
        name: c.kind === 'DateTime' ? 'TIME' : 'MD',
        uom: c.indexUom,
        depthDatum: '',
        indexPropertyKindUri: '',
        filterable: true,
      },
    ],
    channelName: c.name,
    dataKind: 'typeDouble',
    uom: c.uom,
    depthDatum: '',
    channelClassUri: '',
    status: 'Active',
    source: '',
    axisVectorLengths: [],
    attributeMetadata: [],
    customData: {},
  };
}

const item = (channelId: number, index: unknown, value: number) => ({ channelId, indexes: [{ item: index }], value: { item: { double: value } }, valueAttributes: [] });

/** A store: session, discovery of the log's channels (in two parts), metadata, then `stream` once subscribed. */
function store12(stream: (send: Send, sub: Msg, ws: WebSocket, session: number) => void, ranges?: (send: Send, m: Msg) => void) {
  return (m: Msg, send: Send, ws: WebSocket, session: number) => {
    const reply = { correlationId: m.header.messageId };
    switch (m.name) {
      case 'Core.RequestSession':
        return send('Core.OpenSession', openSession12, reply);
      case 'Discovery.GetResources':
        expect(m.body.context.uri).toBe(LOG);
        send('Discovery.GetResourcesResponse', { resources: [resource(CH('dbtm'))] }, { ...reply, flags: 0 });
        return send('Discovery.GetResourcesResponse', { resources: [resource(CH('ropa'))] }, reply);
      case 'ChannelSubscribe.GetChannelMetadata':
        return send(
          'ChannelSubscribe.GetChannelMetadataResponse',
          { metadata: Object.fromEntries(Object.entries(m.body.uris as Record<string, string>).map(([k, uri]) => [k, metadata12(uri)])) },
          reply,
        );
      case 'ChannelSubscribe.GetRanges':
        return ranges?.(send, m);
      case 'ChannelSubscribe.SubscribeChannels':
        send('ChannelSubscribe.SubscribeChannelsResponse', { success: Object.fromEntries(Object.keys(m.body.channels).map((k) => [k, ''])) }, reply);
        return stream(send, m, ws, session);
    }
  };
}

const config12 = (url: string, extra: Record<string, unknown> = {}) =>
  etpAdapter.config.parse({ type: 'etp', url, version: '1.2', auth: { kind: 'bearer', token: 'sesame' }, uris: [LOG, CH('gr')], well: 'F-12', ...extra });

describe('ETP 1.2 (ChannelSubscribe)', () => {
  it('discovers, subscribes to the latest data and relays ChannelData as NDJSON rows', async () => {
    let dataMessageId = 0;
    const srv = await fakeServer(
      '1.2',
      'Bearer sesame',
      store12((send) => {
        send('Core.Ping', { currentDateTime: us(T1) });
        send('ChannelSubscribe.ChannelData', {
          data: [item(1, { long: us(T1) }, 2500.1), item(2, { long: us(T1) }, 22), item(1, { long: us(T1 + 1000) }, 2500.2), item(2, { long: us(T1 + 1000) }, 23.5)],
        });
        // header extension + acknowledgement requested; depth in ft
        dataMessageId = send('ChannelSubscribe.ChannelData', { data: [item(3, { double: 8202 }, 45)] }, { flags: FIN | ACK | EXT, extension: { extension: { trace: { item: { string: 'x' } } } } });
      }),
    );
    const { ctx, ac, rec, rows } = fakeCtx();
    const done = etpAdapter.open(config12(srv.url), ctx);
    await vi.waitFor(() => expect(rec.sent.length).toBe(2));

    expect(rec.ready).toEqual([['json', {}, '3 channels over ETP 1.2 from ' + new URL(srv.url).host]]);
    expect(rows()).toEqual([
      { topic: LOG, well: 'F-12', time: T1, 'DBTM [m]': 2500.1, 'ROPA [m/h]': 22 },
      { topic: LOG, well: 'F-12', time: T1 + 1000, 'DBTM [m]': 2500.2, 'ROPA [m/h]': 23.5 },
      { topic: 'channels', well: 'F-12', DEPTH: 2499.9696, 'GR [gAPI]': 45 },
    ]);

    const req = srv.got.find((m) => m.name === 'Core.RequestSession')!;
    expect(req.body.requestedProtocols.map((p: Body) => [p.protocol, p.role])).toEqual([
      [21, 'store'],
      [3, 'store'],
    ]);
    expect(req.header.messageId % 2).toBe(0);
    const sub = srv.got.find((m) => m.name === 'ChannelSubscribe.SubscribeChannels')!;
    expect(Object.values(sub.body.channels)).toEqual([1, 2, 3].map((channelId) => ({ channelId, startIndex: { item: null }, dataChanges: false, requestLatestIndexCount: null })));
    await vi.waitFor(() => expect(srv.got.some((m) => m.name === 'Core.Acknowledge')).toBe(true));
    expect(srv.got.find((m) => m.name === 'Core.Acknowledge')!.header.correlationId).toBe(dataMessageId);
    expect(srv.got.find((m) => m.name === 'Core.Pong')).toBeTruthy();

    ac.abort();
    await done;
    await vi.waitFor(() => expect(srv.got.at(-1)?.name).toBe('Core.CloseSession'));
  });

  it('reads the history with GetRanges, then subscribes from where it ended', async () => {
    const FROM = T1 - 3_600_000;
    const HIST = T1 - 600_000;
    const srv = await fakeServer(
      '1.2',
      'Bearer sesame',
      store12(
        (send) => send('ChannelSubscribe.ChannelData', { data: [item(1, { long: us(HIST) }, 2400), item(1, { long: us(T1) }, 2500.1), item(3, { double: 8202 }, 46)] }),
        (send, m) => {
          const reply = { correlationId: m.header.messageId };
          send('ChannelSubscribe.GetRangesResponse', { data: [item(1, { long: us(HIST) }, 2400)] }, { ...reply, flags: 0 });
          send('ChannelSubscribe.GetRangesResponse', { data: [item(3, { double: 8000 }, 40), item(3, { double: 8202 }, 45)] }, reply);
        },
      ),
    );
    const { ctx, ac, rec, rows } = fakeCtx({ from: new Date(FROM).toISOString(), channels: ['dbtm', 'GR'] });
    const done = etpAdapter.open(config12(srv.url), ctx);
    await vi.waitFor(() => expect(rec.sent.length).toBe(3));
    ac.abort();
    await done;

    const ranges = srv.got.find((m) => m.name === 'ChannelSubscribe.GetRanges')!;
    expect(ranges.body.channelRanges.map((r: Body) => [r.channelIds, r.interval.startIndex.item, r.interval.uom])).toEqual([
      [[1], us(FROM), 'us'],
      [[3], 8000, 'ft'],
    ]);
    const sub = srv.got.find((m) => m.name === 'ChannelSubscribe.SubscribeChannels')!;
    expect(Object.values(sub.body.channels).map((c: Body) => [c.channelId, c.startIndex.item])).toEqual([
      [1, us(HIST)],
      [3, 8202],
    ]);
    // the repeated boundary values (HIST, 8202 ft) are dropped
    expect(rows()).toEqual([
      { topic: LOG, well: 'F-12', time: HIST, 'DBTM [m]': 2400 },
      { topic: 'channels', well: 'F-12', DEPTH: 2438.4, 'GR [gAPI]': 40 },
      { topic: 'channels', well: 'F-12', DEPTH: 2499.9696, 'GR [gAPI]': 45 },
      { topic: LOG, well: 'F-12', time: T1, 'DBTM [m]': 2500.1 },
    ]);
  });

  it('reconnects after losing the socket and resumes from the last index', async () => {
    const srv = await fakeServer(
      '1.2',
      'Bearer sesame',
      store12(
        (send, _m, ws, session) => {
          if (session === 1) {
            send('ChannelSubscribe.ChannelData', { data: [item(1, { long: us(T1) }, 2500.1)] });
            setTimeout(() => ws.terminate(), 20);
          } else send('ChannelSubscribe.ChannelData', { data: [item(1, { long: us(T1) }, 2500.1), item(1, { long: us(T1 + 1000) }, 2500.2)] });
        },
        (send, m) => send('ChannelSubscribe.GetRangesResponse', { data: [] }, { correlationId: m.header.messageId }),
      ),
    );
    const { ctx, ac, rec, rows } = fakeCtx({ channels: ['DBTM'] });
    const done = etpAdapter.open(config12(srv.url, { uris: [LOG] }), ctx);
    await vi.waitFor(() => expect(rec.sent.length).toBe(2), { timeout: 3000 });
    ac.abort();
    await done;
    expect(rec.status[0][0]).toBe('reconnecting');
    expect(rec.status.at(-1)?.[0]).toBe('live');
    expect(rec.ready.length).toBe(1);
    // the gap is read with GetRanges from the last index seen, then the subscription resumes there
    const ranges = srv.got.filter((m) => m.name === 'ChannelSubscribe.GetRanges');
    expect(ranges.map((r) => r.body.channelRanges[0].interval.startIndex.item)).toEqual([us(T1)]);
    const subs = srv.got.filter((m) => m.name === 'ChannelSubscribe.SubscribeChannels');
    expect(Object.values(subs[1].body.channels).map((c: Body) => c.startIndex.item)).toEqual([us(T1)]);
    expect(rows().map((r) => r.time)).toEqual([T1, T1 + 1000]);
  });

  it('fails clearly when the credentials are refused', async () => {
    const srv = await fakeServer('1.2', 'Bearer sesame', () => {});
    const { ctx } = fakeCtx();
    await expect(etpAdapter.open(config12(srv.url, { auth: { kind: 'bearer', token: 'wrong' } }), ctx)).rejects.toThrow(/rejected the bearer credentials \(HTTP 401/);
    expect(srv.sessions()).toBe(0);
  });

  it('fails clearly when the server answers the session request with a ProtocolException', async () => {
    const srv = await fakeServer('1.2', 'Bearer sesame', (m, send) => {
      if (m.name === 'Core.RequestSession')
        send('Core.ProtocolException', { error: { message: 'The store role of protocol 21 is not supported', code: 2 }, errors: {} }, { correlationId: m.header.messageId });
    });
    const { ctx, rec } = fakeCtx();
    await expect(etpAdapter.open(config12(srv.url), ctx)).rejects.toThrow('The ETP server refused the session: The store role of protocol 21 is not supported (code 2)');
    expect(rec.ready).toEqual([]);
    expect(srv.sessions()).toBe(1);
  });
});

// ------------------------------------------------------------------ ETP 1.1

const LOG11 = 'eml://witsml14/well(F-12)/wellbore(F-12)/log(realtime)';

function metadata11(id: number, name: string, uom: string, index: 'Time' | 'Depth', indexUom: string, scale: number) {
  return {
    channelUri: `${LOG11}/logCurveInfo(${name})`,
    channelId: id,
    indexes: [
      {
        indexType: index,
        uom: indexUom,
        depthDatum: null,
        direction: 'Increasing',
        mnemonic: index === 'Time' ? 'TIME' : 'DEPT',
        description: null,
        uri: null,
        customData: {},
        scale,
        timeDatum: null,
      },
    ],
    channelName: name,
    dataType: 'double',
    uom,
    startIndex: null,
    endIndex: null,
    description: '',
    status: 'Active',
    contentType: null,
    source: '',
    measureClass: '',
    uuid: null,
    customData: {},
    domainObject: null,
  };
}

describe('ETP 1.1 (ChannelStreaming)', () => {
  it('describes the log, starts streaming and relays ChannelData as NDJSON rows', async () => {
    const auth = `Basic ${Buffer.from('driller:sesame').toString('base64')}`;
    const srv = await fakeServer('1.1', auth, (m, send) => {
      const reply = { correlationId: m.header.messageId };
      switch (m.name) {
        case 'Core.RequestSession':
          return send(
            'Core.OpenSession',
            {
              applicationName: 'Fake producer',
              applicationVersion: '0.1',
              sessionId: 's1',
              supportedProtocols: [{ protocol: 1, protocolVersion: { major: 1, minor: 1, revision: 0, patch: 0 }, role: 'producer', protocolCapabilities: {} }],
              supportedObjects: [],
            },
            reply,
          );
        case 'ChannelStreaming.ChannelDescribe':
          // a multipart answer: MULTIPART on each part, FIN too on the last
          send('ChannelStreaming.ChannelMetadata', { channels: [metadata11(7, 'ROP', 'm/h', 'Time', 'us', 0)] }, { ...reply, flags: MULTIPART });
          return send('ChannelStreaming.ChannelMetadata', { channels: [metadata11(8, 'GR', 'gAPI', 'Depth', 'ft', 3)] }, { ...reply, flags: MULTIPART | FIN });
        case 'ChannelStreaming.ChannelStreamingStart': {
          const d = (channelId: number, index: number, value: number) => ({ indexes: [index], channelId, value: { item: { double: value } }, valueAttributes: [] });
          return send('ChannelStreaming.ChannelData', { data: [d(7, us(T1), 22), d(8, 2_500_100, 45), d(7, us(T1 + 1000), 23)] });
        }
      }
    });
    const { ctx, ac, rec, rows } = fakeCtx();
    const done = etpAdapter.open(
      etpAdapter.config.parse({ type: 'etp', url: srv.url, version: '1.1', auth: { kind: 'basic', username: 'driller', password: 'sesame' }, uris: [LOG11], maxMessageRate: 500 }),
      ctx,
    );
    await vi.waitFor(() => expect(rec.sent.length).toBe(2));
    ac.abort();
    await done;

    expect(rec.ready[0][0]).toBe('json');
    expect(rows()).toEqual([
      { topic: `${LOG11} (time)`, time: T1, 'ROP [m/h]': 22 },
      { topic: `${LOG11} (time)`, time: T1 + 1000, 'ROP [m/h]': 23 },
      { topic: `${LOG11} (depth)`, DEPTH: 762.03048, 'GR [gAPI]': 45 },
    ]);
    const names = srv.got.map((m) => m.name);
    expect(names.slice(0, 4)).toEqual(['Core.RequestSession', 'ChannelStreaming.Start', 'ChannelStreaming.ChannelDescribe', 'ChannelStreaming.ChannelStreamingStart']);
    const req = srv.got[0].body;
    expect(req.requestedProtocols.map((p: Body) => [p.protocol, p.role])).toEqual([[1, 'producer']]);
    expect(srv.got[1].body).toEqual({ maxMessageRate: 500, maxDataItems: 10_000 });
    expect(srv.got[2].body).toEqual({ uris: [LOG11] });
    expect(srv.got[3].body.channels).toEqual([7, 8].map((channelId) => ({ channelId, startIndex: { item: null }, receiveChangeNotification: false })));
    await vi.waitFor(() => expect(srv.got.at(-1)?.name).toBe('Core.CloseSession'));
  });

  it('reports a ProtocolException to ChannelDescribe', async () => {
    const auth = 'Bearer t';
    const srv = await fakeServer('1.1', auth, (m, send) => {
      const reply = { correlationId: m.header.messageId };
      if (m.name === 'Core.RequestSession')
        send(
          'Core.OpenSession',
          {
            applicationName: 'P',
            applicationVersion: '1',
            sessionId: 's',
            supportedProtocols: [{ protocol: 1, protocolVersion: { major: 1, minor: 1, revision: 0, patch: 0 }, role: 'producer', protocolCapabilities: {} }],
            supportedObjects: [],
          },
          reply,
        );
      if (m.name === 'ChannelStreaming.ChannelDescribe') send('Core.ProtocolException', { errorCode: 11, errorMessage: 'Invalid URI' }, reply);
    });
    const { ctx, rec } = fakeCtx();
    await expect(etpAdapter.open(etpAdapter.config.parse({ type: 'etp', url: srv.url, version: '1.1', auth: { kind: 'bearer', token: 't' }, uris: ['eml://nowhere'] }), ctx)).rejects.toThrow(
      'The ETP server returned no channels for eml://nowhere.',
    );
    expect(rec.logs).toContain('Channels of eml://nowhere: Invalid URI (code 11)');
  });
});
