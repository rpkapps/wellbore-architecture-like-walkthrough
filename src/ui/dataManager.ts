import { Well } from '../data/dataset';
import { chooseWell, findColumn, COLS, logsFromTable, productionFromTable, surveyFromTable, topsFromTable, type Table } from '../data/csv';
import { detectKind, type ImportKind } from '../data/importers';
import { readBwsimAny } from '../data/bwsim';
import type { SimulationFeature } from '../features/simulation';
import { parseLAS, sampleCurve } from '../data/las';
import { Trajectory, stationsFromSurvey } from '../data/trajectory';
import type { LogSet } from '../data/types';
import type { App } from './app';
import { chip, download, h } from './dom';
import { I } from './icons';

type Kind = ImportKind;
type Target = 'supplement' | 'replace' | 'new';
type DepthUnit = 'auto' | 'm' | 'ft';

interface Source {
  label: string;
  url: string;
  note: string;
  direct?: boolean; // single-file download, no registration
}

interface GuideEntry {
  title: string;
  formats: string;
  needs: string;
  optional: string;
  notes: string;
  template?: string;
  sources: Source[];
}

const GH = 'https://github.com';
const GUIDE: GuideEntry[] = [
  {
    title: 'Well logs — LAS',
    formats: '.las (LAS 1.2 / 2.0, wrapped or unwrapped)',
    needs: 'A <code>~Curve</code> section whose first curve is depth, and an <code>~ASCII</code> data section.',
    optional:
      'Curves the app plots, under any common vendor mnemonic: <code>GR</code> · deep resistivity <code>RT/ILD/LLD/RDEP/AT90</code> · shallow resistivity <code>RXO/MSFL/LLS/RMED</code> · <code>RHOB/DEN/RHOZ</code> · <code>NPHI/NEU/TNPH</code> · <code>DT/DTC/AC</code> · <code>DTS</code> · <code>CALI</code> · <code>BS</code> · <code>PEF</code>. Other curves are loaded but not plotted.',
    notes: 'Depth in feet (<code>DEPT.F</code>) is converted to metres. The <code>NULL</code> value from the header is honoured. Calculated Sw needs RT + RHOB (+ GR for Vsh). LAS 3.0 is not supported.',
    sources: [
      { label: 'Volve LAS files (GitHub mirror)', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/tree/master/Data/Volve`, note: 'Equinor Volve wells, e.g. 15_9-F-1A.LAS, 15-9-19_SR_COMP.las — open a file, then "Download raw file".', direct: true },
      { label: 'Equinor Volve Data Village', url: 'https://www.equinor.com/energy/volve-data-sharing', note: 'The complete Volve release (all wells, LAS/DLIS, reports). Free registration, Equinor Open Data Licence.' },
      { label: 'Kansas Geological Survey — digital well logs', url: 'https://www.kgs.ku.edu/Magellan/Logs/index.html', note: 'Tens of thousands of LAS files from Kansas wells, searchable by location. Depths in feet.' },
      { label: 'NLOG — Dutch oil & gas portal', url: 'https://www.nlog.nl/en', note: 'Public well logs for Netherlands onshore and North Sea wells.' },
      { label: 'FORCE 2020 lithology competition', url: `${GH}/bolgebrygg/Force-2020-Machine-Learning-competition`, note: 'LAS and CSV for ~100 Norwegian North Sea wells (see the data links in the README).' },
    ],
  },
  {
    title: 'Well logs — CSV',
    formats: '.csv / .txt (comma, semicolon, tab or pipe delimited)',
    needs: 'A depth column (<code>DEPTH</code>, <code>MD</code>, <code>DEPT</code>, <code>DEPTH_MD</code>) and one column per curve.',
    optional: 'Units in brackets — <code>GR (API)</code>, <code>RT [ohm.m]</code>. A <code>WELL</code> column for multi-well files: when adding to an existing well its rows are used; with "Create new well" the first well in the file is used.',
    notes: 'Curve names follow the same aliases as LAS. If depths are in feet without a unit in the header, set <b>Depth units</b> to Feet below.',
    template: 'logs_template.csv',
    sources: [
      { label: 'VolveWells.csv', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/VolveWells.csv`, note: 'Volve wellbores 15/9-F-1 C, F-4 and F-7 in one file (WELL, DEPTH, GR, AC, DEN, NEU, RDEP, RMED…). Supplement 15/9-F-1 C, or create a new well for F-1 C.', direct: true },
      { label: 'SEG 2016 ML contest — facies_vectors.csv', url: `${GH}/seg/2016-ml-contest/blob/master/facies_vectors.csv`, note: 'Real Kansas (Hugoton / Panoma) wells. Depth is in feet: choose Depth units = Feet. ILD is stored as log10.', direct: true },
      { label: 'FORCE 2020 well-log CSV', url: `${GH}/bolgebrygg/Force-2020-Machine-Learning-competition`, note: 'Semicolon-delimited, 118 Norwegian wells, DEPTH_MD in metres. Large: best split per well first.' },
    ],
  },
  {
    title: 'Formation tops',
    formats: '.csv / .txt / .xlsx',
    needs: 'A name column (<code>FORMATION</code>, <code>PICK(S)</code>, <code>NAME</code>, <code>SURFACE</code>, <code>MARKER</code>) and an MD column (<code>MD</code>, <code>DEPTH</code>, <code>TOP_DEPTH</code>). A headerless two-column <code>NAME,MD</code> file also works.',
    optional: '<code>TVD</code>, and <code>WELL</code> for multi-well pick files (filtered to the target well; "NO 15/9-…" prefixes are ignored).',
    notes: 'Known North Sea names (Utsira, Hordaland, Draupne, Hugin, Sleipner…) map to the model stratigraphy; unknown names become new formations. Tops define the zones drawn along the well.',
    template: 'tops_template.csv',
    sources: [
      { label: 'Volve official well picks', url: `${GH}/yohanesnuwara/volve-machine-learning/blob/master/Volve_well_picks_modified.csv`, note: '408 picks in 34 wellbores with MD, TVD, easting, northing.', direct: true },
      { label: 'NPD tops for 15/9-19 SR', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9_19_SR_TOPS_NPD.csv`, note: 'Headerless NAME,MD format. Pair with 15-9-19_SR_COMP.las in "Create new well".', direct: true },
      { label: 'Sodir FactPages — wellbore lithostratigraphy', url: 'https://factpages.sodir.no/en/wellbore', note: 'Official tops for every Norwegian wellbore; export the table as CSV. The FactPages columns wlbName / lsuName / lsuTopDepth are recognised.' },
    ],
  },
  {
    title: 'Directional survey',
    formats: '.csv / .txt / .xlsx',
    needs: '<code>MD</code> + inclination (<code>INC</code>, <code>INCL</code>, <code>DEVI</code>) + azimuth (<code>AZI</code>, <code>AZIM</code>) — positions are computed by minimum curvature. <b>Or</b> <code>MD</code> + <code>TVD</code> + <code>NS</code> + <code>EW</code> positions.',
    optional: 'Both angles and positions (positions are then used as given).',
    notes: 'Angles in degrees; azimuth clockwise from grid north. Distances in metres unless the header or Depth units says feet. The survey is tied to the well\'s surface slot.',
    template: 'survey_template.csv',
    sources: [
      { label: 'Volve 15/9-F-11 A definitive survey', url: `${GH}/jczettl/wellbore-trajectory-uncertainty/blob/main/data/15_9_F_11_A.csv`, note: '323 stations with MD, Incl, Azi, TVD, NS, EW.', direct: true },
      { label: 'Volve 15/9-F-12 survey', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/Volve/15_9-F-12_Survey_Data.csv`, note: 'md, inc, azi (the field\'s top producer).', direct: true },
      { label: 'P11-A-02 (Dutch North Sea) survey', url: `${GH}/andymcdgeo/Petrophysics-Python-Series/blob/master/Data/P11-A-02_SURV.csv`, note: 'DEPTH, DEVI, AZIM columns — a well from the NLOG archive.', direct: true },
    ],
  },
  {
    title: 'Production',
    formats: '.csv / .txt / .xlsx (Excel is read directly)',
    needs: 'A date (<code>DATE</code>, <code>DATEPRD</code>) or <code>YEAR</code> + <code>MONTH</code>, and at least one volume: <code>OIL</code>, <code>GAS</code>, <code>WATER</code>, <code>WATER_INJ</code> (Volve names <code>BORE_OIL_VOL</code>… also work).',
    optional: 'Downhole pressure (bar) and temperature (°C), WHP, choke, on-stream hours. A <code>WELL</code> column for multi-well files (e.g. "15/9-F-11" is matched to wellbore 15/9-F-11 B).',
    notes: 'Volumes per period in Sm³. Daily vs monthly is detected from the date spacing. Dates: ISO, dd/mm/yyyy or Excel dates. FactPages million/billion Sm³ columns are converted.',
    template: 'production_template.csv',
    sources: [
      { label: 'Volve production data.xlsx', url: `${GH}/yohanesnuwara/volve-machine-learning/blob/master/Volve%20production%20data.xlsx`, note: 'Equinor daily + monthly production for all Volve wells, 2007–2016. Drop the workbook in as-is: the daily sheet is used.', direct: true },
      { label: 'Sodir FactPages — field production', url: 'https://factpages.sodir.no/en/field', note: 'Monthly production for every Norwegian field (field level, not per well); export as CSV.' },
    ],
  },
  {
    title: 'Reservoir simulation — Eclipse / OPM',
    formats: '.bwsim (BoreWalk simulation package)',
    needs: 'Convert simulator output first: <code>python3 scripts/prepare_sim.py DECK.EGRID DECK.INIT DECK.UNRST [DECK.UNSMRY] -o model.bwsim</code>. A GRDECL grid (COORD / ZCORN / ACTNUM) also works in place of the EGRID.',
    optional: 'Restart arrays <code>SWAT</code>, <code>SGAS</code>, <code>PRESSURE</code> per report date; INIT arrays <code>PORO</code>, <code>PERMX</code>, <code>NTG</code>, <code>SWATINIT</code>; summary vectors <code>FOPR</code>, <code>FWPR</code> for the history-match chart.',
    notes: 'The grid is placed with its <code>MAPAXES</code> (UTM), so it lines up with the wells if both use the same datum. Cells are drawn as boxes (centre + size).',
    sources: [
      { label: 'Equinor Volve Data Village', url: 'https://www.equinor.com/energy/volve-data-sharing', note: 'The Volve Eclipse reservoir model (grid, properties, schedule and results). Free registration.' },
      { label: 'Volve deck adapted for OPM Flow', url: `${GH}/dabiged/Volve2OPM`, note: 'Run it with the open-source OPM Flow simulator to produce EGRID / INIT / UNRST.', direct: true },
      { label: 'OPM open datasets (Norne)', url: `${GH}/OPM/opm-data`, note: 'The Norne field benchmark model — another complete public North Sea simulation model.', direct: true },
    ],
  },
];

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

    const input = h('input', { type: 'file', multiple: true, accept: '.las,.LAS,.csv,.txt,.asc,.xlsx,.bwsim,.gz', style: 'display:none' }) as HTMLInputElement;
    input.onchange = () => input.files && this.handleFiles([...input.files]);
    const dz = h(
      'div',
      { class: 'dropzone', onclick: () => input.click() },
      h('b', {}, 'Drop LAS / CSV / XLSX files here, or click to browse'),
      h('p', {}, 'Several files at once is fine — the type of each is detected automatically. See "What you can import" below for the columns each file needs and where to get real data.'),
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
    const units = h('div', { class: 'seg small' });
    for (const [u, l] of [
      ['auto', 'Auto (from header)'],
      ['m', 'Metres'],
      ['ft', 'Feet'],
    ] as [DepthUnit, string][]) {
      const b = h('button', { class: this.depthUnit === u ? 'on' : '' }, l);
      b.onclick = () => {
        this.depthUnit = u;
        units.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      units.append(b);
    }

    this.body.append(
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, `Active dataset — ${w.name}`), h('span', { class: 'faint', style: 'font-size:10.5px' }, m.crs)), files),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Upload target')),
        seg,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('label', {}, 'Depth units for CSV / XLSX'), units),
      ),
      dz,
      this.log,
      this.guide(),
      h(
        'div',
        { class: 'section faint', style: 'font-size:11px;line-height:1.6' },
        h('div', { class: 'micro', style: 'margin-bottom:6px' }, 'Sources & licence'),
        ...m.sources.map((s) => h('div', {}, '· ', s)),
        h('div', { style: 'margin-top:6px' }, m.licence),
      ),
    );
  }

  private depthUnit: DepthUnit = 'auto';

  private get depthScale(): number | undefined {
    return this.depthUnit === 'ft' ? 0.3048 : this.depthUnit === 'm' ? 1 : undefined;
  }

  /** Per-file-type instructions with links to real, openly available data. */
  private guide(): HTMLElement {
    const wrap = h(
      'div',
      { class: 'section guide' },
      h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'What you can import'), h('span', { class: 'faint', style: 'font-size:10.5px' }, 'with open sources of real data')),
    );
    GUIDE.forEach((g, i) => {
      const src = h('ul', { class: 'src' });
      for (const s of g.sources)
        src.append(
          h(
            'li',
            {},
            h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.label),
            h('span', { class: `tag ${s.direct ? 'direct' : ''}` }, s.direct ? 'direct download' : 'data portal'),
            h('div', { class: 'faint' }, s.note),
          ),
        );
      const d = h(
        'details',
        { open: i === 0 },
        h('summary', {}, h('b', {}, g.title), h('span', { class: 'faint' }, g.formats)),
        h(
          'div',
          { class: 'gbody' },
          h('div', { class: 'grow' }, h('span', { class: 'gk' }, 'Required'), h('span', { html: g.needs })),
          h('div', { class: 'grow' }, h('span', { class: 'gk' }, 'Optional'), h('span', { html: g.optional })),
          h('div', { class: 'grow' }, h('span', { class: 'gk' }, 'Notes'), h('span', { html: g.notes })),
          g.template
            ? h('div', { class: 'grow' }, h('span', { class: 'gk' }, 'Template'), h('span', {}, h('button', { class: 'btn', onclick: () => download(g.template!, TEMPLATES[g.template!], 'text/csv'), html: `${I.download} ${g.template}` })))
            : '',
          h('div', { class: 'grow' }, h('span', { class: 'gk' }, 'Real data'), src),
        ),
      );
      wrap.append(d);
    });
    wrap.append(
      h(
        'div',
        { class: 'faint', style: 'font-size:11px;margin-top:8px;line-height:1.5' },
        'On GitHub pages, use "Download raw file" to save the actual file. Recommended combination to try: 15-9-19_SR_COMP.las + 15_9_19_SR_TOPS_NPD.csv with target "Create new well"; or Volve production data.xlsx while 15/9-F-12 is active.',
      ),
    );
    return wrap;
  }

  private say(msg: string, cls: 'ok' | 'err' | '' = '') {
    this.log.prepend(h('div', { class: cls }, msg));
  }

  async handleFiles(files: File[]) {
    if (!this.open) this.show();
    const app = this.app;
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
        if (this.target === 'new' && !createdWell) {
          createdWell = this.newWell(parsed.find((q) => q.kind === 'las') ?? p);
          well = createdWell;
        }
        const replace = this.target === 'replace' || (createdWell !== null && createdWell === well);
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
    void app;
    return w;
  }
}
