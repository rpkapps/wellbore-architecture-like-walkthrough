import { z } from 'zod';
import { child, find, kids, parseXml, textOf, unescapeXml, type XmlNode } from '../../src/connect/xml';
import { backoff, defineAdapter, From, parseFrom, sleep, type RelayContext } from '../adapter';

/**
 * A WITSML 1.3.1.1 / 1.4.1.1 store, polled with WMLS_GetFromStore over SOAP
 * 1.1 (the "Store" interface of the WITSML API 1.2.0 WSDL, rpc/encoded).
 *
 * On open it reads the wellbore's trajectories and formation markers once
 * (each sent as one bare WITSML document followed by `end`), then polls every
 * configured log from the last index it received. Stores answer index ranges
 * inclusively, so rows at or before the last index are dropped from each
 * response before it is forwarded; a response with no new rows is not sent.
 * The browser reads the documents with its `witsml` codec.
 */

export const SOAP_ACTION = 'http://www.witsml.org/action/120/Store.WMLS_GetFromStore';
/** the rpc/encoded body namespace of the WITSML API 1.2.0 WSDL (the WSDL's own targetNamespace is …/wsdl/120) */
export const MESSAGE_NS = 'http://www.witsml.org/message/120';
const SCHEMA_NS = { '1.4.1.1': 'http://www.witsml.org/schemas/1series', '1.3.1.1': 'http://www.witsml.org/schemas/131' } as const;
type Version = keyof typeof SCHEMA_NS;

/** how far back "latest" reaches: time logs in ms, depth logs in the log's index unit */
const LATEST_TIME_MS = 10 * 60 * 1000;
const latestDepthWindow = (uom: string) => (/^(ft|ftUS|usft|ft\.us)$/i.test(uom) ? 100 : 30);
/** follow-up requests for one log when the store says more data is waiting (Result 2) */
const MAX_PARTIAL_ROUNDS = 50;

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A SOAP 1.1 WMLS_GetFromStore request. */
export function getFromStoreEnvelope(type: string, query: string, options: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    '<soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<wmls:WMLS_GetFromStore xmlns:wmls="${MESSAGE_NS}">` +
    `<WMLtypeIn xsi:type="xsd:string">${escapeXml(type)}</WMLtypeIn>` +
    `<QueryIn xsi:type="xsd:string">${escapeXml(query)}</QueryIn>` +
    `<OptionsIn xsi:type="xsd:string">${escapeXml(options)}</OptionsIn>` +
    '<CapabilitiesIn xsi:type="xsd:string"></CapabilitiesIn>' +
    '</wmls:WMLS_GetFromStore>' +
    '</soap:Body>' +
    '</soap:Envelope>'
  );
}

const Config = z.object({
  type: z.literal('witsml'),
  label: z.string().optional(),
  url: z.string().url().describe('Store endpoint (the SOAP service URL)'),
  username: z.string().default(''),
  password: z.string().default(''),
  version: z.enum(['1.4.1.1', '1.3.1.1']).default('1.4.1.1'),
  uidWell: z.string().min(1),
  uidWellbore: z.string().min(1),
  /** log uids; empty = every log of the wellbore (discovered once on open) */
  logs: z.array(z.string().min(1)).default([]),
  trajectory: z.boolean().default(true),
  markers: z.boolean().default(true),
  /** seconds between polls of each log */
  interval: z.number().min(0.05).default(10),
  timeoutMs: z.number().int().positive().default(30000),
});
type Config = z.output<typeof Config>;
const Params = z.object({ from: From });
type Params = z.output<typeof Params>;

interface Reply {
  result: number;
  xml: string;
  msg: string;
}

interface LogState {
  uid: string;
  name: string;
  time: boolean;
  /** unit of a depth index */
  uom: string;
  /** +1 increasing, -1 decreasing */
  dir: number;
  /** start index for the next request, as the store wrote it; undefined = from the top */
  start?: string;
  /** index of the last row forwarded (epoch ms for time logs); -Infinity before the first */
  last: number;
  /** column of the index in a data row */
  pos?: number;
}

const fatal = (message: string) => Object.assign(new Error(message), { fatal: true });
const isFatal = (e: unknown) => !!(e as { fatal?: boolean } | null)?.fatal;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Store {
  private announced = false;
  private degraded = false;
  constructor(
    private c: Config,
    private ctx: RelayContext<Params>,
  ) {}

  private get ns() {
    return SCHEMA_NS[this.c.version as Version];
  }

  /** `<logs …>inner</logs>` with the schema namespace and version */
  plural(type: string, inner: string) {
    return `<${type}s xmlns="${this.ns}" version="${this.c.version}">${inner}</${type}s>`;
  }

  ids(extra = '') {
    return `uidWell="${escapeXml(this.c.uidWell)}" uidWellbore="${escapeXml(this.c.uidWellbore)}"${extra}`;
  }

  /** One WMLS_GetFromStore call, retried while the store is unreachable. Null once aborted. */
  async get(type: string, query: string, options: string): Promise<Reply | null> {
    const { c, ctx } = this;
    const headers: Record<string, string> = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SOAP_ACTION}"`, Accept: 'text/xml' };
    if (c.username || c.password) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
    const body = getFromStoreEnvelope(type, query, options);
    let faults = 0;
    for (let attempt = 0; !ctx.signal.aborted; attempt++) {
      try {
        let res: Response;
        try {
          res = await fetch(c.url, { method: 'POST', headers, body, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(c.timeoutMs)]) });
        } catch (e) {
          if (ctx.signal.aborted) return null;
          const name = (e as { name?: string }).name;
          throw new Error(name === 'TimeoutError' ? `The WITSML store did not answer within ${c.timeoutMs} ms.` : `Cannot reach the WITSML store: ${errText((e as { cause?: unknown }).cause ?? e)}`);
        }
        if (res.status === 401) throw fatal(`The WITSML store refused the relay's credentials (401): check username and password of this source.`);
        if (res.status === 403) throw fatal(`The WITSML store denied access (403) for user "${c.username}": the account may not read well ${c.uidWell}.`);
        const text = await res.text();
        const doc = parseXml(text);
        const fault = find(doc, 'Fault')[0];
        if (fault) {
          const why = textOf(fault, 'faultstring') || textOf(child(fault, 'Reason'), 'Text') || `HTTP ${res.status}`;
          // a fault may be a passing server problem; three in a row means the request itself is wrong
          if (++faults >= 3) throw fatal(`The WITSML store answered ${type} queries with a SOAP fault: ${why}`);
          throw new Error(`SOAP fault: ${why}`);
        }
        if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Error(`The WITSML store answered ${res.status} ${res.statusText}`.trim());
        if (!res.ok) throw fatal(`The WITSML store at ${c.url} answered ${res.status} ${res.statusText}: is this the store's SOAP endpoint?`.replace(/\s+:/, ':'));
        const r = find(doc, 'Result')[0];
        const result = r ? Number(r.text.trim()) : NaN;
        if (!Number.isFinite(result)) throw fatal(`${c.url} did not answer with a WMLS_GetFromStore response: is this a WITSML store endpoint?`);
        if (!this.announced) {
          this.announced = true;
          ctx.ready('witsml', {}, `WITSML ${c.version} ${new URL(c.url).host}`);
        } else if (this.degraded) ctx.status('live');
        this.degraded = false;
        return { result, xml: find(doc, 'XMLout')[0]?.text.trim() ?? '', msg: textOf(find(doc, 'SuppMsgOut')[0]) };
      } catch (e) {
        if (ctx.signal.aborted) return null;
        if (isFatal(e)) throw e;
        this.degraded = true;
        ctx.status('reconnecting', errText(e));
        await sleep(backoff(attempt), ctx.signal);
      }
    }
    return null;
  }
}

const storeError = (what: string, r: Reply) => `The WITSML store refused the ${what} query (error ${r.result})${r.msg ? `: ${r.msg}` : '.'}`;

/** where the index is in a data row of a 1.4.1 (mnemonicList) or 1.3.1 (columnIndex) log */
function indexPosition(log: XmlNode): number {
  const infos = kids(log, 'logCurveInfo');
  const idx = textOf(log, 'indexCurve');
  const list = textOf(child(log, 'logData'), 'mnemonicList');
  if (list) {
    const p = list.split(',').map((s) => s.trim());
    const i = idx ? p.indexOf(idx) : 0;
    return i >= 0 ? i : 0;
  }
  const colIdx = child(log, 'indexCurve')?.attrs.columnIndex;
  const info = infos.find((i) => textOf(i, 'mnemonic') === idx);
  const col = Number(textOf(info, 'columnIndex') || colIdx);
  if (!Number.isFinite(col)) return 0;
  // 1.3.1 columnIndex is 1-based; data rows hold the columns in columnIndex order
  const sorted = infos
    .map((i) => Number(textOf(i, 'columnIndex')))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const at = sorted.indexOf(col);
  return at >= 0 ? at : Math.max(0, col - 1);
}

const DATA_ROW = /<((?:[A-Za-z_][\w.-]*:)?)data(\s[^>]*)?>([\s\S]*?)<\/\1data\s*>/g;

/**
 * The rows of a log response past the last index forwarded: the document with
 * older rows removed, how many were kept and where the next request starts.
 */
export function newRows(xml: string, st: Pick<LogState, 'time' | 'dir' | 'last' | 'pos'>): { xml: string; kept: number; last: number; start?: string } {
  const doc = parseXml(xml);
  const log = find(doc, 'log')[0];
  if (!log || !child(log, 'logData')) return { xml, kept: 0, last: st.last };
  const pos = st.pos ?? indexPosition(log);
  let kept = 0;
  let last = st.last;
  let start: string | undefined;
  const out = xml.replace(DATA_ROW, (m, _p, _a, body: string) => {
    const cell = (unescapeXml(body).split(',')[pos] ?? '').trim();
    const v = st.time ? Date.parse(cell) : cell === '' ? NaN : Number(cell);
    if (!Number.isFinite(v) || st.dir * v <= st.dir * st.last) return '';
    kept++;
    if (st.dir * v > st.dir * last) {
      last = v;
      start = cell;
    }
    return m;
  });
  return { xml: out, kept, last, start };
}

export const witsmlAdapter = defineAdapter({
  type: 'witsml',
  label: 'WITSML 1.3.1 / 1.4.1 store (SOAP)',
  config: Config,
  params: Params,
  describe: (c) => ({ url: c.url.replace(/[?#].*$/, ''), version: c.version, uidWell: c.uidWell, uidWellbore: c.uidWellbore, logs: c.logs, interval: c.interval }),
  async open(c, ctx) {
    const store = new Store(c, ctx);
    const from = parseFrom(ctx.params.from);

    // trajectories and formation markers, once
    for (const [on, type, node] of [
      [c.trajectory, 'trajectory', 'trajectoryStation'],
      [c.markers, 'formationMarker', 'formationMarker'],
    ] as const) {
      if (!on) continue;
      const r = await store.get(type, store.plural(type, `<${type} ${store.ids(' uid=""')}/>`), 'returnElements=all');
      if (!r) return;
      if (r.result < 0) {
        ctx.log(storeError(type, r), 'warn');
        continue;
      }
      if (r.xml && find(parseXml(r.xml), node).length) {
        await ctx.send(r.xml, { topic: type, ts: Date.now(), contentType: 'application/xml' });
        ctx.end();
      }
    }

    // the logs to follow
    let uids = c.logs;
    if (!uids.length) {
      const r = await store.get('log', store.plural('log', `<log ${store.ids(' uid=""')}><name/></log>`), 'returnElements=id-only');
      if (!r) return;
      if (r.result < 0) throw fatal(storeError('log list', r));
      uids = r.xml
        ? find(parseXml(r.xml), 'log')
            .map((l) => l.attrs.uid ?? '')
            .filter(Boolean)
        : [];
      if (!uids.length) {
        ctx.log(`Wellbore ${c.uidWellbore} of well ${c.uidWell} has no logs.`, 'warn');
        ctx.status('idle', 'No logs in this wellbore');
        return;
      }
      ctx.log(`Following ${uids.length} log(s): ${uids.join(', ')}.`);
    }

    const logs: LogState[] = [];
    for (const uid of uids) {
      const r = await store.get('log', store.plural('log', `<log ${store.ids(` uid="${escapeXml(uid)}"`)}/>`), 'returnElements=header-only');
      if (!r) return;
      if (r.result < 0) throw fatal(storeError(`log ${uid} header`, r));
      const h = r.xml ? find(parseXml(r.xml), 'log')[0] : undefined;
      if (!h) throw fatal(`Log "${uid}" was not found in wellbore ${c.uidWellbore} of well ${c.uidWell}.`);
      const time = /time/i.test(textOf(h, 'indexType'));
      const idxInfo = kids(h, 'logCurveInfo').find((i) => textOf(i, 'mnemonic') === textOf(h, 'indexCurve'));
      const uom = child(h, 'endIndex')?.attrs.uom || child(h, 'startIndex')?.attrs.uom || child(idxInfo, 'unit')?.attrs.uom || textOf(idxInfo, 'unit') || 'm';
      const st: LogState = { uid, name: textOf(h, 'name') || uid, time, uom, dir: /decreasing/i.test(textOf(h, 'direction')) ? -1 : 1, last: -Infinity };
      if (st.dir < 0) st.last = Infinity;
      if (time) {
        const end = Date.parse(textOf(h, 'endDateTimeIndex'));
        if (from === null && Number.isFinite(end)) st.start = new Date(end - LATEST_TIME_MS).toISOString();
        else if (from !== null && from >= 0) st.start = new Date(from).toISOString();
      } else if (from === null) {
        const end = Number(textOf(h, 'endIndex') || NaN);
        if (Number.isFinite(end)) st.start = String(end - st.dir * latestDepthWindow(uom));
      }
      logs.push(st);
    }

    const query = (st: LogState) => {
      const range =
        st.start === undefined ? '' : st.time ? `<startDateTimeIndex>${escapeXml(st.start)}</startDateTimeIndex>` : `<startIndex uom="${escapeXml(st.uom)}">${escapeXml(st.start)}</startIndex>`;
      return store.plural('log', `<log ${store.ids(` uid="${escapeXml(st.uid)}"`)}>${range}</log>`);
    };

    while (!ctx.signal.aborted) {
      const t0 = Date.now();
      for (const st of logs) {
        for (let round = 0; round < MAX_PARTIAL_ROUNDS && !ctx.signal.aborted; round++) {
          const r = await store.get('log', query(st), 'returnElements=all');
          if (!r) return;
          if (r.result < 0) throw fatal(storeError(`log ${st.uid} data`, r));
          if (!r.xml) break;
          if (st.pos === undefined) {
            const l = find(parseXml(r.xml), 'log')[0];
            if (l && child(l, 'logData')) st.pos = indexPosition(l);
          }
          const n = newRows(r.xml, st);
          if (!n.kept) break;
          st.last = n.last;
          if (n.start !== undefined) st.start = n.start;
          await ctx.send(n.xml, { topic: st.name, key: st.uid, ts: Date.now(), contentType: 'application/xml' });
          // Result 2: partial success, more rows are waiting
          if (r.result !== 2) break;
        }
      }
      await sleep(Math.max(0, c.interval * 1000 - (Date.now() - t0)), ctx.signal);
    }
  },
});
