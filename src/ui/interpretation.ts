import { DEFAULT_PARAMS, PARAM_NOTES, autoGrLimits, type PetroParams } from '../data/petro';
import { sampleCurve } from '../data/las';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { App } from './app';
import { chip, fmt, h, download } from './dom';
import { I } from './icons';

interface ParamDef {
  key: keyof PetroParams;
  label: string;
  unit?: string;
  step: number;
  kind?: 'select';
  options?: [string, string][];
}

const GROUPS: { title: string; params: ParamDef[] }[] = [
  {
    title: 'Shale volume',
    params: [
      { key: 'grClean', label: 'GR clean sand', unit: 'API', step: 1 },
      { key: 'grShale', label: 'GR shale', unit: 'API', step: 1 },
      { key: 'vshMethod', label: 'Vsh transform', step: 0, kind: 'select', options: [['linear', 'Linear IGR'], ['larionov-older', 'Larionov (older rocks)'], ['larionov-tertiary', 'Larionov (Tertiary)']] },
    ],
  },
  {
    title: 'Porosity',
    params: [
      { key: 'rhoMa', label: 'Matrix density ρma', unit: 'g/cm³', step: 0.01 },
      { key: 'rhoFl', label: 'Fluid density ρfl', unit: 'g/cm³', step: 0.01 },
      { key: 'porosityMethod', label: 'Method', step: 0, kind: 'select', options: [['density', 'Density'], ['neutron-density', 'Neutron–density (RMS)']] },
    ],
  },
  {
    title: 'Saturation',
    params: [
      { key: 'satModel', label: 'Model', step: 0, kind: 'select', options: [['archie', 'Archie'], ['simandoux', 'Modified Simandoux']] },
      { key: 'rw', label: 'Rw', unit: 'Ω·m', step: 0.001 },
      { key: 'rwTemp', label: 'Rw reference temp.', unit: '°C', step: 1 },
      { key: 'a', label: 'Tortuosity a', step: 0.05 },
      { key: 'm', label: 'Cementation m', step: 0.05 },
      { key: 'n', label: 'Saturation n', step: 0.05 },
      { key: 'rsh', label: 'Rsh (Simandoux)', unit: 'Ω·m', step: 0.1 },
    ],
  },
  {
    title: 'Net pay cut-offs',
    params: [
      { key: 'cutVsh', label: 'Vsh ≤', step: 0.01 },
      { key: 'cutPhi', label: 'φ ≥', step: 0.01 },
      { key: 'cutSw', label: 'Sw ≤', step: 0.01 },
    ],
  },
];

export class InterpretationDrawer {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private timer: number | null = null;

  constructor(private app: App) {
    this.body = h('div', { class: 'panel-body' });
    this.el = h(
      'div',
      { class: 'drawer glass hidden' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, 'Petrophysical interpretation'), h('div', { class: 'faint', style: 'font-size:11px;margin-top:2px' }, 'Hydrocarbon view inputs — all outputs are calculated')),
        h('button', { class: 'btn icon ghost', html: I.close, onclick: () => this.hide() }),
      ),
      this.body,
    );
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
  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  private scheduleApply() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.app.reinterpret();
      this.renderResults();
    }, 250);
  }

  private resultsEl = h('div');

  render() {
    const w = this.app.engine.activeWell;
    const p = w.params;
    this.body.innerHTML = '';
    const inputs = w.petro?.inputs;
    this.body.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Method'), h('span', { html: chip('calculated') })),
        h(
          'div',
          { class: 'muted', style: 'font-size:11.5px;line-height:1.55' },
          h('div', { class: 'mono', style: 'color:var(--text);margin-bottom:6px' }, 'Vsh = (GR − GRclean)/(GRshale − GRclean)'),
          h('div', { class: 'mono', style: 'color:var(--text);margin-bottom:6px' }, 'φ = (ρma − ρb)/(ρma − ρfl)'),
          h('div', { class: 'mono', style: 'color:var(--text);margin-bottom:8px' }, 'Sw = (a·Rw / (φᵐ·Rt))^(1/n)   So = 1 − Sw'),
          `Inputs from ${w.name}: ${[inputs?.gr, inputs?.rt, inputs?.rhob, inputs?.nphi].filter(Boolean).join(', ') || '—'} (measured). ${w.petro?.available ? '' : '<b style="color:var(--danger)">Density or resistivity missing — saturation cannot be computed for this well.</b>'}`,
        ),
      ),
    );
    for (const g of GROUPS) {
      const grid = h('div', { class: 'param-grid' });
      for (const d of g.params) {
        let input: HTMLInputElement | HTMLSelectElement;
        if (d.kind === 'select') {
          input = h('select', { class: 'select' }) as HTMLSelectElement;
          for (const [v, l] of d.options!) input.append(h('option', { value: v }, l));
          input.value = String(p[d.key]);
          input.onchange = () => {
            (p as unknown as Record<string, unknown>)[d.key] = input.value;
            this.scheduleApply();
          };
        } else {
          input = h('input', { class: 'num', type: 'number', step: d.step, value: String(p[d.key]) }) as HTMLInputElement;
          input.oninput = () => {
            const v = parseFloat(input.value);
            if (Number.isFinite(v)) {
              (p as unknown as Record<string, unknown>)[d.key] = v;
              this.scheduleApply();
            }
          };
        }
        grid.append(h('label', {}, d.label, d.unit ? h('small', {}, d.unit) : ''), input);
        const note = PARAM_NOTES[d.key];
        if (note) grid.append(h('div', { class: 'note' }, note));
      }
      this.body.append(h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, g.title)), grid));
    }
    this.body.append(
      h(
        'div',
        { class: 'section', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', {
          class: 'btn',
          onclick: () => {
            Object.assign(w.params, DEFAULT_PARAMS);
            const g = w.logs ? autoGrLimits(w.logs) : null;
            if (g) {
              w.params.grClean = g.clean;
              w.params.grShale = g.shale;
            }
            this.app.reinterpret();
            this.render();
          },
          html: `${I.reset} Reset to calibrated defaults`,
        }),
        h('button', { class: 'btn', onclick: () => this.exportCsv(), html: `${I.download} Export calculated curves` }),
      ),
    );
    this.body.append(this.resultsEl);
    this.renderResults();
  }

  private renderResults() {
    const w = this.app.engine.activeWell;
    const el = this.resultsEl;
    el.innerHTML = '';
    const sums = this.app.zoneSummaries().filter((s) => s.coverage > 0.05 && s.gross > 1);
    const table = h('table', { class: 'table' });
    table.append(
      h('thead', {}, h('tr', {}, h('th', {}, 'Zone'), h('th', {}, 'MD top'), h('th', {}, 'Gross'), h('th', {}, 'N/G'), h('th', {}, 'Pay'), h('th', {}, 'φ'), h('th', {}, 'Sw'), h('th', {}, 'HC col.'))),
    );
    const tb = h('tbody');
    let totPay = 0, totHc = 0;
    for (const s of sums) {
      totPay += s.pay;
      totHc += s.hcColumn;
      const f = FORMATION_BY_ID.get(s.zone.formationId);
      tb.append(
        h(
          'tr',
          { class: f?.reservoir ? 'hl' : '' },
          h('td', {}, h('span', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${f?.color}` }), f?.name ?? s.zone.name),
          h('td', {}, fmt.n(s.zone.topMD, 0)),
          h('td', {}, fmt.n(s.gross, 0)),
          h('td', {}, fmt.pct(s.ntg)),
          h('td', {}, fmt.n(s.pay, 1)),
          h('td', {}, fmt.pct(s.phiAvg, 1)),
          h('td', {}, fmt.pct(s.swAvg)),
          h('td', {}, fmt.n(s.hcColumn, 2)),
        ),
      );
    }
    table.append(tb);
    el.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Zone summary (along hole)'), h('span', { html: chip('calculated') })),
        table,
        h('div', { class: 'faint', style: 'margin-top:8px;font-size:11px' }, `Total net pay ${fmt.n(totPay, 1)} m MD · hydrocarbon column Σφ·So·h ${fmt.n(totHc, 2)} m. Along-hole values in a horizontal well are not true vertical thickness.`),
      ),
    );
    // CPI comparison
    if (w.cpi && w.logs && w.petro) {
      const sw = w.cpi.curves.get('SW');
      const ph = w.cpi.curves.get('PHIF');
      const cmp = (cpiC: typeof sw, mine: Float32Array) => {
        if (!cpiC) return null;
        const a: number[] = [];
        const b: number[] = [];
        for (let i = 0; i < w.cpi!.depth.length; i += 2) {
          const x = cpiC.values[i];
          const y = sampleCurve(w.logs!.depth, mine, w.cpi!.depth[i]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            a.push(x);
            b.push(y);
          }
        }
        if (a.length < 20) return null;
        const ma = a.reduce((s, v) => s + v, 0) / a.length;
        const mb = b.reduce((s, v) => s + v, 0) / b.length;
        let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < a.length; i++) {
          sab += (a[i] - ma) * (b[i] - mb);
          saa += (a[i] - ma) ** 2;
          sbb += (b[i] - mb) ** 2;
        }
        return { r: sab / Math.sqrt(saa * sbb), bias: mb - ma, n: a.length };
      };
      const cs = cmp(sw, w.petro.sw.values);
      const cp = cmp(ph, w.petro.phie.values);
      el.append(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Validation vs. Equinor CPI'), h('span', { html: chip('interpreted') })),
          h(
            'div',
            { class: 'stat-row', style: 'padding:0;grid-template-columns:repeat(2,1fr)' },
            cs ? h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Sw correlation'), h('div', { class: 'v' }, `r = ${cs.r.toFixed(2)}`, h('small', {}, `bias ${cs.bias >= 0 ? '+' : ''}${(cs.bias * 100).toFixed(1)} pu`))) : '',
            cp ? h('div', { class: 'stat' }, h('div', { class: 'k' }, 'φ correlation'), h('div', { class: 'v' }, `r = ${cp.r.toFixed(2)}`, h('small', {}, `bias ${cp.bias >= 0 ? '+' : ''}${(cp.bias * 100).toFixed(1)} pu`))) : '',
          ),
          h('div', { class: 'faint', style: 'margin-top:8px;font-size:11px' }, `Compared sample-by-sample with ${w.cpi.source}. The CPI Sw is plotted as a dashed violet curve in the Saturation track.`),
        ),
      );
    }
  }

  private exportCsv() {
    const w = this.app.engine.activeWell;
    if (!w.logs || !w.petro) return;
    const p = w.petro;
    const lines = [
      `# ${w.name} — calculated interpretation (Volve Wellbore Digital Twin). Parameters: ${JSON.stringify(w.params)}`,
      'DEPTH_M,VSH_CALC,PHIE_CALC,SW_CALC,SO_CALC,HCPV_CALC,NET,PAY',
    ];
    const f = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '');
    for (let i = 0; i < w.logs.depth.length; i++) {
      if (!Number.isFinite(p.phie.values[i]) && !Number.isFinite(p.vsh.values[i])) continue;
      lines.push([w.logs.depth[i].toFixed(2), f(p.vsh.values[i]), f(p.phie.values[i]), f(p.sw.values[i]), f(p.so.values[i]), f(p.hcpv.values[i]), p.net[i], p.pay[i]].join(','));
    }
    download(`${w.name.replace(/[^\w]+/g, '_')}_interpretation.csv`, lines.join('\n'), 'text/csv');
  }
}
