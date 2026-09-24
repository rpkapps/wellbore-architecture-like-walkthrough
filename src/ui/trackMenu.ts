import {
  DEFAULT_TRACKS,
  MAX_CURVES_PER_TRACK,
  availableCurves,
  moveTrack,
  newTrack,
  specForOption,
  trackHasData,
  type CurveOption,
  type TrackSpec,
  type WellCurves,
} from '../data/trackLayout';
import { h } from './dom';
import { I } from './icons';

export interface TrackMenuHost {
  layout: TrackSpec[];
  hideEmpty: boolean;
  well?: WellCurves;
  /** layout or options changed: store and redraw */
  commit(): void;
  reset(): void;
}

const WIDTHS: [number, string][] = [
  [0.6, 'Narrow'],
  [0.9, 'Normal'],
  [1.3, 'Wide'],
];

/** Popover in the log panel for showing, hiding, reordering, editing and adding tracks. */
export class TrackMenu {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private editing: string | null = null;

  constructor(private host: TrackMenuHost) {
    this.body = h('div', { class: 'tm-body' });
    const close = h('button', { class: 'btn icon ghost', title: 'Close', html: I.close, onclick: () => this.hide() });
    const reset = h('button', { class: 'btn xs ghost', title: 'Back to the six standard tracks', onclick: () => ((this.editing = null), host.reset(), this.render()) }, 'Reset');
    this.el = h('div', { class: 'track-menu glass hidden' }, h('div', { class: 'tm-head' }, h('h4', {}, 'Log tracks'), h('div', { style: 'flex:1' }), reset, close), this.body);
    // keep clicks inside the menu from reaching the canvas under it
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  show() {
    this.render();
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
    this.editing = null;
  }

  /** re-render when the active well changes (the curve list depends on it) */
  refresh() {
    if (this.open) this.render();
  }

  private change(layout?: TrackSpec[]) {
    if (layout) this.host.layout = layout;
    this.host.commit();
    this.render();
  }

  render() {
    const host = this.host;
    const w = host.well;
    this.body.innerHTML = '';
    const list = h('div', { class: 'tm-list' });
    host.layout.forEach((t, i) => {
      const vis = h('input', { type: 'checkbox', title: t.hidden ? 'Show track' : 'Hide track' }) as HTMLInputElement;
      vis.checked = !t.hidden;
      vis.onchange = () => {
        t.hidden = !vis.checked;
        this.change();
      };
      const noData = w && !trackHasData(w, t);
      const row = h(
        'div',
        { class: `tm-row${t.hidden ? ' off' : ''}` },
        h('label', { class: 'tm-name', title: t.curves.map((c) => c.label).join(', ') }, vis, h('span', {}, txt(t.title)), t.custom ? h('span', { class: 'tm-tag' }, 'added') : null, noData ? h('span', { class: 'tm-tag faint' }, 'no data') : null),
        h('button', { class: 'btn icon ghost xs tm-rot', title: 'Move up', html: I.prev, disabled: i === 0, onclick: () => this.change(moveTrack(host.layout, t.id, -1)) }),
        h('button', { class: 'btn icon ghost xs tm-rot', title: 'Move down', html: I.next, disabled: i === host.layout.length - 1, onclick: () => this.change(moveTrack(host.layout, t.id, 1)) }),
        h('button', { class: `btn icon ghost xs${this.editing === t.id ? ' active' : ''}`, title: 'Scales and colours', html: I.sliders, onclick: () => ((this.editing = this.editing === t.id ? null : t.id), this.render()) }),
        t.custom ? h('button', { class: 'btn icon ghost xs', title: 'Remove track', html: I.trash, onclick: () => this.change(host.layout.filter((q) => q !== t)) }) : h('span', { class: 'tm-spacer' }),
      );
      list.append(row);
      if (this.editing === t.id) list.append(this.editor(t));
    });
    this.body.append(list);

    // add a track for any curve of the active well
    const opts = w ? availableCurves(w) : [];
    const sel = this.curveSelect(opts, 'Choose a curve …');
    const add = h('button', { class: 'btn xs primary', disabled: !opts.length }, '+ Add track');
    add.onclick = () => {
      const o = opts.find((q) => q.id === sel.value);
      if (!o || !w) return;
      const t = newTrack(w, o, host.layout);
      this.editing = t.id;
      this.change([...host.layout, t]);
    };
    const hide = h('input', { type: 'checkbox' }) as HTMLInputElement;
    hide.checked = host.hideEmpty;
    hide.onchange = () => {
      host.hideEmpty = hide.checked;
      this.change();
    };
    this.body.append(
      h('div', { class: 'tm-add' }, sel, add),
      h('label', { class: 'tm-opt' }, hide, h('span', {}, 'Hide tracks this well has no data for')),
      h('div', { class: 'tm-note' }, 'The layout is saved in this browser and applies to every well. Added tracks are skipped on wells that lack their curves.'),
    );
  }

  private curveSelect(opts: CurveOption[], placeholder: string): HTMLSelectElement {
    const sel = h('select', { class: 'select' }) as HTMLSelectElement;
    sel.append(h('option', { value: '' }, placeholder));
    const groups: [CurveOption['source'], string][] = [
      ['logs', 'Measured logs'],
      ['cpi', 'Equinor CPI (operator interp.)'],
      ['petro', 'Calculated in the app'],
    ];
    for (const [src, label] of groups) {
      const g = opts.filter((o) => o.source === src);
      if (!g.length) continue;
      const og = h('optgroup', { label });
      for (const o of g) og.append(h('option', { value: o.id, title: o.description }, txt(`${o.label}${o.unit ? ` (${o.unit})` : ''}`)));
      sel.append(og);
    }
    return sel;
  }

  private editor(t: TrackSpec): HTMLElement {
    const host = this.host;
    const ed = h('div', { class: 'tm-editor' });
    if (t.custom) {
      const title = h('input', { class: 'tm-text', value: t.title, maxlength: 40 }) as HTMLInputElement;
      title.onchange = () => {
        t.title = title.value.trim() || t.title;
        this.change();
      };
      ed.append(h('div', { class: 'tm-field' }, h('span', {}, 'Title'), title));
    }
    const width = h('select', { class: 'select' }) as HTMLSelectElement;
    for (const [v, l] of WIDTHS) width.append(h('option', { value: String(v) }, l));
    width.value = String(WIDTHS.reduce((a, b) => (Math.abs(b[0] - t.flex) < Math.abs(a[0] - t.flex) ? b : a))[0]);
    width.onchange = () => {
      t.flex = +width.value;
      this.change();
    };
    ed.append(h('div', { class: 'tm-field' }, h('span', {}, 'Width'), width));
    t.curves.forEach((c, k) => {
      const color = h('input', { type: 'color', value: c.color, title: 'Colour' }) as HTMLInputElement;
      color.oninput = () => {
        c.color = color.value;
        host.commit();
      };
      const num = (end: 'min' | 'max') => {
        const v = c.scale[end];
        const el = h('input', { class: 'num', type: 'number', step: 'any', value: +v.toPrecision(6), title: end === 'min' ? 'Left edge' : 'Right edge' }) as HTMLInputElement;
        el.onchange = () => {
          const x = +el.value;
          const next = { ...c.scale, [end]: x };
          // a log scale needs positive ends; equal ends are meaningless
          if (Number.isFinite(x) && next.min !== next.max && (!next.log || (next.min > 0 && next.max > 0))) {
            c.scale = next;
            this.change();
          } else el.value = String(+v.toPrecision(6));
        };
        return el;
      };
      const min = num('min');
      const max = num('max');
      const log = h('input', { type: 'checkbox', title: 'Logarithmic scale' }) as HTMLInputElement;
      log.checked = !!c.scale.log;
      log.disabled = !c.scale.log && (c.scale.min <= 0 || c.scale.max <= 0);
      log.onchange = () => {
        c.scale = { ...c.scale, log: log.checked };
        if (k === 0) t.grid = log.checked ? 'log' : 'linear';
        this.change();
      };
      const flip = h('button', { class: 'btn icon ghost xs', title: 'Reverse the scale', html: '⇄', onclick: () => ((c.scale = { ...c.scale, min: c.scale.max, max: c.scale.min }), this.change()) });
      const remove =
        t.curves.length > 1 && (t.custom || k >= builtInCount(t))
          ? h('button', { class: 'btn icon ghost xs', title: 'Remove curve', html: I.close, onclick: () => ((t.curves = t.curves.filter((q) => q !== c)), this.change()) })
          : h('span', { class: 'tm-spacer' });
      ed.append(
        h('div', { class: 'tm-curve' }, color, h('b', { title: c.key }, txt(c.label)), remove),
        h('div', { class: 'tm-scale' }, min, h('span', { class: 'faint' }, '→'), max, flip, h('label', { class: 'tm-log' }, log, 'log')),
      );
    });
    if (t.custom) {
      const shade = h('input', { type: 'checkbox' }) as HTMLInputElement;
      shade.checked = t.fill === 'shade';
      shade.onchange = () => {
        t.fill = shade.checked ? 'shade' : undefined;
        this.change();
      };
      ed.append(h('label', { class: 'tm-opt' }, shade, h('span', {}, txt(`Shade under ${t.curves[0].label}`))));
    }
    if (t.curves.length < MAX_CURVES_PER_TRACK && host.well) {
      const w = host.well;
      const opts = availableCurves(w);
      const sel = this.curveSelect(opts, 'Add a curve to this track …');
      sel.onchange = () => {
        const o = opts.find((q) => q.id === sel.value);
        if (!o) return;
        t.curves.push(specForOption(w, o, t.curves.map((q) => q.color)));
        this.change();
      };
      ed.append(sel);
    }
    return ed;
  }
}

/** text node for names that come from uploaded files (h() would parse a leading '<' as HTML) */
const txt = (s: string) => document.createTextNode(s);

/** number of curves a built-in track starts with (curves beyond it were added by the user) */
function builtInCount(t: TrackSpec): number {
  return DEFAULT_TRACKS.find((d) => d.id === t.id)?.curves.length ?? t.curves.length;
}
