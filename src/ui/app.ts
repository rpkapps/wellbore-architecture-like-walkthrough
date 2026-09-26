import type { ReactNode } from 'react';
import { toast } from 'sonner';
import * as THREE from 'three';
import type { FieldModel } from '../data/dataset';
import { summariseZones, type ZoneSummary } from '../data/petro';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { ColormapName } from '../data/colormap';
import { Trajectory } from '../data/trajectory';
import type { Engine, PickResult } from '../scene/engine';
import type { GuidedView, NavMode } from '../scene/cameraRig';
import type { PropertyMode } from '../scene/wellbore';
import type { SectionBox } from '../scene/geology';
import { LogTracks } from './logTracks';
import { onAnyChange, Rev, SCENE, Signal } from './signal';
import { DOCK_PANELS, Workspace, type WorkspaceContext } from './workspace/layout';
import { openWindows } from './toolWindow';
import { prefs, themeRev } from './prefs';
import { ActionRegistry } from '../actions/registry';
import { withTransition } from './transition';
import { buildChapters, type Chapter } from './tour';
import { FeatureFlags, type FeatureId, type FeatureModule } from '../features/registry';
import { createFeatureModules } from '../features';
import { inspect, type InspectorView } from './inspect';
import { sameSelection, type Selection } from './selection';
import type { Marking } from './marking';
import { DataImporter } from './dataImport';
import { DataHub } from '../connect/hub';
import type { ConnectRequest } from './shell/ConnectDialog';

/** Position read-out along the active well (timeline, log cursor). */
export interface Pose {
  md: number;
  tvdss: number;
  inc: number;
  azi: number;
  zone: string;
  section: string;
}

/** Compass and camera read-out over the 3D view. */
export interface Hud {
  heading: number;
  where: string;
  nav: string;
  camY: number;
}

/** A command a feature adds to the viewport toolbar (measure, snapshot, saved views). */
export interface ToolEntry {
  id: string;
  label: string;
  icon: ReactNode;
  /** a plain action; omit it when the tool opens a menu */
  onAction?: () => void;
  /** pressed state of a toggle tool */
  isActive?: () => boolean;
  /** a tool with choices opens a menu of these */
  menu?: { id: string; label: string; onAction: () => void; isSelected?: () => boolean }[];
  /** re-render the tool when this changes */
  watch?: Signal<unknown>;
}

/** A read-out a feature adds to the position details (geosteering status, measuring hint). */
export interface HudEntry {
  id: string;
  render: () => ReactNode;
  /** a few words for the timeline's position read-out, beside the depth (geosteering: IN ZONE) */
  chip?: () => ReactNode;
  /** an instruction for what the next click does (measuring): shown over the 3D view, above its toolbar, not tucked into the details */
  prompt?: boolean;
}

/** Near-well display options that belong to the wellbore, reapplied whenever it is rebuilt. */
export interface WellboreDisplay {
  casingOpacity: number;
  wallOpacity: number;
  shellOpacity: number;
  casing: boolean;
  fractures: boolean;
  markers: boolean;
}

export interface SceneDisplay {
  labels: boolean;
  otherWells: boolean;
  sea: boolean;
  contours: boolean;
  postFx: boolean;
}

export type LayerPreset = 'default' | 'solid' | 'reservoir' | 'pay';

/**
 * A number that changes every frame (the camera heading). Unlike a Signal it
 * renders nothing and asks for no redraw: subscribers write it straight to
 * the DOM (the compass needle turns with the camera without a React render).
 */
export class FrameValue {
  private listeners: ((v: number) => void)[] = [];
  value = 0;

  set(v: number) {
    if (v === this.value) return;
    this.value = v;
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](v);
  }

  subscribe(l: (v: number) => void): () => void {
    this.listeners = [...this.listeners, l];
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }
}

/**
 * The application controller. It owns the engine, the feature modules and the
 * state the React chrome renders; the chrome subscribes to its signals and
 * calls its methods. Nothing here builds DOM.
 */
export class App {
  engine!: Engine;
  flags!: FeatureFlags;
  readonly logs = new LogTracks();
  modules = new Map<FeatureId, FeatureModule>();
  chapters: Chapter[] = [];
  colormapName: ColormapName = 'resistivity';
  /** click interceptors (e.g. the measure tool); returning true consumes the click */
  clickHandlers: ((p: PickResult | null, ev: PointerEvent) => boolean)[] = [];

  // ------------------------------------------------------------------ state the chrome renders
  /** the engine exists and the first well is loaded */
  readonly ready = new Signal(false);
  /** active well, its data or its interpretation changed */
  readonly wellRev = new Rev(SCENE);
  /** bumped while an interpretation parameter is being dragged (the live results only) */
  readonly interpRev = new Rev(SCENE);
  /** geology layers, section box or scene display options changed */
  readonly sceneRev = new Rev(SCENE);
  /** navigation mode, camera view, property mode or colour map changed */
  readonly viewRev = new Rev(SCENE);
  /** a colour the tool-window canvases draw with changed (colour map, formation colour, uncertainty band): they redraw */
  readonly paintRev = new Rev();
  /** the same position, updated at most ~15 times a second: for text read-outs that need not follow every frame */
  readonly poseText = new Signal<Pose>({ md: 0, tvdss: 0, inc: 0, azi: 0, zone: '—', section: '' });
  private poseTextAt = 0;
  readonly pose = new Signal<Pose>({ md: 0, tvdss: 0, inc: 0, azi: 0, zone: '—', section: '' });
  /** camera read-out text, updated at most ~15 times a second (and at once when the place or the mode changes) */
  readonly hud = new Signal<Hud>({ heading: 0, where: '', nav: '', camY: 0 });
  /** the camera heading in degrees, every frame it turns: for the compass needle */
  readonly heading = new FrameValue();
  readonly playing = new Signal(false);
  readonly chapter = new Signal<{ index: number; touring: boolean } | null>(null);
  /**
   * The chapter card shows over the timeline (guided mode only): going to a
   * chapter (a marker, N / P, the tour) or playing opens it; its close
   * button, pausing and Explore put it away, leaving the numbered markers.
   */
  readonly chapterCard = new Signal(false);
  /**
   * The selected object (a click in the 3D view or the Scene tree, an
   * action): Properties, the details card and the right-click menus follow it.
   * Set it with `select`.
   */
  readonly selection = new Signal<Selection | null>(null);
  /** Properties stays on this object (its pin) whatever is selected meanwhile */
  readonly pinned = new Signal<Selection | null>(null);
  /**
   * Depth intervals of a well a view has marked (the crossplot's brushed
   * samples): the timeline shows them as ticks to travel to. The view that
   * set it clears it.
   */
  readonly marking = new Signal<Marking | null>(null);
  /** a right-click menu of the selection's actions, open at this point of the window */
  readonly contextMenu = new Signal<{ x: number; y: number; selection: Selection } | null>(null);
  /**
   * The details of the selection, derived from it (and rebuilt when the well
   * or its interpretation changes): the floating details card shows these.
   * Read-only for the chrome; change the selection instead.
   */
  readonly inspector = new Signal<InspectorView | null>(null);
  readonly tools = new Signal<ToolEntry[]>([]);
  readonly huds = new Signal<HudEntry[]>([]);
  /** the panels over the 3D view: docked columns, groups of tabs, floating windows */
  readonly workspace = new Workspace();
  readonly productionOpen = new Signal(false);
  readonly dataOpen = new Signal(false);
  readonly helpOpen = new Signal(false);
  /** the Well logs track editor: a popover on the logs header, so the tracks redraw beside it as they change */
  readonly tracksOpen = new Signal(false);
  readonly personaliseOpen = new Signal(false);
  readonly paletteOpen = new Signal(false);
  /** every operation as a typed action: the command palette runs these, and an assistant can (actions/tanstack.ts) */
  readonly actions = new ActionRegistry<App>(this);
  /** name of the well whose files are loading (panels show placeholders) */
  readonly loadingWell = new Signal<string | null>(null);
  /**
   * Full-screen presentation (saved views): while set, the chrome is hidden,
   * the 3D view fills the window and this caption sits over it.
   */
  readonly presentation = new Signal<ReactNode>(null);
  /** property modes features offer (ROP, when the well has the log) */
  readonly optionalModes = new Signal<ReadonlySet<PropertyMode>>(new Set());

  readonly wellbore: WellboreDisplay = { casingOpacity: 0.42, wallOpacity: 1, shellOpacity: 1, casing: true, fractures: true, markers: true };
  readonly display: SceneDisplay = { labels: true, otherWells: true, sea: true, contours: true, postFx: true };

  private zoneCache: ZoneSummary[] | null = null;
  private tourTimer: number | null = null;
  private chapterIdx = -1;
  private resolveReady!: () => void;
  /** resolves once the first well is on screen */
  readonly whenReady = new Promise<void>((r) => (this.resolveReady = r));
  /** The page loader's progress line: each step of the start-up after the data has loaded (set by the loader). */
  onBootStep?: (msg: string, f: number) => void;

  readonly importer: DataImporter;
  /** live and streamed data: the connectors (src/connect) */
  readonly hub: DataHub;
  /** the connect dialog: open with a draft, or to edit a connection */
  readonly connectRequest = new Signal<ConnectRequest | null>(null);

  constructor(readonly field: FieldModel) {
    this.importer = new DataImporter(this);
    this.hub = new DataHub(this);
    // a layout change made from a panel's menu or buttons is announced, with Undo (one toast at a time)
    this.workspace.changes.subscribe(() => {
      const c = this.workspace.changes.value;
      // (it stays a little longer than a plain message: time to reach Undo)
      if (c) this.toast(`${c.label}.`, 'info', { id: 'layout-change', duration: 8000, action: { label: 'Undo', onClick: () => void this.actions.run('panels.undo_layout', { change: c.n }) } });
    });
    // the details follow the selection, and the data they read out
    const details = () => this.inspector.set(this.selection.value && this.engine ? this.inspectorFor(this.selection.value) : null);
    this.selection.subscribe(details);
    this.wellRev.subscribe(() => this.selection.value && details());
    // formation colours the user picked, before the geology is built from them
    try {
      const saved = JSON.parse(localStorage.getItem('bw.formationColors') ?? '{}') as Record<string, string>;
      for (const [id, hex] of Object.entries(saved)) {
        const f = FORMATION_BY_ID.get(id);
        if (f && /^#[0-9a-f]{6}$/i.test(hex)) f.color = hex;
      }
    } catch {
      /* storage blocked or malformed */
    }
  }

  /** Create the 3D engine in the work area and load the first well. */
  mount(engine: Engine) {
    this.engine = engine;
    const e = engine;
    this.flags = new FeatureFlags(e.quality === 'low');
    this.display.postFx = e.quality !== 'low';
    // the 3D view draws on demand: only signals marked SCENE redraw it (chrome state such as
    // drags, layout and read-outs never does); the engine's setters request their own frames
    onAnyChange.hook = () => e.requestRender(100);
    // personal settings that reach into the scene
    const personal = () => {
      e.rig.instantMoves = prefs.value.reduceMotion;
      // the labels are placed again (panel opacity or blur scrubs leave the view alone)
      if (e.labelDensity !== prefs.value.labelDensity) e.requestRender();
      e.labelDensity = prefs.value.labelDensity;
    };
    personal();
    prefs.subscribe(personal);
    // a new theme, accent or density: every canvas redraws with its colours and text sizes
    themeRev.subscribe(() => {
      this.logs.invalidate();
      this.paintRev.bump();
      this.notifyFeatures();
      this.viewRev.bump();
      this.sceneRev.bump();
      this.wellRev.bump();
    });
    this.logs.onPick = (md) => this.travelTo(md);
    // the engine redraws when the hover depth changes (a pointer crossing the tracks costs nothing)
    this.logs.onHover = (md) => {
      if (e.wellbore) e.wellbore.uniforms.uHoverMd.value = md ?? -1e6;
    };
    this.logs.onScroll = (md) => {
      this.stopFollowing();
      e.rig.playing = false;
      e.rig.targetMd = null;
      e.rig.setMd(md);
    };
    e.rig.onUserInput = () => {
      this.stopTour();
      // orbiting the view in Explore keeps following (the camera moves with the bit); travelling along the well stops it
      if (e.rig.mode !== 'explore') this.stopFollowing();
    };
    // the Follow the bit toggle is the one switch: on goes to the bit now, off stops where the view is
    this.hub.followBit.subscribe(() => (this.hub.followBit.value ? this.goToBit() : this.letGoOfBit()));
    e.onFrame = (dt) => this.frame(dt);
    this.bindPicking();
    this.bindKeys();
    for (const m of createFeatureModules(this)) this.modules.set(m.id, m);
    this.frameModules = [...this.modules.values()].filter((m) => m.frame);
    void this.boot();
  }

  /**
   * Start-up after the data has loaded, in steps the loader reports, each
   * given a frame to paint before its work runs: the first well's geometry,
   * the log tracks, the overlays, then the shaders, compiled before the first
   * frame so the loader does not leave onto a stall.
   */
  private async boot() {
    const step = async (msg: string, f: number) => {
      this.onBootStep?.(msg, f);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    };
    // (the loader sets its hook once the app is constructed)
    await Promise.resolve();
    const e = this.engine;
    await step(`Building the ${this.field.primary.name} wellbore`, 0.88);
    await this.loadWell(this.field.primary.id, false);
    const w = e.activeWell;
    const hug = w.zones.find((z) => z.formationId === 'hugin');
    e.rig.setMd(hug ? hug.topMD + 25 : w.tdMD * 0.7);
    this.chapterIdx = -1;
    this.sectionAlongWell();
    await step('Starting the overlays', 0.92);
    // features start once the first well is on screen
    for (const m of this.modules.values())
      this.flags.watch(m.id, (on) => {
        try {
          if (on) m.enable();
          else m.disable();
          e.requestRender();
        } catch (err) {
          console.error(`feature ${m.id}`, err);
          this.toast(`Feature “${m.id}” failed: ${(err as Error).message}`, 'error');
        }
      });
    if (!prefs.value.labels) this.setDisplay({ labels: false });
    await step('Preparing the shaders', 0.95);
    try {
      await e.renderer.compileAsync(e.scene, e.camera);
    } catch {
      /* compiled on the first frame instead */
    }
    this.ready.set(true);
    this.resolveReady();
  }

  /**
   * Show a message. `opts.id` replaces an earlier toast with the same id
   * instead of stacking another; `opts.action` adds a button (Undo).
   */
  /** Toasts made while the page loader shows wait for it to go (`releaseToasts`); null once released. */
  private heldToasts: (() => void)[] | null = [];

  /** The loader has gone: show the toasts it held back, and every later one at once. */
  releaseToasts() {
    const held = this.heldToasts ?? [];
    this.heldToasts = null;
    for (const t of held) t();
  }

  toast(msg: string, kind: 'info' | 'error' = 'info', opts?: { id?: string; duration?: number; action?: { label: string; onClick: () => void } }) {
    if (this.heldToasts) return void this.heldToasts.push(() => this.toast(msg, kind, opts));
    if (kind === 'error') toast.error(msg, opts);
    else toast(msg, opts);
  }

  // ------------------------------------------------------------------ viewport toolbar and HUD slots
  addTool(t: ToolEntry) {
    this.tools.update((l) => [...l.filter((x) => x.id !== t.id), t]);
  }

  removeTool(id: string) {
    this.tools.update((l) => l.filter((x) => x.id !== id));
  }

  addHud(t: HudEntry) {
    this.huds.update((l) => [...l.filter((x) => x.id !== t.id), t]);
  }

  removeHud(id: string) {
    this.huds.update((l) => l.filter((x) => x.id !== id));
  }

  // ------------------------------------------------------------------ well management
  private async loadWell(id: string, fly = true) {
    const w = this.field.wells.find((x) => x.id === id);
    if (!w) return;
    if (!w.loaded) {
      this.loadingWell.set(w.name);
      try {
        await this.field.ensureLoaded(w);
      } finally {
        this.loadingWell.set(null);
      }
    }
    this.engine.setActiveWell(w);
    this.applyWellboreDisplay();
    this.zoneCache = null;
    this.logs.setWell(w);
    this.chapters = buildChapters(w, this.field);
    // a point, a pick or an interval of the previous well no longer exists
    if (this.selection.value?.well && this.selection.value.well !== w.id) this.select(null);
    if (this.pinned.value?.well && this.pinned.value.well !== w.id) this.pinned.set(null);
    this.notifyFeatures();
    this.wellRev.bump();
    if (fly) {
      this.engine.rig.setMd(0);
      this.overview();
    }
    // (the first well opens behind the loader: nothing to announce)
    if (this.ready.value)
      this.toast(
        `${w.name} — ${w.trajectory.status === 'reconstructed' ? 'trajectory reconstructed from pick coordinates' : 'definitive survey'} · ${w.logs ? `${w.logs.curves.size} log curves` : 'no logs'}`,
      );
  }

  selectWell(id: string) {
    void this.loadWell(id, true);
  }

  loadWellAsync(id: string, fly = false) {
    return this.loadWell(id, fly);
  }

  /** Wells offered in the selector: the extra Volve wells only once their feature is on. */
  selectableWells() {
    return this.field.wells.filter((w) => !w.extra || this.flags?.on('extraWells') || w === this.engine?.activeWell);
  }

  /** Called after uploads change the active well's data. */
  onDataChanged() {
    this.zoneCache = null;
    this.engine.refreshWellData();
    this.applyWellboreDisplay();
    this.logs.setWell(this.engine.activeWell);
    this.chapters = buildChapters(this.engine.activeWell, this.field);
    this.notifyFeatures();
    this.wellRev.bump();
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

  /**
   * The cheap part of a re-interpretation, run while a parameter is dragged:
   * the curves, the 3D colouring, the log tracks and the headline numbers.
   * `reinterpret` (features, every panel) follows when the drag settles.
   */
  reinterpretLive() {
    const w = this.engine.activeWell;
    w.refresh(this.field.meta.datumElevation, this.field.meta.waterDepth);
    this.zoneCache = null;
    this.engine.refreshInterpretation();
    this.logs.invalidate();
    this.interpRev.bump();
  }

  /**
   * Streamed data changed the active well. The cheap path re-runs the
   * interpretation and re-uploads the wellbore's data textures; `rebuild`
   * rebuilds its geometry too (the well got deeper or its path changed).
   * The hub decides which, and how often, from what each costs.
   */
  liveRefresh(o: { rebuild: boolean; curves: boolean; features: boolean; fromMd?: number; panels?: boolean }) {
    const w = this.engine.activeWell;
    w.refresh(this.field.meta.datumElevation, this.field.meta.waterDepth);
    this.zoneCache = null;
    if (o.rebuild) {
      this.engine.refreshWellData();
      this.applyWellboreDisplay();
      this.chapters = buildChapters(w, this.field);
    } else this.engine.refreshFrom(o.fromMd ?? 0);
    this.engine.wellbore?.setClip(w.tdMD);
    this.engine.rig.mdMax = w.tdMD;
    if (o.curves) this.logs.setWell(w);
    else this.logs.invalidate();
    if (o.features) this.notifyFeatures();
    // the panels' numbers follow at their own, slower pace
    if (o.panels !== false) this.interpRev.bump();
    this.engine.requestRender(300);
  }

  /** the well the Live charts panel shows (null: the active well, or the first with readings) */
  readonly liveWell = new Signal<string | null>(null);

  /** Show the live charts (of a well). */
  openLive(wellId?: string) {
    if (wellId) this.liveWell.set(wellId);
    withTransition(() => this.workspace.open('live'));
  }

  /** Show the live data panel (and, with an id, that connection in it). */
  openSources(id?: string) {
    withTransition(() => this.workspace.open('sources'));
    if (id) this.hub.focus.set(id);
  }

  /**
   * Following the bit of a well being drilled. The Follow the bit toggle
   * (`hub.followBit`) is the one switch, and it always tells the truth: on,
   * the view goes to the bit and stays with it; off, it stops where it is;
   * and taking the view over (scrolling the logs, travelling along the well)
   * turns the toggle off. Following never changes Guided / Explore: Guided
   * travels along the well to the bit, Explore moves the free camera with it.
   */
  private followingBit = false;
  /** the travel target that following set, so letting go stops that travel and nothing else */
  private followTarget: number | null = null;
  private followPos: THREE.Vector3 | null = null;

  /** Start keeping the view at the bit (the hub calls this when it opens a well being drilled). */
  startFollowing() {
    this.followingBit = true;
    this.followPos = null;
    if (!this.hub.followBit.value) this.hub.followBit.set(true);
  }

  /** The user took the view over: stop following, and show it on the toggle. */
  stopFollowing() {
    if (this.hub.followBit.value) this.hub.followBit.set(false);
    else this.letGoOfBit();
  }

  /** The toggle went on: follow from wherever the view is, going to the bit now. */
  private goToBit() {
    this.startFollowing();
    const md = this.hub.bitDepth(this.engine.activeWell.id);
    if (md !== null) this.followDepth(md);
  }

  /** The toggle went off: stop where the view is (a travel that following started stops too). */
  private letGoOfBit() {
    this.followingBit = false;
    this.followPos = null;
    const rig = this.engine.rig;
    if (this.followTarget !== null && rig.targetMd === this.followTarget) rig.targetMd = null;
    this.followTarget = null;
  }

  /** Keep the view at the bit of a well being drilled, while following. */
  followDepth(md: number) {
    const rig = this.engine.rig;
    if (!this.followingBit || rig.playing || this.chapter.value?.touring) return;
    const at = Math.min(md, rig.mdMax);
    if (rig.mode === 'explore') {
      // the free camera keeps its angle and distance, and moves with the bit
      const p = this.engine.wellbore?.frameAt(at).pos;
      if (!p) return;
      if (this.followPos) {
        const d = p.clone().sub(this.followPos);
        rig.camera.position.add(d);
        rig.orbit.target.add(d);
      } else if (Math.abs(rig.md - at) > 60) {
        // the camera is elsewhere: bring it beside the bit first, then move with it
        this.travelTo(at);
      }
      this.followPos = p.clone();
      rig.md = at;
      this.engine.requestRender(300);
      return;
    }
    this.followPos = null;
    if (Math.abs(rig.md - at) < 0.05) return;
    rig.targetMd = at;
    this.followTarget = at;
  }

  reinterpret() {
    const w = this.engine.activeWell;
    w.refresh(this.field.meta.datumElevation, this.field.meta.waterDepth);
    this.zoneCache = null;
    this.engine.refreshInterpretation();
    this.logs.invalidate();
    this.notifyFeatures();
    this.wellRev.bump();
  }

  zoneSummaries(): ZoneSummary[] {
    const w = this.engine.activeWell;
    if (!w.logs || !w.petro) return [];
    if (!this.zoneCache)
      this.zoneCache = summariseZones(
        w.logs,
        w.petro,
        w.zones.filter((z) => z.formationId !== 'air' && z.formationId !== 'sea'),
      );
    return this.zoneCache;
  }

  // ------------------------------------------------------------------ navigation
  setNav(mode: NavMode) {
    const rig = this.engine.rig;
    rig.setMode(mode);
    if (mode === 'explore') {
      this.stopTour();
      rig.playing = false;
      this.chapterCard.set(false);
      this.toast('Explore — drag to look · WASD / QE to fly · Shift to boost · wheel sets speed · double-click to focus');
    }
    this.viewRev.bump();
  }

  setGuidedView(v: GuidedView) {
    this.engine.rig.setGuidedView(v);
    if (v === 'tunnel') {
      if (this.engine.mode === 'hydrocarbon') this.setWallOpacity(0.55);
    } else this.setWallOpacity(1);
    this.viewRev.bump();
  }

  setExploreView(v: 'fly' | 'orbit') {
    this.engine.rig.setExploreView(v);
    this.viewRev.bump();
  }

  setProperty(m: PropertyMode) {
    this.engine.setMode(m);
    if (m === 'hydrocarbon' && this.engine.rig.guidedView === 'tunnel' && this.engine.rig.mode === 'guided') this.setWallOpacity(0.55);
    else if (m !== 'hydrocarbon') this.setWallOpacity(1);
    this.viewRev.bump();
  }

  /** Offer or withdraw an optional property mode (ROP, while the active well has an ROP log). */
  setPropertyAvailable(m: PropertyMode, on: boolean) {
    const next = new Set(this.optionalModes.value);
    if (on) next.add(m);
    else next.delete(m);
    this.optionalModes.set(next);
  }

  setColormap(n: ColormapName) {
    this.colormapName = n;
    this.engine.setColormap(n);
    this.logs.colormap = n;
    this.logs.invalidate();
    this.paintRev.bump();
    this.viewRev.bump();
  }

  setRadialScale(s: number) {
    this.engine.setRadialScale(s);
    this.viewRev.bump();
  }

  // ------------------------------------------------------------------ near-well and scene display
  setWallOpacity(v: number) {
    this.setWellboreDisplay({ wallOpacity: v });
  }

  setWellboreDisplay(d: Partial<WellboreDisplay>) {
    Object.assign(this.wellbore, d);
    this.applyWellboreDisplay();
    this.sceneRev.bump();
  }

  private applyWellboreDisplay() {
    const wb = this.engine.wellbore;
    if (!wb) return;
    const d = this.wellbore;
    wb.setCasingOpacity(d.casingOpacity);
    wb.setWallOpacity(d.wallOpacity);
    wb.uniforms.uShellOpacity.value = d.shellOpacity;
    wb.casings.forEach((m) => (m.visible = d.casing));
    wb.cements.forEach((m) => (m.visible = d.casing));
    wb.fractureGroup.visible = d.fractures;
    wb.uniforms.uShowFractures.value = d.fractures ? 1 : 0;
    wb.markers.visible = d.markers;
  }

  setDisplay(d: Partial<SceneDisplay>) {
    Object.assign(this.display, d);
    const e = this.engine;
    const s = this.display;
    if (d.labels !== undefined) {
      e.labelsVisible = s.labels;
      e.env.platform.children.forEach((c) => {
        if ((c as { isCSS2DObject?: boolean }).isCSS2DObject) c.visible = s.labels;
      });
    }
    if (d.otherWells !== undefined) e.contextVisible = s.otherWells;
    if (d.sea !== undefined) {
      e.env.seaVisible = s.sea;
      e.env.sea.visible = s.sea;
      e.env.waterColumn.visible = s.sea;
      e.env.platform.visible = s.sea;
    }
    if (d.contours !== undefined) e.geology.setContours(s.contours);
    if (d.postFx !== undefined) e.setPostFx(s.postFx);
    this.sceneRev.bump();
  }

  // ------------------------------------------------------------------ geology
  private pendingBox: Partial<SectionBox> | null = null;
  private pendingPreview = false;

  /**
   * Section box edits from sliders: coalesced to one rebuild per frame.
   * `preview` marks the steps of a drag, which update the slabs' buffers in
   * place at the grid resolution the drag started with; the drag's last call
   * (without it) rebuilds at the box's own resolution.
   */
  setBox(b: Partial<SectionBox>, immediate = false, preview = false) {
    const geo = this.engine.geology;
    if (immediate) {
      this.pendingBox = null;
      geo.setBox(b);
      this.sceneRev.bump();
      return;
    }
    const first = !this.pendingBox;
    this.pendingBox = { ...this.pendingBox, ...b };
    this.pendingPreview = preview;
    if (first)
      requestAnimationFrame(() => {
        const p = this.pendingBox;
        this.pendingBox = null;
        if (p) geo.setBox(p, this.pendingPreview);
      });
  }

  setLayer(id: string, s: { visible?: boolean; opacity?: number }) {
    this.engine.geology.setLayer(id, s);
    this.sceneRev.bump();
  }

  /** A formation's colour, everywhere it is drawn; remembered in this browser. */
  setFormationColor(id: string, hex: string) {
    const f = FORMATION_BY_ID.get(id);
    if (!f) return;
    f.color = hex;
    this.engine.geology.setColor(id, hex);
    this.logs.invalidate();
    try {
      const saved = JSON.parse(localStorage.getItem('bw.formationColors') ?? '{}') as Record<string, string>;
      saved[id] = hex;
      localStorage.setItem('bw.formationColors', JSON.stringify(saved));
    } catch {
      /* storage blocked */
    }
    this.paintRev.bump();
    this.sceneRev.bump();
    this.wellRev.bump();
  }

  isolate(id: string | null) {
    this.engine.geology.isolate(id);
    this.sceneRev.bump();
  }

  preset(kind: LayerPreset) {
    const geo = this.engine.geology;
    geo.isolate(null);
    const defaults: Record<string, number> = {
      nordland: 0.2,
      utsira: 0.22,
      hordaland: 0.14,
      ty: 0.18,
      ekofisk: 0.3,
      hod: 0.26,
      draupne: 0.55,
      heather: 0.5,
      hugin: 0.92,
      sleipner: 0.75,
      skagerrak: 0.8,
      smithbank: 0.85,
    };
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
    this.sceneRev.bump();
  }

  /** Section box trimmed to a corridor that hugs the active well, cut through its centre. */
  sectionAlongWell() {
    const t = this.engine.activeWell.trajectory;
    let n0 = Infinity;
    let n1 = -Infinity;
    for (let i = 0; i < t.md.length; i++) {
      n0 = Math.min(n0, t.ns[i]);
      n1 = Math.max(n1, t.ns[i]);
    }
    const fb = this.engine.geology.fullBox;
    const midN = (n0 + n1) / 2;
    this.setBox({ xMin: fb.xMin, xMax: fb.xMax, nMin: Math.max(fb.nMin, midN), nMax: fb.nMax, stripTo: 0 }, true);
  }

  // ------------------------------------------------------------------ camera
  travelTo(md: number) {
    const rig = this.engine.rig;
    if (rig.mode === 'explore') {
      // fly the free camera to a viewpoint beside that depth
      const f = this.engine.wellbore!.frameAt(md);
      const d = 40 + f.radius * 16;
      const side = new THREE.Vector3().crossVectors(f.tan, new THREE.Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-3) side.set(1, 0, 0);
      side.normalize();
      const pos = f.pos
        .clone()
        .addScaledVector(side, d)
        .add(new THREE.Vector3(0, d * 0.35, 0));
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

  /** Scrub the camera to a depth without flying (timeline, log wheel). */
  scrubTo(md: number) {
    const rig = this.engine.rig;
    rig.playing = false;
    rig.targetMd = null;
    rig.setMd(md);
  }

  overview() {
    const o = this.engine.overviewPose();
    const rig = this.engine.rig;
    if (rig.mode === 'guided') this.setNav('explore');
    rig.setExploreView('orbit');
    this.viewRev.bump();
    rig.flyTo(o.pos, o.target, 2.6);
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
    this.chapterCard.set(rig.playing);
  }

  setSpeed(v: number) {
    this.engine.rig.speed = v;
    this.viewRev.bump();
  }

  // ------------------------------------------------------------------ panels
  /** The Interpretation panel is brought up (from the rail or a menu): its parameters redraw the Hydrocarbons view, so show that. */
  interpretationShown() {
    if (this.engine.mode === 'hydrocarbon') return;
    this.setProperty('hydrocarbon');
    this.toast('Showing the Hydrocarbons view: it redraws live as you change parameters.');
  }

  /**
   * Can a workspace show this panel now? The app's own panels always; a tool
   * window only while it is open, since its feature decides that: switching
   * workspace moves the open ones to that workspace's places for them and
   * never opens or closes one.
   */
  readonly hasPanel = (id: string) => DOCK_PANELS.has(id) || openWindows.value.some((w) => w.opts.id === id);

  /**
   * Switch workspace (its tab, Ctrl PgUp / PgDn, the palette). Its layout
   * comes back as it was left, animated, and its task context (the colouring,
   * the navigation mode) is set through the same calls the top bar makes.
   * Returns false for an unknown workspace.
   */
  switchWorkspace(id: string) {
    const ws = this.workspace;
    if (!ws.has(id)) return false;
    if (id === this.targetWorkspace) return true;
    const ctx = ws.info(id)?.context;
    // before the transition: a toast (Explore's hint) would otherwise cut its animation short
    if (ctx && this.ready.value) this.applyContext(ctx);
    this.pendingWorkspace = id;
    withTransition(() => {
      ws.switchTo(id, this.hasPanel);
      if (this.pendingWorkspace === id) this.pendingWorkspace = null;
    });
    return true;
  }

  /** a switch waiting for its transition to start */
  private pendingWorkspace: string | null = null;

  /** The workspace being switched to, or the active one: Ctrl PgDn pressed twice quickly steps twice. */
  get targetWorkspace() {
    return this.pendingWorkspace ?? this.workspace.current.value;
  }

  private applyContext(ctx: WorkspaceContext) {
    const rig = this.engine.rig;
    // an optional mode (ROP) is only set while a feature offers it
    if (ctx.colour && ctx.colour !== this.engine.mode && (ctx.colour !== 'rop' || this.optionalModes.value.has('rop'))) this.setProperty(ctx.colour);
    if (ctx.nav && ctx.nav !== rig.mode) this.setNav(ctx.nav);
    if (ctx.nav === 'guided' && ctx.guidedView && ctx.guidedView !== rig.guidedView) this.setGuidedView(ctx.guidedView);
  }

  /** Reset a workspace's layout to where it started (the active one animates). */
  resetWorkspace(id = this.workspace.current.value) {
    withTransition(() => this.workspace.reset(id, this.hasPanel));
  }

  // ------------------------------------------------------------------ selection
  /** Select an object (null clears the selection); selecting what is already selected changes nothing. */
  select(sel: Selection | null) {
    if (sameSelection(sel, this.selection.value)) return;
    this.selection.set(sel);
    const md = sel?.md;
    if (md !== undefined && sel?.well === this.engine?.activeWell.id) this.logs.setCursor(md);
  }

  /** The details of a selected object: its title, read-outs and quick actions (null when it no longer exists). */
  inspectorFor(sel: Selection): InspectorView | null {
    try {
      return inspect.view(this, sel);
    } catch (err) {
      console.error('inspect', err);
      return null;
    }
  }

  /** Open the right-click menu of an object at a point of the window, selecting it. */
  openContextMenu(sel: Selection, x: number, y: number) {
    this.select(sel);
    this.contextMenu.set({ x, y, selection: this.selection.value! });
  }

  inspectFormation(id: string) {
    this.select({ kind: 'formation', id });
  }

  inspectAt(md: number) {
    const id = this.engine.activeWell.id;
    this.select({ kind: 'well', id, well: id, md });
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
    this.chapter.set({ index: k, touring: this.tourTimer !== null });
    this.chapterCard.set(true);
  }

  startTour() {
    this.stopTour();
    let i = 0;
    const step = () => {
      this.goChapter(i);
      i++;
      if (i < this.chapters.length) this.tourTimer = window.setTimeout(step, 9000);
      else this.tourTimer = null;
      this.chapter.set({ index: this.chapterIdx, touring: this.tourTimer !== null });
    };
    this.tourTimer = 0;
    step();
    this.toast('Auto tour — any interaction pauses it');
  }

  stopTour() {
    if (this.tourTimer !== null) {
      clearTimeout(this.tourTimer);
      this.tourTimer = null;
      this.chapter.set({ index: Math.max(0, this.chapterIdx), touring: false });
    }
  }

  get touring() {
    return this.tourTimer !== null;
  }

  // ------------------------------------------------------------------ interaction
  /** A right-click in the 3D view: the menu of the object under the pointer (and it is selected). */
  private rightClickAt(x: number, y: number) {
    const p = this.engine.pick(x, y);
    const sel = p && inspect.selectionOf(this, p);
    if (sel) this.openContextMenu(sel, x, y);
  }

  private bindPicking() {
    const cv = this.engine.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    // a click selects (the right button opens the menu below instead)
    cv.addEventListener('pointerdown', (e) => (down = e.button === 2 ? null : { x: e.clientX, y: e.clientY, t: performance.now() }));
    cv.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 5 && performance.now() - down.t < 500) {
        const p = this.engine.pick(e.clientX, e.clientY);
        if (this.clickHandlers.some((fn) => fn(p, e))) {
          down = null;
          return;
        }
        this.select(p ? inspect.selectionOf(this, p) : null);
        if (p?.md !== undefined) this.logs.setCursor(p.md);
      }
      down = null;
    });
    // right click without dragging (a right drag pans the view): the picked object's menu of actions.
    // It opens on release, as some systems send `contextmenu` when the button goes down.
    let rdown: { x: number; y: number } | null = null;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) rdown = { x: e.clientX, y: e.clientY };
    });
    cv.addEventListener('pointerup', (e) => {
      const r = rdown;
      if (e.button !== 2 || !r) return;
      rdown = null;
      if (Math.hypot(e.clientX - r.x, e.clientY - r.y) > 5) return;
      this.rightClickAt(e.clientX, e.clientY);
    });
    // A right-click while a menu is open never reaches the page (an open menu leaves the rest of
    // the page deaf to the pointer, and closes only for a left click): close the menu, and once it
    // has gone pass the right-click on to what is under the pointer, so it opens that thing's menu
    // as it would have with none open.
    let passOn: { x: number; y: number } | null = null;
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 2 || !document.querySelector('[role="menu"]') || (e.target as Element | null)?.closest?.('[role="menu"]')) return;
        e.preventDefault();
        e.stopPropagation();
        passOn = { x: e.clientX, y: e.clientY };
        this.contextMenu.set(null);
        // any other menu (a tab's, the rail's) closes as Escape closes it
        const focus = document.activeElement;
        if (focus && focus !== document.body) focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      },
      true,
    );
    window.addEventListener(
      'pointerup',
      (e) => {
        const at = passOn;
        if (e.button !== 2 || !at) return;
        passOn = null;
        e.stopPropagation();
        // once the menu has gone (and the page hears the pointer again), half a second at most
        const t0 = performance.now();
        const send = () => {
          if (document.querySelector('[role="menu"]') && performance.now() - t0 < 500) return void requestAnimationFrame(send);
          const el = document.elementsFromPoint(at.x, at.y).find((x) => !x.closest('[data-testid="underlay"], [role="menu"], [role="dialog"]'));
          if (!el) return;
          if (el === cv) this.rightClickAt(at.x, at.y);
          else el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2, buttons: 0 }));
        };
        requestAnimationFrame(send);
      },
      true,
    );
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    // The app's own right-click menus stand in for the browser's everywhere: on some systems the
    // browser's arrives after ours opened, aimed at our menu rather than the view, so it is turned
    // off for the whole page. Text fields and selected text keep it (copy, paste, spelling).
    document.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      if (String(window.getSelection() ?? '').trim()) return;
      e.preventDefault();
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
      this.viewRev.bump();
      const dir = this.engine.camera.position.clone().sub(p.point).normalize();
      const dist = Math.min(this.engine.camera.position.distanceTo(p.point) * 0.45, 900);
      rig.flyTo(p.point.clone().addScaledVector(dir, Math.max(25, dist)), p.point, 1.6);
    });
    // hover: the latest pointer position is picked once per frame at most (and no more than
    // ~20 times a second), never while a button is held (orbiting, or a drag from the chrome)
    let hx = 0;
    let hy = 0;
    let hoverRaf = 0;
    let hoverAt = 0;
    const setHover = (md: number | null, over: boolean) => {
      if (md !== this.logs.hoverMd) {
        const wb = this.engine.wellbore;
        if (wb) wb.uniforms.uHoverMd.value = md ?? -1e6;
        this.logs.hoverMd = md;
        this.engine.requestRender(200);
      }
      const c = over ? 'pointer' : '';
      if (cv.style.cursor !== c) cv.style.cursor = c;
    };
    const cancel = () => {
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    };
    const hover = () => {
      hoverRaf = 0;
      const now = performance.now();
      if (now - hoverAt < 50) {
        hoverRaf = requestAnimationFrame(hover);
        return;
      }
      hoverAt = now;
      const p = this.engine.pick(hx, hy, true);
      setHover(p?.md ?? null, !!p);
    };
    cv.addEventListener(
      'pointermove',
      (e) => {
        if (e.buttons) return cancel();
        hx = e.clientX;
        hy = e.clientY;
        if (!hoverRaf) hoverRaf = requestAnimationFrame(hover);
      },
      { passive: true },
    );
    // the pointer went onto the chrome (or out of the window): nothing is hovered in the view
    cv.addEventListener('pointerleave', () => {
      cancel();
      setHover(null, false);
    });
  }

  private bindKeys() {
    // Ctrl PgUp / PgDn steps through the workspace tabs. Caught on the way down, since a focused
    // button or tab list would otherwise swallow it; text fields, menus and dialogs keep it.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || (e.key !== 'PageUp' && e.key !== 'PageDown')) return;
        if ((e.target as HTMLElement).closest?.('input, select, textarea, [role="dialog"], [role="menu"], [role="listbox"]')) return;
        e.preventDefault();
        e.stopPropagation();
        void this.actions.run(e.key === 'PageUp' ? 'workspace.previous' : 'workspace.next');
      },
      true,
    );
    // ⌘I / Ctrl I opens or closes the assistant from anywhere, even its own composer (not mid-IME
    // composition, and not in rich text, where it is italics)
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'i' || e.isComposing || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest?.('[contenteditable="true"]')) return;
      e.preventDefault();
      void this.actions.run('assistant.toggle');
    });
    // Ctrl Z (outside text fields, menus and dialogs) takes back the last layout change
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z' || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest?.('input, select, textarea, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (!this.workspace.canUndo()) return;
      e.preventDefault();
      void this.actions.run('panels.undo_layout');
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      // keys belong to form controls, and to anything inside a dialog or popover
      if (t.closest('input, select, textarea, [role="dialog"], [role="menu"], [role="listbox"], [role="slider"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const rig = this.engine.rig;
      // keys run the same actions as the command palette
      const act = (id: string, input?: unknown) => void this.actions.run(id, input);
      if (e.code === 'Space' && rig.mode === 'guided') {
        e.preventDefault();
        act('nav.play_pause');
      } else if (rig.mode === 'guided' && e.key === '1') act('nav.guided_view', { view: 'tunnel' });
      else if (rig.mode === 'guided' && e.key === '2') act('nav.guided_view', { view: 'chase' });
      else if (rig.mode === 'guided' && e.key === '3') act('nav.guided_view', { view: 'orbit' });
      else if (e.key === 'n' || e.key === 'N') act('nav.chapter', { index: Math.min(this.chapters.length - 1, this.chapterIdx + 1) });
      else if (e.key === 'p' || e.key === 'P') act('nav.chapter', { index: Math.max(0, this.chapterIdx - 1) });
      else if (e.key === ']') rig.setMd(rig.md + 10);
      else if (e.key === '[') rig.setMd(rig.md - 10);
      else if (e.key === 'v' || e.key === 'V') {
        const order: PropertyMode[] = ['resistivity', 'hydrocarbon', 'lithology', ...(this.optionalModes.value.has('rop') ? (['rop'] as PropertyMode[]) : [])];
        act('view.color_by', { mode: order[(order.indexOf(this.engine.mode) + 1) % order.length] });
      } else if (e.key === '?') act('help.open');
      else if (e.key === 'Escape') this.select(null);
    });
  }

  // ------------------------------------------------------------------ per-frame sync
  /** the feature modules with a per-frame hook */
  private frameModules: FeatureModule[] = [];
  private lastMdShown = -1;
  // camera read-out state: recomputed only when the camera or the navigation mode changes
  private readonly camDir = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3(NaN, NaN, NaN);
  private readonly camQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
  private camY = 0;
  private camAbove = false;
  private navOf: [NavMode | null, GuidedView | null, string | null] = [null, null, null];
  private nav = '';
  private whereOf: [string | null | undefined, boolean] = [undefined, false];
  private where = '';
  private hudAt = 0;

  /** Runs every animation frame, so its idle path allocates nothing and sets no signal that has not changed. */
  private frame(dt = 0.016) {
    const mods = this.frameModules;
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      if (this.flags.on(m.id))
        try {
          m.frame!(dt);
        } catch (err) {
          console.error(`feature ${m.id}`, err);
        }
    }
    const e = this.engine;
    const rig = e.rig;
    const w = e.activeWell;
    const md = rig.md;
    this.playing.set(rig.playing);
    if (Math.abs(md - this.lastMdShown) > 0.01) {
      this.lastMdShown = md;
      const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
      const z = w.zoneAt(md);
      this.pose.set({ md, tvdss: t.tvd - this.field.meta.datumElevation, inc: t.inc, azi: t.azi, zone: z?.name ?? '—', section: Trajectory.sectionType(t.inc) });
      this.logs.setCursor(md);
      // the narrative follows the position in guided mode
      if (rig.mode === 'guided' && this.tourTimer === null) {
        let k = -1;
        for (let i = 0; i < this.chapters.length; i++) if (this.chapters[i].md <= md + 3) k = i;
        if (k !== this.chapterIdx && k >= 0) {
          this.chapterIdx = k;
          this.chapter.set({ index: k, touring: false });
        }
      }
    }
    const now = performance.now();
    if (this.poseText.value !== this.pose.value && now - this.poseTextAt > 66) {
      this.poseTextAt = now;
      this.poseText.set(this.pose.value);
    }
    // the compass needle follows every frame (straight to the DOM); the text at a readable pace
    const cam = e.camera;
    if (!cam.position.equals(this.camPos) || !cam.quaternion.equals(this.camQuat)) {
      this.camPos.copy(cam.position);
      this.camQuat.copy(cam.quaternion);
      cam.getWorldDirection(this.camDir);
      this.heading.set(Math.round((Math.atan2(this.camDir.x, -this.camDir.z) * 1800) / Math.PI) / 10);
      this.camY = Math.round(cam.position.y);
      this.camAbove = cam.position.y > 0;
    }
    const nv = this.navOf;
    if (nv[0] !== rig.mode || nv[1] !== rig.guidedView || nv[2] !== rig.exploreView) {
      this.navOf = [rig.mode, rig.guidedView, rig.exploreView];
      this.nav = rig.mode === 'guided' ? `Guided · ${rig.guidedView === 'tunnel' ? 'inside the hole' : rig.guidedView}` : `Explore · ${rig.exploreView}`;
    }
    const f = e.cameraFormation;
    const above = this.camAbove;
    if (this.whereOf[0] !== f || this.whereOf[1] !== above) {
      this.whereOf = [f, above];
      this.where = f === 'sea' ? 'In the water column' : f ? `Inside ${FORMATION_BY_ID.get(f)?.name ?? f}` : above ? 'Above sea level' : 'Outside model';
    }
    const h = this.hud.value;
    const hd = Math.round(this.heading.value);
    if (h.where !== this.where || h.nav !== this.nav || ((h.heading !== hd || h.camY !== this.camY) && now - this.hudAt > 66)) {
      this.hudAt = now;
      this.hud.set({ heading: hd, where: this.where, nav: this.nav, camY: this.camY });
    }
  }
}
