import { z } from 'zod';
import { backoff, defineAdapter, sleep, type RelayContext } from '../adapter';

/**
 * OSDU wellbores through the Search, Storage and Wellbore DDMS (v3) services.
 *
 * For each configured wellbore: its name from the Wellbore master record
 * (`data.FacilityName`), its trajectory (WellboreTrajectory bulk data) and
 * every WellLog's bulk data. The bulk data is read as a pandas "split"
 * document and forwarded as NDJSON records stamped with the well name, the
 * reference curve as `DEPTH [unit]` and each curve as `NAME [unit]`, so the
 * browser's `json` codec knows the well, the index and the units. With an
 * interval, the logs are read again and only rows past the last index are
 * forwarded (new WellLogs of the wellbore are picked up too).
 */

const Auth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), token: z.string().min(1) }),
  z.object({
    kind: z.literal('client-credentials'),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().default(''),
  }),
]);

const Config = z.object({
  type: z.literal('osdu'),
  label: z.string().optional(),
  baseUrl: z.string().url().describe('OSDU base URL, e.g. https://osdu.example.com'),
  partition: z.string().min(1).describe('data-partition-id'),
  auth: Auth,
  /** Wellbore master record ids, e.g. opendes:master-data--Wellbore:123 */
  wellbores: z.array(z.string().min(1)).min(1),
  /** seconds between reads of the logs; 0 = read once */
  interval: z.number().min(0).default(60),
  timeoutMs: z.number().int().positive().default(30000),
});
type Config = z.output<typeof Config>;

const Params = z.object({
  wellbore: z.string().optional().describe('One of the configured wellbore ids (default: all)'),
  curves: z.array(z.string()).optional().describe('Curves to read (default: all); the reference curve is always included'),
});
type Params = z.output<typeof Params>;

const WELL_LOG_KIND = 'osdu:wks:work-product-component--WellLog:*';
const TRAJECTORY_KIND = 'osdu:wks:work-product-component--WellboreTrajectory:*';
const DDMS = '/api/os-wellbore-ddms/ddms/v3';
/** rows per NDJSON message */
const ROWS_PER_MESSAGE = 5000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const fatal = (message: string) => Object.assign(new Error(message), { fatal: true });
const isFatal = (e: unknown) => !!(e as { fatal?: boolean } | null)?.fatal;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class NotFound extends Error {}

/** "opendes:reference-data--UnitOfMeasure:ft:" → "ft" (a plain unit stays as it is) */
export function unitOf(ref: unknown): string {
  if (typeof ref !== 'string' || !ref) return '';
  const m = /reference-data--UnitOfMeasure:(.+?):?$/.exec(ref);
  const u = m ? m[1] : ref;
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

/** an id without its trailing version colon, safe in a URL path (colons kept) */
const bare = (id: string) => id.replace(/:$/, '');
const pathId = (id: string) => encodeURIComponent(bare(id)).replace(/%3A/gi, ':');
/** a Lucene phrase matching a relationship to this record, versioned ("…:") or not */
const refQuery = (field: string, id: string) => {
  const q = bare(id).replace(/[\\"]/g, (c) => `\\${c}`);
  return `${field}:("${q}" OR "${q}:")`;
};

class Osdu {
  private token?: { value: string; expires: number };
  private degraded = false;
  constructor(
    private c: Config,
    private ctx: RelayContext<Params>,
  ) {}

  private async bearer(): Promise<string> {
    const a = this.c.auth;
    if (a.kind === 'token') return a.token;
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.clientSecret });
    if (a.scope) form.set('scope', a.scope);
    let res: Response;
    try {
      res = await fetch(a.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: this.signal() });
    } catch (e) {
      throw new Error(`Cannot reach the token endpoint: ${errText((e as { cause?: unknown }).cause ?? e)}`);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      throw fatal(`The token endpoint refused the client credentials (${res.status})${body ? `: ${body.slice(0, 200)}` : '.'}`);
    }
    if (!res.ok) throw new Error(`The token endpoint answered ${res.status} ${res.statusText}`.trim());
    const j = (await res.json()) as { access_token?: string; expires_in?: number | string };
    if (!j.access_token) throw fatal('The token endpoint answered without an access_token.');
    const life = Number(j.expires_in ?? 3600) * 1000;
    // renew a minute early (or halfway through a short-lived token)
    this.token = { value: j.access_token, expires: Date.now() + (life > 120_000 ? life - 60_000 : life / 2) };
    return j.access_token;
  }

  private signal() {
    return AbortSignal.any([this.ctx.signal, AbortSignal.timeout(this.c.timeoutMs)]);
  }

  /**
   * One call to an OSDU service, retried while it is unreachable or busy.
   * Throws NotFound on 404, a fatal error on 401/403; null once aborted.
   */
  async call<T>(method: 'GET' | 'POST', path: string, what: string, body?: unknown): Promise<T | null> {
    const { c, ctx } = this;
    const url = c.baseUrl.replace(/\/+$/, '') + path;
    let renewed = false;
    for (let attempt = 0; !ctx.signal.aborted; attempt++) {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${await this.bearer()}`, 'data-partition-id': c.partition, Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let res: Response;
        try {
          res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal() });
        } catch (e) {
          if (ctx.signal.aborted) return null;
          throw new Error(
            (e as { name?: string }).name === 'TimeoutError' ? `OSDU did not answer ${what} within ${c.timeoutMs} ms.` : `Cannot reach OSDU: ${errText((e as { cause?: unknown }).cause ?? e)}`,
          );
        }
        if (res.status === 401) {
          if (c.auth.kind === 'client-credentials' && !renewed) {
            // the cached token may have been revoked or expired early: fetch a new one once
            renewed = true;
            this.token = undefined;
            attempt--;
            continue;
          }
          throw fatal(
            `OSDU rejected the access token (401) reading ${what}: ${c.auth.kind === 'token' ? 'the configured token is invalid or expired' : 'the client credentials give a token OSDU does not accept'}.`,
          );
        }
        if (res.status === 403)
          throw fatal(
            `OSDU denied access (403) to ${what}: the identity needs viewer entitlements in data partition "${c.partition}" (and on the records' ACLs), and data-partition-id must be right.`,
          );
        if (res.status === 404) throw new NotFound(`${what} was not found (404) in data partition "${c.partition}".`);
        if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Error(`OSDU answered ${res.status} ${res.statusText} for ${what}`.replace(/\s+for/, ' for'));
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw fatal(`OSDU answered ${res.status} for ${what}${t ? `: ${t.slice(0, 300)}` : '.'}`);
        }
        const out = (await res.json()) as T;
        if (this.degraded) ctx.status('live');
        this.degraded = false;
        return out;
      } catch (e) {
        if (ctx.signal.aborted) return null;
        if (isFatal(e) || e instanceof NotFound) throw e;
        this.degraded = true;
        ctx.status('reconnecting', errText(e));
        await sleep(backoff(attempt), ctx.signal);
      }
    }
    return null;
  }

  async search(kind: string, wellbore: string, returnedFields: string[], what: string): Promise<Json[] | null> {
    const r = await this.call<{ results?: Json[]; totalCount?: number }>('POST', '/api/search/v2/query', what, { kind, query: refQuery('data.WellboreID', wellbore), returnedFields, limit: 1000 });
    if (!r) return null;
    const results = r.results ?? [];
    if ((r.totalCount ?? 0) > results.length) this.ctx.log(`${what}: reading the first ${results.length} of ${r.totalCount}.`, 'warn');
    return results;
  }

  record(id: string, what: string) {
    return this.call<Json>('GET', `/api/storage/v2/records/${pathId(id)}`, what);
  }
}

// ------------------------------------------------------------------ bulk data

interface Split {
  columns: string[];
  data: unknown[][];
  index?: unknown[];
}

function asSplit(v: unknown): Split | null {
  if (!isObj(v) || !Array.isArray(v.columns) || !Array.isArray(v.data)) return null;
  return { columns: v.columns.map(String), data: v.data as unknown[][], index: Array.isArray(v.index) ? v.index : undefined };
}

const scalar = (v: unknown) => (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null);
const indexValue = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : Date.parse(v)) : NaN);
const named = (name: string, unit: string) => (unit ? `${name} [${unit}]` : name);

interface LogState {
  id: string;
  name: string;
  ref: string;
  units: Map<string, string>;
  curves: string[];
  last: number;
  missing?: boolean;
}

/** NDJSON records of a WellLog's split data, only the rows past `last`. */
export function logRecords(split: Split, well: string, ref: string, units: Map<string, string>, last: number): { lines: string[]; last: number } {
  const { columns, data } = split;
  let r = columns.indexOf(ref);
  if (r < 0) r = columns.findIndex((c) => c.toLowerCase() === ref.toLowerCase());
  const trivial = !split.index || split.index.every((v, i) => v === i);
  // the reference curve: a column, else a meaningful pandas index, else the first column
  const refValues: unknown[] = r >= 0 ? data.map((row) => row[r]) : !trivial ? split.index! : data.map((row) => row[0]);
  const refCol = r >= 0 ? r : trivial ? 0 : -1;
  const refName = r >= 0 ? columns[r] : ref;
  const isTime = refValues.some((v) => typeof v === 'string' && !Number.isFinite(Number(v)));
  const refKey = isTime ? 'TIME' : named('DEPTH', units.get(refName) ?? units.get(ref) ?? '');
  const keys = columns.map((c) => named(c, units.get(c) ?? ''));
  const lines: string[] = [];
  let max = last;
  data.forEach((row, i) => {
    const iv = indexValue(refValues[i]);
    if (!Number.isFinite(iv) || iv <= last) return;
    if (iv > max) max = iv;
    const rec: Json = { well, [refKey]: scalar(refValues[i]) };
    columns.forEach((_, j) => {
      if (j !== refCol) rec[keys[j]] = scalar(row[j]);
    });
    lines.push(JSON.stringify(rec));
  });
  return { lines, last: max };
}

const TRAJ_ROLES: [key: string, name: RegExp, type: RegExp][] = [
  ['MD', /^(md|measured.?depth|depth|mdm)$/i, /MeasuredDepth|:MD:?$/i],
  ['INC', /^(inc|incl|inclination|dev|deviation)$/i, /Inclination/i],
  ['AZI', /^(azi|azim|azimuth|azimuthtn|azimuth.?true|azi.?tn)$/i, /Azimuth(TN)?(:|$)/i],
  ['TVD', /^(tvd|true.?vertical.?depth|tvdm)$/i, /TrueVerticalDepth|:TVD:?$/i],
  ['NS', /^(ns|disp.?ns|dy|dytn|north.?offset|ns.?offset)$/i, /:(DYTN|NSOffset)/i],
  ['EW', /^(ew|disp.?ew|dx|dxtn|east.?offset|ew.?offset)$/i, /:(DXTN|EWOffset)/i],
];

/** NDJSON survey records (MD / INC / AZI / TVD with units) of a trajectory's split data. */
export function trajectoryRecords(split: Split, well: string, props: Json[]): { lines: string[]; identified: boolean } {
  const keys = split.columns.map((col) => {
    const p = props.find((x) => x.Name === col);
    const type = String(p?.TrajectoryStationPropertyTypeID ?? '');
    const role = TRAJ_ROLES.find(([, n, t]) => n.test(col.trim()) || (type && t.test(type)));
    return { col, key: role ? role[0] : col, unit: unitOf(p?.StationPropertyUnitID) };
  });
  const seen = new Set<string>();
  // the first column of a role wins; a second one keeps its own name
  for (const k of keys) {
    if (seen.has(k.key)) k.key = k.col;
    seen.add(k.key);
  }
  const identified = ['MD', 'INC', 'AZI'].every((r) => seen.has(r));
  const lines = split.data.map((row) => {
    const rec: Json = { well };
    keys.forEach((k, j) => (rec[named(k.key, k.unit)] = scalar(row[j])));
    return JSON.stringify(rec);
  });
  return { lines, identified };
}

// ------------------------------------------------------------------ the adapter

export const osduAdapter = defineAdapter({
  type: 'osdu',
  label: 'OSDU (Wellbore DDMS)',
  config: Config,
  params: Params,
  describe: (c) => ({ baseUrl: c.baseUrl, partition: c.partition, wellbores: c.wellbores, interval: c.interval }),
  async open(c, ctx) {
    const { wellbore, curves } = ctx.params;
    if (wellbore && !c.wellbores.some((w) => bare(w) === bare(wellbore))) throw fatal(`Wellbore "${wellbore}" is not one of this source's wellbores (${c.wellbores.join(', ')}).`);
    const ids = wellbore ? [wellbore] : c.wellbores;
    const osdu = new Osdu(c, ctx);
    let announced = false;

    const send = async (lines: string[], topic: string) => {
      for (let i = 0; i < lines.length; i += ROWS_PER_MESSAGE) await ctx.send(lines.slice(i, i + ROWS_PER_MESSAGE).join('\n'), { topic, ts: Date.now(), contentType: 'application/x-ndjson' });
    };

    const wells: { id: string; well: string; logs: Map<string, LogState> }[] = [];
    for (const id of ids) {
      let rec: Json | null;
      try {
        rec = await osdu.record(id, `wellbore ${id}`);
      } catch (e) {
        if (e instanceof NotFound) throw fatal(e.message);
        throw e;
      }
      if (!rec) return;
      if (!announced) {
        announced = true;
        ctx.ready('json', {}, `OSDU ${new URL(c.baseUrl).host} (${c.partition})`);
      }
      const d = isObj(rec.data) ? rec.data : {};
      const well = String(d.FacilityName ?? d.Name ?? bare(id).split(':').pop() ?? id);
      wells.push({ id, well, logs: new Map() });

      // the trajectory, once
      const found = await osdu.search(TRAJECTORY_KIND, id, ['id', 'data.Name'], `trajectories of ${well}`);
      if (!found) return;
      if (found.length) {
        const pick = found.find((t) => /definitive|actual/i.test(String(isObj(t.data) ? t.data.Name : ''))) ?? found[0];
        if (found.length > 1) ctx.log(`${well} has ${found.length} trajectories; reading ${String(pick.id)}.`);
        try {
          const tr = await osdu.record(String(pick.id), `trajectory ${String(pick.id)}`);
          const bulk = await osdu.call<unknown>('GET', `${DDMS}/wellboretrajectories/${pathId(String(pick.id))}/data?orient=split`, `trajectory data of ${well}`);
          if (!tr || bulk === null) return;
          const split = asSplit(bulk);
          if (!split) ctx.log(`The trajectory data of ${well} is not a "split" JSON document; skipped.`, 'warn');
          else if (split.data.length) {
            const props = (isObj(tr.data) && Array.isArray(tr.data.AvailableTrajectoryStationProperties) ? tr.data.AvailableTrajectoryStationProperties : []).filter(isObj);
            const t = trajectoryRecords(split, well, props);
            if (!t.identified) ctx.log(`Could not tell MD, inclination and azimuth apart in the trajectory of ${well} (columns ${split.columns.join(', ')}).`, 'warn');
            await send(t.lines, `${well} trajectory`);
            ctx.end();
          }
        } catch (e) {
          if (!(e instanceof NotFound)) throw e;
          ctx.log(`${e.message} (trajectory of ${well})`, 'warn');
        }
      }
    }

    while (!ctx.signal.aborted) {
      const t0 = Date.now();
      for (const w of wells) {
        const found = await osdu.search(WELL_LOG_KIND, w.id, ['id', 'data.Name'], `well logs of ${w.well}`);
        if (!found) return;
        for (const hit of found) {
          const id = String(hit.id ?? '');
          if (!id || w.logs.has(id)) continue;
          let rec: Json | null;
          try {
            rec = await osdu.record(id, `well log ${id}`);
          } catch (e) {
            if (!(e instanceof NotFound)) throw e;
            ctx.log(e.message, 'warn');
            continue;
          }
          if (!rec) return;
          const d = isObj(rec.data) ? rec.data : {};
          const list = (Array.isArray(d.Curves) ? d.Curves : []).filter(isObj);
          const units = new Map(list.map((cv) => [String(cv.CurveID ?? cv.Mnemonic ?? ''), unitOf(cv.CurveUnit)] as [string, string]));
          const ref = String(d.ReferenceCurveID ?? list[0]?.CurveID ?? '');
          let want: string[] = [];
          if (curves?.length) {
            const lower = new Map([...units.keys()].map((k) => [k.toLowerCase(), k]));
            want = curves.map((cv) => lower.get(cv.toLowerCase())).filter((x): x is string => !!x);
            if (!want.length) {
              ctx.log(`${String(d.Name ?? id)} has none of the curves ${curves.join(', ')}.`);
              w.logs.set(id, { id, name: String(d.Name ?? id), ref, units, curves: [], last: -Infinity, missing: true });
              continue;
            }
            if (units.has(ref) && !want.includes(ref)) want.unshift(ref);
          }
          w.logs.set(id, { id, name: String(d.Name ?? id), ref, units, curves: want, last: -Infinity });
        }
        if (!found.length && !w.logs.size) ctx.log(`${w.well} has no well logs yet.`);
        for (const st of w.logs.values()) {
          if (st.missing || ctx.signal.aborted) continue;
          const q = `orient=split${st.curves.length ? `&curves=${st.curves.map(encodeURIComponent).join(',')}` : ''}`;
          let bulk: unknown;
          try {
            bulk = await osdu.call<unknown>('GET', `${DDMS}/welllogs/${pathId(st.id)}/data?${q}`, `data of well log ${st.name}`);
          } catch (e) {
            if (!(e instanceof NotFound)) throw e;
            if (st.last === -Infinity) ctx.log(`${st.name} (${st.id}) has no bulk data yet.`, 'warn');
            continue;
          }
          if (bulk === null) return;
          const split = asSplit(bulk);
          if (!split) {
            ctx.log(`The data of ${st.name} is not a "split" JSON document; skipped.`, 'warn');
            st.missing = true;
            continue;
          }
          const r = logRecords(split, w.well, st.ref, st.units, st.last);
          st.last = r.last;
          if (r.lines.length) await send(r.lines, `${w.well} ${st.name}`);
        }
      }
      if (!c.interval) return;
      await sleep(Math.max(0, c.interval * 1000 - (Date.now() - t0)), ctx.signal);
    }
  },
});
