import { DEFAULT_PARAMS, PARAM_NOTES, autoGrLimits, payIntervals, type PetroParams } from '../data/petro';
import { sampleCurve } from '../data/las';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { App } from './app';
import { chip, fmt, h, download, setRangeFill } from './dom';

interface Summary {
  pay: number;
  phi: number;
  sw: number;
  hc: number;
  ints: number;
}
import { I } from './icons';

interface ParamDef {
  key: keyof PetroParams;
  label: string;
  unit?: string;
  step: number;
  kind?: 'select';
  options?: [string, string][];
  range?: [number, number];
  log?: boolean; // logarithmic slider
}

const GROUPS: { title: string; params: ParamDef[] }[] = [
  {
    title: 'Shale volume',
    params: [
      { key: 'grClean', label: 'GR clean sand', unit: 'API', step: 1, range: [0, 80] },
      { key: 'grShale', label: 'GR shale', unit: 'API', step: 1, range: [50, 200] },
      { key: 'vshMethod', label: 'Vsh transform', step: 0, kind: 'select', options: [['linear', 'Linear IGR'], ['larionov-older', 'Larionov (older rocks)'], ['larionov-tertiary', 'Larionov (Tertiary)']] },
    ],
  },
  {
    title: 'Porosity',
    params: [
      { key: 'rhoMa', label: 'Matrix density ρma', unit: 'g/cm³', step: 0.01, range: [2.6, 2.75] },
      { key: 'rhoFl', label: 'Fluid density ρfl', unit: 'g/cm³', step: 0.01, range: [0.8, 1.2] },
      { key: 'porosityMethod', label: 'Method', step: 0, kind: 'select', options: [['density', 'Density'], ['neutron-density', 'Neutron–density (RMS)']] },
    ],
  },
  {
    title: 'Saturation',
    params: [
      { key: 'satModel', label: 'Model', step: 0, kind: 'select', options: [['archie', 'Archie'], ['simandoux', 'Modified Simandoux']] },
      { key: 'rw', label: 'Rw', unit: 'Ω·m', step: 0.001, range: [0.005, 0.5], log: true },
      { key: 'rwTemp', label: 'Rw reference temp.', unit: '°C', step: 1, range: [20, 150] },
      { key: 'a', label: 'Tortuosity a', step: 0.05, range: [0.5, 1.5] },
      { key: 'm', label: 'Cementation m', step: 0.05, range: [1.5, 2.6] },
      { key: 'n', label: 'Saturation n', step: 0.05, range: [1.5, 3] },
      { key: 'rsh', label: 'Rsh (Simandoux)', unit: 'Ω·m', step: 0.1, range: [0.5, 10] },
    ],
  },
  {
    title: 'Net pay cut-offs',
    params: [
      { key: 'cutVsh', label: 'Vsh ≤', step: 0.01, range: [0, 1] },
      { key: 'cutPhi', label: 'φ ≥', step: 0.01, range: [0, 0.3] },
      { key: 'cutSw', label: 'Sw ≤', step: 0.01, range: [0, 1] },
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
      { class: 'drawer left glass hidden' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, 'Petrophysical interpretation'), h('div', { class: 'faint', style: 'font-size:11px;margin-top:2px' }, 'Turns measured logs into oil / water saturation — updates live')),
        h('button', { class: 'btn icon ghost', html: I.close, onclick: () => this.hide() }),
      ),
      this.body,
    );
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }
  private baseline: Summary | null = null;
  private summaryEl = h('div', { class: 'interp-summary' });

  show() {
    this.baseline = this.summary();
    if (this.app.engine.mode !== 'hydrocarbon') {
      this.app.setProperty('hydrocarbon');
      this.app.toast('Showing the Hydrocarbons view: it redraws live as you change parameters.');
    }
    this.render();
    this.el.classList.remove('hidden');
    document.body.classList.add('interp-open');
  }

  private summary(): Summary {
    const sums = this.app.zoneSummaries();
    let pay = 0, phi = 0, pv = 0, swpv = 0, hc = 0;
    for (const s of sums) {
      if (!(s.pay > 0)) continue;
      pay += s.pay;
      phi += s.phiAvg * s.pay;
      pv += s.phiAvg * s.pay;
      swpv += s.swAvg * s.phiAvg * s.pay;
      hc += s.hcColumn;
    }
    const w = this.app.engine.activeWell;
    const ints = w.logs && w.petro ? payIntervals(w.logs.depth, w.petro.pay, 1.0).length : 0;
    return { pay, phi: pay > 0 ? phi / pay : NaN, sw: pv > 0 ? swpv / pv : NaN, hc, ints };
  }

  private renderSummary() {
    const cur = this.summary();
    const b = this.baseline;
    const w = this.app.engine.activeWell;
    const delta = (now: number, was: number | undefined, f: (v: number) => string, higherIsMore = true) => {
      if (was === undefined || !Number.isFinite(was) || !Number.isFinite(now) || Math.abs(now - was) < 1e-6) return '';
      const up = now > was;
      return `<span class="dl ${up === higherIsMore ? 'up' : 'down'}">${up ? '▲' : '▼'} was ${f(was)}</span>`;
    };
    const tile = (k: string, v: string, d: string) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${d}</div>`;
    this.summaryEl.innerHTML = w.petro?.available
      ? `<div class="stat-row" style="padding:0">${[
          tile('Net pay (MD)', `${fmt.n(cur.pay, 1)}<small>m</small>`, delta(cur.pay, b?.pay, (v) => `${fmt.n(v, 1)} m`)),
          tile('Avg φ in pay', fmt.pct(cur.phi, 1), delta(cur.phi, b?.phi, (v) => fmt.pct(v, 1))),
          tile('Avg Sw in pay', fmt.pct(cur.sw, 0), delta(cur.sw, b?.sw, (v) => fmt.pct(v, 0), false)),
          tile('HC column Σφ·So·h', `${fmt.n(cur.hc, 2)}<small>m</small>`, delta(cur.hc, b?.hc, (v) => `${fmt.n(v, 2)} m`)),
        ].join('')}</div>
        <div class="faint" style="font-size:10.5px;margin-top:6px">${cur.ints} pay intervals ≥ 1 m · changes are relative to when this panel was opened · watch the Saturation / Vsh·Porosity log tracks and the amber oil volume in 3D.</div>`
      : `<div style="color:var(--danger);font-size:11.5px">${w.name} has no density + resistivity logs, so saturation cannot be calculated. Switch to 15/9-F-11 B, F-11 A or F-1 C.</div>`;
  }
  hide() {
    this.el.classList.add('hidden');
    document.body.classList.remove('interp-open');
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
      this.renderSummary();
      this.summaryEl.classList.remove('flash');
      void this.summaryEl.offsetWidth;
      this.summaryEl.classList.add('flash');
    }, 90);
  }

  private resultsEl = h('div');

  render() {
    const w = this.app.engine.activeWell;
    const p = w.params;
    this.body.innerHTML = '';
    const inputs = w.petro?.inputs;
    this.renderSummary();
    this.body.append(
      h('div', { class: 'section interp-top' }, this.summaryEl),
      h(
        'div',
        { class: 'section muted', style: 'font-size:11.5px;line-height:1.55' },
        h('b', { style: 'color:var(--text)' }, 'What this does. '),
        'The measured logs (gamma ray, density, deep resistivity) are converted into shale volume, porosity and water saturation with the equations below. Those calculated results drive the ',
        h('b', { style: 'color:var(--oil)' }, 'Hydrocarbons'),
        ' 3D view (oil vs water in the pore space), the Vsh · Porosity and Saturation log tracks, the pay flags on the timeline and in the logs, and the zone table. The measured Resistivity view never changes. ',
        h('span', { class: 'faint' }, 'Try: Rw 0.025 → 0.08 (saltier → fresher brine) and watch pay shrink; or the Sw cut-off 0.6 → 0.3.'),
      ),
    );
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
          const num = h('input', { class: 'num', type: 'number', step: d.step, value: String(p[d.key]) }) as HTMLInputElement;
          input = num;
          let range: HTMLInputElement | null = null;
          if (d.range) {
            const [lo, hi] = d.range;
            const toR = (v: number) => (d.log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo)) * 1000;
            const fromR = (r: number) => (d.log ? Math.pow(10, Math.log10(lo) + (r / 1000) * (Math.log10(hi) - Math.log10(lo))) : lo + (r / 1000) * (hi - lo));
            const rr = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: String(toR(Number(p[d.key]))) }) as HTMLInputElement;
            range = rr;
            setRangeFill(rr);
            rr.oninput = () => {
              const dec = Math.max(0, -Math.floor(Math.log10(d.step)));
              const v = Number(fromR(+rr.value).toFixed(d.log ? 4 : dec));
              num.value = String(v);
              (p as unknown as Record<string, unknown>)[d.key] = v;
              setRangeFill(rr);
              this.scheduleApply();
            };
            num.addEventListener('input', () => {
              const v = parseFloat(num.value);
              if (Number.isFinite(v)) {
                rr.value = String(Math.max(0, Math.min(1000, toR(v))));
                setRangeFill(rr);
              }
            });
          }
          num.addEventListener('input', () => {
            const v = parseFloat(num.value);
            if (Number.isFinite(v)) {
              (p as unknown as Record<string, unknown>)[d.key] = v;
              this.scheduleApply();
            }
          });
          grid.append(h('label', {}, d.label, d.unit ? h('small', {}, d.unit) : ''), num);
          if (range) grid.append(h('div', { class: 'prange' }, range));
          const note0 = PARAM_NOTES[d.key];
          if (note0) grid.append(h('div', { class: 'note' }, note0));
          continue;
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
            this.app.toast('Parameters reset to the defaults calibrated against Equinor CPI.');
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
      `# ${w.name} — calculated interpretation (BoreWalk). Parameters: ${JSON.stringify(w.params)}`,
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
