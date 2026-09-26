import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FieldModel, Well } from '../data/dataset';
import type { ColormapName } from '../data/colormap';
import { formationAt } from '../data/surfaces';
import { Coords } from './coords';
import { GeologyModel } from './geology';
import { WellboreAssembly, type PropertyMode } from './wellbore';
import { Environment, WellPaths } from './environment';
import { CameraRig } from './cameraRig';
import { buildWellTextures, makeLutTexture, updateWellTextures } from './wellData';
import { FOCUS, SEABED } from './rockMaterial';
import { FinalPass, GlowPass, LensBlurShader, MudParticles, ScenePass } from './postfx';
import type { SectionBox } from './geology';
import { ensureBVHFor } from './bvh';
import { LabelRenderer } from './labels';
import { textureEvents } from './textures';

export interface PickResult {
  kind: string;
  point: THREE.Vector3;
  md?: number;
  object: THREE.Object3D;
}

/** Most device pixels a frame draws: a retina laptop's view stays near 60 fps, sharper than 1× (MSAA keeps edges clean). */
const PIXEL_BUDGET = 2.5e6;

/**
 * GPU time of each frame's draw calls (EXT_disjoint_timer_query_webgl2),
 * read back a few frames later without stalling the pipeline.
 */
class GpuTimer {
  private pending: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private gl: WebGL2RenderingContext,
    private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number },
  ) {}

  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    if (!('createQuery' in gl)) return null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  begin() {
    // results come back within a few frames; a backlog means the driver is not answering
    if (this.active || this.pending.length > 6) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Report finished measurements (ms); those spanning a disjoint event (power state change, …) are dropped. */
  poll(out: (ms: number) => void) {
    if (!this.pending.length) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.free.push(this.pending.shift()!);
      if (!disjoint) out(ns / 1e6);
    }
  }
}

/**
 * Two camera poses that no pixel can tell apart (0.1 µrad, 10 µm). Damped orbits and the guided camera's
 * smoothing approach their target geometrically: compared exactly, they kept drawing for seconds after
 * every move to shift the image by a fraction of a pixel.
 */
function sameView(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > (i >= 12 ? 1e-5 : 1e-7)) return false;
  return true;
}

/** Reversed depth needs EXT_clip_control (WebGL2); probed on a throwaway context. */
function supportsReversedDepth(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ok = !!gl?.getExtension('EXT_clip_control');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: LabelRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly rig: CameraRig;
  readonly coords: Coords;
  geology!: GeologyModel;
  env!: Environment;
  paths!: WellPaths;
  wellbore?: WellboreAssembly;
  activeWell!: Well;
  private headlight: THREE.PointLight;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private timer = new THREE.Timer();
  private scenePass: ScenePass;
  private glow: GlowPass;
  private final: FinalPass;
  private raycaster = new THREE.Raycaster();
  /**
   * Objects drawn by the overlay features (the log curtain, the geosteering
   * band…) that a click can pick: each is tagged `userData.kind = 'feature'`
   * with its `featureId`. A feature adds its group while it is on. One marked
   * `userData.soft` (a see-through envelope around the well) gives way to
   * the well when the same click also hits the well behind it.
   */
  readonly pickables = new Set<THREE.Object3D>();
  private lutTex: THREE.DataTexture;
  mode: PropertyMode = 'resistivity';
  tunnel = false;
  labelsVisible = true;
  contextVisible = true;
  cameraFormation: string | null = null;
  onFrame?: (dt: number) => void;
  radialScale = 25;
  private fog: THREE.FogExp2;
  private lensPass: ShaderPass;
  private gpu: GpuTimer | null;
  /** CSS size of the view; the drawing buffer follows it once a resize settles */
  private size = { w: 1, h: 1 };
  readonly mud = new MudParticles();
  /** optional-feature switches (see src/features) */
  fx = { shadows: false, tunnel: false, sea: false };
  /** listeners for section-box changes (geology rebuilds) */
  boxListeners: ((b: SectionBox) => void)[] = [];

  readonly quality: 'high' | 'low';
  readonly depthMode: 'reversed' | 'log';

  constructor(
    container: HTMLElement,
    public field: FieldModel,
  ) {
    this.quality = /[?&]q=low/.test(location.search) ? 'low' : 'high';
    this.coords = new Coords(field.meta.datumElevation);
    // The scene spans 5 cm to 90 km. A reversed float depth buffer covers that range while keeping the GPU's
    // early depth test; the logarithmic buffer writes depth per fragment, which disables it, so every hidden
    // pixel of the rock / fracture / pore shaders is shaded anyway. Log depth stays as the fallback.
    this.depthMode = /[?&]depth=log/.test(location.search) || !supportsReversedDepth() ? 'log' : 'reversed';
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.size = { w, h };
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      reversedDepthBuffer: this.depthMode === 'reversed',
      logarithmicDepthBuffer: this.depthMode === 'log',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.pixelRatioFor(w, h));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('gl');
    this.gpu = GpuTimer.create(this.renderer.getContext());

    this.labelRenderer = new LabelRenderer();
    this.labelRenderer.setSize(w, h);
    this.labelRenderer.domElement.className = 'labels-layer';
    // a label's text or class changed its size: place the labels again
    this.labelRenderer.onSizeChange = () => this.requestRender();
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.05, 90000);
    this.camera.position.set(-2600, 1400, 2600);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.fog = new THREE.FogExp2(0x0b1016, 0.0);
    this.scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xb9c8d8, 0x2a2118, 0.55);
    this.sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
    this.sun.position.set(-3000, 5000, 2500);
    this.headlight = new THREE.PointLight(0xf4f1ea, 0, 0, 1.2);
    this.scene.add(this.hemi, this.sun, this.camera);
    this.camera.add(this.headlight);

    // Only the scene draw is multisampled (ScenePass); the post chain runs on plain half-float
    // buffers without depth. Scene → glow (half resolution) → lens (inside the hole) → final
    // (glow added, tone mapping, grade) straight to the canvas.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.scenePass = new ScenePass(this.scene, this.camera, this.quality === 'low' ? 0 : 4);
    this.composer.addPass(this.scenePass);
    this.glow = new GlowPass(new THREE.Vector2(w, h), 0.32, 0.55, 0.88);
    this.glow.enabled = this.quality !== 'low';
    this.composer.addPass(this.glow);
    this.lensPass = new ShaderPass(LensBlurShader);
    this.lensPass.enabled = false;
    this.composer.addPass(this.lensPass);
    this.final = new FinalPass(this.glow);
    this.composer.addPass(this.final);

    this.rig = new CameraRig(this.camera, this.renderer.domElement);
    // Explore's wheel zooms toward what is under the pointer
    this.rig.pickPoint = (x, y) => this.pick(x, y)?.point ?? null;
    this.lutTex = makeLutTexture('resistivity');

    this.env = new Environment(field);
    this.scene.add(this.env.group);
    this.geology = new GeologyModel(field);
    this.scene.add(this.geology.group);
    this.geology.onBoxChange = (b) => {
      this.env.setBox(b);
      this.fitShadowCamera();
      this.renderer.shadowMap.needsUpdate = true;
      for (const f of this.boxListeners) f(b);
      this.requestRender();
    };
    this.scene.add(this.mud.points, this.sun.target);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // the block and platform are static: render the shadow map only when something changes
    this.renderer.shadowMap.autoUpdate = false;
    this.geology.onStateChange = () => {
      this.renderer.shadowMap.needsUpdate = true;
      this.requestRender();
    };
    this.sun.shadow.mapSize.setScalar(this.quality === 'low' ? 1024 : 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.5;
    this.fitShadowCamera();
    this.paths = new WellPaths(field, this.coords);
    this.scene.add(this.paths.group);

    // a feature adding or removing its objects (markers, contacts, a simulation grid) redraws
    this.scene.addEventListener('childadded', () => this.requestRender());
    this.scene.addEventListener('childremoved', () => this.requestRender());
    // photo textures arrive asynchronously
    textureEvents.loaded = () => this.requestRender();

    this.resize();
    // the container follows the window, so its observer covers window resizes as well (layout is clean in the callback)
    new ResizeObserver(() => {
      this.rect = null;
      this.onResize(container.clientWidth, container.clientHeight);
    }).observe(container);
    // the canvas moves with the page, not only when it resizes
    window.addEventListener('scroll', () => (this.rect = null), { capture: true, passive: true });
    // moving to a display of another density changes no CSS size
    let dpr = window.devicePixelRatio;
    window.addEventListener('resize', () => {
      this.rect = null;
      if (window.devicePixelRatio === dpr) return;
      dpr = window.devicePixelRatio;
      this.scheduleRealloc();
    });
  }

  /** how many scene labels to show: all, hide distant and overlapping ones, or only the essentials */
  labelDensity: 'all' | 'near' | 'few' = 'near';

  private insets = { left: 0, right: 0, bottom: 0 };
  /** the view offset now applied; it glides to the insets' */
  private offset = { dx: 0, dy: 0 };
  private offsetMoving = false;
  /** a pointer went down on the chrome (a panel, an edge, a tab) and is still down */
  private chromeDrag = false;
  /**
   * The parts of the view covered by panels (px). The projection centre moves
   * to the middle of what is left, so the subject stays centred in the free
   * area; the canvas itself keeps its size (no reallocation, no flash). While
   * a column edge or panel is being dragged the view keeps its framing (a
   * redraw per pointer move would compete with the drag); it glides to the new
   * centre on release.
   */
  setInsets(left: number, right: number, bottom = 0) {
    const i = this.insets;
    if (i.left === left && i.right === right && i.bottom === bottom) return;
    this.insets = { left, right, bottom };
    if (!this.started) {
      this.offset = { dx: (left - right) / 2, dy: bottom / 2 };
      this.applyViewOffset();
    } else if (!this.chromeDrag) this.offsetMoving = true;
  }
  private stepViewOffset(dt: number) {
    if (!this.offsetMoving) return;
    const tx = (this.insets.left - this.insets.right) / 2;
    const ty = this.insets.bottom / 2;
    const o = this.offset;
    const k = this.rig.instantMoves ? 1 : 1 - Math.exp(-dt * 12);
    o.dx += (tx - o.dx) * k;
    o.dy += (ty - o.dy) * k;
    if (Math.abs(tx - o.dx) < 0.5 && Math.abs(ty - o.dy) < 0.5) {
      o.dx = tx;
      o.dy = ty;
      this.offsetMoving = false;
    }
    this.applyViewOffset();
  }
  private applyViewOffset() {
    const { w, h } = this.size;
    const { dx, dy } = this.offset;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.camera.setViewOffset(w, h, -dx, dy, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Glow + film grade can be switched off from the Display panel. */
  setPostFx(on: boolean) {
    this.glow.enabled = on;
    this.final.grade = on;
    this.requestRender();
  }

  /** Sun shadows on the platform, sea and geological block. */
  setShadows(on: boolean) {
    this.fx.shadows = on;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.scenePass.ao = on;
    this.geology.shadows = on;
    this.geology.applyState();
    this.env.platform.traverse((o) => {
      o.castShadow = on;
      o.receiveShadow = on;
    });
    this.env.sea.receiveShadow = on;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
    this.requestRender();
  }

  setTunnelFx(on: boolean) {
    this.fx.tunnel = on;
    if (!on) this.lensPass.enabled = false;
    this.requestRender();
  }

  setSeaFx(on: boolean) {
    this.fx.sea = on;
    this.env.setDetail(on);
    SEABED.uSeabedOn.value = on ? 1 : 0;
    this.requestRender();
  }

  private fitShadowCamera() {
    const b = this.geology.box;
    const cx = (b.xMin + b.xMax) / 2;
    const cz = -(b.nMin + b.nMax) / 2;
    const half = Math.max(b.xMax - b.xMin, b.nMax - b.nMin) * 0.78;
    const dir = new THREE.Vector3(-3000, 5000, 2500).normalize();
    this.sun.target.position.set(cx, -1400, cz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 9000);
    const c = this.sun.shadow.camera;
    c.left = -half;
    c.right = half;
    c.top = half;
    c.bottom = -half;
    c.near = 1000;
    c.far = 18000;
    c.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  /** Device pixel ratio for a view of w × h CSS px: the display's, capped at 1.75 and at the pixel budget, times the adaptive scale. */
  private pixelRatioFor(w: number, h: number) {
    if (this.quality === 'low') return 1;
    const budget = Math.max(1, Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h)));
    return Math.min(window.devicePixelRatio, 1.75, budget) * this.prScale;
  }

  private reallocTimer = 0;
  /**
   * The container changed size. The camera and the CSS size follow at once
   * (the current drawing buffer is stretched meanwhile, and the view is drawn
   * into it with the new aspect, so nothing distorts); the renderer, the
   * multisampled target, the glow mips and the post buffers are reallocated
   * once, 150 ms after the size stopped changing, instead of on every step of
   * a live window resize.
   */
  private onResize(w: number, h: number) {
    if (!w || !h || (w === this.size.w && h === this.size.h)) return;
    this.size = { w, h };
    this.camera.aspect = w / h;
    this.applyViewOffset();
    const st = this.renderer.domElement.style;
    st.width = `${w}px`;
    st.height = `${h}px`;
    this.labelRenderer.setSize(w, h);
    (this.lensPass.uniforms as Record<string, THREE.IUniform>).uAspect.value = w / h;
    this.requestRender();
    this.scheduleRealloc();
  }
  private scheduleRealloc(ms = 150) {
    clearTimeout(this.reallocTimer);
    this.reallocTimer = window.setTimeout(() => this.realloc(), ms);
  }
  private realloc() {
    const pr = this.pixelRatioFor(this.size.w, this.size.h);
    if (pr !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(pr);
      this.composer.setPixelRatio(pr);
    }
    this.resize();
  }

  /** Size every buffer to the view now, at the renderer's pixel ratio (the snapshot export sets its own). */
  resize() {
    const { w, h } = this.size;
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    (this.lensPass.uniforms as Record<string, THREE.IUniform>).uAspect.value = w / h;
    this.labelRenderer.setSize(w, h);
    this.requestRender();
  }

  setActiveWell(well: Well) {
    if (this.wellbore) {
      this.scene.remove(this.wellbore.group);
      this.wellbore.dispose();
    }
    this.activeWell = well;
    const tex = buildWellTextures(well);
    this.wellbore = new WellboreAssembly(well, this.field, this.coords, tex, this.lutTex);
    this.wellbore.setRadialScale(this.radialScale);
    this.wellbore.setMode(this.mode);
    this.scene.add(this.wellbore.group);
    this.rig.wellbore = this.wellbore;
    this.rig.mdMax = well.tdMD;
    this.paths.build(well.id);
    this.requestRender();
    // build the picking BVH for the heavy wall geometry off the critical path, not on the first hover
    const wb = this.wellbore;
    const build = () => {
      if (this.wellbore === wb) ensureBVHFor([wb.wall, wb.overviewTube, ...wb.casings]);
    };
    // the render loop can keep the browser from ever going idle: cap the wait
    // a well being drilled is rebuilt often: its index waits for a longer quiet spell
    if ('requestIdleCallback' in window) requestIdleCallback(build, { timeout: well.buildAhead > 0 ? 8000 : 1500 });
    else setTimeout(build, 500);
  }

  /** Re-upload log/interpretation textures after parameters or data changed. */
  /** Interpretation changed only: update data textures in place. */
  refreshInterpretation() {
    if (this.wellbore) this.wellbore.updateTextures(buildWellTextures(this.activeWell));
    this.requestRender();
  }

  /**
   * Live data reached the well from `fromMd` down: refill that part of the
   * wellbore's data textures in place (or rebuild them when TD outgrew them).
   */
  refreshFrom(fromMd: number) {
    const wb = this.wellbore;
    if (!wb) return;
    if (updateWellTextures(wb.tex, this.activeWell, fromMd)) wb.texturesChanged();
    else wb.updateTextures(buildWellTextures(this.activeWell));
    this.requestRender();
  }

  refreshWellData() {
    if (!this.wellbore) return;
    const md = this.rig.md;
    this.setActiveWell(this.activeWell);
    this.wellbore.setCursor(md);
  }

  setMode(m: PropertyMode) {
    this.mode = m;
    this.wellbore?.setMode(m);
    this.requestRender();
  }

  setColormap(name: ColormapName) {
    const t = makeLutTexture(name);
    this.lutTex.dispose();
    this.lutTex = t;
    this.wellbore?.setLut(t);
    this.requestRender();
  }

  setRadialScale(s: number) {
    this.radialScale = s;
    this.wellbore?.setRadialScale(s);
    this.requestRender();
  }

  // ---- render on demand: the scene is drawn only when something in it changed. Camera motion, the
  // cursor depth and the hover highlight are seen here; everything else asks: the engine's setters, the
  // app's scene signals (SCENE in ui/signal.ts), objects added to the scene and input on the view.
  // There is no periodic redraw: a chrome drag never costs a 3D frame.
  private renderUntil = 0;
  /** at least one more frame, however late the next tick comes */
  private framePending = true;
  private lastView = new THREE.Matrix4();
  private lastProj = new THREE.Matrix4();
  private lastMd = NaN;
  private lastHover = NaN;
  private started = false;
  /** Draw the next frame, and keep drawing for `ms` (state changed, input on the view, data arrived). */
  requestRender(ms = 100) {
    this.framePending = true;
    this.renderUntil = Math.max(this.renderUntil, performance.now() + ms);
  }
  private shouldRender(animating: boolean): boolean {
    this.camera.updateMatrixWorld();
    const moved = !sameView(this.lastView, this.camera.matrixWorld) || !this.lastProj.equals(this.camera.projectionMatrix);
    // the cursor moved along the well (timeline, log scroll) or the hover highlight changed (a panel dragged
    // across the log tracks moves it too: that waits for the release)
    const md = this.rig.md;
    const hover = (this.wellbore?.uniforms.uHoverMd.value as number | undefined) ?? -1e6;
    const changed = md !== this.lastMd || (hover !== this.lastHover && !this.chromeDrag);
    if (!moved && !changed && !animating && !this.framePending && performance.now() > this.renderUntil) return false;
    this.framePending = false;
    this.lastView.copy(this.camera.matrixWorld);
    this.lastProj.copy(this.camera.projectionMatrix);
    this.lastMd = md;
    this.lastHover = hover;
    return true;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const cv = this.renderer.domElement;
    // a drag that started on the chrome (a panel or window being moved) and crosses the view
    // does not redraw it; nor does moving the pointer over the view (the hover highlight is
    // seen through its uniform)
    let downOnView = false;
    const opts = { passive: true, capture: true };
    window.addEventListener(
      'pointerdown',
      (e) => {
        downOnView = e.target === cv;
        if (downOnView) this.requestRender(600);
        else this.chromeDrag = true;
      },
      opts,
    );
    const release = () => {
      downOnView = false;
      if (!this.chromeDrag) return;
      this.chromeDrag = false;
      // the framing the panels asked for while they were dragged
      this.offsetMoving = true;
    };
    window.addEventListener('pointerup', release, opts);
    window.addEventListener('pointercancel', release, opts);
    window.addEventListener('blur', release);
    cv.addEventListener('pointermove', () => downOnView && this.requestRender(600), { passive: true });
    cv.addEventListener('wheel', () => this.requestRender(600), { passive: true });
    window.addEventListener('keydown', (e) => {
      // typing in the chrome (search, forms) is not navigation
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('input, textarea, select, [contenteditable="true"]')) this.requestRender(300);
    });
    // Safety net for state that changes the scene without saying so: a click anywhere draws a frame or two
    // (a click is discrete, so this costs nothing during drags).
    window.addEventListener('click', () => this.requestRender(34), opts);
    const loop = (ts: number) => {
      requestAnimationFrame(loop);
      this.timer.update(ts);
      // capped so a stall cannot teleport the camera, but loose enough that playback
      // keeps its speed at low frame rates (a 0.05 s cap halved it below 20 fps)
      const dt = Math.min(0.2, this.timer.getDelta());
      this.tick(dt);
    };
    requestAnimationFrame(loop);
  }

  // Adaptive quality, measured only on frames that were drawn: GPU time where the browser exposes
  // it, otherwise the interval between two consecutive drawn frames. Budget: 60 fps. Slow windows
  // first drop MSAA to 2×, then step the pixel ratio down; with GPU timing, headroom steps back up
  // (the thresholds are far enough apart that one step cannot flip the verdict).
  private frameMs: number[] = [];
  private prScale = 1;
  private slowWindows = 0;
  private fastWindows = 0;
  private drewLastTick = false;
  private lastDrawAt = 0;
  private noteFrameMs(ms: number) {
    if (this.quality === 'low') return;
    this.frameMs.push(ms);
    if (this.frameMs.length < 45) return;
    const avg = this.frameMs.reduce((a, b) => a + b, 0) / this.frameMs.length;
    this.frameMs = [];
    const gpu = !!this.gpu;
    const slow = gpu ? avg > 12 : avg > 20;
    const fast = gpu && avg < 5.5;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    this.fastWindows = fast ? this.fastWindows + 1 : 0;
    if (this.slowWindows >= 2) {
      this.slowWindows = 0;
      if (this.scenePass.samples > 2) this.scenePass.samples = 2;
      else if (this.prScale > 0.55) this.setPrScale(Math.max(0.55, this.prScale - 0.15));
    } else if (this.fastWindows >= 3) {
      this.fastWindows = 0;
      if (this.prScale < 1) this.setPrScale(Math.min(1, this.prScale + 0.15));
      else if (this.scenePass.samples < 4) this.scenePass.samples = 4;
    }
  }
  private setPrScale(k: number) {
    this.prScale = k;
    this.realloc();
  }

  private tick(dt: number) {
    const t = this.timer.getElapsed();
    this.gpu?.poll((ms) => this.noteFrameMs(ms));
    this.rig.update(dt);
    this.stepViewOffset(dt);
    const wb = this.wellbore;
    const inside = !!wb && this.rig.mode === 'guided' && this.rig.guidedView === 'tunnel';
    const tfx = this.fx.tunnel && inside;
    // nothing changed: skip the scene work as well as the draw (the chrome's per-frame hooks still run)
    const draw = this.shouldRender(this.rig.playing || tfx);
    if (draw) this.updateScene(t, inside, tfx);
    this.onFrame?.(dt);
    if (!draw) {
      this.drewLastTick = false;
      return;
    }
    wb?.cullTubes(this.camera, this.renderer.domElement.height);
    this.gpu?.begin();
    this.composer.render();
    this.gpu?.end();
    // the WebGL render just updated the scene graph's matrices
    this.labelRenderer.render(this.scene, this.camera, false);
    this.labelRenderer.declutter(this.labelDensity);
    const now = performance.now();
    if (!this.gpu && this.drewLastTick && now - this.lastDrawAt < 100) this.noteFrameMs(now - this.lastDrawAt);
    this.drewLastTick = true;
    this.lastDrawAt = now;
    if (this.drawWaiters.length) {
      const due = this.drawWaiters.filter((w) => --w.n <= 0);
      this.drawWaiters = this.drawWaiters.filter((w) => w.n > 0);
      for (const w of due) w.resolve();
    }
  }

  private drawWaiters: { n: number; resolve: () => void }[] = [];

  /** Resolves once the view has drawn `n` more frames (it draws on demand: this asks for them). */
  whenDrawn(n = 1): Promise<void> {
    this.requestRender(500);
    return new Promise((resolve) => this.drawWaiters.push({ n, resolve }));
  }

  /** Per-frame scene state that depends on the camera, the cursor and the time: only when a frame is drawn. */
  private updateScene(t: number, inside: boolean, tfx: boolean) {
    const cam = this.camera.position;
    this.geology.sortForCamera(cam.y);
    const wb = this.wellbore;
    if (wb) {
      wb.setCursor(this.rig.md);
      wb.update(this.camera, t, this.labelsVisible, this.rig.md, inside);
      // cutaway only when looking at the well from outside
      const f = wb.frameAt(this.rig.md);
      this.tunnel = inside;
      wb.uniforms.uCut.value = inside ? 0 : 1;
      this.headlight.intensity = inside ? 7 : cam.distanceTo(f.pos) < 300 ? 4 : 0;
      this.headlight.distance = inside ? 140 : 400;
      // proximity bubble in the regional model around the point of interest
      const guided = this.rig.mode === 'guided';
      this.geology.setGuided(guided || (cam.y < -this.field.meta.waterDepth && this.rig.exploreView === 'fly'));
      if (guided) {
        FOCUS.uFocus.value.copy(f.pos).lerp(cam, 0.35);
        FOCUS.uFocusR.value = Math.max(150, cam.distanceTo(f.pos) * 2.4);
        FOCUS.uFocusOn.value = 1;
      } else if (cam.y < -this.field.meta.waterDepth) {
        FOCUS.uFocus.value.copy(cam);
        FOCUS.uFocusR.value = 220;
        FOCUS.uFocusOn.value = 1;
      } else FOCUS.uFocusOn.value = 0;
    }
    this.paths.update(this.camera, this.contextVisible && this.labelsVisible);
    this.paths.group.visible = this.contextVisible;
    // atmosphere: water tint below sea level, faint rock-tinted haze inside formations
    const under = cam.y < 0;
    this.env.update(t, under);
    const ex = this.field.extent;
    const inBox = cam.x > ex.xMin && cam.x < ex.xMax && -cam.z > ex.nMin && -cam.z < ex.nMax;
    this.cameraFormation = null;
    if (under && inBox) {
      const { tvdss, ns, ew } = this.coords.fromScene(cam);
      if (this.tunnel) {
        this.fog.color.setRGB(0.012, 0.012, 0.014);
        this.fog.density = 0.011;
        this.cameraFormation = formationAt(this.field.horizons, ew, ns, tvdss);
      } else if (tvdss < this.field.meta.waterDepth) {
        this.fog.color.setRGB(0.02, 0.07, 0.1);
        this.fog.density = 0.0009;
        this.cameraFormation = 'sea';
      } else {
        this.cameraFormation = formationAt(this.field.horizons, ew, ns, tvdss);
        this.fog.color.setRGB(0.028, 0.03, 0.034);
        this.fog.density = this.rig.mode === 'guided' ? 0.0011 : 0.00025;
      }
    } else {
      this.fog.density = 0;
    }
    // inside the borehole the sky cannot reach: the camera lamp becomes the key light
    this.sun.intensity = this.tunnel ? 0.12 : under ? 2.2 : 3.2;
    this.hemi.intensity = this.tunnel ? 0.05 : 0.55;
    this.scene.environmentIntensity = this.tunnel ? 0.12 : 0.55;
    this.final.uniforms.uTime.value = t;
    // inside-the-hole atmosphere: lens blur and drifting fluid particles
    this.lensPass.enabled = tfx && this.quality !== 'low';
    if (wb && tfx) {
      const r = wb.innerRadiusAt(this.rig.md);
      this.mud.update(this.camera, t, true, Math.max(3, r * 3.2), this.renderer.domElement.height);
    } else this.mud.update(this.camera, t, false, 1, 1);
  }

  /** Render one frame immediately (used by the snapshot export). */
  renderFrame() {
    this.composer.render();
  }

  private rect: DOMRect | null = null;
  /** The canvas' client rect, measured once per layout change: hover picks run on pointer moves, and a fresh read would force a layout. */
  private canvasRect(): DOMRect {
    return (this.rect ??= this.renderer.domElement.getBoundingClientRect());
  }

  /** Raycast the scene at client coordinates. */
  pick(clientX: number, clientY: number, hoverOnly = false): PickResult | null {
    const rect = this.canvasRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line = { threshold: 2 };
    const targets: THREE.Object3D[] = [];
    const wb = this.wellbore;
    if (wb) {
      targets.push(wb.wall);
      if (wb.overviewTube.visible) targets.push(wb.overviewTube);
      if (!hoverOnly) {
        targets.push(...wb.casings.filter((m) => m.visible), ...wb.fractureGroup.children.filter((c) => c.visible && wb.fractureGroup.visible));
        if (wb.payGroup.visible) targets.push(...wb.payGroup.children);
        targets.push(...wb.markers.children);
      }
    }
    if (!hoverOnly) {
      for (const m of this.geology.meshes.values()) if (m.visible && (m.material as THREE.Material).opacity > 0.15) targets.push(m);
      if (this.paths.group.visible) targets.push(...this.paths.group.children.filter((c) => c.type === 'Mesh'));
      targets.push(this.env.platform);
      for (const o of this.pickables) if (o.visible && o.parent) targets.push(o);
    }
    ensureBVHFor(targets);
    const hits = this.raycaster.intersectObjects(targets, true);
    // What a click passes through on its way to what it means: a see-through envelope around
    // the well (the uncertainty cones) gives way to the well behind it; a formation drawn as
    // glass gives way to what shows through it (the well, an overlay, another well), but not
    // to a solid formation behind (then the glass one was clicked).
    const WELL_PARTS = new Set(['wall', 'casing', 'cement', 'fracture', 'top', 'pay']);
    let soft: { hit: PickResult; glass: boolean } | null = null;
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData?.kind) o = o.parent;
      if (!o) continue;
      // a hidden part is not the thing drawn
      if (!h.object.visible) continue;
      const kind = o.userData.kind as string;
      const glass = kind === 'formation' && ((h.object as THREE.Mesh).material as THREE.Material).opacity < 0.7;
      if (!soft && (glass || o.userData.soft)) {
        soft = { hit: { kind, point: h.point.clone(), object: o }, glass };
        continue;
      }
      if (soft) {
        // more glass on the way through
        if (soft.glass && glass) continue;
        if (soft.glass ? kind === 'formation' : !WELL_PARTS.has(kind)) return soft.hit;
      }
      // respect the wall cutaway: skip hits on the removed wedge
      if ((kind === 'wall' || kind === 'casing') && wb && wb.uniforms.uCut.value > 0.5) {
        const md = h.uv ? h.uv.y : undefined;
        if (md !== undefined) {
          const f = wb.frameAt(md);
          const r = h.point.clone().sub(f.pos);
          const toCam = this.camera.position.clone().sub(f.pos);
          toCam.addScaledVector(f.tan, -toCam.dot(f.tan));
          if (r.normalize().dot(toCam.normalize()) > wb.uniforms.uCutCos.value) continue;
        }
      }
      return { kind, point: h.point.clone(), md: h.uv && (kind === 'wall' || kind === 'casing') ? h.uv.y : undefined, object: o };
    }
    return soft?.hit ?? null;
  }

  /** Viewpoint that frames the whole model. */
  overviewPose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const e = this.geology.box;
    const cx = (e.xMin + e.xMax) / 2;
    const cn = (e.nMin + e.nMax) / 2;
    const size = Math.max(e.xMax - e.xMin, e.nMax - e.nMin, 2500);
    const target = new THREE.Vector3(cx, -1900, -cn);
    const pos = new THREE.Vector3(cx - size * 0.55, 900, -cn + size * 0.8);
    return { pos, target };
  }
}
