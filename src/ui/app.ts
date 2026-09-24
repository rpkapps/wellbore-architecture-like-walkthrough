import * as THREE from 'three';
import type { FieldModel } from '../data/dataset';
import { summariseZones, type ZoneSummary } from '../data/petro';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { colormap, toCss, RES_RANGE, type ColormapName } from '../data/colormap';
import { Trajectory } from '../data/trajectory';
import type { Engine } from '../scene/engine';
import type { GuidedView, NavMode } from '../scene/cameraRig';
import type { PropertyMode } from '../scene/wellbore';
import { chip, fmt, h } from './dom';
import { I, LOGO } from './icons';
import { LeftPanel } from './leftPanel';
import { LogTracks } from './logTracks';
import { Inspector } from './inspector';
import { InterpretationDrawer } from './interpretation';
import { ProductionDrawer } from './production';
import { DataManager } from './dataManager';
import { buildChapters, type Chapter } from './tour';
import { FeatureFlags, type FeatureId, type FeatureModule } from '../features/registry';
import { FeaturesPanel } from './featuresPanel';
import { createFeatureModules } from '../features';
import { ropByZone, ROP_RANGE } from '../data/drilling';

const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class App {
  readonly root: HTMLElement;
  left!: LeftPanel;
  logs!: LogTracks;
  inspector!: Inspector;
  interp!: InterpretationDrawer;
  prod!: ProductionDrawer;
  data!: DataManager;
  flags!: FeatureFlags;
  modules = new Map<FeatureId, FeatureModule>();
  featuresPanel!: FeaturesPanel;
  /** slot in the top bar where tool features add their buttons */
  toolSlot!: HTMLElement;
  /** slot under the compass HUD for feature read-outs */
  hudSlot!: HTMLElement;
  /** click interceptors (e.g. the measure tool); returning true consumes the click */
  clickHandlers: ((p: ReturnType<Engine['pick']>, ev: PointerEvent) => boolean)[] = [];
  chapters: Chapter[] = [];
  private zoneCache: ZoneSummary[] | null = null;
  private tl!: { canvas: HTMLCanvasElement; head: HTMLElement; marks: HTMLElement; scale: HTMLElement; wrap: HTMLElement };
  private readout!: Record<string, HTMLElement>;
  private narrative!: HTMLElement;
  private legend!: HTMLElement;
  private hud!: { el: HTMLElement; needle: SVGElement; loc: HTMLElement };
  private toastEl!: HTMLElement;
  private help!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private navSeg!: HTMLElement;
  private propSeg!: HTMLElement;
  private viewSeg!: HTMLElement;
  private wellSelect!: HTMLSelectElement;
  private chapterIdx = -1;
  private tourTimer: number | null = null;
  private lastHover = 0;
  onSectionPreset?: (b: { xMin: number; xMax: number; nMin: number; nMax: number; stripTo: number }) => void;
  onWallOpacity?: (v: number) => void;
  onColormap?: (n: ColormapName) => void;
  onTexturesChanged?: (on: boolean) => void;
  colormapName: ColormapName = 'resistivity';

  constructor(
    readonly field: FieldModel,
    readonly engine: Engine,
    container: HTMLElement,
  ) {
    this.root = container;
  }

  ready!: Promise<void>;

  init() {
    const e = this.engine;
    this.flags = new FeatureFlags(e.quality === 'low');
    this.toolSlot = h('div', { class: 'tool-slot' });
    this.hudSlot = h('div', { class: 'hud-slot' });
    this.left = new LeftPanel(this);
    this.logs = new LogTracks();
    this.inspector = new Inspector(this);
    this.interp = new InterpretationDrawer(this);
    this.prod = new ProductionDrawer(this);
    this.data = new DataManager(this);
    this.root.append(
      this.buildTopBar(),
      this.left.el,
      this.logs.el,
      this.buildTimeline(),
      this.buildNarrative(),
      this.buildLegend(),
      this.buildHud(),
      this.inspector.el,
      this.interp.el,
      this.prod.el,
      this.data.el,
      this.buildHelp(),
      (this.toastEl = h('div', { class: 'toast glass hidden' })),
    );

    this.logs.onPick = (md) => this.travelTo(md);
    this.logs.onHover = (md) => {
      if (e.wellbore) e.wellbore.uniforms.uHoverMd.value = md ?? -1e6;
    };
    this.logs.onScroll = (md) => {
      e.rig.playing = false;
      e.rig.targetMd = null;
      e.rig.setMd(md);
    };
    e.rig.onUserInput = () => this.stopTour();
    e.onFrame = (dt) => this.frame(dt);
    this.bindPicking();
    this.bindKeys();
    for (const m of createFeatureModules(this)) this.modules.set(m.id, m);
    this.featuresPanel = new FeaturesPanel(this.flags, this.modules, e.quality === 'low');
    document.body.append(this.featuresPanel.el);
    this.ready = this.loadWell(this.field.primary.id, false).then(() => {
      const w = this.engine.activeWell;
      const hug = w.zones.find((z) => z.formationId === 'hugin');
      this.engine.rig.setMd(hug ? hug.topMD + 25 : w.tdMD * 0.7);
      this.chapterIdx = -1;
      this.sectionAlongWell();
      // features start once the first well is on screen
      for (const m of this.modules.values())
        this.flags.watch(m.id, (on) => {
          try {
            if (on) m.enable();
            else m.disable();
          } catch (err) {
            console.error(`feature ${m.id}`, err);
            this.toast(`Feature “${m.id}” failed: ${(err as Error).message}`);
          }
        });
    });
    this.applyInsets();
    window.addEventListener('resize', () => this.applyInsets());
  }

  /** Keep the 3D subject centred in the free area between the side panels. */
  applyInsets() {
    const left = this.left.el.classList.contains('collapsed') ? 0 : this.left.el.offsetWidth + 12;
    const right = this.logs.el.classList.contains('collapsed') ? 0 : this.logs.el.offsetWidth + 12;
    this.engine.setInsets(left, right);
  }

  // ------------------------------------------------------------------ well management
  private async loadWell(id: string, fly = true) {
    const w = this.field.wells.find((x) => x.id === id);
    if (!w) return;
    if (!w.loaded) {
      this.toast(`Loading ${w.name} …`);
      await this.field.ensureLoaded(w);
    }
    this.engine.setActiveWell(w);
    this.zoneCache = null;
    this.logs.setWell(w);
    this.chapters = buildChapters(w, this.field);
    this.wellSelect.value = w.id;
    this.renderTimelineStatic();
    this.updateLegend();
    this.inspector.hide();
    if (this.interp.open) this.interp.render();
    if (this.prod.open) this.prod.render();
    this.notifyFeatures();
    if (fly) {
      this.engine.rig.setMd(0);
      this.overview();
    }
    this.toast(`${w.name} — ${w.trajectory.status === 'reconstructed' ? 'trajectory reconstructed from pick coordinates' : 'definitive survey'} · ${w.logs ? `${w.logs.curves.size} log curves` : 'no logs'}`);
  }

  selectWell(id: string) {
    void this.loadWell(id, true);
  }

  loadWellAsync(id: string, fly = false) {
    return this.loadWell(id, fly);
  }

  /** Called after uploads change the active well's data. */
  onDataChanged() {
    this.zoneCache = null;
    this.engine.refreshWellData();
    this.logs.setWell(this.engine.activeWell);
    this.chapters = buildChapters(this.engine.activeWell, this.field);
    this.renderTimelineStatic();
    this.refreshWellOptions();
    if (this.interp.open) this.interp.render();
    if (this.prod.open) this.prod.render();
    this.notifyFeatures();
  }

  /** Tell enabled features that the active well or its data changed. */
  notifyFeatures() {
    for (const m of this.modules.values())
      if (this.flags?.on(m.id))
        try {
          m.onWell?.();
        } catch (err) {
          console.error(`feature ${m.id}`, err);
        }
  }

  feature<T extends FeatureModule>(id: FeatureId): T | undefined {
    return this.modules.get(id) as T | undefined;
  }

  reinterpret() {
    const w = this.engine.activeWell;
    w.refresh(this.field.meta.datumElevation, this.field.meta.waterDepth);
    this.zoneCache = null;
    this.engine.refreshInterpretation();
    this.logs.invalidate();
    this.renderTimelineStatic();
    this.updateLegend();
    this.notifyFeatures();
  }

  zoneSummaries(): ZoneSummary[] {
    const w = this.engine.activeWell;
    if (!w.logs || !w.petro) return [];
    if (!this.zoneCache) this.zoneCache = summariseZones(w.logs, w.petro, w.zones.filter((z) => z.formationId !== 'air' && z.formationId !== 'sea'));
    return this.zoneCache;
  }

  // ------------------------------------------------------------------ navigation
  setNav(mode: NavMode) {
    const rig = this.engine.rig;
    rig.setMode(mode);
    this.navSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
    this.updateViewSeg();
    this.narrative.classList.toggle('hidden', mode !== 'guided');
    if (mode === 'explore') {
      this.stopTour();
      rig.playing = false;
      this.toast('Explore — drag to look · WASD / QE to fly · Shift to boost · wheel sets speed · double-click to focus');
    }
  }

  setGuidedView(v: GuidedView) {
    this.engine.rig.setGuidedView(v);
    this.updateViewSeg();
    if (v === 'tunnel') {
      if (this.engine.mode === 'hydrocarbon') this.setWallOpacity(0.55);
    } else this.setWallOpacity(1);
  }

  private setWallOpacity(v: number) {
    this.engine.wellbore?.setWallOpacity(v);
    this.onWallOpacity?.(v);
  }

  setProperty(m: PropertyMode) {
    this.engine.setMode(m);
    this.propSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    if (m === 'hydrocarbon' && this.engine.rig.guidedView === 'tunnel' && this.engine.rig.mode === 'guided') this.setWallOpacity(0.55);
    else if (m !== 'hydrocarbon') this.setWallOpacity(1);
    this.updateLegend();
  }

  /** Show or hide an optional property button (e.g. ROP from the Features panel). */
  setPropertyAvailable(m: PropertyMode, on: boolean) {
    const b = this.propSeg.querySelector(`button[data-v="${m}"]`) as HTMLElement | null;
    if (b) b.style.display = on ? '' : 'none';
  }

  setColormap(n: ColormapName) {
    this.colormapName = n;
    this.engine.setColormap(n);
    this.logs.colormap = n;
    this.logs.invalidate();
    this.onColormap?.(n);
    this.updateLegend();
  }

  setRadialScale(s: number) {
    this.engine.setRadialScale(s);
    this.updateLegend();
  }

  travelTo(md: number) {
    const rig = this.engine.rig;
    if (rig.mode === 'explore') {
      // fly the free camera to a viewpoint beside that depth
      const f = this.engine.wellbore!.frameAt(md);
      const d = 40 + f.radius * 16;
      const side = new THREE.Vector3().crossVectors(f.tan, new THREE.Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-3) side.set(1, 0, 0);
      side.normalize();
      const pos = f.pos.clone().addScaledVector(side, d).add(new THREE.Vector3(0, d * 0.35, 0));
      rig.setMd(md);
      rig.flyTo(pos, f.pos, 1.8);
    } else {
      if (Math.abs(md - rig.md) > 800) {
        // long jumps: cut through with a cinematic flight instead of crawling along the hole
        const f = this.engine.wellbore!.frameAt(md);
        const d = 40 + f.radius * 16;
        rig.flyTo(f.pos.clone().add(new THREE.Vector3(-d, d * 0.6, d)), f.pos, 2.0, () => {
          rig.setMd(md);
          rig.setGuidedView(rig.guidedView);
        });
        rig.setMd(md);
      } else rig.travelTo(md);
    }
    this.logs.setCursor(md);
  }

  overview() {
    const o = this.engine.overviewPose();
    const rig = this.engine.rig;
    if (rig.mode === 'guided') this.setNav('explore');
    rig.setExploreView('orbit');
    this.updateViewSeg();
    rig.flyTo(o.pos, o.target, 2.6);
  }

  preset(kind: 'default' | 'solid' | 'reservoir' | 'pay') {
    const geo = this.engine.geology;
    geo.isolate(null);
    const defaults: Record<string, number> = { nordland: 0.2, utsira: 0.22, hordaland: 0.14, ty: 0.18, ekofisk: 0.3, hod: 0.26, draupne: 0.55, heather: 0.5, hugin: 0.92, sleipner: 0.75, skagerrak: 0.8, smithbank: 0.85 };
    for (const id of geo.state.keys()) {
      if (kind === 'default') geo.setLayer(id, { visible: true, opacity: defaults[id] ?? 1 });
      else if (kind === 'solid') geo.setLayer(id, { visible: true, opacity: 1 });
      else if (kind === 'reservoir') geo.setLayer(id, { visible: ['draupne', 'heather', 'hugin', 'sleipner'].includes(id), opacity: id === 'hugin' ? 0.85 : 0.25 });
      else geo.setLayer(id, { visible: id === 'hugin', opacity: 0.35 });
    }
    const wb = this.engine.wellbore;
    if (wb) wb.uniforms.uPayOnly.value = kind === 'pay' ? 1 : 0;
    if (kind === 'pay') {
      this.setProperty('hydrocarbon');
      this.toast('Pay isolated — only intervals passing the Vsh / φ / Sw cut-offs are shown, inside a ghosted Hugin Fm.');
    }
    this.left.sync();
  }

  /** Section box trimmed to a corridor that hugs the active well, cut through its centre. */
  sectionAlongWell() {
    const t = this.engine.activeWell.trajectory;
    let x0 = Infinity, x1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (let i = 0; i < t.md.length; i++) {
      x0 = Math.min(x0, t.ew[i]);
      x1 = Math.max(x1, t.ew[i]);
      n0 = Math.min(n0, t.ns[i]);
      n1 = Math.max(n1, t.ns[i]);
    }
    const fb = this.engine.geology.fullBox;
    const midN = (n0 + n1) / 2;
    void x0;
    void x1;
    const b = { xMin: fb.xMin, xMax: fb.xMax, nMin: Math.max(fb.nMin, midN), nMax: fb.nMax, stripTo: 0 };
    this.onSectionPreset?.(b);
  }

  inspectFormation(id: string) {
    this.inspector.formation(id);
  }

  // ------------------------------------------------------------------ tour
  goChapter(i: number) {
    if (!this.chapters.length) return;
    const k = Math.max(0, Math.min(this.chapters.length - 1, i));
    const c = this.chapters[k];
    this.chapterIdx = k;
    if (this.engine.rig.mode !== 'guided') this.setNav('guided');
    if (c.mode) this.setProperty(c.mode);
    this.setGuidedView(c.view);
    this.travelTo(c.md);
    this.renderNarrative(c, k);
  }

  startTour() {
    this.stopTour();
    let i = 0;
    const step = () => {
      this.goChapter(i);
      i++;
      if (i < this.chapters.length) this.tourTimer = window.setTimeout(step, 9000);
      else this.tourTimer = null;
    };
    step();
    this.toast('Auto tour — any interaction pauses it');
    this.renderNarrative(this.chapters[0], 0);
  }

  stopTour() {
    if (this.tourTimer) {
      clearTimeout(this.tourTimer);
      this.tourTimer = null;
      this.renderNarrative(this.chapters[this.chapterIdx] ?? this.chapters[0], Math.max(0, this.chapterIdx));
    }
  }

  // ------------------------------------------------------------------ UI builders
  private buildTopBar(): HTMLElement {
    this.wellSelect = h('select', { title: 'Active wellbore' }) as HTMLSelectElement;
    this.wellSelect.onchange = () => this.selectWell(this.wellSelect.value);
    this.refreshWellOptions();
    const seg = (items: [string, string, string?][], on: string, cb: (v: string) => void, cls = 'seg') => {
      const s = h('div', { class: cls });
      for (const [v, label, dot] of items) {
        const b = h('button', { class: v === on ? 'on' : '', 'data-v': v, html: `${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${label}` });
        b.onclick = () => cb(v);
        s.append(b);
      }
      return s;
    };
    this.navSeg = seg(
      [
        ['guided', 'Guided'],
        ['explore', 'Explore'],
      ],
      'explore',
      (v) => this.setNav(v as NavMode),
    );
    this.propSeg = seg(
      [
        ['resistivity', 'Resistivity<small class="seg-sub">measured</small>', '#7fe3ff'],
        ['hydrocarbon', 'Hydrocarbons<small class="seg-sub">calculated</small>', '#ffb547'],
        ['lithology', 'Lithology', '#a28e67'],
        ['rop', 'ROP<small class="seg-sub">drilling</small>', '#f28a3c'],
      ],
      'resistivity',
      (v) => this.setProperty(v as PropertyMode),
    );
    this.setPropertyAvailable('rop', false);
    const btn = (icon: string, title: string, fn: () => void, label?: string) =>
      h('button', { class: `btn ${label ? 'lbl' : 'icon'} ghost`, title, html: `${icon}${label ? `<span class="hide-md">${label}</span>` : ''}`, onclick: fn });
    return h(
      'div',
      { class: 'topbar glass' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'brand-mark', html: LOGO }),
        h('div', {}, h('div', { class: 'brand-title' }, 'BoreWalk'), h('div', { class: 'brand-sub' }, `3D wellbore walkthrough · ${this.field.meta.name} open data`)),
      ),
      h('div', { class: 'divider' }),
      h('div', { class: 'well-select' }, this.wellSelect),
      h('div', { class: 'spacer' }),
      this.navSeg,
      this.propSeg,
      h('div', { class: 'spacer' }),
      btn(I.flask, 'Petrophysical interpretation', () => {
        this.prod.hide();
        this.interp.toggle();
      }, 'Interpretation'),
      btn(I.chart, 'Production history', () => {
        this.interp.hide();
        this.prod.toggle();
      }, 'Production'),
      btn(I.upload, 'Data manager & uploads', () => this.data.show(), 'Data'),
      btn(I.sliders, 'Switch features on and off', () => this.featuresPanel.toggle(), 'Features'),
      h('div', { class: 'divider' }),
      this.toolSlot,
      btn(I.panelLeft, 'Toggle scene panel', () => this.togglePanel('left')),
      btn(I.panelRight, 'Toggle log tracks', () => this.togglePanel('right')),
      btn(I.home, 'Field overview', () => this.overview()),
      btn(I.help, 'Controls & data notes', () => this.help.classList.remove('hidden')),
      btn(I.expand, 'Fullscreen', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())),
    );
  }

  refreshWellOptions() {
    this.wellSelect.innerHTML = '';
    for (const w of this.field.wells) {
      if (w.extra && !this.flags?.on('extraWells') && w !== this.engine.activeWell) continue;
      const tag = w.userAdded ? ' · uploaded' : w.lasFile ? '' : ' · survey + production';
      this.wellSelect.append(h('option', { value: w.id }, `${w.name}${tag}`));
    }
    if (this.engine.activeWell) this.wellSelect.value = this.engine.activeWell.id;
  }

  togglePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.left.el : this.logs.el;
    el.classList.toggle('collapsed');
    document.body.classList.toggle(`${side}-collapsed`, el.classList.contains('collapsed'));
    this.applyInsets();
  }

  private buildTimeline(): HTMLElement {
    this.playBtn = h('button', { class: 'play', title: 'Play along the well (Space)', html: I.play }) as HTMLButtonElement;
    this.playBtn.onclick = () => this.togglePlay();
    const speed = h('select', { class: 'select', title: 'Travel speed', style: 'width:78px' }) as HTMLSelectElement;
    for (const [v, l] of [
      ['15', '15 m/s'],
      ['45', '45 m/s'],
      ['120', '120 m/s'],
      ['300', '300 m/s'],
    ])
      speed.append(h('option', { value: v }, l));
    speed.value = '45';
    speed.onchange = () => (this.engine.rig.speed = +speed.value);
    this.viewSeg = h('div', { class: 'seg small' });
    const canvas = h('canvas');
    const marks = h('div', { class: 'track-marks' });
    const scale = h('div', { class: 'track-scale' });
    const head = h('div', { class: 'playhead' });
    const track = h('div', { class: 'track' }, canvas);
    const wrap = h('div', { class: 'track-wrap' }, marks, track, scale, head);
    this.tl = { canvas, head, marks, scale, wrap };
    const scrub = (ev: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const md = f * this.engine.activeWell.tdMD;
      this.engine.rig.playing = false;
      this.engine.rig.targetMd = null;
      this.engine.rig.setMd(md);
    };
    track.addEventListener('pointerdown', (ev) => {
      track.setPointerCapture(ev.pointerId);
      scrub(ev);
      const mv = (e2: PointerEvent) => scrub(e2);
      track.addEventListener('pointermove', mv);
      track.addEventListener('pointerup', () => track.removeEventListener('pointermove', mv), { once: true });
    });
    new ResizeObserver(() => this.renderTimelineStatic()).observe(track);
    const rd = (k: string, cls = '') => {
      const v = h('div', { class: `v ${cls}` });
      return [h('div', { class: 'k' }, k), v] as const;
    };
    const [kMd, vMd] = rd('MD', 'hero');
    const [kTvd, vTvd] = rd('TVDSS');
    const [kInc, vInc] = rd('Inc · Azi');
    const [kZ, vZ] = rd('Zone');
    this.readout = { md: vMd, tvd: vTvd, inc: vInc, zone: vZ };
    vZ.style.cssText = 'font-family:var(--sans);font-size:12px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    return h(
      'div',
      { class: 'timeline glass' },
      h('div', { class: 'tl-controls' }, this.playBtn, h('div', { style: 'display:flex;flex-direction:column;gap:5px' }, this.viewSeg, speed)),
      wrap,
      h('div', { class: 'depth-readout' }, kMd, kTvd, kInc, kZ, vMd, vTvd, vInc, vZ),
    );
  }

  private updateViewSeg() {
    const rig = this.engine.rig;
    const items: [string, string, string][] =
      rig.mode === 'guided'
        ? [
            ['tunnel', 'Inside', I.tunnel],
            ['chase', 'Chase', I.chase],
            ['orbit', 'Orbit', I.orbit],
          ]
        : [
            ['fly', 'Fly', I.fly],
            ['orbit', 'Orbit', I.orbit],
          ];
    const cur = rig.mode === 'guided' ? rig.guidedView : rig.exploreView;
    this.viewSeg.innerHTML = '';
    for (const [v, l, ic] of items) {
      const b = h('button', { class: v === cur ? 'on' : '', html: `${ic.replace('<svg', '<svg width="12" height="12"')}${l}` });
      b.onclick = () => {
        if (rig.mode === 'guided') this.setGuidedView(v as GuidedView);
        else {
          rig.setExploreView(v as 'fly' | 'orbit');
          this.updateViewSeg();
        }
      };
      this.viewSeg.append(b);
    }
  }

  togglePlay() {
    const rig = this.engine.rig;
    if (rig.mode !== 'guided') {
      this.setNav('guided');
      this.setGuidedView('chase');
    }
    if (rig.md >= rig.mdMax - 1) rig.setMd(0);
    rig.playing = !rig.playing;
    rig.targetMd = null;
  }

  private renderTimelineStatic() {
    const w = this.engine.activeWell;
    if (!w || !this.tl) return;
    const cv = this.tl.canvas;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const td = w.tdMD;
    const x = (md: number) => (md / td) * W;
    for (const z of w.zones) {
      g.fillStyle = z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a2029' : FORMATION_BY_ID.get(z.formationId)?.color ?? '#555';
      g.fillRect(x(z.topMD), 0, Math.max(1, x(z.baseMD) - x(z.topMD)), H);
    }
    // inclination profile
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    for (let px = 0; px < W; px++) {
      const md = (px / W) * td;
      const inc = w.trajectory.at(Math.min(md, w.trajectory.mdEnd)).inc;
      const y = H - 2 - (inc / 95) * (H - 4);
      if (px === 0) g.moveTo(px, y);
      else g.lineTo(px, y);
    }
    g.stroke();
    // pay
    if (w.petro && w.logs) {
      g.fillStyle = '#ffb547';
      const d = w.logs.depth;
      for (let i = 0; i < d.length; i += 3) if (w.petro.pay[i]) g.fillRect(x(d[i]), H - 3, Math.max(1, x(3 * 0.1)), 3);
    }
    // casing shoes
    g.fillStyle = '#dfe6ec';
    for (const c of w.casing) g.fillRect(x(c.shoeMD) - 0.5, 0, 1.5, H);
    // chapter marks
    this.tl.marks.innerHTML = '';
    let prevLeft = -10;
    this.chapters.forEach((c, i) => {
      const left = (c.md / td) * 100;
      const crowded = left - prevLeft < 1.4;
      prevLeft = left;
      const m = h('div', { class: 'track-mark', style: `left:${left}%;${crowded ? 'margin-left:9px' : ''}`, title: c.title }, String(i + 1));
      m.onclick = () => this.goChapter(i);
      this.tl.marks.append(m);
    });
    this.tl.scale.innerHTML = '';
    const step = td > 3000 ? 500 : 250;
    for (let md = 0; md <= td; md += step) this.tl.scale.append(h('span', { style: `left:${(md / td) * 100}%` }, md === 0 ? '0 m' : String(md)));
    this.tl.scale.append(h('span', { style: 'left:100%;transform:translateX(-100%);color:var(--text-3)' }, `TD ${td.toFixed(0)}`));
  }

  private buildNarrative(): HTMLElement {
    this.narrative = h('div', { class: 'narrative glass hidden' });
    return this.narrative;
  }

  private renderNarrative(c: Chapter | undefined, i: number) {
    if (!c) return;
    const n = this.narrative;
    n.innerHTML = '';
    const facts = h('div', { class: 'facts' });
    const pc: Record<string, string> = { measured: 'var(--measured)', calculated: 'var(--calculated)', interpreted: 'var(--interpreted)', reconstructed: 'var(--reconstructed)' };
    for (const f of c.facts) facts.append(h('div', { class: 'fact', title: f.prov }, h('div', { class: 'k' }, h('i', { style: `background:${pc[f.prov]}` }), f.k), h('div', { class: 'v' }, f.v)));
    const touring = this.tourTimer !== null;
    n.append(
      h('div', { class: 'step' }, `CHAPTER ${String(i + 1).padStart(2, '0')} / ${String(this.chapters.length).padStart(2, '0')}`),
      h('h2', {}, c.title),
      h('p', {}, c.text),
      facts,
      h(
        'div',
        { class: 'nav' },
        h('div', { style: 'display:flex;gap:4px' }, h('button', { class: 'btn icon', html: I.prev, title: 'Previous chapter', onclick: () => { this.stopTour(); this.goChapter(i - 1); } }), h('button', { class: 'btn icon', html: I.next, title: 'Next chapter', onclick: () => { this.stopTour(); this.goChapter(i + 1); } })),
        h('button', { class: `btn ${touring ? '' : 'primary'}`, html: touring ? `${I.pause} Pause tour` : `${I.play} Auto tour`, onclick: () => (touring ? this.stopTour() : this.startTour()) }),
      ),
    );
  }

  private buildLegend(): HTMLElement {
    this.legend = h('div', { class: 'legend glass' });
    return this.legend;
  }

  updateLegend() {
    const L = this.legend;
    const m = this.engine.mode;
    const w = this.engine.activeWell;
    L.innerHTML = '';
    if (m === 'resistivity') {
      const stops = Array.from({ length: 24 }, (_, i) => `${toCss(colormap(this.colormapName, i / 23))} ${((i / 23) * 100).toFixed(1)}%`).join(',');
      const ticks = h('div', { class: 'ticks' });
      const lmin = Math.log10(RES_RANGE.min);
      const lmax = Math.log10(RES_RANGE.max);
      for (const v of [0.2, 1, 10, 100, 1000]) ticks.append(h('span', { style: `left:${((Math.log10(v) - lmin) / (lmax - lmin)) * 100}%` }, String(v)));
      L.append(
        h('div', { class: 'row', style: 'min-height:0' }, h('b', { style: 'font-size:12px' }, 'Formation resistivity · Ω·m'), h('span', { html: chip('measured') })),
        h('div', { class: 'bar', style: `background:linear-gradient(90deg,${stops})` }),
        ticks,
        h('div', { class: 'note' }, `Log scale ${RES_RANGE.min}–${RES_RANGE.max} Ω·m. Borehole wall shows the shallow reading; the halo grades outward to the deep reading (RT). Radial scale ×${this.engine.radialScale}; investigation depth schematic.`),
      );
    } else if (m === 'rop') {
      const stops = Array.from({ length: 16 }, (_, i) => {
        const t = i / 15;
        const c = t < 0.33 ? mix([0.13, 0.04, 0.32], [0.72, 0.16, 0.42], t / 0.33) : t < 0.66 ? mix([0.72, 0.16, 0.42], [0.98, 0.55, 0.2], (t - 0.33) / 0.33) : mix([0.98, 0.55, 0.2], [0.99, 0.95, 0.62], (t - 0.66) / 0.34);
        return `${toCss(c)} ${(t * 100).toFixed(1)}%`;
      }).join(',');
      const ticks = h('div', { class: 'ticks' });
      for (const v of [1, 3, 10, 30, 100]) ticks.append(h('span', { style: `left:${(Math.log10(v) / Math.log10(ROP_RANGE.max)) * 100}%` }, String(v)));
      const zones = w.logs ? ropByZone(w.logs, w.zones) : [];
      const byF = new Map<string, { name: string; h: number; f: number }>();
      for (const z of zones) {
        const a = byF.get(z.formationId) ?? { name: z.name, h: 0, f: 0 };
        a.h += z.hours;
        a.f += z.footage;
        byF.set(z.formationId, a);
      }
      const tbl = h('div', { class: 'rop-table' });
      let tot = 0;
      for (const [id, a] of byF) {
        tot += a.h;
        tbl.append(h('div', {}, h('i', { style: `background:${FORMATION_BY_ID.get(id)?.color ?? '#666'}` }), h('span', {}, a.name.replace(/ \(.*\)| –.*/, '')), h('b', {}, `${(a.f / a.h).toFixed(0)} m/h`), h('small', {}, `${a.h.toFixed(0)} h`)));
      }
      L.append(
        h('div', { class: 'row', style: 'min-height:0' }, h('b', { style: 'font-size:12px' }, 'Rate of penetration · m/h'), h('span', { html: chip('measured') })),
        h('div', { class: 'bar', style: `background:linear-gradient(90deg,${stops})` }),
        ticks,
        zones.length ? tbl : h('div', { class: 'note' }, 'No ROP curve in this well’s logs.'),
        h('div', { class: 'note' }, zones.length ? `On-bottom drilling time Σ ΔMD / ROP ≈ ${tot.toFixed(0)} h for the logged footage (connections, trips and casing runs excluded). Averages are footage-weighted.` : ''),
      );
    } else if (m === 'hydrocarbon') {
      const p = w.params;
      L.append(
        h('div', { class: 'row', style: 'min-height:0' }, h('b', { style: 'font-size:12px' }, 'Interpreted pore fluids'), h('span', { html: chip('calculated') })),
        h(
          'div',
          { class: 'swatches' },
          h('div', {}, h('i', { style: 'background:linear-gradient(90deg,#8a520e,#e0932a)' }), 'Oil-filled pore space (So)'),
          h('div', {}, h('i', { style: 'background:linear-gradient(90deg,#1b4d7a,#3f86c4)' }), 'Water-filled pore space (Sw)'),
          h('div', {}, h('i', { style: 'background:#5b4a35' }), 'Oil-stained borehole wall'),
          h('div', {}, h('i', { style: 'background:#ffc35a;height:3px' }), 'Net pay boundaries'),
        ),
        h(
          'div',
          { class: 'note' },
          `${p.satModel === 'archie' ? 'Archie' : 'Simandoux'} Sw from measured RT & RHOB · a ${p.a}, m ${p.m}, n ${p.n}, Rw ${p.rw} Ω·m @ ${p.rwTemp} °C. Pore size tracks φ; drawn only where density and resistivity logs exist.`,
        ),
      );
    } else {
      const sw = h('div', { class: 'swatches' });
      const seen = new Set<string>();
      for (const z of w.zones) {
        const f = FORMATION_BY_ID.get(z.formationId);
        if (!f || seen.has(f.id)) continue;
        seen.add(f.id);
        sw.append(h('div', {}, h('i', { style: `background:${f.color}` }), f.name));
      }
      L.append(h('div', { class: 'row', style: 'min-height:0' }, h('b', { style: 'font-size:12px' }, 'Formations along the well'), h('span', { html: chip('interpreted') })), sw);
    }
  }

  private buildHud(): HTMLElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const wrap = h('div', {
      class: 'compass',
      html: `<svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="19" fill="rgba(0,0,0,.25)" stroke="rgba(255,255,255,.12)"/><g id="needle"><path d="M21 5 L24.5 21 L21 19 L17.5 21 Z" fill="#ff8a65"/><path d="M21 37 L24.5 21 L21 23 L17.5 21 Z" fill="rgba(255,255,255,.35)"/><text x="21" y="4.2" text-anchor="middle" font-size="6" fill="#e7ecf1" font-family="Inter Variable" font-weight="600">N</text></g></svg>`,
    });
    const needle = wrap.querySelector('#needle') as SVGElement;
    void svgNs;
    const loc = h('div', { class: 'loc' });
    const el = h('div', { class: 'hud glass' }, h('div', { class: 'hud-row' }, wrap, loc), this.hudSlot);
    this.hud = { el, needle, loc };
    return el;
  }

  private buildHelp(): HTMLElement {
    const k = (s: string) => `<span class="kbd">${s}</span>`;
    const r = (a: string, b: string) => h('div', { class: 'row', html: `<span>${a}</span><span>${b}</span>` });
    const m = this.field.meta;
    this.help = h(
      'div',
      { class: 'modal-back hidden', onclick: (e: Event) => e.target === this.help && this.help.classList.add('hidden') },
      h(
        'div',
        { class: 'modal glass' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Controls & data notes'), h('button', { class: 'btn icon ghost', html: I.close, onclick: () => this.help.classList.add('hidden') })),
        h(
          'div',
          { class: 'panel-body' },
          h(
            'div',
            { class: 'help-grid' },
            h('div', {}, h('h5', { class: 'micro' }, 'Guided walkthrough'), r('Play / pause', k('Space')), r('Step along hole', `${k('Wheel')} ${k('[')} ${k(']')}`), r('Next / previous chapter', `${k('N')} ${k('P')}`), r('Inside · Chase · Orbit', `${k('1')} ${k('2')} ${k('3')}`), r('Toggle property view', k('V'))),
            h('div', {}, h('h5', { class: 'micro' }, 'Free explore'), r('Look (Fly)', 'drag'), r('Move', `${k('W')}${k('A')}${k('S')}${k('D')}`), r('Up / down', `${k('E')} ${k('Q')}`), r('Boost', k('Shift')), r('Focus point', 'double-click'), r('Inspect', 'click anything')),
          ),
          h(
            'div',
            { class: 'section', style: 'font-size:12px;color:var(--text-2);line-height:1.6' },
            h('div', { class: 'micro', style: 'margin-bottom:8px' }, 'Provenance legend'),
            h('div', { html: `${chip('measured')} acquired by logging / survey tools or gauges, as delivered by ${m.operator}.` }),
            h('div', { html: `${chip('interpreted')} operator interpretation: formation picks, Equinor CPI.` }),
            h('div', { html: `${chip('calculated')} computed live in this app from measured inputs and editable parameters.` }),
            h('div', { html: `${chip('reconstructed')} geometry derived from other data (trajectories through pick coordinates, casing from bit size).` }),
            h('div', { html: `${chip('schematic')} illustrative only (natural fractures, cement placement, platform model).` }),
            h('div', { style: 'margin-top:10px' }, `Coordinates: ${m.crs}, local origin E ${m.originE} / N ${m.originN}. Depths MD / TVD from ${m.datum} (+${m.datumElevation} m MSL); TVDSS below MSL. Near-well geometry is radially exaggerated for legibility; along-hole and vertical geometry are true scale.`),
            h('div', { style: 'margin-top:8px' }, m.licence),
          ),
        ),
      ),
    );
    return this.help;
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    clearTimeout((this.toastEl as unknown as { _t: number })._t);
    (this.toastEl as unknown as { _t: number })._t = window.setTimeout(() => this.toastEl.classList.add('hidden'), 4200);
  }

  // ------------------------------------------------------------------ interaction
  private bindPicking() {
    const cv = this.engine.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    cv.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    cv.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 5 && performance.now() - down.t < 500) {
        const p = this.engine.pick(e.clientX, e.clientY);
        if (this.clickHandlers.some((fn) => fn(p, e))) {
          down = null;
          return;
        }
        if (p) {
          this.inspector.show(p);
          if (p.md !== undefined) this.logs.setCursor(p.md);
        } else this.inspector.hide();
      }
      down = null;
    });
    cv.addEventListener('dblclick', (e) => {
      const p = this.engine.pick(e.clientX, e.clientY);
      if (!p) return;
      const rig = this.engine.rig;
      if (p.md !== undefined && rig.mode === 'guided') {
        rig.travelTo(p.md);
        return;
      }
      if (rig.mode === 'guided') this.setNav('explore');
      rig.setExploreView('orbit');
      this.updateViewSeg();
      const dir = this.engine.camera.position.clone().sub(p.point).normalize();
      const dist = Math.min(this.engine.camera.position.distanceTo(p.point) * 0.45, 900);
      rig.flyTo(p.point.clone().addScaledVector(dir, Math.max(25, dist)), p.point, 1.6);
    });
    cv.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - this.lastHover < 120 || e.buttons) return;
      this.lastHover = now;
      const p = this.engine.pick(e.clientX, e.clientY, true);
      const wb = this.engine.wellbore;
      if (wb) wb.uniforms.uHoverMd.value = p?.md ?? -1e6;
      this.logs.hoverMd = p?.md ?? null;
      this.logs.invalidate();
      cv.style.cursor = p ? 'pointer' : '';
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      const rig = this.engine.rig;
      if (e.code === 'Space' && rig.mode === 'guided') {
        e.preventDefault();
        this.togglePlay();
      } else if (rig.mode === 'guided' && e.key === '1') this.setGuidedView('tunnel');
      else if (rig.mode === 'guided' && e.key === '2') this.setGuidedView('chase');
      else if (rig.mode === 'guided' && e.key === '3') this.setGuidedView('orbit');
      else if (e.key === 'n' || e.key === 'N') this.goChapter(this.chapterIdx + 1);
      else if (e.key === 'p' || e.key === 'P') this.goChapter(this.chapterIdx - 1);
      else if (e.key === ']') rig.setMd(rig.md + 10);
      else if (e.key === '[') rig.setMd(rig.md - 10);
      else if (e.key === 'v' || e.key === 'V') {
        const order: PropertyMode[] = ['resistivity', 'hydrocarbon', 'lithology', ...(this.flags.on('rop') ? (['rop'] as PropertyMode[]) : [])];
        this.setProperty(order[(order.indexOf(this.engine.mode) + 1) % order.length]);
      } else if (e.key === 'Escape') {
        this.featuresPanel.hide();
        this.interp.hide();
        this.prod.hide();
        this.data.hide();
        this.help.classList.add('hidden');
      }
    });
  }

  // ------------------------------------------------------------------ per-frame UI sync
  private lastMdShown = -1;
  private playIconState: boolean | null = null;
  private frame(dt = 0.016) {
    for (const m of this.modules.values())
      if (m.frame && this.flags.on(m.id))
        try {
          m.frame(dt);
        } catch (err) {
          console.error(`feature ${m.id}`, err);
        }
    const e = this.engine;
    const rig = e.rig;
    const w = e.activeWell;
    const md = rig.md;
    // swap the icon only when the state changes: rewriting it every frame replaces the element
    // under the cursor between mousedown and mouseup, and the browser then drops the click
    if (this.playIconState !== rig.playing) {
      this.playIconState = rig.playing;
      this.playBtn.innerHTML = rig.playing ? I.pause : I.play;
    }
    if (Math.abs(md - this.lastMdShown) > 0.01) {
      this.lastMdShown = md;
      const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
      this.readout.md.innerHTML = `${fmt.n(md, 1)}<small>m</small>`;
      this.readout.tvd.innerHTML = `${fmt.n(t.tvd - this.field.meta.datumElevation, 1)}<small>m</small>`;
      this.readout.inc.innerHTML = `${fmt.n(t.inc, 1)}°<small>${fmt.n(t.azi, 0)}°</small>`;
      const z = w.zoneAt(md);
      this.readout.zone.textContent = `${z?.name ?? '—'} · ${Trajectory.sectionType(t.inc)}`;
      this.tl.head.style.left = `${(md / w.tdMD) * this.tl.wrap.clientWidth}px`;
      this.logs.setCursor(md);
      // narrative follows position in guided mode
      if (rig.mode === 'guided' && this.tourTimer === null) {
        let k = -1;
        for (let i = 0; i < this.chapters.length; i++) if (this.chapters[i].md <= md + 3) k = i;
        if (k !== this.chapterIdx && k >= 0) {
          this.chapterIdx = k;
          this.renderNarrative(this.chapters[k], k);
        }
      }
    }
    // HUD
    const dir = new THREE.Vector3();
    e.camera.getWorldDirection(dir);
    const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
    this.hud.needle.setAttribute('transform', `rotate(${-heading} 21 21)`);
    const cam = e.camera.position;
    const where =
      e.cameraFormation === 'sea'
        ? 'In the water column'
        : e.cameraFormation
          ? `Inside ${FORMATION_BY_ID.get(e.cameraFormation)?.name ?? e.cameraFormation}`
          : cam.y > 0
            ? 'Above sea level'
            : 'Outside model';
    const nav = rig.mode === 'guided' ? `Guided · ${rig.guidedView === 'tunnel' ? 'inside the hole' : rig.guidedView}` : `Explore · ${rig.exploreView}`;
    this.hud.loc.innerHTML = `<b>${where}</b><span>${nav} · cam ${cam.y >= 0 ? '+' : ''}${fmt.n(cam.y, 0)} m · hdg ${fmt.n((heading + 360) % 360, 0)}°</span>`;
  }
}
