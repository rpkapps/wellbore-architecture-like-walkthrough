import * as THREE from 'three';
import { readBwsimAny, type SimModel } from '../data/bwsim';
import { colormap, type RGB } from '../data/colormap';
import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Button } from '@tecton/react/components/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { ScrollArea } from '@tecton/react/components/scroll-area';
import { Spinner } from '@tecton/react/components/spinner';
import { Link } from '@tecton/react/tecton/link';
import { CircleAlertIcon, Grid3x3Icon, PauseIcon, PlayIcon } from 'lucide-react';
import type { App } from '../ui/app';
import { Note, SelectField, SliderField, SwitchField } from '../ui/controls';
import { fmt } from '../ui/dom';
import { ToolWindow, fitCanvas } from '../ui/toolWindow';
import { IconButton } from '../ui/icon-button';
import { Rev } from '../ui/signal';
import { font, ink } from '../ui/tokens';
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
  /** bump when the model or its loading state changes (Features panel settings) */
  readonly rev = new Rev();
  private panel: ToolWindow;
  private chart: HTMLCanvasElement | null = null;
  private error: string | null = null;
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

  constructor(private app: App) {
    this.panel = new ToolWindow({
      id: 'simulation',
      title: 'Reservoir simulation',
      badge: 'calculated',
      onClose: () => app.flags.set('simulation', false),
      body: () => (
        <>
          <ScrollArea className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="flex flex-col gap-3 pb-1">{this.renderControls()}</div>
          </ScrollArea>
          <canvas
            ref={(el) => {
              this.chart = el;
            }}
            aria-label="Field oil rate, measured and simulated: click to show that report date"
            className="block h-32 w-full shrink-0 cursor-pointer"
            onClick={(e) => {
              const m = this.model;
              if (!m || !m.header.dates.length) return;
              const t = this.chartT(e.nativeEvent.offsetX);
              if (t === null) return;
              let best = 0;
              m.header.dates.forEach((d, i) => {
                if (Math.abs(Date.parse(d) - t) < Math.abs(Date.parse(m.header.dates[best]) - t)) best = i;
              });
              this.setStep(best);
            }}
          />
        </>
      ),
    });
    this.panel.onResize = () => this.drawChart();
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
    else this.refresh();
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
    this.app.sceneRev.bump();
  }

  private restoreGeo() {
    if (!this.savedLayers) return;
    const geo = this.app.engine.geology;
    for (const [id, v] of this.savedLayers) geo.setLayer(id, { visible: v });
    this.savedLayers = null;
    this.app.sceneRev.bump();
  }

  frame(dt: number) {
    if (!this.playing || !this.model) return;
    this.playT += dt;
    if (this.playT > 0.7) {
      this.playT = 0;
      const n = this.model.header.dates.length;
      if (this.stepIdx >= n - 1) this.playing = false;
      else this.setStep(this.stepIdx + 1);
      this.panel.rev.bump();
    }
  }

  settings() {
    const m = this.model;
    return (
      <>
        <Note>{m ? `${m.header.name}: ${fmt.n(m.n, 0)} active cells, ${m.header.dates.length} report dates. ${m.header.note}` : this.loading ? 'Loading simulation package …' : 'No simulation loaded. Import a .bwsim package in Data (convert Eclipse / OPM output with scripts/prepare_sim.py).'}</Note>
        <div>
          <Button variant="ghost" size="sm" onPress={() => this.panel.show()}>
            Open simulation panel
          </Button>
        </div>
      </>
    );
  }

  /** Re-render the panel body and the Features-panel settings, then redraw the chart. */
  private refresh() {
    this.panel.rev.bump();
    this.rev.bump();
    this.drawChart();
  }

  private async loadPreloaded() {
    const url = this.app.field.simulationFile;
    if (!url) {
      this.refresh();
      return;
    }
    this.loading = true;
    this.error = null;
    this.refresh();
    try {
      const r = await fetch(this.app.field.baseUrl + url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.setModel(await readBwsimAny(await r.arrayBuffer()));
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
      this.refresh();
    }
  }

  setModel(m: SimModel) {
    this.model = m;
    this.error = null;
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
    this.refresh();
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
    this.panel.rev.bump();
  }

  /** Controls in the panel body: model info, property and legend, report date, layer range, threshold and display switches. */
  private renderControls() {
    const m = this.model;
    if (!m) {
      if (this.loading)
        return (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Spinner />
              </EmptyMedia>
              <EmptyTitle>Loading the simulation</EmptyTitle>
              <EmptyDescription>Loading the Volve simulation package …</EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      if (this.error)
        return (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Simulation failed to load</AlertTitle>
            <AlertDescription>Could not load the simulation package: {this.error}</AlertDescription>
          </Alert>
        );
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Grid3x3Icon />
            </EmptyMedia>
            <EmptyTitle>No simulation grid loaded</EmptyTitle>
            <EmptyDescription>
              Import a <b>.bwsim</b> package in <b>Data</b>. Convert Eclipse or OPM Flow output (GRDECL / EGRID + INIT + UNRST + UNSMRY) with <code>scripts/prepare_sim.py</code>. The Volve Eclipse model is part of the{' '}
              <Link href="https://www.equinor.com/energy/volve-data-sharing" isExternal>
                Equinor Volve data village
              </Link>
              .
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onPress={() => this.app.dataOpen.set(true)}>
              Import simulation
            </Button>
          </EmptyContent>
        </Empty>
      );
    }
    const hd = m.header;
    const { d, def } = this.propInfo();
    const pal = paletteFor(this.prop);
    const stops = Array.from({ length: 12 }, (_, i) => {
      const t = i / 11;
      const c: RGB = pal === 'fluid' ? [0.13 + 0.82 * t, 0.36 + 0.22 * t, 0.66 - 0.52 * t] : colormap(pal === 'inferno' ? 'inferno' : pal === 'viridis' ? 'viridis' : 'turbo', t);
      return `rgb(${c.map((x) => Math.round(x * 255)).join(',')}) ${(t * 100).toFixed(0)}%`;
    });
    const dp = def.max < 2 ? 2 : 0;
    const set = (fn: () => void) => {
      fn();
      this.updateUniforms();
      this.panel.rev.bump();
    };
    return (
      <>
        <div className="flex flex-col gap-0.5 text-xs">
          <span>
            <b className="font-medium">{hd.name}</b> · {fmt.n(m.n, 0)} active cells ({hd.dims.join(' × ')})
          </span>
          <span className="text-muted-foreground">
            {hd.source}. {hd.note}
          </span>
        </div>
        <SelectField
          label="Property"
          value={this.prop}
          onChange={(v) => {
            this.prop = v;
            this.applyProp();
            this.refresh();
          }}
          options={[
            { label: 'Over time', options: hd.dynamic.map((x) => ({ id: x.key, label: `${x.label} (${x.unit})` })) },
            { label: 'Static', options: hd.static.map((x) => ({ id: x.key, label: `${x.label}${x.unit ? ` (${x.unit})` : ''}` })) },
          ].filter((g) => g.options.length)}
        />
        <div className="flex flex-col gap-1">
          <div aria-hidden className="h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg,${stops.join(',')})` }} />
          <div className="flex justify-between gap-2 font-mono text-xs text-muted-foreground">
            <span>{fmt.n(def.min, dp)}</span>
            <span>
              {def.label}
              {def.log ? ' (log)' : ''}
            </span>
            <span>
              {fmt.n(def.max, dp)} {def.unit}
            </span>
          </div>
        </div>
        {d && hd.dates.length > 0 && (
          <div className="flex items-end gap-2">
            <IconButton
              label={this.playing ? 'Pause' : 'Play through time'}
              variant="ghost"
              onPress={() => {
                this.playing = !this.playing;
                if (this.playing && this.stepIdx >= hd.dates.length - 1) this.setStep(0);
                this.panel.rev.bump();
              }}
            >
              {this.playing ? <PauseIcon /> : <PlayIcon />}
            </IconButton>
            <div className="min-w-0 flex-1">
              <SliderField label="Report date" value={this.stepIdx} minValue={0} maxValue={hd.dates.length - 1} step={1} format={(v) => hd.dates[v] ?? ''} onChange={(v) => this.setStep(v)} />
            </div>
          </div>
        )}
        <SliderField label="Layers from K" value={this.kRange[0]} minValue={0} maxValue={this.kMax} step={1} format={(v) => String(v + 1)} onChange={(v) => set(() => (this.kRange[0] = v))} />
        <SliderField label="to K" value={this.kRange[1]} minValue={0} maxValue={this.kMax} step={1} format={(v) => String(v + 1)} onChange={(v) => set(() => (this.kRange[1] = v))} />
        <SliderField label="Hide cells below" value={this.threshold} minValue={0} maxValue={0.95} step={0.01} format={(v) => fmt.n(def.min + v * (def.max - def.min), dp)} onChange={(v) => set(() => (this.threshold = v))} />
        <SwitchField label="Clip to section box" isSelected={this.clip} onChange={(v) => set(() => (this.clip = v))} />
        <SwitchField label="Ghost (see-through cells)" isSelected={this.ghost} onChange={(v) => set(() => (this.ghost = v))} />
        <SwitchField
          label="Hide model formations over the grid"
          isSelected={this.hideGeo}
          onChange={(v) => {
            this.hideGeo = v;
            this.applyGeoHide();
            this.panel.rev.bump();
          }}
        />
      </>
    );
  }

  private chartT(x: number): number | null {
    const s = this.model?.header.summary;
    const W = this.chart?.clientWidth ?? 0;
    const t = s?.t ?? this.measured.map((m) => m.t);
    if (!t.length || !W) return null;
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
    g.font = font.mono(10);
    g.fillStyle = ink.muted;
    g.textAlign = 'left';
    g.fillText('Field oil rate, Sm³/d', 4, 11);
    g.strokeStyle = ink.grid;
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
      g.strokeStyle = ink.text;
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
