import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { FieldModel, Well } from '../data/dataset';
import type { Coords } from './coords';
import { NOISE } from './glsl';

/** Sea surface, water column, sky dome and a stylised jack-up production unit. */
export class Environment {
  readonly group = new THREE.Group();
  sea!: THREE.Mesh;
  waterColumn!: THREE.Mesh;
  platform = new THREE.Group();
  sky!: THREE.Mesh;
  private seaUniforms = { uTime: { value: 0 } };

  constructor(private field: FieldModel) {
    this.buildSky();
    this.buildSea();
    this.buildPlatform();
    this.group.add(this.platform);
  }

  private buildSky() {
    const g = new THREE.SphereGeometry(40000, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uUnder: { value: 0 } },
      vertexShader: `varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vDir = normalize(position); vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `varying vec3 vDir; uniform float uUnder;
#include <common>
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  float h = vDir.y;
  vec3 zenith = vec3(0.012, 0.018, 0.028);
  vec3 horizon = vec3(0.06, 0.075, 0.095);
  vec3 below = vec3(0.012, 0.016, 0.022);
  vec3 c = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon * 0.5, below, pow(-h, 0.4));
  // faint warm glow toward the low sun
  float sun = max(dot(vDir, normalize(vec3(-0.5, 0.18, 0.6))), 0.0);
  c += vec3(0.35, 0.22, 0.12) * pow(sun, 18.0) * 0.6;
  c = mix(c, vec3(0.008, 0.012, 0.016), uUnder);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    this.sky = new THREE.Mesh(g, m);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);
  }

  /** Keep the sea opening and the water column matched to the geology section box. */
  setBox(b: { xMin: number; xMax: number; nMin: number; nMax: number; stripTo: number }) {
    this.sea.geometry.dispose();
    this.sea.geometry = this.seaGeometry(b);
    const wd = this.field.meta.waterDepth;
    const bw = b.xMax - b.xMin;
    const bh = b.nMax - b.nMin;
    this.waterColumn.scale.set(bw / this.wcBase.w, 1, bh / this.wcBase.h);
    this.waterColumn.position.set((b.xMin + b.xMax) / 2, -wd / 2, -(b.nMin + b.nMax) / 2);
    this.waterColumn.visible = this.seaVisible && b.stripTo < wd;
  }

  seaVisible = true;
  private wcBase = { w: 1, h: 1 };

  private seaGeometry(hb: { xMin: number; xMax: number; nMin: number; nMax: number }) {
    const e = this.field.extent;
    const w = (e.xMax - e.xMin) * 3.2;
    const h = (e.nMax - e.nMin) * 3.2;
    const cx = (e.xMin + e.xMax) / 2;
    const cn = (e.nMin + e.nMax) / 2;
    const shape = new THREE.Shape();
    shape.moveTo(cx - w / 2, cn - h / 2);
    shape.lineTo(cx + w / 2, cn - h / 2);
    shape.lineTo(cx + w / 2, cn + h / 2);
    shape.lineTo(cx - w / 2, cn + h / 2);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(hb.xMin, hb.nMin);
    hole.lineTo(hb.xMin, hb.nMax);
    hole.lineTo(hb.xMax, hb.nMax);
    hole.lineTo(hb.xMax, hb.nMin);
    hole.closePath();
    shape.holes.push(hole);
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2); // shape y (north) -> -z
    return g;
  }

  private buildSea() {
    const e = this.field.extent;
    const cx = (e.xMin + e.xMax) / 2;
    const cn = (e.nMin + e.nMax) / 2;
    const g = this.seaGeometry(e);
    const m = new THREE.MeshStandardMaterial({
      color: 0x0c2433,
      roughness: 0.42,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 0.25,
    });
    const su = this.seaUniforms;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, su);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix*vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWP; uniform float uTime;\n${NOISE}`)
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
float fw = length(fwidth(vWP));
float k = 1.0 - smoothstep(2.0, 12.0, fw);
vec3 q = vec3(vWP.x * 0.012, uTime * 0.08, vWP.z * 0.012);
float nx = snoise(q + vec3(0.7, 0.0, 0.0)) - snoise(q - vec3(0.7, 0.0, 0.0));
float nz = snoise(q + vec3(0.0, 0.0, 0.7)) - snoise(q - vec3(0.0, 0.0, 0.7));
vec3 wn = normalize(vec3(-nx * 0.08 * k, 1.0, -nz * 0.08 * k));
normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz) * (gl_FrontFacing ? 1.0 : -1.0);`,
        );
    };
    m.customProgramCacheKey = () => 'sea-v1';
    this.sea = new THREE.Mesh(g, m);
    this.sea.renderOrder = 40;
    this.sea.userData = { kind: 'sea' };
    this.group.add(this.sea);

    // water column box between the sea surface and the seabed (model extent only)
    const wd = this.field.meta.waterDepth;
    const bw = e.xMax - e.xMin;
    const bh = e.nMax - e.nMin;
    const bg = new THREE.BoxGeometry(bw, wd, bh);
    this.wcBase = { w: bw, h: bh };
    const bm = new THREE.MeshStandardMaterial({
      color: 0x2a6f93,
      transparent: true,
      opacity: 0.12,
      roughness: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.waterColumn = new THREE.Mesh(bg, bm);
    this.waterColumn.position.set(cx, -wd / 2, -cn);
    this.waterColumn.renderOrder = 3;
    this.waterColumn.userData = { kind: 'sea' };
    this.group.add(this.waterColumn);
  }

  private buildPlatform() {
    // Stylised jack-up (Maersk Inspirer class): triangular hull, three lattice legs to the seabed, derrick on cantilever over the well slots.
    const steel = new THREE.MeshStandardMaterial({ color: 0x7c848c, metalness: 0.75, roughness: 0.45 });
    const paint = new THREE.MeshStandardMaterial({ color: 0x3c434b, metalness: 0.3, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb8742c, metalness: 0.3, roughness: 0.55 });
    const lamp = new THREE.MeshBasicMaterial({ color: 0xffd7a0, toneMapped: false });
    const wd = this.field.meta.waterDepth;
    const deckY = 38;
    const hullC = new THREE.Vector3(0, deckY, 42);
    // hull: rounded triangle prism
    const tri = new THREE.Shape();
    const R = 52;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      const x = Math.cos(a) * R;
      const y = Math.sin(a) * R;
      if (i === 0) tri.moveTo(x, y);
      else tri.lineTo(x, y);
    }
    tri.closePath();
    const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 9, bevelEnabled: true, bevelSize: 2, bevelThickness: 2, bevelSegments: 2 }), paint);
    hull.rotation.x = -Math.PI / 2;
    hull.position.copy(hullC).add(new THREE.Vector3(0, -9, 0));
    this.platform.add(hull);
    // legs
    const legH = deckY + wd + 25;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      const lx = hullC.x + Math.cos(a) * (R - 6);
      const lz = hullC.z - Math.sin(a) * (R - 6);
      const leg = new THREE.Group();
      const chords = 3;
      for (let c = 0; c < chords; c++) {
        const ca = (c / chords) * Math.PI * 2;
        const chord = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, legH, 8), accent);
        chord.position.set(Math.cos(ca) * 5, 0, Math.sin(ca) * 5);
        leg.add(chord);
      }
      // bracing
      const nb = Math.floor(legH / 9);
      const brace = new THREE.CylinderGeometry(0.28, 0.28, 11, 5);
      for (let b = 0; b < nb; b++) {
        for (let c = 0; c < chords; c++) {
          const ca = (c / chords) * Math.PI * 2;
          const cb = ((c + 1) / chords) * Math.PI * 2;
          const p0 = new THREE.Vector3(Math.cos(ca) * 5, -legH / 2 + b * 9, Math.sin(ca) * 5);
          const p1 = new THREE.Vector3(Math.cos(cb) * 5, -legH / 2 + b * 9 + 9, Math.sin(cb) * 5);
          const m = new THREE.Mesh(brace, steel);
          m.position.copy(p0).add(p1).multiplyScalar(0.5);
          m.lookAt(p1);
          m.rotateX(Math.PI / 2);
          m.scale.y = p0.distanceTo(p1) / 11;
          leg.add(m);
        }
      }
      // spud can
      const can = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 5, 16), paint);
      can.position.y = -legH / 2 + 2;
      leg.add(can);
      leg.position.set(lx, deckY + 25 - legH / 2, lz);
      this.platform.add(leg);
    }
    // cantilever + derrick above the well slots (origin)
    const cant = new THREE.Mesh(new THREE.BoxGeometry(22, 5, 36), paint);
    cant.position.set(0, deckY + 2.5, 12);
    this.platform.add(cant);
    const drillFloor = new THREE.Mesh(new THREE.BoxGeometry(16, 2, 16), steel);
    drillFloor.position.set(0, this.field.meta.datumElevation - 1, 0);
    this.platform.add(drillFloor);
    const derrickH = 52;
    const base = this.field.meta.datumElevation;
    const legGeo = new THREE.CylinderGeometry(0.35, 0.5, derrickH, 6);
    for (let i = 0; i < 4; i++) {
      const sx = i % 2 ? 1 : -1;
      const sz = i < 2 ? 1 : -1;
      const m = new THREE.Mesh(legGeo, accent);
      m.position.set(sx * 3.5, base + derrickH / 2, sz * 3.5);
      m.rotation.z = -sx * 0.06;
      m.rotation.x = sz * 0.06;
      this.platform.add(m);
    }
    for (let y = 6; y < derrickH; y += 7) {
      const w = 7 - (y / derrickH) * 5.2;
      const ring = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, w), accent);
      ring.position.set(0, base + y, 0);
      this.platform.add(ring);
    }
    // accommodation block & helideck
    const quarters = new THREE.Mesh(new THREE.BoxGeometry(26, 14, 18), paint);
    quarters.position.set(-18, deckY + 7, 62);
    this.platform.add(quarters);
    const heli = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 0.8, 32), steel);
    heli.position.set(-24, deckY + 15, 76);
    this.platform.add(heli);
    const heliMark = new THREE.Mesh(new THREE.RingGeometry(6, 7, 32), new THREE.MeshBasicMaterial({ color: 0xd9d27a, side: THREE.DoubleSide }));
    heliMark.rotation.x = -Math.PI / 2;
    heliMark.position.set(-24, deckY + 15.45, 76);
    this.platform.add(heliMark);
    // flare boom
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 45, 6), steel);
    boom.position.set(30, deckY + 14, 70);
    boom.rotation.z = -0.9;
    this.platform.add(boom);
    const flare = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false }));
    flare.position.set(48, deckY + 27, 70);
    this.platform.add(flare);
    // obstruction lamps
    for (const p of [
      [0, base + derrickH + 0.5, 0],
      [-18, deckY + 15, 62],
    ]) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), lamp);
      l.position.set(p[0], p[1], p[2]);
      this.platform.add(l);
    }
    this.platform.traverse((o) => (o.userData = { kind: 'platform' }));
    const el = document.createElement('div');
    el.className = 'label3d platform';
    el.innerHTML = `<b>${this.field.meta.facility.split('(')[0].trim()}</b><span>${this.field.meta.name} field · ${this.field.meta.block}</span>`;
    const l = new CSS2DObject(el);
    l.position.set(0, base + derrickH + 12, 0);
    this.platform.add(l);
  }

  update(time: number, underwater: boolean) {
    this.seaUniforms.uTime.value = time;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uUnder.value = underwater ? 1 : 0;
  }
}

/** Trajectories of the other Volve wellbores (context) and of non-active detailed wells. */
export class WellPaths {
  readonly group = new THREE.Group();
  readonly labels = new THREE.Group();
  constructor(
    private field: FieldModel,
    private coords: Coords,
  ) {
    this.group.add(this.labels);
  }

  build(activeId: string) {
    for (const c of [...this.group.children]) if (c !== this.labels) this.group.remove(c);
    for (const l of [...this.labels.children]) {
      (l as CSS2DObject).element.remove();
      this.labels.remove(l);
    }
    const v = new THREE.Vector3();
    const mkTube = (pts: THREE.Vector3[], radius: number, mat: THREE.Material) => {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(600, pts.length * 2), radius, 8, false), mat);
    };
    const ctxMat = new THREE.MeshStandardMaterial({ color: 0x8795a3, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.55, depthWrite: false });
    for (const c of this.field.context) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < c.md.length; i++) pts.push(this.coords.toScene(c.ns[i], c.ew[i], c.tvd[i], new THREE.Vector3()));
      const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.5);
      if (clean.length < 2) continue;
      const m = mkTube(clean, 2.2, ctxMat);
      m.userData = { kind: 'contextWell', name: c.name, status: 'reconstructed' };
      m.renderOrder = 4;
      this.group.add(m);
      const end = clean[clean.length - 1];
      this.addLabel(`${c.name}`, 'ctx', end);
    }
    const accent = [0x5fd4ff, 0xa78bfa, 0x7ee0a1, 0xf5b971];
    this.field.wells.forEach((w: Well, k) => {
      if (w.id === activeId) return;
      const pts: THREE.Vector3[] = [];
      const t = w.trajectory;
      for (let i = 0; i < t.md.length; i += 5) pts.push(this.coords.toScene(t.ns[i], t.ew[i], t.tvd[i], new THREE.Vector3()));
      pts.push(this.coords.toScene(t.ns[t.md.length - 1], t.ew[t.md.length - 1], t.tvd[t.md.length - 1], v.clone()));
      const mat = new THREE.MeshStandardMaterial({
        color: accent[k % accent.length],
        emissive: accent[k % accent.length],
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.2,
      });
      const m = mkTube(pts, 4, mat);
      m.userData = { kind: 'detailWell', wellId: w.id };
      this.group.add(m);
      this.addLabel(`<b>${w.name}</b><span>${w.logs || w.lasFile ? 'logs · ' : ''}${w.trajectory.status} survey — click to open</span>`, 'well', pts[pts.length - 1]);
    });
  }

  private addLabel(html: string, cls: string, pos: THREE.Vector3) {
    const el = document.createElement('div');
    el.className = `label3d ${cls}`;
    el.innerHTML = html;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    this.labels.add(o);
  }

  update(camera: THREE.Camera, visible: boolean) {
    for (const o of this.labels.children as CSS2DObject[]) {
      const d = o.position.distanceTo(camera.position);
      o.visible = visible && d < 9000;
    }
  }
}
