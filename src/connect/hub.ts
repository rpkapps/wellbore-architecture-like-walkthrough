import { sameWell } from '../data/csv';
import { Well } from '../data/dataset';
import { formationIdForPick } from '../data/stratigraphy';
import { Trajectory, stationsFromSurvey } from '../data/trajectory';
import { toMonthly } from '../data/csv';
import type { ProductionRecord, SurveyStation } from '../data/types';
import type { App } from '../ui/app';
import { Rev, Signal } from '../ui/signal';
import type { Frame, LogFrame, ProductionFrame, SurveyFrame, TopsFrame } from './frames';
import { ConnectorConfig, type ConnectorInput, type Stats } from './pipeline';
import type { TransportState } from './plugin';
import { LiveLog, TimeSeries } from './store';
import type { FromWorker, PreviewResult, ToWorker } from './worker';

export interface ConnectionState {
  id: string;
  config: ConnectorConfig;
  status: TransportState | 'stopped';
  detail?: string;
  codec: string | null;
  stats: Stats | null;
  /** values per second, the last minute (one entry per second) */
  rate: number[];
  /** ids of the wells this connection has written to */
  wells: string[];
  log: { at: number; text: string; level: 'info' | 'warn' | 'error' }[];
  paused: boolean;
}

interface LiveWell {
  log?: LiveLog;
  series?: TimeSeries;
  stations?: SurveyStation[];
  /** deepest MD when its wellbore geometry was last built */
  builtTd: number;
  dirty: { logs: boolean; curves: boolean; path: boolean; tops: boolean; production: boolean };
  lastDepth: number;
  lastTime: number;
  /** shallowest depth changed since the last refresh */
  dirtyFrom: number;
}

const STORE_KEY = 'bw.connections.v1';
const BUILD_AHEAD = 50;
/** run heavy work when the page is idle (but within `timeout`) */
const idle = (fn: () => void, timeout: number) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 1));
/** A connection to start: an id is made up when it has none. */
export type NewConnection = Omit<ConnectorInput, 'id'> & { id?: string };

const SECRET = /token|password|secret|authorization|apikey|api_key|cookie/i;
const newWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

/** What only the page knows: the replay reads the dataset next to the page, not next to the worker's script. */
function withPage(config: ConnectorConfig): ConnectorConfig {
  if (config.transport.id !== 'replay') return config;
  return { ...config, transport: { ...config.transport, options: { ...(config.transport.options as object), baseUrl: new URL('./data/volve/', document.baseURI).href } } };
}

/** Transport options without credentials, for saving. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object' && !(v instanceof Blob)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '' : scrub(x)]));
  return v;
}

/**
 * The page side of the connectors. It starts a worker per connection,
 * applies what the workers deliver to the wells — at most a few
 * milliseconds of work per animation frame, acknowledging each delivery only
 * once it is applied, so a fast source is held back in its worker instead of
 * flooding the page — and refreshes the 3D view, the log tracks and the
 * panels at a rate set by how long each refresh takes.
 */
export class DataHub {
  readonly connections = new Signal<ConnectionState[]>([]);
  /** time-indexed readings arrived (live charts redraw on this) */
  readonly seriesRev = new Rev();
  /** keep the camera and the log tracks at the bit while a well is being drilled */
  readonly followBit = new Signal(true);
  /** the connection the Live data panel should show expanded */
  readonly focus = new Signal<string | null>(null);
  readonly live = new Map<string, LiveWell>();

  private workers = new Map<string, Worker>();
  private queue: { conn: string; frames: Frame[]; next: number; worker: Worker }[] = [];
  private draining = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = 0;
  private lastRebuild = 0;
  private lastFeatures = 0;
  private costLight = 8;
  private costRebuild = 60;
  private costFeatures = 40;
  private seriesQueued = false;
  private rebuildQueued = false;
  private lastPanels = 0;
  private featuresQueued = false;
  private newWellFor = new Map<string, string>();
  private focusConn = new Set<string>();
  private pendingFocus: string | null = null;

  constructor(private readonly app: App) {
    this.restore();
  }

  // ------------------------------------------------------------------ connections

  /**
   * Start a connection. With `focus`, the first well it creates becomes the
   * active well once its first data is in, with the view at the bottom.
   */
  connect(input: NewConnection, files?: File[], opts: { focus?: boolean } = {}): string {
    const config = ConnectorConfig.parse({ ...input, id: input.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` });
    const existing = this.connections.value.find((c) => c.id === config.id);
    if (existing) this.stop(config.id);
    const state: ConnectionState = { id: config.id, config, status: 'connecting', codec: null, stats: null, rate: [], wells: existing?.wells ?? [], log: [], paused: false };
    this.connections.set([...this.connections.value.filter((c) => c.id !== config.id), state]);
    if (opts.focus) this.focusConn.add(config.id);
    this.start(config, files);
    this.save();
    return config.id;
  }

  /** Start (or restart) a saved connection. */
  resume(id: string) {
    const c = this.get(id);
    if (!c) return;
    if (this.workers.has(id)) return this.pause(id, false);
    this.patch(id, { status: 'connecting', paused: false, detail: undefined });
    this.start(c.config);
  }

  pause(id: string, paused: boolean) {
    this.workers.get(id)?.postMessage({ type: 'pause', paused } satisfies ToWorker);
    this.patch(id, { paused });
  }

  stop(id: string) {
    const w = this.workers.get(id);
    if (w) {
      w.postMessage({ type: 'stop' } satisfies ToWorker);
      setTimeout(() => w.terminate(), 500);
      this.workers.delete(id);
    }
    this.queue = this.queue.filter((q) => q.conn !== id);
    this.patch(id, { status: 'stopped', paused: false });
  }

  remove(id: string) {
    this.stop(id);
    this.connections.set(this.connections.value.filter((c) => c.id !== id));
    this.save();
  }

  update(id: string, input: NewConnection) {
    this.connect({ ...input, id });
  }

  get(id: string) {
    return this.connections.value.find((c) => c.id === id);
  }

  /** Run a connection for a moment and see what it would deliver, without touching any well. */
  preview(input: NewConnection, files?: File[], opts: { rows?: number; timeoutMs?: number } = {}): Promise<PreviewResult> {
    const config = ConnectorConfig.parse({ ...input, id: input.id || 'preview' });
    return new Promise((resolve) => {
      const w = newWorker();
      const done = (r: PreviewResult) => {
        w.terminate();
        resolve(r);
      };
      const t = setTimeout(() => done({ codec: null, raw: [], out: [], frames: [], logs: [], error: 'No data arrived in time.' }), (opts.timeoutMs ?? 6000) + 4000);
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'preview') {
          clearTimeout(t);
          done(e.data.result);
        }
      };
      w.onerror = (e) => {
        clearTimeout(t);
        done({ codec: null, raw: [], out: [], frames: [], logs: [], error: e.message || 'The connector failed to start.' });
      };
      w.postMessage({ type: 'preview', config: withPage(config), files, rows: opts.rows, timeoutMs: opts.timeoutMs } satisfies ToWorker);
    });
  }

  /** The plugins (with their option schemas), including custom modules. */
  describe(plugins: string[] = []): Promise<Extract<FromWorker, { type: 'describe' }>> {
    return new Promise((resolve) => {
      const w = newWorker();
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'describe') {
          w.terminate();
          resolve(e.data);
        }
      };
      w.postMessage({ type: 'describe', plugins } satisfies ToWorker);
    });
  }

  private start(config: ConnectorConfig, files?: File[]) {
    const w = newWorker();
    this.workers.set(config.id, w);
    let prevSamples = 0;
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (this.workers.get(config.id) !== w) return;
      switch (m.type) {
        case 'frames':
          this.queue.push({ conn: config.id, frames: m.frames, next: 0, worker: w });
          this.schedule();
          break;
        case 'status':
          this.patch(config.id, { status: m.state, detail: m.detail });
          if (m.state === 'error') this.say(config.id, m.detail ?? 'Error', 'error');
          break;
        case 'log':
          this.say(config.id, m.text, m.level);
          break;
        case 'stats': {
          const c = this.get(config.id);
          if (!c) break;
          const rate = [...c.rate, Math.max(0, m.stats.samples - prevSamples)].slice(-60);
          prevSamples = m.stats.samples;
          this.patch(config.id, { stats: m.stats, codec: m.codec, rate });
          break;
        }
      }
    };
    w.onerror = (e) => {
      this.patch(config.id, { status: 'error', detail: e.message });
      this.say(config.id, e.message || 'The connector stopped.', 'error');
    };
    w.postMessage({ type: 'start', config: withPage(config), files } satisfies ToWorker);
  }

  private patch(id: string, p: Partial<ConnectionState>) {
    this.connections.set(this.connections.value.map((c) => (c.id === id ? { ...c, ...p } : c)));
  }

  private say(id: string, text: string, level: 'info' | 'warn' | 'error') {
    const c = this.get(id);
    if (!c) return;
    this.patch(id, { log: [...c.log, { at: Date.now(), text, level }].slice(-60) });
  }

  private save() {
    try {
      const keep = this.connections.value
        .filter((c) => c.config.transport.id !== 'file')
        .map((c) => ({ ...c.config, transport: { ...c.config.transport, options: scrub(c.config.transport.options) } }));
      localStorage.setItem(STORE_KEY, JSON.stringify(keep));
    } catch {
      /* storage blocked */
    }
  }

  /** Saved connections come back stopped: starting one is the user's call (and may need its credentials again). */
  private restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as unknown[];
      const list: ConnectionState[] = [];
      for (const r of raw) {
        const p = ConnectorConfig.safeParse(r);
        if (p.success) list.push({ id: p.data.id, config: p.data, status: 'stopped', codec: null, stats: null, rate: [], wells: [], log: [], paused: false });
      }
      this.connections.set(list);
    } catch {
      /* none saved */
    }
  }

  // ------------------------------------------------------------------ applying frames

  private schedule() {
    if (!this.draining) this.draining = requestAnimationFrame(() => this.drain());
  }

  /** Apply queued frames for up to ~4 ms, then yield to the page until the next frame. */
  private drain() {
    this.draining = 0;
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < 4) {
      const q = this.queue[0];
      const f = q.frames[q.next++];
      if (f) {
        try {
          this.apply(q.conn, f);
        } catch (e) {
          this.say(q.conn, `Could not apply ${f.kind} data: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      }
      if (q.next >= q.frames.length) {
        this.queue.shift();
        // only now may the worker send the next delivery
        q.worker.postMessage({ type: 'ack' } satisfies ToWorker);
      }
    }
    if (this.queue.length) this.schedule();
    else if (this.pendingFocus) this.focusWell(this.pendingFocus);
    this.planRefresh();
  }

  private liveWell(w: Well): LiveWell {
    let l = this.live.get(w.id);
    if (!l)
      this.live.set(
        w.id,
        (l = { builtTd: w.tdMD, dirty: { logs: false, curves: false, path: false, tops: false, production: false }, lastDepth: -Infinity, lastTime: -Infinity, dirtyFrom: Infinity }),
      );
    return l;
  }

  /** The well a frame belongs to, creating one when the data names a well BoreWalk does not have. */
  private wellFor(connId: string, name: string | undefined): Well {
    const c = this.get(connId)!;
    const t = c.config.target;
    const field = this.app.field;
    const byName = (n: string) => field.wells.find((w) => w.id === n || sameWell(w.name, n));
    let w: Well | undefined;
    if (t.mode === 'well' && t.well) w = byName(t.well);
    else if (t.mode === 'active') w = this.app.engine.activeWell;
    else if (name) w = byName(name);
    else if (t.mode === 'new') {
      const id = this.newWellFor.get(connId);
      w = id ? field.wells.find((x) => x.id === id) : undefined;
    } else w = this.app.engine.activeWell;
    if (!w) {
      w = this.createWell(name || t.well || c.config.name, c.config.name);
      if (!name) this.newWellFor.set(connId, w.id);
      if (this.focusConn.delete(connId)) this.pendingFocus = w.id;
    }
    if (!c.wells.includes(w.id)) this.patch(connId, { wells: [...c.wells, w.id] });
    return w;
  }

  private createWell(name: string, source: string): Well {
    const st = stationsFromSurvey(
      [
        { md: 0, inc: 0, azi: 0, tvd: NaN, ns: NaN, ew: NaN },
        { md: 50, inc: 0, azi: 0, tvd: NaN, ns: NaN, ew: NaN },
      ],
      false,
    );
    const w = new Well(`live-${Date.now().toString(36)}`, name, new Trajectory(st, 'user', 'Vertical until a survey arrives', 'assumed'), 'A well created by a live data connection.');
    w.userAdded = true;
    w.loaded = true;
    w.liveSource = source;
    this.app.field.wells.push(w);
    this.app.wellRev.bump();
    this.app.toast(`New well “${name}” from a live connection`);
    return w;
  }

  private apply(connId: string, f: Frame) {
    const w = this.wellFor(connId, f.well);
    const l = this.liveWell(w);
    const source = `Live · ${this.get(connId)?.config.name ?? connId}`;
    switch (f.kind) {
      case 'log':
        return f.index === 'depth' ? this.applyDepth(w, l, f, source) : this.applyTime(l, f);
      case 'survey':
        return this.applySurvey(w, l, f, source);
      case 'tops':
        return this.applyTops(w, l, f, source);
      case 'production':
        return this.applyProduction(w, l, f, source);
    }
  }

  private applyDepth(w: Well, l: LiveWell, f: LogFrame, source: string) {
    l.log ??= new LiveLog(w.logs, source);
    // being drilled: build the 3D hole ahead of the bit, so it is rebuilt every ~50 m instead of every update
    w.buildAhead = BUILD_AHEAD;
    if (l.log.merge(f.key, f.channels, f.step)) l.dirty.curves = true;
    w.logs = l.log.view(w.name);
    if (f.key.length) l.dirtyFrom = Math.min(l.dirtyFrom, f.key[0]);
    l.lastDepth = Math.max(l.lastDepth, l.log.last);
    l.dirty.logs = true;
  }

  private applyTime(l: LiveWell, f: LogFrame) {
    l.series ??= new TimeSeries();
    l.series.append(f.key, f.channels);
    l.lastTime = Math.max(l.lastTime, l.series.last);
    if (!this.seriesQueued) {
      this.seriesQueued = true;
      setTimeout(() => {
        this.seriesQueued = false;
        this.seriesRev.bump();
      }, 250);
    }
  }

  private applySurvey(w: Well, l: LiveWell, f: SurveyFrame, source: string) {
    l.stations ??= w.trajectory.status === 'user' ? [] : w.trajectory.stations.map((s) => ({ ...s }));
    for (let i = 0; i < f.md.length; i++) {
      const s = { md: f.md[i], inc: f.inc[i], azi: f.azi[i], tvd: f.tvd?.[i] ?? NaN, ns: f.ns?.[i] ?? NaN, ew: f.ew?.[i] ?? NaN };
      if (!Number.isFinite(s.md) || !Number.isFinite(s.inc) || !Number.isFinite(s.azi)) continue;
      const at = l.stations.findIndex((x) => Math.abs(x.md - s.md) < 0.01);
      if (at >= 0) l.stations[at] = s;
      else l.stations.push(s);
    }
    l.stations.sort((a, b) => a.md - b.md);
    const rows = l.stations.filter((s) => s.md > 0 || l.stations!.length === 1);
    if (rows.length < 1) return;
    const positions = rows.every((r) => Number.isFinite(r.tvd) && Number.isFinite(r.ns) && Number.isFinite(r.ew));
    const st = stationsFromSurvey(rows.length === 1 ? [{ md: 0, inc: 0, azi: 0, tvd: 0, ns: 0, ew: 0 }, ...rows] : rows, positions);
    if (st.length < 2) return;
    w.trajectory = new Trajectory(st, 'measured', `Survey streamed from ${source}`, source);
    l.dirty.path = true;
  }

  private applyTops(w: Well, l: LiveWell, f: TopsFrame, source: string) {
    for (let i = 0; i < f.names.length; i++) {
      if (!f.names[i] || !Number.isFinite(f.md[i])) continue;
      const top = { name: f.names[i], formationId: formationIdForPick(f.names[i]), md: f.md[i], tvd: f.tvd?.[i], source, provenance: 'interpreted' as const };
      const at = w.tops.findIndex((t) => t.name === top.name);
      if (at >= 0) w.tops[at] = top;
      else w.tops.push(top);
    }
    w.tops.sort((a, b) => a.md - b.md);
    l.dirty.tops = true;
  }

  private applyProduction(w: Well, l: LiveWell, f: ProductionFrame, source: string) {
    const recs = w.production?.records.slice() ?? [];
    const byT = new Map(recs.map((r, i) => [r.t, i]));
    for (let i = 0; i < f.t.length; i++) {
      const t = f.t[i];
      if (!Number.isFinite(t)) continue;
      const g = (a?: Float64Array) => (a && Number.isFinite(a[i]) ? a[i] : undefined);
      const prev = byT.has(t) ? recs[byT.get(t)!] : undefined;
      const r: ProductionRecord = {
        t,
        hours: g(f.hours) ?? prev?.hours ?? 24,
        oil: g(f.oil) ?? prev?.oil ?? 0,
        gas: g(f.gas) ?? prev?.gas ?? 0,
        water: g(f.water) ?? prev?.water ?? 0,
        waterInj: g(f.waterInj) ?? prev?.waterInj ?? 0,
        bhp: g(f.bhp) ?? prev?.bhp,
        whp: g(f.whp) ?? prev?.whp,
        bht: g(f.bht) ?? prev?.bht,
        choke: g(f.choke) ?? prev?.choke,
      };
      if (prev) recs[byT.get(t)!] = r;
      else {
        byT.set(t, recs.length);
        recs.push(r);
      }
    }
    recs.sort((a, b) => a.t - b.t);
    w.production = { wellName: w.name, period: 'daily', records: recs, source, provenance: 'measured' };
    w.productionMonthly = toMonthly(w.production);
    l.dirty.production = true;
  }

  /** Make a well that live data created the active one, looking at its bottom. */
  private focusWell(id: string) {
    this.pendingFocus = null;
    const l = this.live.get(id);
    void this.app.loadWellAsync(id, false).then(() => {
      if (l) l.builtTd = this.app.engine.activeWell.tdMD;
      const md = l && Number.isFinite(l.lastDepth) ? l.lastDepth : this.app.engine.activeWell.tdMD;
      this.app.travelTo(Math.max(0, md - 15));
      this.app.startFollowing();
      this.app.openLive(id);
    });
  }

  // ------------------------------------------------------------------ refreshing the view

  /**
   * Refresh the active well at a pace its cost allows: the cheap update
   * (interpretation, 3D colouring, log tracks) no more often than every
   * max(200 ms, 4 × its cost); a rebuild of the wellbore (it grew, or its path
   * changed) every max(1.5 s, 6 × its cost); the feature panels every
   * max(3 s, 10 × their cost).
   */
  private planRefresh() {
    if (this.refreshTimer) return;
    const w = this.app.engine?.activeWell;
    const l = w && this.live.get(w.id);
    const otherDirty = [...this.live.entries()].some(([id, x]) => id !== w?.id && (x.dirty.path || x.dirty.logs));
    if (otherDirty) {
      for (const [id, x] of this.live) if (id !== w?.id) x.dirty = { logs: false, curves: false, path: false, tops: false, production: false };
      this.app.wellRev.bump();
    }
    if (!l || !Object.values(l.dirty).some(Boolean)) return;
    const wait = Math.max(0, Math.max(200, this.costLight * 4) - (performance.now() - this.lastRefresh));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, wait);
  }

  private refresh() {
    const app = this.app;
    const w = app.engine.activeWell;
    const l = this.live.get(w.id);
    if (!l) return;
    const d = l.dirty;
    const now = performance.now();
    // the geometry is rebuilt when the bit nears the end of what was built, or the path changed
    const built = app.engine.wellbore?.builtTd ?? l.builtTd;
    const grew = w.tdMD > built - 2;
    const rebuildDue = (grew || d.path) && now - this.lastRebuild > Math.max(grew ? 1500 : 10000, this.costRebuild * (grew ? 8 : 20));
    const t0 = performance.now();
    // tops move zone boundaries anywhere in the well; new log rows only change their own depths
    const fromMd = d.tops ? 0 : Number.isFinite(l.dirtyFrom) ? l.dirtyFrom - 1 : w.tdMD;
    const panels = now - this.lastPanels > 1000;
    if (panels) this.lastPanels = now;
    app.liveRefresh({ rebuild: false, curves: d.curves, features: false, fromMd, panels });
    l.dirtyFrom = Infinity;
    this.costLight = this.costLight * 0.7 + (performance.now() - t0) * 0.3;
    d.logs = false;
    d.curves = false;
    this.lastRefresh = performance.now();
    if (rebuildDue && !this.rebuildQueued) {
      // the expensive part waits for a quiet moment (or at most a second)
      this.rebuildQueued = true;
      idle(() => {
        this.rebuildQueued = false;
        if (app.engine.activeWell !== w) return;
        const t1 = performance.now();
        app.liveRefresh({ rebuild: true, curves: true, features: false });
        const t2 = performance.now();
        this.costRebuild = this.costRebuild * 0.6 + (t2 - t1) * 0.4;
        this.lastRebuild = t2;
        l.builtTd = app.engine.wellbore?.builtTd ?? w.tdMD;
        d.path = false;
      }, 1000);
    }
    const featuresDue = (d.tops || d.production || rebuildDue || now - this.lastFeatures > 15000) && now - this.lastFeatures > Math.max(5000, this.costFeatures * 25);
    if (featuresDue && !this.featuresQueued) {
      this.featuresQueued = true;
      idle(() => {
        this.featuresQueued = false;
        const t1 = performance.now();
        app.notifyFeatures();
        const t2 = performance.now();
        this.costFeatures = this.costFeatures * 0.6 + (t2 - t1) * 0.4;
        this.lastFeatures = t2;
        d.tops = d.production = false;
        app.wellRev.bump();
      }, 2000);
    }
    if (this.followBit.value && Number.isFinite(l.lastDepth)) app.followDepth(Math.min(l.lastDepth, w.tdMD));
  }

  /** For the Live panel: the series of a well, if it has any. */
  series(wellId: string): TimeSeries | undefined {
    return this.live.get(wellId)?.series;
  }

  dispose() {
    for (const id of this.workers.keys()) this.stop(id);
  }
}
