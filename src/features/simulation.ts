import * as THREE from 'three';
import { readBwsimAny, type SimModel } from '../data/bwsim';
import { colormap, type RGB } from '../data/colormap';
import type { App } from '../ui/app';
import { chip, fmt, h, slider, toggle } from '../ui/dom';
import { FloatingPanel, fitCanvas } from '../ui/floating';
import { I } from '../ui/icons';
import type { FeatureModule } from './registry';
import { FOCUS } from '../scene/rockMaterial';

type Palette = 'turbo' | 'viridis' | 'fluid' | 'inferno';

function paletteFor(key: string): Palette {
  if (/SOIL|SWAT|SO|SW/i.test(key)) return 'fluid';
  if (/PRESS/i.test(key)) return 'inferno';
  if (/PERM/i.test(key)) return 'viridis';
  return 'turbo';
}

function lutTexture(p: Palette, invert = false): THREE.DataTexture {
  const n = 256;
  const d = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let t = i / (n - 1);
    if (invert) t = 1 - t;
    let c: RGB;
    if (p === 'fluid') {
      // water (blue) → oil (amber), low values dim
      const w: RGB = [0.13, 0.36, 0.66];
      const o: RGB = [0.95, 0.58, 0.14];
      c = [w[0] + (o[0] - w[0]) * t, w[1] + (o[1] - w[1]) * t, w[2] + (o[2] - w[2]) * t];
    } else c = colormap(p === 'inferno' ? 'inferno' : p === 'viridis' ? 'viridis' : 'turbo', t);
    d[i * 4] = Math.round(c[0] * 255);
    d[i * 4 + 1] = Math.round(c[1] * 255);
    d[i * 4 + 2] = Math.round(c[2] * 255);
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, n, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Reservoir simulation grid on a time slider: every active cell drawn as an
 * instanced box, coloured by a static property or by a dynamic result
 * (saturation, pressure) at the selected report date.
 */
export class SimulationFeature implements FeatureModule {
  readonly id = 'simulation' as const;
  model: SimModel | null = null;
  private mesh?: THREE.Mesh;
  private mat?: THREE.ShaderMaterial;
  private valAttr?: THREE.InstancedBufferAttribute;
  private panel: FloatingPanel;
  private chart = h('canvas', { class: 'fp-canvas sim-chart' });
  private controls = h('div', { class: 'sim-controls' });
  private info = h('div', { class: 'sim-info' });
  prop = '';
  stepIdx = 0;
  private playing = false;
  private playT = 0;
  private kRange: [number, number] = [0, 999];
  private kMax = 0;
  private threshold = 0;
  private clip = true;
  private ghost = false;
  private hideGeo = true;
  private savedLayers: Map<string, boolean> | null = null;
  private static GEO_IDS = ['heather', 'hugin', 'sleipner', 'skagerrak', 'smithbank'];
  private loading = false;
  private offBox?: () => void;
  private measured: { t: number; oil: number }[] = [];
  private dateSlider: { set: (v: number) => void } | null = null;

  constructor(private app: App) {
    this.panel = new FloatingPanel({ id: 'simulation', title: 'Reservoir simulation', badge: chip('calculated'), width: 420, height: 520, place: 'top-left', onClose: () => app.flags.set('simulation', false) });
    this.panel.body.append(this.info, this.controls, this.chart);
    this.panel.onResize = () => this.drawChart();
    this.chart.addEventListener('click', (e) => {
      const m = this.model;
      if (!m || !m.header.dates.length) return;
      const t = this.chartT(e.offsetX);
      if (t === null) return;
      let best = 0;
      m.header.dates.forEach((d, i) => {
        if (Math.abs(Date.parse(d) - t) < Math.abs(Date.parse(m.header.dates[best]) - t)) best = i;
      });
      this.setStep(best);
    });
  }

  enable() {
    // the panel opens by itself only when there is a model to show
    if (this.model || this.app.field.simulationFile) this.panel.show();
    const fn = () => this.updateUniforms();
    this.app.engine.boxListeners.push(fn);
    this.offBox = () => (this.app.engine.boxListeners = this.app.engine.boxListeners.filter((f) => f !== fn));
    if (this.mesh) this.app.engine.scene.add(this.mesh);
    this.applyGeoHide();
    if (!this.model) void this.loadPreloaded();
    else this.renderControls();
  }

  disable() {
    this.panel.hide();
    this.offBox?.();
    if (this.mesh) this.app.engine.scene.remove(this.mesh);
    this.playing = false;
    this.restoreGeo();
  }

  /** The grid sits inside the Hugin / Sleipner slabs: hide those units while the grid is shown. */
  private applyGeoHide() {
    const geo = this.app.engine.geology;
    if (!this.hideGeo || !this.model) return this.restoreGeo();
    if (!this.savedLayers) {
      this.savedLayers = new Map();
      for (const id of SimulationFeature.GEO_IDS) {
        const s = geo.state.get(id);
        if (s) this.savedLayers.set(id, s.visible);
      }
    }
    for (const id of SimulationFeature.GEO_IDS) geo.setLayer(id, { visible: false });
    this.app.left.sync();
  }

  private restoreGeo() {
    if (!this.savedLayers) return;
    const geo = this.app.engine.geology;
    for (const [id, v] of this.savedLayers) geo.setLayer(id, { visible: v });
    this.savedLayers = null;
    this.app.left.sync();
  }

  frame(dt: number) {
    if (!this.playing || !this.model) return;
    this.playT += dt;
    if (this.playT > 0.7) {
      this.playT = 0;
      const n = this.model.header.dates.length;
      if (this.stepIdx >= n - 1) this.playing = false;
      else this.setStep(this.stepIdx + 1);
      this.renderControls();
    }
  }

  settings() {
    const m = this.model;
    return h(
      'div',
      { class: 'feat-note' },
      m ? `${m.header.name}: ${fmt.n(m.n, 0)} active cells, ${m.header.dates.length} report dates. ${m.header.note}` : this.loading ? 'Loading simulation package …' : 'No simulation loaded. Import a .bwsim package in Data (convert Eclipse / OPM output with scripts/prepare_sim.py).',
      h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn', onclick: () => this.panel.show() }, 'Open simulation panel')),
    );
  }

  private async loadPreloaded() {
    const url = this.app.field.simulationFile;
    if (!url) {
      this.renderControls();
      return;
    }
    this.loading = true;
    this.renderControls();
    try {
      const r = await fetch(this.app.field.baseUrl + url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.setModel(await readBwsimAny(await r.arrayBuffer()));
    } catch (err) {
      this.info.innerHTML = `<span style="color:var(--danger)">Could not load the simulation package: ${(err as Error).message}</span>`;
    } finally {
      this.loading = false;
    }
  }

  setModel(m: SimModel) {
    this.model = m;
    const h0 = m.header;
    this.prop = h0.dynamic[0]?.key ?? h0.static.find((s) => s.key === 'SOIL0')?.key ?? h0.static[0]?.key ?? '';
    this.stepIdx = Math.max(0, h0.dates.length - 1);
    let kMax = 0;
    for (let q = 0; q < m.n; q++) kMax = Math.max(kMax, m.ijk[q * 3 + 2]);
    this.kRange = [0, kMax];
    this.kMax = kMax;
    this.measured = this.fieldMeasured();
    this.buildMesh();
    this.applyProp();
    this.renderControls();
    if (this.app.flags.on('simulation')) this.applyGeoHide();
    if (this.app.flags.on('simulation')) this.panel.show();
  }

  private fieldMeasured(): { t: number; oil: number }[] {
    const by = new Map<number, number>();
    for (const recs of this.app.field.productionMonthly.values())
      for (const r of recs) {
        const d = new Date(r.t);
        const k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        by.set(k, (by.get(k) ?? 0) + r.oil);
      }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, oil]) => ({ t, oil }));
  }

  private buildMesh() {
    const m = this.model!;
    if (this.mesh) {
      this.app.engine.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = box.index;
    g.setAttribute('position', box.getAttribute('position'));
    g.setAttribute('normal', box.getAttribute('normal'));
    g.setAttribute('uv', box.getAttribute('uv'));
    const c = new Float32Array(m.n * 3);
    const s = new Float32Array(m.n * 3);
    const k = new Float32Array(m.n);
    for (let q = 0; q < m.n; q++) {
      c[q * 3] = m.center[q * 3];
      c[q * 3 + 1] = -m.center[q * 3 + 2];
      c[q * 3 + 2] = -m.center[q * 3 + 1];
      s[q * 3] = m.size[q * 3];
      s[q * 3 + 1] = m.size[q * 3 + 2];
      s[q * 3 + 2] = m.size[q * 3 + 1];
      k[q] = m.ijk[q * 3 + 2];
    }
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(c, 3));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(s, 3));
    g.setAttribute('aK', new THREE.InstancedBufferAttribute(k, 1));
    this.valAttr = new THREE.InstancedBufferAttribute(new Float32Array(m.n), 1);
    this.valAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aVal', this.valAttr);
    g.instanceCount = m.n;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uLut: { value: lutTexture('fluid') },
        uBoxMin: { value: new THREE.Vector3(-1e9, -1e9, -1e9) },
        uBoxMax: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
        uK: { value: new THREE.Vector2(0, 999) },
        uThr: { value: 0 },
        uOpacity: { value: 1 },
        ...FOCUS,
      },
      vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aCenter; attribute vec3 aSize; attribute float aK; attribute float aVal;
uniform vec3 uBoxMin; uniform vec3 uBoxMax; uniform vec2 uK; uniform float uThr;
uniform vec3 uFocus; uniform float uFocusR; uniform float uFocusOn;
varying float vVal; varying vec3 vN; varying vec2 vUv; varying float vShade;
void main(){
  vVal = aVal; vUv = uv; vN = normal;
  bool hide = aVal < -0.5 || aK < uK.x - 0.5 || aK > uK.y + 0.5 || aVal < uThr
    || (uFocusOn > 0.5 && distance(aCenter, uFocus) < uFocusR * 0.7)
    || aCenter.x < uBoxMin.x || aCenter.x > uBoxMax.x || aCenter.z < uBoxMin.z || aCenter.z > uBoxMax.z || aCenter.y > uBoxMax.y;
  vec3 p = aCenter + position * aSize * 0.985;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
  vShade = 0.55 + 0.45 * max(dot(normal, normalize(vec3(-0.4, 0.85, 0.35))), 0.0) + 0.1 * normal.y;
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uLut; uniform float uOpacity;
varying float vVal; varying vec3 vN; varying vec2 vUv; varying float vShade;
void main(){
  #include <logdepthbuf_fragment>
  vec3 c = texture2D(uLut, vec2(clamp(vVal, 0.002, 0.998), 0.5)).rgb;
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = 1.0 - smoothstep(0.0, 0.06, min(e.x, e.y));
  c *= vShade * (1.0 - 0.35 * edge);
  gl_FragColor = vec4(c, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.userData = { kind: 'simCell' };
    if (this.app.flags.on('simulation')) this.app.engine.scene.add(this.mesh);
    this.updateUniforms();
  }

  private propInfo() {
    const hd = this.model!.header;
    const d = hd.dynamic.find((p) => p.key === this.prop);
    const s = hd.static.find((p) => p.key === this.prop);
    return { d, s, def: d ?? s! };
  }

  private applyProp() {
    const m = this.model;
    if (!m || !this.valAttr || !this.mat) return;
    const { d, def } = this.propInfo();
    const vals = d ? m.step(this.prop, this.stepIdx) : m.prop(this.prop);
    const arr = this.valAttr.array as Float32Array;
    if (!vals) return;
    for (let q = 0; q < m.n; q++) {
      const v = vals[q];
      if (!Number.isFinite(v)) arr[q] = -1;
      else if (def.log) arr[q] = Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1e-6)) - Math.log10(def.min)) / (Math.log10(def.max) - Math.log10(def.min))));
      else arr[q] = Math.max(0, Math.min(1, (v - def.min) / (def.max - def.min || 1)));
    }
    this.valAttr.needsUpdate = true;
    const old = this.mat.uniforms.uLut.value as THREE.Texture;
    this.mat.uniforms.uLut.value = lutTexture(paletteFor(this.prop));
    old.dispose();
  }

  private updateUniforms() {
    if (!this.mat) return;
    const u = this.mat.uniforms;
    const b = this.app.engine.geology.box;
    if (this.clip) {
      u.uBoxMin.value.set(b.xMin, -1e9, -b.nMax);
      u.uBoxMax.value.set(b.xMax, -b.stripTo, -b.nMin);
    } else {
      u.uBoxMin.value.set(-1e9, -1e9, -1e9);
      u.uBoxMax.value.set(1e9, 1e9, 1e9);
    }
    u.uK.value.set(this.kRange[0], this.kRange[1]);
    u.uThr.value = this.threshold;
    u.uOpacity.value = this.ghost ? 0.35 : 1;
    this.mat.transparent = this.ghost;
    this.mat.depthWrite = !this.ghost;
  }

  setStep(i: number) {
    this.stepIdx = i;
    this.applyProp();
    this.drawChart();
    this.dateSlider?.set(i);
  }

  private renderControls() {
    this.controls.innerHTML = '';
    this.dateSlider = null;
    const m = this.model;
    if (!m) {
      this.info.innerHTML = this.loading
        ? 'Loading the Volve simulation package …'
        : `No simulation grid is loaded. Import a <b>.bwsim</b> package in <b>Data</b>. Convert Eclipse or OPM Flow output (GRDECL / EGRID + INIT + UNRST + UNSMRY) with <code>scripts/prepare_sim.py</code>. The Volve Eclipse model is part of the <a href="https://www.equinor.com/energy/volve-data-sharing" target="_blank" rel="noopener">Equinor Volve data village</a>.`;
      this.drawChart();
      return;
    }
    const hd = m.header;
    this.info.innerHTML = `<b>${hd.name}</b> · ${fmt.n(m.n, 0)} active cells (${hd.dims.join(' × ')})<br><span class="faint">${hd.source}. ${hd.note}</span>`;
    const sel = h('select', { class: 'select' }) as HTMLSelectElement;
    for (const d of hd.dynamic) sel.append(h('option', { value: d.key }, `${d.label} (${d.unit}) · over time`));
    for (const s of hd.static) sel.append(h('option', { value: s.key }, `${s.label}${s.unit ? ` (${s.unit})` : ''}`));
    sel.value = this.prop;
    sel.onchange = () => {
      this.prop = sel.value;
      this.applyProp();
      this.renderControls();
    };
    const { d, def } = this.propInfo();
    const bar = h('div', { class: 'sim-bar' });
    const pal = paletteFor(this.prop);
    const stops = Array.from({ length: 12 }, (_, i) => {
      const t = i / 11;
      const c: RGB = pal === 'fluid' ? [0.13 + 0.82 * t, 0.36 + 0.22 * t, 0.66 - 0.52 * t] : colormap(pal === 'inferno' ? 'inferno' : pal === 'viridis' ? 'viridis' : 'turbo', t);
      return `rgb(${c.map((x) => Math.round(x * 255)).join(',')}) ${(t * 100).toFixed(0)}%`;
    });
    bar.style.background = `linear-gradient(90deg,${stops.join(',')})`;
    const rng = h('div', { class: 'sim-range' }, h('span', {}, fmt.n(def.min, def.max < 2 ? 2 : 0)), h('span', {}, `${def.label}${def.log ? ' (log)' : ''}`), h('span', {}, `${fmt.n(def.max, def.max < 2 ? 2 : 0)} ${def.unit}`));
    this.controls.append(h('div', { class: 'row' }, h('label', {}, 'Property'), sel), bar, rng);
    if (d && hd.dates.length) {
      const play = h('button', { class: 'btn icon', html: this.playing ? I.pause : I.play, title: 'Play through time' });
      play.onclick = () => {
        this.playing = !this.playing;
        if (this.playing && this.stepIdx >= hd.dates.length - 1) this.setStep(0);
        this.renderControls();
      };
      const t = slider({ label: 'Report date', min: 0, max: hd.dates.length - 1, step: 1, value: this.stepIdx, format: (v) => hd.dates[v] ?? '', onInput: (v) => this.setStep(v) });
      t.el.querySelector('.val')?.classList.add('sim-date');
      this.dateSlider = t;
      this.controls.append(h('div', { class: 'sim-time' }, play, t.el));
    }
    const kMax = this.kMax;
    const k0 = slider({ label: 'Layers from K', min: 0, max: kMax, step: 1, value: this.kRange[0], format: (v) => String(v + 1), onInput: (v) => ((this.kRange[0] = v), this.updateUniforms()) });
    const k1 = slider({ label: 'to K', min: 0, max: kMax, step: 1, value: this.kRange[1], format: (v) => String(v + 1), onInput: (v) => ((this.kRange[1] = v), this.updateUniforms()) });
    const thr = slider({ label: 'Hide cells below', min: 0, max: 0.95, step: 0.01, value: this.threshold, format: (v) => fmt.n(def.min + v * (def.max - def.min), def.max < 2 ? 2 : 0), onInput: (v) => ((this.threshold = v), this.updateUniforms()) });
    this.controls.append(
      k0.el,
      k1.el,
      thr.el,
      toggle('Clip to section box', this.clip, (v) => ((this.clip = v), this.updateUniforms())),
      toggle('Ghost (see-through cells)', this.ghost, (v) => ((this.ghost = v), this.updateUniforms())),
      toggle('Hide model formations over the grid', this.hideGeo, (v) => ((this.hideGeo = v), this.applyGeoHide())),
    );
    this.drawChart();
  }

  private chartT(x: number): number | null {
    const s = this.model?.header.summary;
    const W = this.chart.clientWidth;
    const t = s?.t ?? this.measured.map((m) => m.t);
    if (!t.length) return null;
    const t0 = Math.min(t[0], this.measured[0]?.t ?? Infinity);
    const t1 = Math.max(t[t.length - 1], this.measured[this.measured.length - 1]?.t ?? -Infinity);
    return t0 + ((x - 40) / (W - 50)) * (t1 - t0);
  }

  private drawChart() {
    const fit = fitCanvas(this.chart);
    if (!fit) return;
    const { g, W, H } = fit;
    const m = this.model;
    const s = m?.header.summary;
    const meas = this.measured.length ? this.measured : this.fieldMeasured();
    if (!meas.length && !s) return;
    const simT = s?.t ?? [];
    const simRate = s?.field.FOPR ?? [];
    const t0 = Math.min(meas[0]?.t ?? Infinity, simT[0] ?? Infinity);
    const t1 = Math.max(meas[meas.length - 1]?.t ?? -Infinity, simT[simT.length - 1] ?? -Infinity);
    // measured monthly volume → mean daily rate
    const mr = meas.map((q) => ({ t: q.t, r: q.oil / 30.4 }));
    const rMax = Math.max(...mr.map((q) => q.r), ...simRate, 1) * 1.1;
    const X = (t: number) => 40 + ((t - t0) / (t1 - t0 || 1)) * (W - 50);
    const Y = (r: number) => H - 18 - (r / rMax) * (H - 34);
    g.font = '10px "IBM Plex Mono", monospace';
    g.fillStyle = 'rgba(231,236,241,0.55)';
    g.textAlign = 'left';
    g.fillText('Field oil rate, Sm³/d', 4, 11);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) {
      const x = X(Date.UTC(y, 0, 1));
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x, H - 18);
      g.stroke();
      g.textAlign = 'center';
      g.fillText(String(y).slice(2), x, H - 5);
    }
    g.textAlign = 'right';
    g.fillText(fmt.big(rMax), 36, 22);
    g.fillText('0', 36, H - 18);
    // measured (bars) vs simulated (line)
    g.fillStyle = 'rgba(255,181,71,0.55)';
    for (const q of mr) g.fillRect(X(q.t), Y(q.r), Math.max(1, X(q.t + 30 * 864e5) - X(q.t) - 0.5), H - 18 - Y(q.r));
    if (simRate.length) {
      g.strokeStyle = '#7fe3ff';
      g.lineWidth = 1.6;
      g.beginPath();
      simT.forEach((t, i) => (i ? g.lineTo(X(t), Y(simRate[i])) : g.moveTo(X(t), Y(simRate[i]))));
      g.stroke();
    }
    g.textAlign = 'left';
    g.fillStyle = '#ffb547';
    g.fillText('■ measured (monthly)', 44, 26);
    if (simRate.length) {
      g.fillStyle = '#7fe3ff';
      g.fillText('— simulated', 170, 26);
    }
    if (m && m.header.dates[this.stepIdx]) {
      const x = X(Date.parse(m.header.dates[this.stepIdx]));
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, 14);
      g.lineTo(x, H - 18);
      g.stroke();
      g.setLineDash([]);
    }
  }
}
