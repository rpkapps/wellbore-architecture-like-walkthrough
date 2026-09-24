import { FORMATION_BY_ID, MODEL_HORIZONS } from '../data/stratigraphy';
import { COLORMAPS, type ColormapName } from '../data/colormap';
import type { App } from './app';
import { h, slider, toggle } from './dom';
import { I } from './icons';

export class LeftPanel {
  readonly el: HTMLElement;
  private layerRows = new Map<string, { row: HTMLElement; eye: HTMLButtonElement; iso: HTMLButtonElement; op: ReturnType<typeof slider> }>();
  private stripSlider!: ReturnType<typeof slider>;

  constructor(private app: App) {
    const body = h('div', { class: 'panel-body' });
    this.el = h(
      'div',
      { class: 'panel left glass' },
      h(
        'div',
        { class: 'panel-head' },
        h('h3', {}, 'Scene'),
        h('span', { class: 'micro' }, `${app.field.meta.name} geomodel`),
      ),
      body,
    );
    body.append(this.formations(), this.sectionBox(), this.wellbore(), this.sceneOptions());
  }

  private formations(): HTMLElement {
    const geo = this.app.engine.geology;
    const list = h('div');
    for (const id of MODEL_HORIZONS) {
      const f = FORMATION_BY_ID.get(id)!;
      const st = geo.state.get(id)!;
      const eye = h('button', { class: 'mini', title: 'Show / hide', html: st.visible ? I.eye : I.eyeOff }) as HTMLButtonElement;
      const iso = h('button', { class: 'mini', title: 'Isolate formation', html: I.target }) as HTMLButtonElement;
      const op = slider({
        label: '',
        min: 0,
        max: 1,
        step: 0.01,
        value: st.opacity,
        onInput: (v) => geo.setLayer(id, { opacity: v }),
      });
      op.el.className = 'op';
      op.el.querySelector('label')?.remove();
      op.el.querySelector('.val')?.remove();
      op.el.style.margin = '0';
      op.el.title = 'Opacity';
      const row = h(
        'div',
        { class: `layer${f.reservoir ? ' reservoir' : ''}${st.visible ? '' : ' off'}` },
        h('div', { class: 'sw', style: `background:${f.color}` }),
        h('div', { class: 'nm' }, h('b', {}, f.name), h('small', {}, `${f.age} · ${f.lithology === 'blackshale' ? 'organic shale' : f.lithology}`)),
        op.el,
        h('div', { class: 'mini-btns' }, eye, iso),
      );
      row.addEventListener('mouseenter', () => geo.setHighlight(id));
      row.addEventListener('mouseleave', () => geo.setHighlight(null));
      row.addEventListener('dblclick', () => this.app.inspectFormation(id));
      eye.onclick = () => {
        const s = geo.state.get(id)!;
        geo.setLayer(id, { visible: !s.visible });
        this.sync();
      };
      iso.onclick = () => {
        geo.isolate(geo.isolatedId === id ? null : id);
        this.sync();
      };
      this.layerRows.set(id, { row, eye, iso, op });
      list.append(row);
    }
    const presets = h(
      'div',
      { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' },
      h('button', { class: 'btn', onclick: () => this.app.preset('default') }, 'Glass overburden'),
      h('button', { class: 'btn', onclick: () => this.app.preset('solid') }, 'Solid'),
      h('button', { class: 'btn', onclick: () => this.app.preset('reservoir') }, 'Reservoir focus'),
      h('button', { class: 'btn', style: 'color:var(--oil);border-color:rgba(255,181,71,.35)', onclick: () => this.app.preset('pay') }, 'Isolate pay'),
    );
    return h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Formations'), h('span', { class: 'chip interpreted', title: 'Surfaces interpolated from Equinor formation picks in 34 wellbores' }, 'Picks model')), list, presets);
  }

  sync() {
    const geo = this.app.engine.geology;
    for (const [id, r] of this.layerRows) {
      const s = geo.state.get(id)!;
      r.row.classList.toggle('off', !s.visible);
      r.row.classList.toggle('iso', geo.isolatedId === id);
      r.eye.innerHTML = s.visible ? I.eye : I.eyeOff;
      r.iso.classList.toggle('on', geo.isolatedId === id);
      r.op.set(s.opacity);
    }
    this.stripSlider?.set(geo.box.stripTo);
  }

  private sectionBox(): HTMLElement {
    const geo = this.app.engine.geology;
    const fb = geo.fullBox;
    let pending: number | null = null;
    const apply = (b: Parameters<typeof geo.setBox>[0]) => {
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        geo.setBox(b);
        pending = null;
      });
    };
    this.stripSlider = slider({
      label: 'Strip overburden to',
      min: 0,
      max: 3200,
      step: 10,
      value: 0,
      format: (v) => `${v.toFixed(0)} m TVDSS`,
      onInput: (v) => apply({ stripTo: v }),
    });
    const km = (v: number) => `${(v / 1000).toFixed(2)} km`;
    const e0 = slider({ label: 'West face', min: fb.xMin, max: fb.xMax - 100, step: 10, value: fb.xMin, format: km, onInput: (v) => apply({ xMin: v }) });
    const e1 = slider({ label: 'East face', min: fb.xMin + 100, max: fb.xMax, step: 10, value: fb.xMax, format: km, onInput: (v) => apply({ xMax: v }) });
    const n0 = slider({ label: 'South face', min: fb.nMin, max: fb.nMax - 100, step: 10, value: fb.nMin, format: km, onInput: (v) => apply({ nMin: v }) });
    const n1 = slider({ label: 'North face', min: fb.nMin + 100, max: fb.nMax, step: 10, value: fb.nMax, format: km, onInput: (v) => apply({ nMax: v }) });
    const setAll = (b: { xMin: number; xMax: number; nMin: number; nMax: number; stripTo: number }) => {
      geo.setBox(b);
      e0.set(b.xMin);
      e1.set(b.xMax);
      n0.set(b.nMin);
      n1.set(b.nMax);
      this.stripSlider.set(b.stripTo);
    };
    this.app.onSectionPreset = setAll;
    const presets = h(
      'div',
      { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px' },
      h('button', { class: 'btn', onclick: () => setAll({ ...fb }) }, 'Full'),
      h('button', { class: 'btn', onclick: () => this.app.sectionAlongWell() }, 'Cut at well'),
      h('button', { class: 'btn', onclick: () => setAll({ ...geo.box, stripTo: 2750 }) }, 'Reservoir window'),
    );
    return h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Section box'), h('span', { class: 'faint', style: 'font-size:10.5px' }, 'capped cut faces')),
      presets,
      this.stripSlider.el,
      e0.el,
      e1.el,
      n0.el,
      n1.el,
    );
  }

  private wellbore(): HTMLElement {
    const e = this.app.engine;
    const rad = slider({
      label: 'Radial exaggeration',
      min: 1,
      max: 60,
      step: 1,
      value: e.radialScale,
      format: (v) => `×${v}`,
      onInput: (v) => this.app.setRadialScale(v),
    });
    const cas = slider({
      label: 'Casing transparency',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0.42,
      format: (v) => `${Math.round((1 - v) * 100)}%`,
      onInput: (v) => e.wellbore?.setCasingOpacity(v),
    });
    const wall = slider({
      label: 'Borehole wall opacity (X-ray)',
      min: 0.05,
      max: 1,
      step: 0.01,
      value: 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => e.wellbore?.setWallOpacity(v),
    });
    this.app.onWallOpacity = (v) => wall.set(v);
    const shells = slider({
      label: 'Halo / fluid volume intensity',
      min: 0,
      max: 2,
      step: 0.01,
      value: 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        if (e.wellbore) e.wellbore.uniforms.uShellOpacity.value = v;
      },
    });
    return h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Wellbore'), h('span', { class: 'faint', style: 'font-size:10.5px' }, 'near-well geometry')),
      rad.el,
      cas.el,
      wall.el,
      shells.el,
      toggle('Casing & cement', true, (v) => {
        e.wellbore?.casings.forEach((m) => (m.visible = v));
        e.wellbore?.cements.forEach((m) => (m.visible = v));
      }),
      toggle('Natural fractures', true, (v) => {
        if (!e.wellbore) return;
        e.wellbore.fractureGroup.visible = v;
        e.wellbore.uniforms.uShowFractures.value = v ? 1 : 0;
      }, h('span', { class: 'chip schematic', style: 'margin-left:6px;height:15px;font-size:8px' }, 'schematic')),
      toggle('Formation tops & depth marks', true, (v) => {
        if (e.wellbore) e.wellbore.markers.visible = v;
      }),
    );
  }

  private sceneOptions(): HTMLElement {
    const e = this.app.engine;
    const cm = h('select', { class: 'select' }) as HTMLSelectElement;
    for (const c of COLORMAPS) cm.append(h('option', { value: c.id }, c.label));
    cm.onchange = () => this.app.setColormap(cm.value as ColormapName);
    this.app.onColormap = (n) => (cm.value = n);
    return h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, h('span', { class: 'micro' }, 'Display')),
      h('div', { class: 'row' }, h('label', {}, 'Resistivity colour map'), cm),
      toggle('Labels', true, (v) => {
        e.labelsVisible = v;
        e.env.platform.children.forEach((c) => {
          if ((c as { isCSS2DObject?: boolean }).isCSS2DObject) c.visible = v;
        });
      }),
      toggle('Other Volve wellbores', true, (v) => (e.contextVisible = v)),
      toggle('Sea, water column & platform', true, (v) => {
        e.env.seaVisible = v;
        e.env.sea.visible = v;
        e.env.waterColumn.visible = v;
        e.env.platform.visible = v;
      }),
      toggle('Structural contours (25 m)', true, (v) => e.geology.setContours(v)),
    );
  }
}
