import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayContext } from '../relay/adapter';
import { osduAdapter } from '../relay/adapters/osdu';
import { SOAP_ACTION, witsmlAdapter } from '../relay/adapters/witsml';
import { jsonCodec } from '../src/connect/codecs/json';
import { readWitsml } from '../src/connect/codecs/witsml';
import { assemble, type Frame, type LogFrame, type SurveyFrame, type TopsFrame } from '../src/connect/frames';
import { find, parseXml, textOf } from '../src/connect/xml';

// ------------------------------------------------------------------ helpers

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => unknown): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => void Promise.resolve(handler(req, body, res)).catch((e) => res.writeHead(500).end(String(e))));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Sent {
  text: string;
  topic?: string;
  key?: string;
}

function fakeCtx<P>(params: P) {
  const ac = new AbortController();
  const events: string[] = [];
  const sent: Sent[] = [];
  const logs: string[] = [];
  const ctx: RelayContext<P> = {
    params,
    signal: ac.signal,
    ready: (format) => events.push(`ready:${format}`),
    send: async (payload, meta = {}) => {
      sent.push({ text: typeof payload === 'string' ? payload : new TextDecoder().decode(payload), topic: meta.topic, key: meta.key });
      events.push(`send:${meta.topic ?? ''}`);
    },
    status: (state, detail) => events.push(`status:${state}${detail ? ` ${detail}` : ''}`),
    log: (text, level = 'info') => logs.push(`${level}: ${text}`),
    end: () => events.push('end'),
  };
  return { ctx, abort: () => ac.abort(), events, sent, logs };
}

async function until(cond: () => boolean, ms = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the adapter');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function jsonFrames(text: string): Promise<Frame[]> {
  const d = jsonCodec.create(jsonCodec.options.parse({}), { log() {} });
  const batches = [...(await d.push(text, { complete: true })), ...((await d.end?.()) ?? [])];
  return batches.flatMap((b) => assemble(b).frames);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------ a WITSML 1.4.1 store

const NS = 'xmlns="http://www.witsml.org/schemas/1series" version="1.4.1.1"';
const IDS = 'uidWell="W1" uidWellbore="WB1"';
const NAMES = '<nameWell>Well 1</nameWell><nameWellbore>F-11</nameWellbore>';
const T_END = Date.parse('2024-05-01T12:00:00Z');

const TRAJECTORY = `<trajectorys ${NS}><trajectory ${IDS} uid="TR1">${NAMES}<name>Definitive</name>${[
  [0, 0, 0, 0],
  [1000, 10, 45, 995],
  [2000, 30, 50, 1950],
]
  .map(([md, inc, azi, tvd], i) => `<trajectoryStation uid="s${i}"><md uom="m">${md}</md><tvd uom="m">${tvd}</tvd><incl uom="dega">${inc}</incl><azi uom="dega">${azi}</azi></trajectoryStation>`)
  .join('')}</trajectory></trajectorys>`;

const MARKERS = `<formationMarkers ${NS}>${[
  ['Top Hugin', 950, 940],
  ['Top Sleipner', 990, 978],
]
  .map(([n, md, tvd], i) => `<formationMarker ${IDS} uid="M${i}">${NAMES}<name>${n}</name><mdTopSample uom="m">${md}</mdTopSample><tvdTopSample uom="m">${tvd}</tvdTopSample></formationMarker>`)
  .join('')}</formationMarkers>`;

async function witsmlStore(opts: { failFirst?: number; password?: string } = {}) {
  const s = {
    url: '',
    calls: [] as { type: string; query: string; options: string }[],
    depthReqs: 0,
    timeReqs: 0,
  };
  let fail = opts.failFirst ?? 0;
  const auth = `Basic ${Buffer.from(`relay:${opts.password ?? 'secret'}`).toString('base64')}`;

  // the depth log grows 5 rows per data request, the time log 3
  const depthRows = () => Array.from({ length: 111 + 5 * s.depthReqs }, (_, i) => [900 + i, 50 + (i % 7), 20 + (i % 3)]);
  const timeRows = () => {
    const n = 400 + 3 * s.timeReqs;
    return Array.from({ length: n }, (_, i) => [new Date(T_END + (i - 399) * 10_000).toISOString(), 100 + i]);
  };
  const header = (uid: string, rows: (string | number)[][]) =>
    uid === 'L1'
      ? `<log ${IDS} uid="L1">${NAMES}<name>Depth log</name><indexType>measured depth</indexType><startIndex uom="m">${rows[0][0]}</startIndex><endIndex uom="m">${rows[rows.length - 1][0]}</endIndex><direction>increasing</direction><indexCurve>DEPT</indexCurve>` +
        '<logCurveInfo uid="DEPT"><mnemonic>DEPT</mnemonic><unit>m</unit></logCurveInfo><logCurveInfo uid="GR"><mnemonic>GR</mnemonic><unit>gAPI</unit></logCurveInfo><logCurveInfo uid="ROP"><mnemonic>ROP</mnemonic><unit>m/h</unit></logCurveInfo>'
      : `<log ${IDS} uid="T1">${NAMES}<name>Time log</name><indexType>date time</indexType><startDateTimeIndex>${rows[0][0]}</startDateTimeIndex><endDateTimeIndex>${rows[rows.length - 1][0]}</endDateTimeIndex><direction>increasing</direction><indexCurve>TIME</indexCurve>` +
        '<logCurveInfo uid="TIME"><mnemonic>TIME</mnemonic><unit>s</unit></logCurveInfo><logCurveInfo uid="HKLD"><mnemonic>HKLD</mnemonic><unit>kkgf</unit></logCurveInfo>';

  s.url = await serve((req, body, res) => {
    if (req.method !== 'POST' || req.headers.soapaction !== `"${SOAP_ACTION}"` || !/^text\/xml/.test(req.headers['content-type'] ?? '')) return void res.writeHead(400).end('bad request');
    if (req.headers.authorization !== auth) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic' }).end();
    if (fail-- > 0) return void res.writeHead(503).end('busy');
    const doc = parseXml(body);
    const call = { type: textOf(find(doc, 'WMLtypeIn')[0]), query: textOf(find(doc, 'QueryIn')[0]), options: textOf(find(doc, 'OptionsIn')[0]) };
    s.calls.push(call);
    let result = 1;
    let xml = '';
    let msg = '';
    if (call.type === 'trajectory') xml = TRAJECTORY;
    else if (call.type === 'formationMarker') xml = MARKERS;
    else if (call.type === 'log') {
      const q = find(parseXml(call.query), 'log')[0];
      const uid = q.attrs.uid;
      if (call.options.includes('id-only')) xml = `<logs ${NS}><log ${IDS} uid="L1"><name>Depth log</name></log><log ${IDS} uid="T1"><name>Time log</name></log></logs>`;
      else if (uid !== 'L1' && uid !== 'T1') {
        result = -433;
        msg = `Log ${uid} does not exist.`;
      } else if (call.options.includes('header-only')) xml = `<logs ${NS}>${header(uid, uid === 'L1' ? depthRows() : timeRows())}</log></logs>`;
      else {
        let rows: (string | number)[][];
        let mn: string;
        if (uid === 'L1') {
          const start = Number(textOf(q, 'startIndex') || -Infinity);
          rows = depthRows().filter((r) => (r[0] as number) >= start);
          s.depthReqs++;
          mn = '<mnemonicList>DEPT,GR,ROP</mnemonicList><unitList>m,gAPI,m/h</unitList>';
        } else {
          const start = Date.parse(textOf(q, 'startDateTimeIndex')) || -Infinity;
          rows = timeRows().filter((r) => Date.parse(r[0] as string) >= start);
          s.timeReqs++;
          mn = '<mnemonicList>TIME,HKLD</mnemonicList><unitList>s,kkgf</unitList>';
        }
        // a store caps each answer and says more is waiting (Result 2)
        if (rows.length > 50) {
          rows = rows.slice(0, 50);
          result = 2;
        }
        xml = `<logs ${NS}>${header(uid, uid === 'L1' ? depthRows() : timeRows())}<logData>${mn}${rows.map((r) => `<data>${r.join(',')}</data>`).join('')}</logData></log></logs>`;
      }
    }
    res
      .writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
      .end(
        '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns1:WMLS_GetFromStoreResponse xmlns:ns1="http://www.witsml.org/message/120">' +
          `<Result>${result}</Result><XMLout>${esc(xml)}</XMLout><SuppMsgOut>${esc(msg)}</SuppMsgOut></ns1:WMLS_GetFromStoreResponse></soap:Body></soap:Envelope>`,
      );
  });
  return s;
}

describe('WITSML relay adapter', () => {
  it('reads trajectory and markers once, then follows growing logs without duplicates', async () => {
    const store = await witsmlStore({ failFirst: 1 });
    const f = fakeCtx(witsmlAdapter.params.parse({ from: 'latest' }));
    const cfg = witsmlAdapter.config.parse({ type: 'witsml', url: store.url, username: 'relay', password: 'secret', uidWell: 'W1', uidWellbore: 'WB1', interval: 0.05 });
    const run = witsmlAdapter.open(cfg, f.ctx);
    await until(() => f.sent.filter((m) => m.key === 'L1').length >= 3 && f.sent.filter((m) => m.key === 'T1').length >= 3);
    f.abort();
    await run;

    // the first request met a 503 and was retried; ready came with the first answer
    expect(f.events[0]).toMatch(/^status:reconnecting/);
    expect(f.events.slice(1, 6)).toEqual(['ready:witsml', 'send:trajectory', 'end', 'send:formationMarker', 'end']);

    const survey = readWitsml(f.sent[0].text);
    expect(survey).toHaveLength(1);
    const sf = assemble(survey[0]).frames[0] as SurveyFrame;
    expect(sf.kind).toBe('survey');
    expect(sf.well).toBe('F-11');
    expect(Array.from(sf.md)).toEqual([0, 1000, 2000]);
    expect(Array.from(sf.inc)).toEqual([0, 10, 30]);
    const tops = assemble(readWitsml(f.sent[1].text)[0]).frames[0] as TopsFrame;
    expect(tops.names).toEqual(['Top Hugin', 'Top Sleipner']);

    // the depth log: "latest" starts 30 m above the end (1010), then only new rows arrive
    const depthMsgs = f.sent.filter((m) => m.key === 'L1');
    const depths = depthMsgs.flatMap((m) => {
      const b = readWitsml(m.text);
      expect(b).toHaveLength(1);
      const fr = assemble(b[0]).frames[0] as LogFrame;
      expect(fr).toMatchObject({ kind: 'log', index: 'depth', well: 'F-11' });
      expect(fr.channels.map((c) => c.name)).toEqual(['GR', 'ROP']);
      return Array.from(fr.key);
    });
    expect(depths.slice(0, 41)).toEqual(Array.from({ length: 41 }, (_, i) => 980 + i));
    expect(depths.every((d, i) => !i || d > depths[i - 1])).toBe(true);
    expect(depthMsgs[1].text).not.toContain('<data>1010,');
    const l1 = store.calls.filter((c) => c.type === 'log' && c.options === 'returnElements=all' && c.query.includes('uid="L1"'));
    expect(l1[0].query).toContain('<startIndex uom="m">980</startIndex>');
    expect(l1[1].query).toContain('<startIndex uom="m">1010</startIndex>');

    // the time log: capped answers (Result 2) are followed up at once; times never repeat
    const times = f.sent.filter((m) => m.key === 'T1').flatMap((m) => Array.from((assemble(readWitsml(m.text)[0]).frames[0] as LogFrame).key));
    expect(times[0]).toBe(T_END - 10 * 60 * 1000);
    expect(times.every((t, i) => !i || t > times[i - 1])).toBe(true);
    expect(times.length).toBeGreaterThanOrEqual(61 + 3);
    const t1 = store.calls.filter((c) => c.query.includes('uid="T1"') && c.options === 'returnElements=all');
    expect(t1[0].query).toContain(`<startDateTimeIndex>${new Date(T_END - 600_000).toISOString()}</startDateTimeIndex>`);
    expect(t1[1].query).toContain(`<startDateTimeIndex>${new Date(T_END - 600_000 + 49 * 10_000).toISOString()}</startDateTimeIndex>`);

    // discovery ran once, as an id-only query
    expect(store.calls.filter((c) => c.options === 'returnElements=id-only')).toHaveLength(1);
  }, 20000);

  it('fails fast on rejected credentials', async () => {
    const store = await witsmlStore({ password: 'other' });
    const f = fakeCtx(witsmlAdapter.params.parse({}));
    const cfg = witsmlAdapter.config.parse({ type: 'witsml', url: store.url, username: 'relay', password: 'secret', uidWell: 'W1', uidWellbore: 'WB1' });
    await expect(witsmlAdapter.open(cfg, f.ctx)).rejects.toThrow(/refused the relay's credentials \(401\)/);
    expect(f.sent).toHaveLength(0);
  });

  it('reports a store error (Result < 0) with its message', async () => {
    const store = await witsmlStore();
    const f = fakeCtx(witsmlAdapter.params.parse({}));
    const cfg = witsmlAdapter.config.parse({
      type: 'witsml',
      url: store.url,
      username: 'relay',
      password: 'secret',
      uidWell: 'W1',
      uidWellbore: 'WB1',
      logs: ['NOPE'],
      trajectory: false,
      markers: false,
    });
    await expect(witsmlAdapter.open(cfg, f.ctx)).rejects.toThrow(/error -433\): Log NOPE does not exist/);
    expect(f.events).toEqual(['ready:witsml']);
  });
});

// ------------------------------------------------------------------ OSDU

const WB = 'opendes:master-data--Wellbore:123';
const LOG = 'opendes:work-product-component--WellLog:gr-1';
const TRAJ = 'opendes:work-product-component--WellboreTrajectory:t-1';
const uom = (u: string) => `opendes:reference-data--UnitOfMeasure:${encodeURIComponent(u)}:`;

async function osduServer() {
  const s = { url: '', tokenCalls: 0, logReqs: 0, requests: [] as { method: string; path: string; search: URLSearchParams; body: string }[] };
  const json = (res: ServerResponse, status: number, v: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
  s.url = await serve((req, body, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(u.pathname);
    if (path === '/oauth/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== 'relay' || f.get('client_secret') !== 's3cret') return json(res, 401, { error: 'invalid_client' });
      s.tokenCalls++;
      return json(res, 200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (req.headers.authorization !== 'Bearer tok-1') return json(res, 401, { message: 'unauthorized' });
    if (req.headers['data-partition-id'] !== 'opendes') return json(res, 403, { message: 'forbidden' });
    s.requests.push({ method: req.method ?? '', path, search: u.searchParams, body });
    if (req.method === 'POST' && path === '/api/search/v2/query') {
      const q = JSON.parse(body) as { kind: string; query: string };
      if (!q.query.includes(`"${WB}"`)) return json(res, 200, { results: [], totalCount: 0 });
      if (q.kind.includes('WellLog')) return json(res, 200, { results: [{ id: LOG, kind: 'osdu:wks:work-product-component--WellLog:1.2.0', data: { Name: 'GR log' } }], totalCount: 1 });
      if (q.kind.includes('WellboreTrajectory')) return json(res, 200, { results: [{ id: TRAJ, data: { Name: 'Definitive survey' } }], totalCount: 1 });
      return json(res, 200, { results: [], totalCount: 0 });
    }
    const rec = /^\/api\/storage\/v2\/records\/(.+)$/.exec(path);
    if (rec) {
      if (rec[1] === WB) return json(res, 200, { id: WB, kind: 'osdu:wks:master-data--Wellbore:1.1.0', data: { FacilityName: 'F-11' } });
      if (rec[1] === LOG)
        return json(res, 200, {
          id: LOG,
          data: {
            Name: 'GR log',
            WellboreID: `${WB}:`,
            ReferenceCurveID: 'MD',
            Curves: [
              { CurveID: 'MD', CurveUnit: uom('ft') },
              { CurveID: 'GR', CurveUnit: uom('gAPI') },
              { CurveID: 'RHOB', CurveUnit: uom('g/cm3') },
            ],
          },
        });
      if (rec[1] === TRAJ)
        return json(res, 200, {
          id: TRAJ,
          data: {
            AvailableTrajectoryStationProperties: [
              { Name: 'MD', StationPropertyUnitID: uom('ft'), TrajectoryStationPropertyTypeID: 'opendes:reference-data--TrajectoryStationPropertyType:MD:' },
              { Name: 'Inclination', StationPropertyUnitID: uom('dega'), TrajectoryStationPropertyTypeID: 'opendes:reference-data--TrajectoryStationPropertyType:Inclination:' },
              { Name: 'Azimuth', StationPropertyUnitID: uom('dega'), TrajectoryStationPropertyTypeID: 'opendes:reference-data--TrajectoryStationPropertyType:AzimuthTN:' },
              { Name: 'TVD', StationPropertyUnitID: uom('ft'), TrajectoryStationPropertyTypeID: 'opendes:reference-data--TrajectoryStationPropertyType:TVD:' },
            ],
          },
        });
      return json(res, 404, { message: 'not found' });
    }
    if (req.headers.accept !== 'application/json') return json(res, 406, { message: 'accept' });
    if (path === `/api/os-wellbore-ddms/ddms/v3/welllogs/${LOG}/data` && u.searchParams.get('orient') === 'split') {
      const all = ['MD', 'GR', 'RHOB'];
      const cols = u.searchParams.get('curves')?.split(',') ?? all;
      const n = 5 + 3 * s.logReqs++;
      const rows = Array.from({ length: n }, (_, i) => ({ MD: 5000 + i * 0.5, GR: 40 + i, RHOB: i === 2 ? null : 2.3 }));
      return json(res, 200, { columns: cols, index: rows.map((_, i) => i), data: rows.map((r) => cols.map((c) => r[c as 'MD'])) });
    }
    if (path === `/api/os-wellbore-ddms/ddms/v3/wellboretrajectories/${TRAJ}/data` && u.searchParams.get('orient') === 'split')
      return json(res, 200, {
        columns: ['MD', 'Inclination', 'Azimuth', 'TVD'],
        index: [0, 1, 2],
        data: [
          [0, 0, 0, 0],
          [1000, 10, 45, 995],
          [2000, 30, 50, 1950],
        ],
      });
    json(res, 404, { message: 'not found' });
  });
  return s;
}

describe('OSDU relay adapter', () => {
  it('sends the trajectory and well log data as NDJSON records the browser reads, then only new rows', async () => {
    const srv = await osduServer();
    const f = fakeCtx(osduAdapter.params.parse({ curves: ['gr'] }));
    const cfg = osduAdapter.config.parse({
      type: 'osdu',
      baseUrl: srv.url,
      partition: 'opendes',
      auth: { kind: 'client-credentials', tokenUrl: `${srv.url}/oauth/token`, clientId: 'relay', clientSecret: 's3cret', scope: 'openid' },
      wellbores: [WB],
      interval: 0.05,
    });
    const run = osduAdapter.open(cfg, f.ctx);
    await until(() => f.sent.length >= 3);
    f.abort();
    await run;

    expect(f.events.slice(0, 3)).toEqual(['ready:json', 'send:F-11 trajectory', 'end']);
    expect(srv.tokenCalls).toBe(1);

    const [sf] = (await jsonFrames(f.sent[0].text)) as SurveyFrame[];
    expect(sf).toMatchObject({ kind: 'survey', well: 'F-11' });
    expect(Array.from(sf.md)).toEqual([0, 1000 * 0.3048, 2000 * 0.3048]);
    expect(Array.from(sf.inc)).toEqual([0, 10, 30]);
    expect(Array.from(sf.azi)).toEqual([0, 45, 50]);
    expect(JSON.parse(f.sent[0].text.split('\n')[1])).toEqual({ well: 'F-11', 'MD [ft]': 1000, 'INC [dega]': 10, 'AZI [dega]': 45, 'TVD [ft]': 995 });

    // the first read: every row; each later one: only rows past the last depth
    const logs = f.sent.slice(1);
    expect(JSON.parse(logs[0].text.split('\n')[0])).toEqual({ well: 'F-11', 'DEPTH [ft]': 5000, 'GR [gAPI]': 40 });
    const frames = await Promise.all(logs.map(async (m) => (await jsonFrames(m.text)) as LogFrame[]));
    for (const [fr] of frames) {
      expect(fr).toMatchObject({ kind: 'log', index: 'depth', well: 'F-11' });
      expect(fr.channels.map((c) => [c.name, c.unit])).toEqual([['GR', 'gAPI']]);
    }
    expect(Array.from(frames[0][0].key)).toEqual([5000, 5000.5, 5001, 5001.5, 5002].map((d) => d * 0.3048));
    expect(Array.from(frames[1][0].key)).toEqual([5002.5, 5003, 5003.5].map((d) => d * 0.3048));
    expect(Array.from(frames[1][0].channels[0].values)).toEqual([45, 46, 47]);

    const search = srv.requests.find((r) => r.path === '/api/search/v2/query' && r.body.includes('WellLog'))!;
    expect(JSON.parse(search.body)).toMatchObject({ kind: 'osdu:wks:work-product-component--WellLog:*', query: `data.WellboreID:("${WB}" OR "${WB}:")` });
    const data = srv.requests.filter((r) => r.path.endsWith('/data') && r.path.includes('welllogs'));
    expect(data[0].search.get('curves')).toBe('MD,GR');
    // the log's record was read once, not on every poll
    expect(srv.requests.filter((r) => r.path === `/api/storage/v2/records/${LOG}`)).toHaveLength(1);
  }, 20000);

  it('explains a wrong data partition (403)', async () => {
    const srv = await osduServer();
    const f = fakeCtx(osduAdapter.params.parse({}));
    const cfg = osduAdapter.config.parse({ type: 'osdu', baseUrl: srv.url, partition: 'other', auth: { kind: 'token', token: 'tok-1' }, wellbores: [WB], interval: 0 });
    await expect(osduAdapter.open(cfg, f.ctx)).rejects.toThrow(/denied access \(403\).*data partition "other"/);
  });

  it('explains a rejected token (401) and a missing wellbore (404)', async () => {
    const srv = await osduServer();
    const bad = osduAdapter.config.parse({ type: 'osdu', baseUrl: srv.url, partition: 'opendes', auth: { kind: 'token', token: 'expired' }, wellbores: [WB], interval: 0 });
    await expect(osduAdapter.open(bad, fakeCtx(osduAdapter.params.parse({})).ctx)).rejects.toThrow(/rejected the access token \(401\)/);
    const missing = osduAdapter.config.parse({
      type: 'osdu',
      baseUrl: srv.url,
      partition: 'opendes',
      auth: { kind: 'token', token: 'tok-1' },
      wellbores: ['opendes:master-data--Wellbore:999'],
      interval: 0,
    });
    await expect(osduAdapter.open(missing, fakeCtx(osduAdapter.params.parse({})).ctx)).rejects.toThrow(/wellbore opendes:master-data--Wellbore:999 was not found \(404\)/);
    await expect(osduAdapter.open(missing, fakeCtx(osduAdapter.params.parse({ wellbore: 'x' })).ctx)).rejects.toThrow(/not one of this source's wellbores/);
  });
});
