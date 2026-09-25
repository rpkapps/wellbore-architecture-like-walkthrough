import { Well } from '../data/dataset';
import { chooseWell, findColumn, COLS, logsFromTable, productionFromTable, surveyFromTable, topsFromTable, type Table } from '../data/csv';
import { detectKind, type ImportKind } from '../data/importers';
import { readBwsimAny } from '../data/bwsim';
import type { SimulationFeature } from '../features/simulation';
import { parseLAS, sampleCurve } from '../data/las';
import { Trajectory, stationsFromSurvey } from '../data/trajectory';
import type { LogSet } from '../data/types';
import type { App } from './app';
import { Signal } from './signal';

type Kind = ImportKind;
export type Target = 'supplement' | 'replace' | 'new';
export type DepthUnit = 'auto' | 'm' | 'ft';

export interface ImportMessage {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
}

/** Merge curves from `add` into `base`, resampling onto base depth where needed. */
function supplementLogs(base: LogSet, add: LogSet): LogSet {
  const inside = add.depth[0] >= base.depth[0] - 1 && add.depth[add.depth.length - 1] <= base.depth[base.depth.length - 1] + 1;
  if (!inside) {
    // extend base grid to cover both
    const step = Math.min(base.depth.length > 1 ? base.depth[1] - base.depth[0] : 0.1, 0.5);
    const d0 = Math.min(base.depth[0], add.depth[0]);
    const d1 = Math.max(base.depth[base.depth.length - 1], add.depth[add.depth.length - 1]);
    const n = Math.floor((d1 - d0) / step) + 1;
    const depth = new Float64Array(n);
    for (let i = 0; i < n; i++) depth[i] = d0 + i * step;
    const curves = new Map(base.curves);
    for (const [k, c] of curves) {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = sampleCurve(base.depth, c.values, depth[i]);
      curves.set(k, { ...c, values: v });
    }
    base = { ...base, depth, curves };
  }
  const curves = new Map(base.curves);
  for (const [k, c] of add.curves) {
    const v = new Float32Array(base.depth.length);
    for (let i = 0; i < v.length; i++) v[i] = sampleCurve(add.depth, c.values, base.depth[i]);
    let key = k;
    if (curves.has(key)) key = `${k}_U`;
    curves.set(key, { ...c, mnemonic: key, values: v });
  }
  return { ...base, curves };
}

/**
 * Reads uploaded LAS / CSV / XLSX / simulation files into the active well (or
 * a new one). Files dropped anywhere on the page open the Data manager and
 * come here.
 */
export class DataImporter {
  readonly target = new Signal<Target>('supplement');
  readonly depthUnit = new Signal<DepthUnit>('auto');
  /** newest first */
  readonly log = new Signal<ImportMessage[]>([]);
  private seq = 0;

  constructor(private app: App) {
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.app.ready.value) this.app.dataOpen.set(true);
    });
    window.addEventListener('drop', (e) => {
      // the Data manager's drop zone handles its own drops
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (this.app.ready.value && e.dataTransfer?.files?.length) void this.handleFiles([...e.dataTransfer.files]);
    });
  }

  private get depthScale(): number | undefined {
    const u = this.depthUnit.value;
    return u === 'ft' ? 0.3048 : u === 'm' ? 1 : undefined;
  }

  private say(text: string, kind: 'ok' | 'err' | '' = '') {
    this.log.update((l) => [{ id: ++this.seq, text, kind: kind || 'info' }, ...l]);
  }

  async handleFiles(files: File[]) {
    const app = this.app;
    app.dataOpen.set(true);
    // reservoir-simulation packages go to the simulation feature
    for (const f of files.filter((x) => /\.bwsim(\.gz)?$/i.test(x.name))) {
      try {
        const m = await readBwsimAny(await f.arrayBuffer());
        app.flags.set('simulation', true);
        app.feature<SimulationFeature>('simulation')?.setModel(m);
        this.say(`✓ ${f.name}: simulation grid with ${m.n.toLocaleString()} cells and ${m.header.dates.length} report dates`, 'ok');
      } catch (e) {
        this.say(`✕ ${f.name}: ${(e as Error).message}`, 'err');
      }
    }
    files = files.filter((x) => !/\.bwsim(\.gz)?$/i.test(x.name));
    if (!files.length) return;
    let well = app.engine.activeWell;
    let createdWell: Well | null = null;
    // sort so that surveys are applied before logs/tops (needed for new wells)
    const parsed: { f: File; text: string; kind: Kind; table?: Table; sheet?: string }[] = [];
    for (const f of files) {
      try {
        const xlsx = /\.xlsx$/i.test(f.name);
        const text = xlsx ? '' : await f.text();
        const d = detectKind(f.name, xlsx ? await f.arrayBuffer() : text);
        if (d.sheet) this.say(`• ${f.name}: using sheet "${d.sheet}"`, '');
        parsed.push({ f, text, ...d });
      } catch (e) {
        this.say(`✕ ${f.name}: ${(e as Error).message}`, 'err');
      }
    }
    const order: Kind[] = ['survey', 'las', 'logs', 'tops', 'production'];
    parsed.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const p of parsed) {
      try {
        if (this.target.value === 'new' && !createdWell) {
          createdWell = this.newWell(parsed.find((q) => q.kind === 'las') ?? p);
          well = createdWell;
        }
        const replace = this.target.value === 'replace' || (createdWell !== null && createdWell === well);
        switch (p.kind) {
          case 'survey': {
            const sv = surveyFromTable(p.table!, this.depthScale);
            const tie = { tvd: 0, ns: well.trajectory.ns[0], ew: well.trajectory.ew[0] };
            const st = stationsFromSurvey(sv.stations, sv.hasPositions, tie);
            well.trajectory = new Trajectory(st, 'user', `Uploaded survey ${p.f.name} (${sv.stations.length} stations)`, p.f.name);
            this.say(`✓ ${p.f.name}: survey with ${sv.stations.length} stations applied to ${well.name} (${sv.hasPositions ? 'positions' : 'minimum curvature'})`, 'ok');
            break;
          }
          case 'las':
          case 'logs': {
            const ls = p.kind === 'las' ? parseLAS(p.text, `${p.f.name} (uploaded)`, 'user') : logsFromTable(p.table!, `${p.f.name} (uploaded)`, well.name, 'user', this.depthScale, createdWell !== well);
            if (p.kind === 'logs' && ls.wellName && ls.wellName !== well.name) this.say(`• ${p.f.name}: using rows of well "${ls.wellName}"`, '');
            for (const c of ls.curves.values()) c.provenance = 'user';
            well.logs = !replace && well.logs ? supplementLogs(well.logs, ls) : ls;
            well.autoCalibrate();
            this.say(`✓ ${p.f.name}: ${ls.curves.size} curves (${[...ls.curves.keys()].slice(0, 8).join(', ')}${ls.curves.size > 8 ? '…' : ''}) ${replace ? 'loaded' : 'merged'} · ${ls.depth[0].toFixed(1)}–${ls.depth[ls.depth.length - 1].toFixed(1)} m`, 'ok');
            break;
          }
          case 'tops': {
            const tops = topsFromTable(p.table!, p.f.name, well.name, 'user', this.depthScale);
            if (!tops.length) throw new Error('no tops matched this well');
            well.tops = replace ? tops : [...well.tops, ...tops].sort((a, b) => a.md - b.md);
            this.say(`✓ ${p.f.name}: ${tops.length} formation tops ${replace ? 'replaced' : 'added'}`, 'ok');
            break;
          }
          case 'production': {
            const target = createdWell === well ? undefined : well.productionWell ?? well.name;
            const s = productionFromTable(p.table!, `${p.f.name} (uploaded)`, target, 'user');
            if (!s.records.length) throw new Error('no dated production records found');
            if (s.wellName) this.say(`• ${p.f.name}: production rows for "${s.wellName}"`, '');
            well.production = s;
            this.say(`✓ ${p.f.name}: ${s.records.length} ${s.period} production records attached`, 'ok');
            break;
          }
        }
      } catch (e) {
        this.say(`✕ ${p.f.name}: ${(e as Error).message}`, 'err');
      }
    }
    if (!parsed.length) return;
    well.refresh(app.field.meta.datumElevation, app.field.meta.waterDepth);
    well.loaded = true;
    if (createdWell) {
      app.field.wells.push(createdWell);
      app.selectWell(createdWell.id);
    } else app.onDataChanged();
  }

  private newWell(p: { f: File; text: string; kind: Kind; table?: Table }): Well {
    let name = p.f.name.replace(/\.[^.]+$/, '');
    let maxMd = 3000;
    if (p.kind === 'las') {
      const ls = parseLAS(p.text, p.f.name, 'user');
      name = ls.wellName || name;
      maxMd = ls.depth[ls.depth.length - 1];
    } else if (p.table) {
      // multi-well tables: name the new well after the first well in the file
      const wi = findColumn(p.table.headers, COLS.well);
      const first = wi >= 0 ? chooseWell(p.table.rows.map((r) => r[wi])) ?? p.table.rows[0]?.[wi] : undefined;
      if (first) name = first.replace(/^NO\s+/, '');
    }
    // default: vertical well from the platform slot until a survey is supplied
    const st = stationsFromSurvey(
      [
        { md: 0, inc: 0, azi: 0, tvd: NaN, ns: NaN, ew: NaN },
        { md: Math.max(maxMd, 500), inc: 0, azi: 0, tvd: NaN, ns: NaN, ew: NaN },
      ],
      false,
      { tvd: 0, ns: 25, ew: 25 },
    );
    const w = new Well(`user-${Date.now().toString(36)}`, name, new Trajectory(st, 'user', 'Assumed vertical from the platform until a survey is uploaded', 'assumed'), 'User-uploaded well.');
    w.userAdded = true;
    w.loaded = true;
    this.say(`• Created well "${name}" (assumed vertical until a survey is uploaded)`, '');
    return w;
  }
}
