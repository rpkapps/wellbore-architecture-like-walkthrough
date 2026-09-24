import { toMonthly } from '../data/csv';
import type { ProductionRecord } from '../data/types';
import type { App } from './app';
import { chip, fmt, h } from './dom';
import { I } from './icons';

export class ProductionDrawer {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private canvas2!: HTMLCanvasElement;
  private records: ProductionRecord[] = [];
  private hoverIdx = -1;

  constructor(private app: App) {
    this.body = h('div', { class: 'panel-body' });
    this.el = h(
      'div',
      { class: 'drawer glass hidden' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, 'Production history'), h('div', { class: 'faint', style: 'font-size:11px;margin-top:2px' }, 'Reported volumes, standard conditions')),
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

  render() {
    const w = this.app.engine.activeWell;
    this.body.innerHTML = '';
    const series = w.production;
    this.records = series ? toMonthly(series) : w.productionMonthly;
    if (!this.records.length) {
      this.body.append(
        h(
          'div',
          { class: 'section muted' },
          `No production data is associated with ${w.name}. Upload a production CSV (date + oil / gas / water columns) from the Data manager to attach one.`,
        ),
      );
      return;
    }
    const r = this.records;
    const cumOil = r.reduce((s, x) => s + x.oil, 0);
    const cumGas = r.reduce((s, x) => s + x.gas, 0);
    const cumWat = r.reduce((s, x) => s + x.water, 0);
    const cumWi = r.reduce((s, x) => s + x.waterInj, 0);
    const days = (x: ProductionRecord) => new Date(Date.UTC(new Date(x.t).getUTCFullYear(), new Date(x.t).getUTCMonth() + 1, 0)).getUTCDate();
    const peak = r.reduce((a, x) => Math.max(a, x.oil / days(x)), 0);
    const first = r.find((x) => x.oil > 0);
    const last = [...r].reverse().find((x) => x.oil > 0 || x.waterInj > 0);
    const wc = cumWat / Math.max(1, cumWat + cumOil);
    const d = (t?: number) => (t ? new Date(t).toISOString().slice(0, 7) : '—');
    this.body.append(
      h(
        'div',
        { class: 'section', style: 'padding-bottom:4px' },
        h('div', { class: 'section-title' }, h('span', { class: 'micro' }, `${series?.wellName ?? w.productionWell ?? w.name}`), h('span', { html: chip(series?.provenance ?? 'measured') })),
        h('div', { class: 'faint', style: 'font-size:11px' }, `${series?.source ?? 'Equinor Volve monthly production'} · ${d(first?.t)} → ${d(last?.t)}`),
      ),
      h(
        'div',
        { class: 'stat-row' },
        stat('Cum. oil', fmt.big(cumOil), 'Sm³'),
        stat('Cum. gas', fmt.big(cumGas), 'Sm³'),
        stat('Cum. water', fmt.big(cumWat), 'Sm³'),
        stat('Peak oil', fmt.n(peak, 0), 'Sm³/d'),
      ),
      h(
        'div',
        { class: 'stat-row', style: 'padding-top:0' },
        stat('Water cut (cum.)', fmt.pct(wc, 1), ''),
        stat('GOR (cum.)', fmt.n(cumGas / Math.max(1, cumOil), 0), 'Sm³/Sm³'),
        stat('Water injected', fmt.big(cumWi), 'Sm³'),
        stat('Months', String(r.length), ''),
      ),
    );
    this.canvas = h('canvas', { class: 'prod-chart' });
    this.canvas2 = h('canvas', { class: 'prod-chart', style: 'height:150px' });
    const tip = h('div', { class: 'logs-readout', style: 'position:absolute' });
    const wrap = h('div', { style: 'position:relative;padding:4px 10px 0' }, this.canvas, tip);
    this.body.append(
      h('div', { class: 'section', style: 'padding:10px 4px 4px' }, h('div', { class: 'micro', style: 'padding:0 10px 4px' }, 'Monthly rates · cumulative oil'), wrap),
      h('div', { class: 'section', style: 'padding:10px 4px 10px' }, h('div', { class: 'micro', style: 'padding:0 10px 4px' }, 'Downhole gauge (monthly mean)'), h('div', { style: 'padding:0 10px' }, this.canvas2)),
      h(
        'div',
        { class: 'section faint', style: 'font-size:11px' },
        'Volumes are the operator-reported, allocated well volumes from the Volve production database (NPD reporting). Production for the F-11 wellbores is reported at the well level (NPD wellbore 15/9-F-11).',
      ),
    );
    this.canvas.addEventListener('pointermove', (e) => {
      const W = this.canvas.clientWidth;
      const i = Math.floor(((e.offsetX - 44) / (W - 88)) * r.length);
      this.hoverIdx = i >= 0 && i < r.length ? i : -1;
      this.draw();
      if (this.hoverIdx >= 0) {
        const x = r[this.hoverIdx];
        tip.style.display = 'block';
        tip.innerHTML = `<div style="color:#fff">${d(x.t)}</div><div><span class="k">Oil</span>${fmt.n(x.oil / days(x), 0)} Sm³/d</div><div><span class="k">Water</span>${fmt.n(x.water / days(x), 0)} Sm³/d</div><div><span class="k">Gas</span>${fmt.big(x.gas / days(x))} Sm³/d</div>${x.waterInj ? `<div><span class="k">Inj.</span>${fmt.n(x.waterInj / days(x), 0)} Sm³/d</div>` : ''}${x.bhp ? `<div><span class="k">BHP</span>${fmt.n(x.bhp, 0)} bar</div>` : ''}`;
        tip.style.left = `${Math.min(W - 150, e.offsetX + 16)}px`;
        tip.style.top = `${e.offsetY}px`;
      } else tip.style.display = 'none';
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverIdx = -1;
      tip.style.display = 'none';
      this.draw();
    });
    requestAnimationFrame(() => this.draw());
  }

  private draw() {
    const r = this.records;
    const days = (x: ProductionRecord) => new Date(Date.UTC(new Date(x.t).getUTCFullYear(), new Date(x.t).getUTCMonth() + 1, 0)).getUTCDate();
    const prep = (cv: HTMLCanvasElement) => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      const g = cv.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      return { g, W, H };
    };
    {
      const { g, W, H } = prep(this.canvas);
      const L = 44, R = 44, T = 10, B = 22;
      const pw = W - L - R;
      const ph = H - T - B;
      const oilR = r.map((x) => x.oil / days(x));
      const watR = r.map((x) => x.water / days(x));
      const injR = r.map((x) => x.waterInj / days(x));
      const maxR = niceMax(Math.max(...oilR.map((v, i) => v + watR[i]), ...injR, 1));
      let cum = 0;
      const cumA = r.map((x) => (cum += x.oil));
      const maxC = niceMax(cum || 1);
      g.font = '500 9.5px "IBM Plex Mono", monospace';
      g.fillStyle = '#6d7986';
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      for (let k = 0; k <= 4; k++) {
        const y = T + ph - (k / 4) * ph;
        g.beginPath();
        g.moveTo(L, y);
        g.lineTo(W - R, y);
        g.stroke();
        g.textAlign = 'right';
        g.fillText(fmt.big((k / 4) * maxR), L - 6, y);
        g.textAlign = 'left';
        g.fillText(fmt.big((k / 4) * maxC), W - R + 6, y);
      }
      const bw = pw / r.length;
      r.forEach((_x, i) => {
        const x0 = L + i * bw;
        const ho = (oilR[i] / maxR) * ph;
        const hw = (watR[i] / maxR) * ph;
        g.fillStyle = i === this.hoverIdx ? '#ffd08a' : 'rgba(255,181,71,0.85)';
        g.fillRect(x0 + 0.5, T + ph - ho, Math.max(1, bw - 1), ho);
        g.fillStyle = 'rgba(90,169,230,0.75)';
        g.fillRect(x0 + 0.5, T + ph - ho - hw, Math.max(1, bw - 1), hw);
        if (injR[i] > 0) {
          g.fillStyle = 'rgba(127,216,180,0.6)';
          const hi = (injR[i] / maxR) * ph;
          g.fillRect(x0 + 0.5, T + ph - hi, Math.max(1, bw - 1), 1.5);
        }
      });
      g.strokeStyle = '#e7ecf1';
      g.lineWidth = 1.5;
      g.beginPath();
      cumA.forEach((c, i) => {
        const x = L + (i + 0.5) * bw;
        const y = T + ph - (c / maxC) * ph;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
      // years
      g.fillStyle = '#6d7986';
      g.textAlign = 'center';
      let lastY = -1;
      r.forEach((x, i) => {
        const y = new Date(x.t).getUTCFullYear();
        if (y !== lastY) {
          lastY = y;
          g.fillText(String(y), L + i * bw + 12, H - 6);
        }
      });
      g.textAlign = 'left';
      g.fillStyle = '#ffb547';
      g.fillText('■ oil', L, T + 2);
      g.fillStyle = '#5aa9e6';
      g.fillText('■ water', L + 42, T + 2);
      g.fillStyle = '#e7ecf1';
      g.fillText('— cum. oil (Sm³)', L + 100, T + 2);
    }
    {
      const { g, W, H } = prep(this.canvas2);
      const L = 44, R = 44, T = 10, B = 18;
      const pw = W - L - R;
      const ph = H - T - B;
      const p = r.map((x) => x.bhp ?? NaN);
      const t = r.map((x) => x.bht ?? NaN);
      const has = p.some(Number.isFinite);
      g.font = '500 9.5px "IBM Plex Mono", monospace';
      if (!has) {
        g.fillStyle = '#4a5561';
        g.fillText('No downhole gauge data', L, H / 2);
        return;
      }
      const pMin = 150, pMax = 350, tMin = 80, tMax = 115;
      const bw = pw / r.length;
      const line = (arr: number[], min: number, max: number, color: string) => {
        g.strokeStyle = color;
        g.lineWidth = 1.4;
        g.beginPath();
        let pen = false;
        arr.forEach((v, i) => {
          if (!Number.isFinite(v)) {
            pen = false;
            return;
          }
          const x = L + (i + 0.5) * bw;
          const y = T + ph - ((v - min) / (max - min)) * ph;
          if (!pen) g.moveTo(x, y);
          else g.lineTo(x, y);
          pen = true;
        });
        g.stroke();
      };
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      for (let k = 0; k <= 4; k++) {
        const y = T + ph - (k / 4) * ph;
        g.beginPath();
        g.moveTo(L, y);
        g.lineTo(W - R, y);
        g.stroke();
        g.fillStyle = '#ff8a65';
        g.textAlign = 'right';
        g.fillText(String(pMin + (k / 4) * (pMax - pMin)), L - 6, y);
        g.fillStyle = '#c792ea';
        g.textAlign = 'left';
        g.fillText(String(tMin + (k / 4) * (tMax - tMin)), W - R + 6, y);
      }
      line(p, pMin, pMax, '#ff8a65');
      line(t, tMin, tMax, '#c792ea');
      g.textAlign = 'left';
      g.fillStyle = '#ff8a65';
      g.fillText('— BHP (bar)', L, T + 2);
      g.fillStyle = '#c792ea';
      g.fillText('— BHT (°C)', L + 90, T + 2);
    }
  }
}

function stat(k: string, v: string, unit: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, unit) : ''));
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
