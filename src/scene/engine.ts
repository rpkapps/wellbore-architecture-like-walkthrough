import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FieldModel, Well } from '../data/dataset';
import type { ColormapName } from '../data/colormap';
import { formationAt } from '../data/surfaces';
import { Coords } from './coords';
import { GeologyModel } from './geology';
import { WellboreAssembly, type PropertyMode } from './wellbore';
import { Environment, WellPaths } from './environment';
import { CameraRig } from './cameraRig';
import { buildWellTextures, makeLutTexture } from './wellData';
import { FOCUS, SEABED } from './rockMaterial';
import { LensBlurShader, LogDepthAOPass, MudParticles } from './postfx';
import type { SectionBox } from './geology';
import { ensureBVHFor } from './bvh';

export interface PickResult {
  kind: string;
  point: THREE.Vector3;
  md?: number;
  object: THREE.Object3D;
}

const GradePass = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.85 },
    uGrain: { value: 0.035 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.95, 0.25, length(d * vec2(1.0, 0.85)) * uVignette * 1.2);
  c.rgb *= mix(0.72, 1.0, v);
  // gentle cool shadows / warm highlights grade
  float l = dot(c.rgb, vec3(0.299,0.587,0.114));
  c.rgb += (vec3(-0.006, 0.0, 0.012) * (1.0 - l) + vec3(0.01, 0.004, -0.008) * l);
  c.rgb += (h(vUv * 1000.0 + uTime) - 0.5) * uGrain * (1.0 - l * 0.6);
  gl_FragColor = c;
}`,
};

/** Replaces NaN / Inf pixels and clamps extreme HDR values before bloom can smear them. */
const SanitizePass = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
bool bad(float v){ return !(v == v) || abs(v) > 60000.0; }
void main(){
  vec4 c = texture2D(tDiffuse, vUv);
  if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 48.0), clamp(c.a, 0.0, 1.0));
}`,
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
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
  private grade: ShaderPass;
  private bloom: UnrealBloomPass;
  private raycaster = new THREE.Raycaster();
  private lutTex: THREE.DataTexture;
  mode: PropertyMode = 'resistivity';
  tunnel = false;
  labelsVisible = true;
  contextVisible = true;
  cameraFormation: string | null = null;
  onFrame?: (dt: number) => void;
  radialScale = 25;
  private fog: THREE.FogExp2;
  private aoPass: LogDepthAOPass;
  private lensPass: ShaderPass;
  readonly mud = new MudParticles();
  /** optional-feature switches (see src/features) */
  fx = { shadows: false, tunnel: false, sea: false };
  /** listeners for section-box changes (geology rebuilds) */
  boxListeners: ((b: SectionBox) => void)[] = [];

  readonly quality: 'high' | 'low';

  constructor(
    private container: HTMLElement,
    public field: FieldModel,
  ) {
    this.quality = /[?&]q=low/.test(location.search) ? 'low' : 'high';
    this.coords = new Coords(field.meta.datumElevation);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.quality === 'low' ? 1 : Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('gl');

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(container.clientWidth, container.clientHeight);
    this.labelRenderer.domElement.className = 'labels-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.05, 90000);
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

    const rt = new THREE.WebGLRenderTarget(container.clientWidth, container.clientHeight, { type: THREE.HalfFloatType, samples: this.quality === 'low' ? 0 : 4 });
    // depth is sampled by the ambient-occlusion pass (log-depth aware)
    rt.depthTexture = new THREE.DepthTexture(container.clientWidth, container.clientHeight, THREE.FloatType);
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.aoPass = new LogDepthAOPass(this.camera);
    this.aoPass.enabled = false;
    this.composer.addPass(this.aoPass);
    this.composer.addPass(new ShaderPass(SanitizePass));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.32, 0.55, 0.88);
    this.bloom.enabled = this.quality !== 'low';
    this.composer.addPass(this.bloom);
    this.lensPass = new ShaderPass(LensBlurShader);
    this.lensPass.enabled = false;
    this.composer.addPass(this.lensPass);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradePass);
    this.composer.addPass(this.grade);

    this.rig = new CameraRig(this.camera, this.renderer.domElement);
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
    };
    this.scene.add(this.mud.points, this.sun.target);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // the block and platform are static: render the shadow map only when something changes
    this.renderer.shadowMap.autoUpdate = false;
    this.geology.onStateChange = () => (this.renderer.shadowMap.needsUpdate = true);
    this.sun.shadow.mapSize.setScalar(this.quality === 'low' ? 1024 : 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.5;
    this.fitShadowCamera();
    this.paths = new WellPaths(field, this.coords);
    this.scene.add(this.paths.group);

    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(container);
  }

  private insets = { left: 0, right: 0 };
  setInsets(left: number, right: number) {
    this.insets = { left, right };
    this.resize();
  }

  /** Glow + film grade can be switched off from the Display panel. */
  setPostFx(on: boolean) {
    this.bloom.enabled = on;
    this.grade.enabled = on;
  }

  /** Sun shadows on the platform, sea and geological block. */
  setShadows(on: boolean) {
    this.fx.shadows = on;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.aoPass.enabled = on;
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
  }

  setTunnelFx(on: boolean) {
    this.fx.tunnel = on;
    if (!on) this.lensPass.enabled = false;
  }

  setSeaFx(on: boolean) {
    this.fx.sea = on;
    this.env.setDetail(on);
    SEABED.uSeabedOn.value = on ? 1 : 0;
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

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    // shift the projection centre into the free area between the side panels
    const shift = (this.insets.left - this.insets.right) / 2;
    if (Math.abs(shift) > 1 && w > 900) this.camera.setViewOffset(w, h, -shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.aoPass.setSize(w * pr, h * pr);
    (this.lensPass.uniforms as Record<string, THREE.IUniform>).uAspect.value = w / h;
    this.labelRenderer.setSize(w, h);
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
    // build the picking BVH for the heavy wall geometry off the critical path, not on the first hover
    const wb = this.wellbore;
    const build = () => {
      if (this.wellbore === wb) ensureBVHFor([wb.wall, wb.overviewTube, ...wb.casings]);
    };
    // the render loop can keep the browser from ever going idle: cap the wait
    if ('requestIdleCallback' in window) requestIdleCallback(build, { timeout: 1500 });
    else setTimeout(build, 500);
  }

  /** Re-upload log/interpretation textures after parameters or data changed. */
  /** Interpretation changed only: update data textures in place. */
  refreshInterpretation() {
    if (this.wellbore) this.wellbore.updateTextures(buildWellTextures(this.activeWell));
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
  }

  setColormap(name: ColormapName) {
    const t = makeLutTexture(name);
    this.lutTex.dispose();
    this.lutTex = t;
    this.wellbore?.setLut(t);
  }

  setRadialScale(s: number) {
    this.radialScale = s;
    this.wellbore?.setRadialScale(s);
  }

  start() {
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

  // adaptive resolution: step the pixel ratio down on slow GPUs, back up when there is headroom
  private frameTimes: number[] = [];
  private prScale = 1;
  private adapt(dt: number) {
    if (this.quality === 'low' || this.prScale <= 0.55) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    // step down only, and only after two consecutive slow windows: never oscillates
    this.slowWindows = avg > 1 / 28 ? this.slowWindows + 1 : 0;
    if (this.slowWindows < 2) return;
    this.slowWindows = 0;
    this.prScale = Math.max(0.55, this.prScale - 0.15);
    const pr = Math.min(window.devicePixelRatio, 1.75) * this.prScale;
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.resize();
  }
  private slowWindows = 0;

  private tick(dt: number) {
    const t = this.timer.getElapsed();
    this.adapt(dt);
    this.rig.update(dt);
    const cam = this.camera.position;
    this.geology.sortForCamera(cam.y);
    const wb = this.wellbore;
    if (wb) {
      wb.setCursor(this.rig.md);
      wb.update(this.camera, t, this.labelsVisible, this.rig.md, this.rig.mode === 'guided' && this.rig.guidedView === 'tunnel');
      // cutaway only when looking at the well from outside
      const f = wb.frameAt(this.rig.md);
      const inside = this.rig.mode === 'guided' && this.rig.guidedView === 'tunnel';
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
    (this.grade.uniforms as Record<string, THREE.IUniform>).uTime.value = t;
    // inside-the-hole atmosphere: lens blur and drifting fluid particles
    const tfx = this.fx.tunnel && this.tunnel;
    this.lensPass.enabled = tfx && this.quality !== 'low';
    if (wb && tfx) {
      const r = wb.innerRadiusAt(this.rig.md);
      this.mud.update(this.camera, t, true, Math.max(3, r * 3.2), this.renderer.domElement.height);
    } else this.mud.update(this.camera, t, false, 1, 1);
    this.onFrame?.(dt);
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** Render one frame immediately (used by the snapshot export). */
  renderFrame() {
    this.composer.render();
  }

  /** Raycast the scene at client coordinates. */
  pick(clientX: number, clientY: number, hoverOnly = false): PickResult | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
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
    }
    ensureBVHFor(targets);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData?.kind) o = o.parent;
      if (!o) continue;
      const kind = o.userData.kind as string;
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
    return null;
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
