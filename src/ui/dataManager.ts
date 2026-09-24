import { Well } from '../data/dataset';
import { findColumn, logsFromTable, parseCSV, productionFromTable, surveyFromTable, topsFromTable, type Table } from '../data/csv';
import { parseLAS, sampleCurve } from '../data/las';
import { Trajectory, stationsFromSurvey } from '../data/trajectory';
import type { LogSet } from '../data/types';
import type { App } from './app';
import { chip, download, h } from './dom';
import { I } from './icons';

type Kind = 'las' | 'logs' | 'tops' | 'survey' | 'production';
type Target = 'supplement' | 'replace' | 'new';

export function detectKind(name: string, text: string): { kind: Kind; table?: Table } {
  if (/\.las$/i.test(name) || /^\s*~V/im.test(text.slice(0, 2000))) return { kind: 'las' };
  const t = parseCSV(text);
  const H = t.headers;
  const has = (c: string[]) => findColumn(H, c) >= 0;
  if (has(['DATEPRD', 'DATE', 'YEAR']) && has(['BOREOILVOL', 'OIL', 'OILSM3', 'QO', 'BOREWIVOL', 'WI', 'GAS'])) return { kind: 'production', table: t };
  if (has(['INC', 'INCL', 'INCLINATION']) && has(['AZI', 'AZIMUTH', 'AZ'])) return { kind: 'survey', table: t };
  if (has(['TVD']) && has(['NS', 'NORTH']) && has(['EW', 'EAST']) && !has(['PICKS', 'FORMATION'])) return { kind: 'survey', table: t };
  if (has(['PICKS', 'PICK', 'FORMATION', 'TOP', 'SURFACE', 'HORIZON', 'MARKER', 'NAME'])) return { kind: 'tops', table: t };
  if (H.length === 2 && H[0].startsWith('COL') && t.rows.every((r) => Number.isFinite(Number(r[1])) && !Number.isFinite(Number(r[0])))) return { kind: 'tops', table: t };
  if (has(['DEPTH', 'MD', 'DEPT'])) return { kind: 'logs', table: t };
  throw new Error('Could not recognise the file. Expected LAS, or CSV with logs (DEPTH + curves), tops (FORMATION + MD), survey (MD + INC + AZI) or production (DATE + OIL/GAS/WATER).');
}

const TEMPLATES: Record<string, string> = {
  'tops_template.csv': 'FORMATION,MD,TVD\nUtsira Fm.,885,882\nHordaland Gp.,1071,1065\nDraupne Fm.,3351,2846\nHugin Fm.,3467,2884\n',
  'survey_template.csv': '# MD m, INC deg from vertical, AZI deg from grid north\nMD,INC,AZI\n0,0,0\n500,0.5,40\n1000,8,45\n1500,25,60\n2000,45,80\n2500,70,95\n3000,88,100\n',
  'production_template.csv': 'DATE,OIL,GAS,WATER,WATER_INJ\n2014-01-01,1520.4,221300,12.3,0\n2014-02-01,1480.1,215800,40.2,0\n',
  'logs_template.csv': 'DEPTH (m),GR (API),RT (ohm.m),RHOB (g/cm3),NPHI (v/v)\n3000.0,45.2,12.3,2.31,0.18\n3000.1,46.0,12.9,2.30,0.18\n',
};

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

export class DataManager {
  readonly el: HTMLElement;
  private modal: HTMLElement;
  private body: HTMLElement;
  private log: HTMLElement;
  private target: Target = 'supplement';

  constructor(private app: App) {
    this.body = h('div', { class: 'panel-body' });
    this.log = h('div', { class: 'upload-log' });
    this.modal = h(
      'div',
      { class: 'modal glass' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, 'Data manager'), h('div', { class: 'faint', style: 'font-size:11px;margin-top:2px' }, 'Preloaded public data · your uploads stay in this browser')),
        h('button', { class: 'btn icon ghost', html: I.close, onclick: () => this.hide() }),
      ),
      this.body,
    );
    this.el = h('div', { class: 'modal-back hidden', onclick: (e: Event) => e.target === this.el && this.hide() }, this.modal);
    // global drag & drop
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.open) this.show();
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) this.handleFiles([...e.dataTransfer.files]);
    });
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }
  show() {
    this.render();
    this.el.classList.remove('hidden');
  }
  hide() {
    this.el.classList.add('hidden');
  }

  render() {
    const w = this.app.engine.activeWell;
    const m = this.app.field.meta;
    this.body.innerHTML = '';
    const files = h('div', { class: 'file-list' });
    const row = (f: string, d: string, prov: string) => files.append(h('div', { class: 'file-row' }, h('div', {}, h('div', { class: 'f' }, f), h('div', { class: 'd' }, d)), h('span', { html: chip(prov) }), h('span')));
    row(w.logs?.source ?? '—', `${w.logs ? `${w.logs.curves.size} curves · ${w.logs.depth[0].toFixed(1)}–${w.logs.depth[w.logs.depth.length - 1].toFixed(1)} m MD` : 'no logs'}`, w.logs?.provenance ?? 'measured');
    if (w.cpi) row(w.cpi.source, `${w.cpi.curves.size} curves (SW, PHIF, VSH, KLOGH…)`, 'interpreted');
    row(w.trajectory.source, w.trajectory.note, w.trajectory.status === 'reconstructed' ? 'reconstructed' : w.trajectory.status === 'user' ? 'user' : 'measured');
    const topSources = [...new Set(w.tops.map((t) => t.source))].join(', ') || 'no formation tops';
    row(topSources, `${w.tops.length} tops for this wellbore · regional model uses ${this.app.field.picks.length} picks across ${new Set(this.app.field.picks.map((p) => p.well)).size} wellbores`, w.tops[0]?.provenance ?? 'interpreted');
    if (w.production) row(w.production.source, `${w.production.records.length} ${w.production.period} records`, w.production.provenance);
    row('Structural surfaces', `${this.app.field.horizons.length} horizons interpolated from picks`, 'interpreted');
    row('Casing & hole geometry', 'inferred from bit-size log', 'reconstructed');
    row('Natural fractures', 'illustrative — no image log in package', 'schematic');

    const input = h('input', { type: 'file', multiple: true, accept: '.las,.LAS,.csv,.txt,.asc', style: 'display:none' }) as HTMLInputElement;
    input.onchange = () => input.files && this.handleFiles([...input.files]);
    const dz = h(
      'div',
      { class: 'dropzone', onclick: () => input.click() },
      h('b', {}, 'Drop LAS / CSV files here, or click to browse'),
      h('p', {}, 'Logs (LAS 1.2/2.0 or CSV), formation tops, directional survey (MD/INC/AZI or MD/TVD/NS/EW) and production (daily or monthly). File type is detected automatically.'),
      input,
    );
    dz.addEventListener('dragenter', () => dz.classList.add('over'));
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', () => dz.classList.remove('over'));
    const seg = h('div', { class: 'seg' });
    const opts: [Target, string][] = [
      ['supplement', `Supplement ${w.name}`],
      ['replace', `Replace in ${w.name}`],
      ['new', 'Create new well'],
    ];
    for (const [t, l] of opts) {
      const b = h('button', { class: this.target === t ? 'on' : '' }, l);
      b.onclick = () => {
        this.target = t;
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      seg.append(b);
    }
    const tmpl = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    for (const name of Object.keys(TEMPLATES)) tmpl.append(h('button', { class: 'btn', onclick: () => download(name, TEMPLATES[name], 'text/csv'), html: `${I.download} ${name.replace('_template.csv', '')}` }));

    this.body.append(
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, `Active dataset — ${w.name}`), h('span', { class: 'faint', style: 'font-size:10.5px' }, m.crs)), files),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Upload target')), seg),
      dz,
      this.log,
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Templates')), tmpl),
      h(
        'div',
        { class: 'section faint', style: 'font-size:11px;line-height:1.6' },
        h('div', { class: 'micro', style: 'margin-bottom:6px' }, 'Sources & licence'),
        ...m.sources.map((s) => h('div', {}, '· ', s)),
        h('div', { style: 'margin-top:6px' }, m.licence),
      ),
    );
  }

  private say(msg: string, cls: 'ok' | 'err' | '' = '') {
    this.log.prepend(h('div', { class: cls }, msg));
  }

  async handleFiles(files: File[]) {
    if (!this.open) this.show();
    const app = this.app;
    let well = app.engine.activeWell;
    let createdWell: Well | null = null;
    // sort so that surveys are applied before logs/tops (needed for new wells)
    const parsed: { f: File; text: string; kind: Kind; table?: Table }[] = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const d = detectKind(f.name, text);
        parsed.push({ f, text, ...d });
      } catch (e) {
        this.say(`✕ ${f.name}: ${(e as Error).message}`, 'err');
      }
    }
    const order: Kind[] = ['survey', 'las', 'logs', 'tops', 'production'];
    parsed.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const p of parsed) {
      try {
        if (this.target === 'new' && !createdWell) {
          createdWell = this.newWell(parsed.find((q) => q.kind === 'las') ?? p);
          well = createdWell;
        }
        const replace = this.target === 'replace' || (createdWell !== null && createdWell === well);
        switch (p.kind) {
          case 'survey': {
            const sv = surveyFromTable(p.table!);
            const tie = { tvd: 0, ns: well.trajectory.ns[0], ew: well.trajectory.ew[0] };
            const st = stationsFromSurvey(sv.stations, sv.hasPositions, tie);
            well.trajectory = new Trajectory(st, 'user', `Uploaded survey ${p.f.name} (${sv.stations.length} stations)`, p.f.name);
            this.say(`✓ ${p.f.name}: survey with ${sv.stations.length} stations applied to ${well.name} (${sv.hasPositions ? 'positions' : 'minimum curvature'})`, 'ok');
            break;
          }
          case 'las':
          case 'logs': {
            const ls = p.kind === 'las' ? parseLAS(p.text, `${p.f.name} (uploaded)`, 'user') : logsFromTable(p.table!, `${p.f.name} (uploaded)`, well.name, 'user');
            for (const c of ls.curves.values()) c.provenance = 'user';
            well.logs = !replace && well.logs ? supplementLogs(well.logs, ls) : ls;
            well.autoCalibrate();
            this.say(`✓ ${p.f.name}: ${ls.curves.size} curves (${[...ls.curves.keys()].slice(0, 8).join(', ')}${ls.curves.size > 8 ? '…' : ''}) ${replace ? 'loaded' : 'merged'} · ${ls.depth[0].toFixed(1)}–${ls.depth[ls.depth.length - 1].toFixed(1)} m`, 'ok');
            break;
          }
          case 'tops': {
            const tops = topsFromTable(p.table!, p.f.name, well.name, 'user');
            if (!tops.length) throw new Error('no tops matched this well');
            well.tops = replace ? tops : [...well.tops, ...tops].sort((a, b) => a.md - b.md);
            this.say(`✓ ${p.f.name}: ${tops.length} formation tops ${replace ? 'replaced' : 'added'}`, 'ok');
            break;
          }
          case 'production': {
            const s = productionFromTable(p.table!, `${p.f.name} (uploaded)`, undefined, 'user');
            if (!s.records.length) throw new Error('no dated production records found');
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
    this.render();
  }

  private newWell(p: { f: File; text: string; kind: Kind; table?: Table }): Well {
    const app = this.app;
    let name = p.f.name.replace(/\.[^.]+$/, '');
    let maxMd = 3000;
    if (p.kind === 'las') {
      const ls = parseLAS(p.text, p.f.name, 'user');
      name = ls.wellName || name;
      maxMd = ls.depth[ls.depth.length - 1];
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
    void app;
    return w;
  }
}
