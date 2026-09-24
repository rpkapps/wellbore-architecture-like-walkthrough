import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { FieldModel, Well } from '../data/dataset';
import { findCurve, sampleCurve } from '../data/las';
import { payIntervals } from '../data/petro';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { sampleHorizon } from '../data/surfaces';
import { RES_RANGE } from '../data/colormap';
import type { Coords } from './coords';
import { DATA_TEX, NOISE, ROCK } from './glsl';
import { formationUniforms, type WellTextures } from './wellData';
import { LAYER_CEMENT, LAYER_STEEL, REAL, REAL_GLSL } from './textures';

export type PropertyMode = 'lithology' | 'resistivity' | 'hydrocarbon' | 'rop';
const IN = 0.0254;
const MAX_FRAC = 64;
const SHELLS = 6;

export interface Frame {
  pos: THREE.Vector3;
  tan: THREE.Vector3;
  nor: THREE.Vector3;
  bin: THREE.Vector3;
  radius: number; // rendered hole radius (m, exaggerated)
}

export interface Fracture {
  md: number;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  strike: number;
  dip: number;
  set: string;
}

const SHARED_VERT_DECL = /* glsl */ `
attribute vec3 aAxis;
attribute vec3 aTan;
attribute float aStrat;
varying vec3 vWPos;
varying vec3 vAxis;
varying vec3 vTan;
varying float vMd;
varying float vStrat;
varying float vTubeU;
`;
const SHARED_VERT_BODY = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vAxis = (modelMatrix * vec4(aAxis, 1.0)).xyz;
vTan = normalize(mat3(modelMatrix) * aTan);
vMd = uv.y;
vStrat = aStrat;
vTubeU = uv.x;
`;
const SHARED_FRAG_DECL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vAxis;
varying vec3 vTan;
varying float vMd;
varying float vStrat;
varying float vTubeU;
uniform float uCut;
uniform float uCutCos;
uniform float uRadialScale;
uniform float uCursorMd;
uniform float uHoverMd;
uniform float uTime;
bool cutaway(){
  if (uCut < 0.5) return false;
  vec3 r = vWPos - vAxis; float rl = length(r);
  vec3 toCam = cameraPosition - vAxis; toCam -= dot(toCam, vTan) * vTan;
  float cl = length(toCam);
  if (cl < rl * 1.6 + 0.5) return false;
  return dot(r / max(rl, 1e-4), toCam / cl) > uCutCos;
}
float mdRing(float md, float target, float halfWidth){
  return 1.0 - smoothstep(halfWidth * 0.4, halfWidth, abs(md - target));
}
`;

/** Cylindrical texture mapping around the hole (rendered scale, isotropic) + tangent-space normals. */
const CYL_GLSL = /* glsl */ `
float gCylReal; vec3 gCylN;
vec2 cylUv(float tile){
  float circ = 6.2831853 * max(length(vWPos - vAxis), 0.01);
  float nrep = max(1.0, floor(circ / tile + 0.5));
  return vec2(vTubeU * nrep, vMd / (circ / nrep));
}
vec3 cylNormal(vec3 n, vec3 tn, float k){
  vec3 t = normalize((viewMatrix * vec4(vTan, 0.0)).xyz);
  vec3 b = normalize(cross(t, n));
  return normalize(n + (tn.x * b + tn.y * t) * k);
}
`;

type Uniforms = Record<string, THREE.IUniform>;

export class WellboreAssembly {
  readonly group = new THREE.Group();
  readonly labels = new THREE.Group();
  wall!: THREE.Mesh;
  casings: THREE.Mesh[] = [];
  cements: THREE.Mesh[] = [];
  shells: THREE.Mesh[] = [];
  fractureGroup = new THREE.Group();
  markers = new THREE.Group();
  payGroup = new THREE.Group();
  cursor!: THREE.Mesh;
  overviewTube!: THREE.Mesh;
  fractures: Fracture[] = [];
  uniforms: Uniforms;
  mode: PropertyMode = 'resistivity';
  radialScale = 25;
  private samples: Float64Array = new Float64Array(0);
  private pos!: Float32Array;
  private tan!: Float32Array;
  private nor!: Float32Array;
  private bin!: Float32Array;
  private rHole!: Float32Array; // real hole radius (m)
  private strat!: Float32Array;
  private shellMatRes: THREE.ShaderMaterial[] = [];
  private shellMatFluid: THREE.ShaderMaterial[] = [];
  private wallMat!: THREE.MeshStandardMaterial;
  private logStart = 0;
  private logEnd = 0;
  tex: WellTextures;

  constructor(
    readonly well: Well,
    private field: FieldModel,
    private coords: Coords,
    tex: WellTextures,
    lutTex: THREE.Texture,
  ) {
    this.tex = tex;
    this.group.name = `wellbore:${well.id}`;
    const fu = formationUniforms();
    this.uniforms = {
      uDataA: { value: tex.a },
      uDataB: { value: tex.b },
      uDataC: { value: tex.c },
      uLut: { value: lutTex },
      uDataStep: { value: tex.step },
      uDataMd0: { value: tex.md0 },
      uDataCount: { value: tex.count },
      uDataWidth: { value: tex.width },
      uMode: { value: 1 },
      uResLogMin: { value: Math.log10(RES_RANGE.min) },
      uResLogMax: { value: Math.log10(RES_RANGE.max) },
      uFormColor: { value: fu.colors },
      uFormLitho: { value: fu.litho },
      uCut: { value: 1 },
      uCutCos: { value: 0.25 },
      uRadialScale: { value: this.radialScale },
      uCursorMd: { value: -1e6 },
      uHoverMd: { value: -1e6 },
      uTime: { value: 0 },
      uWallOpacity: { value: 1 },
      uShellOpacity: { value: 1 },
      uFrac: { value: Array.from({ length: MAX_FRAC }, () => new THREE.Vector4()) },
      uFracN: { value: Array.from({ length: MAX_FRAC }, () => new THREE.Vector4()) },
      uFracCount: { value: 0 },
      uShowFractures: { value: 1 },
      uPayOnly: { value: 0 },
      uPoreScale: { value: 0.55 },
    };
    const logs = well.logs;
    if (logs) {
      const rt = findCurve(logs, 'RT');
      if (rt) {
        let a = -1, b = -1;
        for (let i = 0; i < rt.values.length; i++)
          if (!Number.isNaN(rt.values[i])) {
            if (a < 0) a = i;
            b = i;
          }
        this.logStart = a >= 0 ? logs.depth[a] : 0;
        this.logEnd = b >= 0 ? logs.depth[b] : 0;
      }
    }
    this.buildFrames();
    this.buildWall();
    this.buildCasing();
    this.buildShells();
    this.buildFractures();
    this.buildMarkers();
    this.buildPay();
    this.buildCursor();
    this.buildOverviewTube();
    this.group.add(this.fractureGroup, this.markers, this.payGroup, this.labels);
    this.setMode(this.mode);
  }

  // ------------------------------------------------------------------ geometry frames
  private holeRadiusReal(md: number): number {
    const logs = this.well.logs;
    const zone = this.well.zoneAt(md);
    if (zone && (zone.formationId === 'air' || zone.formationId === 'sea')) return (36 * IN) / 2;
    let cal = NaN;
    if (logs) {
      const c = findCurve(logs, 'CALI');
      if (c) cal = sampleCurve(logs.depth, c.values, md);
    }
    const sec = this.well.holeSections.find((s) => md >= s.topMD && md <= s.baseMD);
    const bit = sec ? sec.hole : 8.5;
    if (!Number.isFinite(cal) || cal < bit * 0.85 || cal > bit * 2.2) cal = bit;
    return (cal * IN) / 2;
  }

  private buildFrames() {
    const w = this.well;
    const td = w.tdMD;
    const breaks = new Set<number>();
    for (const s of w.holeSections) {
      breaks.add(s.topMD);
      breaks.add(s.baseMD);
    }
    for (const z of w.zones) breaks.add(z.topMD);
    const list: number[] = [];
    let md = 0;
    const hasCal = (m: number) => m >= this.logStart && m <= this.logEnd;
    const sortedBreaks = [...breaks].filter((b) => b > 0 && b < td).sort((a, b) => a - b);
    let bi = 0;
    while (md < td) {
      list.push(md);
      const step = hasCal(md) ? 1.0 : md < 200 ? 2 : 4;
      let next = md + step;
      while (bi < sortedBreaks.length && sortedBreaks[bi] <= md) bi++;
      if (bi < sortedBreaks.length && sortedBreaks[bi] < next) {
        const b = sortedBreaks[bi];
        if (b - 0.05 > md + 0.01) list.push(b - 0.05);
        next = b + 0.05;
      }
      md = next;
    }
    list.push(td);
    const n = list.length;
    this.samples = new Float64Array(list);
    this.pos = new Float32Array(n * 3);
    this.tan = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    this.bin = new Float32Array(n * 3);
    this.rHole = new Float32Array(n);
    this.strat = new Float32Array(n);
    const v = new THREE.Vector3();
    const traj = w.trajectory;
    for (let i = 0; i < n; i++) {
      const p = traj.at(Math.min(list[i], traj.mdEnd));
      // extend beyond the survey along the last tangent
      if (list[i] > traj.mdEnd) {
        const e = list[i] - traj.mdEnd;
        const inc = (p.inc * Math.PI) / 180;
        const azi = (p.azi * Math.PI) / 180;
        p.ns += e * Math.sin(inc) * Math.cos(azi);
        p.ew += e * Math.sin(inc) * Math.sin(azi);
        p.tvd += e * Math.cos(inc);
      }
      this.coords.toScene(p.ns, p.ew, p.tvd, v);
      this.pos.set([v.x, v.y, v.z], i * 3);
      this.rHole[i] = this.holeRadiusReal(list[i]);
      // stratigraphic depth below the top of the unit (for conformable bedding)
      const zone = w.zoneAt(list[i]);
      const hz = zone ? this.field.horizons.find((h) => h.id === zone.formationId) : undefined;
      const tvdss = p.tvd - this.field.meta.datumElevation;
      this.strat[i] = hz ? tvdss - sampleHorizon(hz, p.ew, p.ns) : zone ? list[i] - zone.topMD : 0;
    }
    // tangents & parallel-transport frames
    const T = new THREE.Vector3();
    const N = new THREE.Vector3(1, 0, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      a.fromArray(this.pos, Math.max(0, i - 1) * 3);
      b.fromArray(this.pos, Math.min(n - 1, i + 1) * 3);
      T.subVectors(b, a).normalize();
      if (T.lengthSq() < 0.5) T.set(0, -1, 0);
      N.addScaledVector(T, -N.dot(T));
      if (N.lengthSq() < 1e-6) N.set(0, 0, 1).addScaledVector(T, -T.z);
      N.normalize();
      const B = new THREE.Vector3().crossVectors(T, N).normalize();
      T.toArray(this.tan, i * 3);
      N.toArray(this.nor, i * 3);
      B.toArray(this.bin, i * 3);
    }
  }

  /** Index of the sample at or just below md. */
  private idx(md: number): number {
    const s = this.samples;
    let lo = 0;
    let hi = s.length - 1;
    if (md <= s[0]) return 0;
    if (md >= s[hi]) return hi - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (s[m] <= md) lo = m;
      else hi = m;
    }
    return lo;
  }

  frameAt(md: number, out?: Frame): Frame {
    const i = this.idx(md);
    const s = this.samples;
    const t = Math.min(1, Math.max(0, (md - s[i]) / (s[i + 1] - s[i] || 1)));
    const f = out ?? { pos: new THREE.Vector3(), tan: new THREE.Vector3(), nor: new THREE.Vector3(), bin: new THREE.Vector3(), radius: 0 };
    const lerp = (arr: Float32Array, o: THREE.Vector3) =>
      o.set(
        arr[i * 3] + (arr[i * 3 + 3] - arr[i * 3]) * t,
        arr[i * 3 + 1] + (arr[i * 3 + 4] - arr[i * 3 + 1]) * t,
        arr[i * 3 + 2] + (arr[i * 3 + 5] - arr[i * 3 + 2]) * t,
      );
    lerp(this.pos, f.pos);
    lerp(this.tan, f.tan).normalize();
    lerp(this.nor, f.nor).normalize();
    lerp(this.bin, f.bin).normalize();
    f.radius = (this.rHole[i] + (this.rHole[i + 1] - this.rHole[i]) * t) * this.radialScale;
    return f;
  }

  /** Innermost open radius (casing ID or hole) at md, rendered scale. */
  innerRadiusAt(md: number): number {
    let r = this.frameAt(md).radius;
    for (const c of this.well.casing) if (md >= c.topMD && md <= c.shoeMD) r = Math.min(r, ((c.od * 0.92 * IN) / 2) * this.radialScale);
    return r;
  }

  // ------------------------------------------------------------------ tube builder
  private tube(
    from: number,
    to: number,
    radiusAt: (i: number) => number,
    segs: number,
    stride = 1,
  ): THREE.BufferGeometry {
    const i0 = this.idx(from);
    const i1 = Math.min(this.samples.length - 1, this.idx(to) + 1);
    const rings: number[] = [];
    for (let i = i0; i <= i1; i += stride) rings.push(i);
    if (rings[rings.length - 1] !== i1) rings.push(i1);
    const nr = rings.length;
    const nv = nr * (segs + 1);
    const position = new Float32Array(nv * 3);
    const normal = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const axis = new Float32Array(nv * 3);
    const tan = new Float32Array(nv * 3);
    const strat = new Float32Array(nv);
    let k = 0;
    for (let r = 0; r < nr; r++) {
      const i = rings[r];
      const rad = radiusAt(i);
      const px = this.pos[i * 3], py = this.pos[i * 3 + 1], pz = this.pos[i * 3 + 2];
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const c = Math.cos(th), s = Math.sin(th);
        const dx = this.nor[i * 3] * c + this.bin[i * 3] * s;
        const dy = this.nor[i * 3 + 1] * c + this.bin[i * 3 + 1] * s;
        const dz = this.nor[i * 3 + 2] * c + this.bin[i * 3 + 2] * s;
        position[k * 3] = px + dx * rad;
        position[k * 3 + 1] = py + dy * rad;
        position[k * 3 + 2] = pz + dz * rad;
        normal[k * 3] = dx;
        normal[k * 3 + 1] = dy;
        normal[k * 3 + 2] = dz;
        uv[k * 2] = j / segs;
        uv[k * 2 + 1] = this.samples[i];
        axis[k * 3] = px;
        axis[k * 3 + 1] = py;
        axis[k * 3 + 2] = pz;
        tan[k * 3] = this.tan[i * 3];
        tan[k * 3 + 1] = this.tan[i * 3 + 1];
        tan[k * 3 + 2] = this.tan[i * 3 + 2];
        strat[k] = this.strat[i];
        k++;
      }
    }
    const index: number[] = [];
    for (let r = 0; r < nr - 1; r++)
      for (let j = 0; j < segs; j++) {
        const a = r * (segs + 1) + j;
        const b = a + segs + 1;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    g.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
    g.setAttribute('aStrat', new THREE.BufferAttribute(strat, 1));
    g.setIndex(index);
    g.computeBoundingSphere();
    g.userData = { rings, segs, radiusAt };
    return g;
  }

  /** Recompute vertex positions after a radial-scale change (no re-allocation). */
  private refit(mesh: THREE.Mesh) {
    const g = mesh.geometry;
    const { rings, segs, radiusAt } = g.userData as { rings: number[]; segs: number; radiusAt: (i: number) => number };
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    let k = 0;
    for (const i of rings) {
      const rad = radiusAt(i);
      for (let j = 0; j <= segs; j++) {
        p.setXYZ(k, this.pos[i * 3] + n.getX(k) * rad, this.pos[i * 3 + 1] + n.getY(k) * rad, this.pos[i * 3 + 2] + n.getZ(k) * rad);
        k++;
      }
    }
    p.needsUpdate = true;
    g.computeBoundingSphere();
  }

  private refitRibbon(k: number) {
    const g = this.overviewTube.geometry;
    g.userData.radiusAt = () => 5 * k;
    this.refit(this.overviewTube);
  }

  setRadialScale(s: number) {
    this.radialScale = s;
    this.uniforms.uRadialScale.value = s;
    for (const m of [this.wall, ...this.casings, ...this.cements, ...this.shells]) this.refit(m);
    this.buildFractures();
    this.buildMarkers();
    this.buildPay();
    this.cursor.scale.setScalar(1);
  }

  // ------------------------------------------------------------------ materials
  private injectShared(shader: THREE.WebGLProgramParametersWithUniforms, extraFragDecl: string) {
    Object.assign(shader.uniforms, this.uniforms, REAL);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SHARED_VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${SHARED_VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${SHARED_FRAG_DECL}\n${NOISE}\n${ROCK}\n${DATA_TEX}\n${REAL_GLSL}\n${CYL_GLSL}\n${extraFragDecl}`,
    );
  }

  private buildWall() {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 });
    mat.onBeforeCompile = (shader) => {
      this.injectShared(
        shader,
        `uniform float uMode; uniform float uResLogMin; uniform float uResLogMax;
uniform vec3 uFormColor[32]; uniform float uFormLitho[32];
uniform vec4 uFrac[${MAX_FRAC}]; uniform vec4 uFracN[${MAX_FRAC}]; uniform int uFracCount; uniform float uShowFractures;
uniform float uWallOpacity; uniform float uPayOnly;
float gRough; float gH; vec3 gEmit;`,
      );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
if (cutaway()) discard;
vec4 dA = fetchNearest(uDataA, vMd);
vec4 dB = fetchNearest(uDataB, vMd);
vec4 dC = fetchNearest(uDataC, vMd);
int fi = int(dB.w + 0.5 * sign(dB.w));
if (dB.w < -0.5) discard; // air gap & water column: only the conductor is shown`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
gEmit = vec3(0.0);
vec3 baseC = uFormColor[fi];
float litho = uFormLitho[fi];
float fw = length(fwidth(vWPos));
// bedding at true scale: vertical offset from the axis shrinks by the radial exaggeration
float strat = vStrat + (vAxis.y - vWPos.y) / uRadialScale;
vec3 rock = rockColor(litho, baseC, vWPos, strat, fw, gRough, gH);
gCylReal = 0.0;
if (uRealistic > 0.5) {
  // CC0 photo texture of the formation's lithology, mapped around the hole
  // world-space triplanar (not cylindrical): a repeat that runs along the hole would
  // line up with the tunnel camera and show as rings
  vec3 radial = vWPos - vAxis; radial -= dot(radial, vTan) * vTan;
  vec3 alb; vec3 arm; vec3 nW;
  realTri(litho, vWPos, normalize(radial + 1e-5), 2.5, fw, alb, arm, nW);
  gCylN = nW;
  float bed = dot(rock, vec3(0.299, 0.587, 0.114)) / max(dot(baseC, vec3(0.299, 0.587, 0.114)), 1e-3);
  rock = realTint(alb, litho, baseC, 0.5) * mix(1.0, clamp(bed, 0.6, 1.4), 0.4) * mix(1.0, arm.r, 0.7);
  gRough = clamp(arm.g, 0.35, 1.0);
  gCylReal = 1.0;
}
vec3 col = rock;
float lumR = dot(rock, vec3(0.299, 0.587, 0.114)) / max(dot(baseC, vec3(0.299, 0.587, 0.114)), 1e-3);
if (uMode > 2.5) {
  if (dC.w > -900.0) {
    col = ropColor(dC.w) * (0.6 + 0.4 * clamp(lumR, 0.3, 1.7));
    gRough = 0.7;
  } else {
    float hatch = step(0.5, fract((vMd + vWPos.x * 0.3) * 0.5));
    col = mix(rock * 0.35, rock * 0.45, hatch);
  }
} else if (uMode > 0.5 && uMode < 1.5) {
  if (dA.x > -900.0) {
    float t = (dA.y - uResLogMin) / (uResLogMax - uResLogMin); // borehole wall reads the shallow curve
    col = lutColor(t) * (0.55 + 0.45 * clamp(lumR, 0.3, 1.7));
    gRough = 0.6;
  } else {
    float hatch = step(0.5, fract((vMd + vWPos.x * 0.3) * 0.5));
    col = mix(rock * 0.35, rock * 0.45, hatch);
  }
} else if (uMode > 1.5 && uMode < 2.5) {
  if (dB.x > -900.0 && dB.y > -900.0) {
    float so = 1.0 - dB.x;
    float hc = clamp(dB.y * so * 4.0, 0.0, 1.0);
    // oil-stained rock, as seen on slabbed core under white light
    col = mix(rock, rock * vec3(0.42, 0.3, 0.17), hc * 0.85);
    gRough = mix(gRough, 0.35, hc);
    if (dC.x > 0.5) gEmit += vec3(0.9, 0.55, 0.12) * 0.035;
  } else {
    col = rock * 0.55;
  }
  if (uPayOnly > 0.5 && dC.x < 0.5) col *= 0.25;
}
// schematic natural fractures: traces where fracture planes cut the wall
if (uShowFractures > 0.5) {
  for (int k = 0; k < ${MAX_FRAC}; k++) {
    if (k >= uFracCount) break;
    vec4 c = uFrac[k]; vec4 nn = uFracN[k];
    vec3 rel = vWPos - c.xyz;
    if (dot(rel, rel) > c.w * c.w) continue;
    float d = abs(dot(rel, nn.xyz) + snoise(vWPos * 1.7) * 0.05);
    float crack = 1.0 - smoothstep(nn.w, nn.w + fw * 1.5, d);
    col = mix(col, vec3(0.02, 0.02, 0.02), crack * 0.9);
    gH -= crack * 1.5;
  }
}
// cursor & hover rings
float ring = mdRing(vMd, uCursorMd, 0.35 + fw);
float hov = mdRing(vMd, uHoverMd, 0.3 + fw);
gEmit += vec3(0.35, 0.8, 1.0) * ring * 1.6 + vec3(1.0, 0.85, 0.5) * hov * 1.0;
diffuseColor.rgb = col;
diffuseColor.a = uWallOpacity;`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (gCylReal > 0.5) normal = normalize((viewMatrix * vec4(gCylN, 0.0)).xyz) * faceDirection;\nelse normal = perturbNormalH(-vViewPosition, normal, gH, 0.04);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;');
    };
    mat.customProgramCacheKey = () => 'wall-v4';
    this.wallMat = mat;
    const geo = this.tube(0, this.well.tdMD, (i) => this.rHole[i] * this.radialScale, 48);
    this.wall = new THREE.Mesh(geo, mat);
    this.wall.name = 'borehole-wall';
    this.wall.userData = { kind: 'wall', wellId: this.well.id };
    this.wall.renderOrder = 20;
    this.group.add(this.wall);
  }

  private casingMaterial(kind: 'steel' | 'cement', opacity: number) {
    const mat =
      kind === 'steel'
        ? new THREE.MeshPhysicalMaterial({
            color: 0x9aa1a8,
            metalness: 1,
            roughness: 0.32,
            clearcoat: 0.25,
            clearcoatRoughness: 0.4,
            side: THREE.DoubleSide,
            transparent: opacity < 1,
            opacity,
            depthWrite: opacity >= 1,
            envMapIntensity: 1.1,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x8d8a84,
            roughness: 0.95,
            side: THREE.DoubleSide,
            transparent: opacity < 1,
            opacity,
            depthWrite: opacity >= 1,
          });
    mat.onBeforeCompile = (shader) => {
      this.injectShared(shader, 'float gH2; vec3 gCArm;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (cutaway()) discard;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (gCylReal > 0.5) roughnessFactor = clamp(gCArm.g, 0.2, 1.0);')
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nif (gCylReal > 0.5) metalnessFactor *= ${kind === 'steel' ? 'mix(0.25, 1.0, gCArm.b)' : '1.0'};`)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (gCylReal > 0.5) normal = cylNormal(normal, gCylN, 0.8);')
        .replace(
          '#include <color_fragment>',
          kind === 'steel'
            ? `#include <color_fragment>
float fw = length(fwidth(vWPos));
// casing couplings every 12.19 m (40 ft joints) + mill-scale mottling
float cpl = 1.0 - smoothstep(0.12, 0.2 + fw, abs(mod(vMd, 12.19) - 6.1) - 5.85);
float mott = aaNoise(vWPos, 1.4, fw) * 0.5 + aaNoise(vec3(vWPos.x, vMd * 3.0, vWPos.z), 3.0, fw) * 0.25;
diffuseColor.rgb *= 0.92 + 0.1 * mott;
gCylReal = 0.0;
if (uRealistic > 0.5) {
  vec2 cuv = cylUv(2.0);
  gCArm = rArm(cuv, ${LAYER_STEEL}.0);
  gCylN = rNrm(cuv, ${LAYER_STEEL}.0);
  // grey mill-finish steel with the photo's staining (the raw photo reads too rusty through the X-ray casing)
  vec3 st = rAlb(cuv, ${LAYER_STEEL}.0);
  diffuseColor.rgb = mix(vec3(dot(st, vec3(0.3, 0.59, 0.11))) * 1.25, st * 1.15, 0.45);
  gCylReal = 1.0;
}
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, cpl);
gH2 = cpl;`
            : `#include <color_fragment>
float fw = length(fwidth(vWPos));
diffuseColor.rgb *= 0.9 + 0.12 * aaNoise(vWPos, 2.5, fw);
gCylReal = 0.0;
if (uRealistic > 0.5) {
  vec2 cuv = cylUv(2.0);
  gCArm = rArm(cuv, ${LAYER_CEMENT}.0);
  gCylN = rNrm(cuv, ${LAYER_CEMENT}.0);
  diffuseColor.rgb = rAlb(cuv, ${LAYER_CEMENT}.0) * gCArm.r;
  gCylReal = 1.0;
}
gH2 = 0.0;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.35, 0.8, 1.0) * mdRing(vMd, uCursorMd, 0.35) * 0.8;`,
        );
    };
    mat.customProgramCacheKey = () => `casing-${kind}-v2`;
    return mat;
  }

  private buildCasing() {
    for (const m of [...this.casings, ...this.cements]) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.casings = [];
    this.cements = [];
    const casing = this.well.casing;
    casing.forEach((c, k) => {
      const rOut = (c.od * IN) / 2;
      const geo = this.tube(c.topMD, c.shoeMD, () => rOut * this.radialScale, 40, 2);
      const m = new THREE.Mesh(geo, this.casingMaterial('steel', 0.42));
      m.name = `casing:${c.name}`;
      m.userData = { kind: 'casing', casing: c, index: k };
      m.renderOrder = 30 + (casing.length - k);
      this.casings.push(m);
      this.group.add(m);
      // schematic cement sheath: full column for conductor/surface strings, ~500 m above shoe otherwise
      const cementTop = k <= 1 ? Math.max(c.topMD, this.well.zones[1]?.baseMD ?? 150) : Math.max(0, c.shoeMD - 500);
      const hole = c.hole;
      const rc = ((hole * IN) / 2) * 0.97;
      const cg = this.tube(cementTop, c.shoeMD, () => rc * this.radialScale, 32, 3);
      const cm = new THREE.Mesh(cg, this.casingMaterial('cement', 0.3));
      cm.name = `cement:${c.name}`;
      cm.userData = { kind: 'cement', casing: c, cementTop };
      cm.renderOrder = 25;
      this.cements.push(cm);
      this.group.add(cm);
    });
  }

  private buildShells() {
    if (!(this.logEnd > this.logStart)) return;
    const vert = /* glsl */ `
${SHARED_VERT_DECL}
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){
  vec3 transformed = position;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  ${SHARED_VERT_BODY}
}`;
    for (let s = 0; s < SHELLS; s++) {
      const frac = s / (SHELLS - 1);
      const factor = 1.18 + frac * 2.4; // depth of investigation (schematic radial scale)
      const geo = this.tube(this.logStart, this.logEnd, (i) => this.rHole[i] * this.radialScale * factor, 30, 2);
      const common = {
        uniforms: { ...this.uniforms, uShellFrac: { value: frac } },
        vertexShader: vert,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      };
      const fragHead = `
#include <common>
#include <logdepthbuf_pars_fragment>
${SHARED_FRAG_DECL}
${NOISE}
${DATA_TEX}
uniform float uShellFrac; uniform float uResLogMin; uniform float uResLogMax; uniform float uShellOpacity; uniform float uPoreScale; uniform float uPayOnly;`;
      const resMat = new THREE.ShaderMaterial({
        ...common,
        fragmentShader: `${fragHead}
void main(){
  #include <logdepthbuf_fragment>
  if (cutaway()) discard;
  vec4 A = fetchNearest(uDataA, vMd);
  if (A.x < -900.0) discard;
  // radial resistivity profile: shallow reading near the wall grading to the deep reading
  float lr = mix(A.y, A.x, smoothstep(0.0, 0.8, uShellFrac));
  float t = (lr - uResLogMin) / (uResLogMax - uResLogMin);
  vec3 c = lutColor(t);
  float fw = length(fwidth(vWPos));
  float a = uShellOpacity * (0.34 - 0.24 * uShellFrac) * (0.8 + 0.2 * aaNoise(vWPos, 0.6, fw));
  a += mdRing(vMd, uCursorMd, 0.5) * 0.4;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      });
      const fluidMat = new THREE.ShaderMaterial({
        ...common,
        fragmentShader: `${fragHead}
void main(){
  #include <logdepthbuf_fragment>
  if (cutaway()) discard;
  vec4 B = fetchNearest(uDataB, vMd);
  vec4 C = fetchNearest(uDataC, vMd);
  if (B.x < -900.0 || B.y < -900.0) discard;
  if (uPayOnly > 0.5 && C.x < 0.5) discard;
  float sw = clamp(B.x, 0.0, 1.0);
  float phi = clamp(B.y, 0.0, 0.4);
  float so = 1.0 - sw;
  // continuous hydrocarbon "body" (φ·So) modulated by a soft pore-scale network whose
  // connected fraction tracks porosity; each pore is oil- or water-filled in proportion to So
  vec3 q = vWPos * uPoreScale + vec3(0.0, uTime * 0.015, 0.0);
  vec2 w = worleyId(q);
  float thr = 0.35 + 0.8 * sqrt(phi / 0.3);
  float pore = 1.0 - smoothstep(thr * 0.45, thr, w.x);
  float oil = smoothstep(w.y - 0.08, w.y + 0.08, so);
  float hc = clamp(phi * so / 0.22, 0.0, 1.0);
  float wat = clamp(phi * sw / 0.22, 0.0, 1.0);
  vec3 oilC = vec3(0.85, 0.5, 0.1);
  vec3 watC = vec3(0.2, 0.5, 0.82);
  float core = pow(1.0 - clamp(w.x / thr, 0.0, 1.0), 1.5);
  vec3 c = mix(watC, oilC, oil) * (0.55 + 0.75 * core);
  // specular glint on fluid menisci
  c += (oil > 0.5 ? vec3(1.0, 0.78, 0.45) : vec3(0.65, 0.85, 1.0)) * pow(core, 8.0) * 0.9;
  float body = hc * 0.09 + wat * 0.025;
  float a = (body + pore * mix(0.035, 0.42, oil) * (0.35 + 0.65 * max(hc, wat * 0.4))) * uShellOpacity * (1.0 - 0.5 * uShellFrac);
  c = mix(mix(watC, oilC, step(sw, 0.5)) * 0.8, c, clamp(pore * 1.5, 0.0, 1.0));
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
      });
      this.shellMatRes.push(resMat);
      this.shellMatFluid.push(fluidMat);
      const mesh = new THREE.Mesh(geo, resMat);
      mesh.name = `shell:${s}`;
      mesh.userData = { kind: 'shell', frac, factor };
      mesh.renderOrder = 10 + (SHELLS - s);
      this.shells.push(mesh);
      this.group.add(mesh);
    }
  }

  // ------------------------------------------------------------------ fractures (schematic)
  private buildFractures() {
    this.fractureGroup.clear();
    this.fractures = [];
    let seed = 1;
    for (const ch of this.well.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sets = [
      { name: 'Set A (NNW–SSE)', strike: 155, dip: 78 },
      { name: 'Set B (ENE–WSW)', strike: 65, dip: 72 },
    ];
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x1b1d20,
      roughness: 0.3,
      metalness: 0.2,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const rimMat = new THREE.LineBasicMaterial({ color: 0xc8d2dc, transparent: true, opacity: 0.35 });
    for (const z of this.well.zones) {
      const f = FORMATION_BY_ID.get(z.formationId);
      if (!f) continue;
      const density = f.lithology === 'chalk' ? 1 / 22 : f.lithology === 'marl' ? 1 / 45 : f.reservoir ? 1 / 90 : 0;
      if (!density) continue;
      let md = z.topMD + rnd() / density;
      while (md < z.baseMD && this.fractures.length < MAX_FRAC) {
        const set = sets[rnd() < 0.6 ? 0 : 1];
        const strike = set.strike + (rnd() - 0.5) * 16;
        const dip = Math.min(89, set.dip + (rnd() - 0.5) * 12);
        const dd = ((strike + 90) * Math.PI) / 180;
        const dr = (dip * Math.PI) / 180;
        const normal = new THREE.Vector3(Math.sin(dr) * Math.sin(dd), Math.cos(dr), -Math.sin(dr) * Math.cos(dd)).normalize();
        const fr = this.frameAt(md);
        const center = fr.pos.clone();
        this.fractures.push({ md, center, normal, strike: ((strike % 360) + 360) % 360, dip, set: set.name });
        const R = fr.radius * 5.5;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 48), discMat);
        disc.position.copy(center);
        disc.lookAt(center.clone().add(normal));
        disc.userData = { kind: 'fracture', index: this.fractures.length - 1 };
        disc.renderOrder = 8;
        const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(new THREE.Path().absarc(0, 0, R, 0, Math.PI * 2, false).getPoints(64)), rimMat);
        disc.add(rim);
        this.fractureGroup.add(disc);
        md += (0.4 + rnd() * 1.2) / density;
      }
    }
    const fu = this.uniforms.uFrac.value as THREE.Vector4[];
    const fn = this.uniforms.uFracN.value as THREE.Vector4[];
    this.fractures.forEach((f, i) => {
      const R = this.frameAt(f.md).radius * 5.5;
      fu[i].set(f.center.x, f.center.y, f.center.z, R);
      fn[i].set(f.normal.x, f.normal.y, f.normal.z, 0.012 * this.radialScale * 0.5);
    });
    this.uniforms.uFracCount.value = this.fractures.length;
  }

  // ------------------------------------------------------------------ markers & labels
  private label(text: string, cls: string, pos: THREE.Vector3, data?: Record<string, unknown>) {
    const el = document.createElement('div');
    el.className = `label3d ${cls}`;
    el.innerHTML = text;
    const o = new CSS2DObject(el);
    o.position.copy(pos);
    o.userData = { ...data, cls };
    this.labels.add(o);
    return o;
  }

  private buildMarkers() {
    this.markers.clear();
    for (const l of [...this.labels.children]) {
      (l as CSS2DObject).element.remove();
      this.labels.remove(l);
    }
    const ringGeo = new THREE.TorusGeometry(1, 0.035, 8, 64);
    // formation tops
    for (const z of this.well.zones) {
      if (z.formationId === 'air' || z.formationId === 'sea') continue;
      const f = FORMATION_BY_ID.get(z.formationId);
      const fr = this.frameAt(z.topMD);
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: new THREE.Color(f?.color ?? '#888').multiplyScalar(1.6), transparent: true, opacity: 0.85, toneMapped: false }),
      );
      m.position.copy(fr.pos);
      m.scale.setScalar(fr.radius * 1.9);
      m.lookAt(fr.pos.clone().add(fr.tan));
      m.userData = { kind: 'top', zone: z };
      this.markers.add(m);
      const p = fr.pos.clone().addScaledVector(fr.nor, fr.radius * 2.6);
      this.label(`<b>${f?.name ?? z.name}</b><span>${z.topMD.toFixed(1)} m MD</span>`, 'top', p, { md: z.topMD, kind: 'top' });
    }
    // casing shoes
    for (const c of this.well.casing) {
      const fr = this.frameAt(c.shoeMD);
      const p = fr.pos.clone().addScaledVector(fr.bin, ((c.od * IN) / 2) * this.radialScale * 1.6);
      this.label(`<b>${c.name.split(' ')[0]} shoe</b><span>${c.shoeMD.toFixed(0)} m MD · inferred</span>`, 'shoe', p, { md: c.shoeMD, kind: 'shoe' });
    }
    // depth ticks
    const td = this.well.tdMD;
    for (let md = 250; md < td; md += 250) {
      const fr = this.frameAt(md);
      const tp = this.well.trajectory.at(Math.min(md, this.well.trajectory.mdEnd));
      const p = fr.pos.clone().addScaledVector(fr.bin, -fr.radius * 2.2);
      this.label(`${md.toFixed(0)} <span>MD · ${tp.tvd.toFixed(0)} TVD</span>`, 'tick', p, { md, kind: 'tick' });
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xdfe8f0, transparent: true, opacity: 0.35 }));
      m.position.copy(fr.pos);
      m.scale.setScalar(fr.radius * 1.35);
      m.lookAt(fr.pos.clone().add(fr.tan));
      this.markers.add(m);
    }
    // TD
    const fr = this.frameAt(td);
    this.label(`<b>TD</b><span>${td.toFixed(1)} m MD</span>`, 'top', fr.pos.clone().addScaledVector(fr.nor, fr.radius * 2), { md: td, kind: 'td' });
    if (this.well.kickoffMD) {
      const k = this.frameAt(this.well.kickoffMD);
      this.label(`<b>Sidetrack / KOP</b><span>${this.well.kickoffMD.toFixed(0)} m MD</span>`, 'shoe', k.pos.clone().addScaledVector(k.nor, -k.radius * 3), { md: this.well.kickoffMD, kind: 'kop' });
    }
  }

  private buildPay() {
    this.payGroup.clear();
    const p = this.well.petro;
    const logs = this.well.logs;
    if (!p || !logs) return;
    const ints = payIntervals(logs.depth, p.pay, 1.0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffc35a, transparent: true, opacity: 0.7, toneMapped: false });
    const ringGeo = new THREE.TorusGeometry(1, 0.018, 6, 48);
    // bracket only the significant pay intervals to keep the view calm
    for (const iv of ints.filter((q) => q.base - q.top >= 4)) {
      for (const md of [iv.top, iv.base]) {
        const fr = this.frameAt(md);
        const m = new THREE.Mesh(ringGeo, mat);
        m.position.copy(fr.pos);
        m.scale.setScalar(fr.radius * 3.9);
        m.lookAt(fr.pos.clone().add(fr.tan));
        m.userData = { kind: 'pay', interval: iv };
        this.payGroup.add(m);
      }
    }
    this.payGroup.userData = { intervals: ints };
  }

  private buildCursor() {
    const g = new THREE.TorusGeometry(1, 0.05, 8, 72);
    this.cursor = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.9, toneMapped: false }));
    this.cursor.renderOrder = 50;
    this.group.add(this.cursor);
  }

  /** Field-scale ribbon coloured by the active property; fades in as the camera pulls back. */
  private buildOverviewTube() {
    const geo = this.tube(0, this.well.tdMD, () => 6, 10, 3);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uFade: { value: 0 }, uFormColorArr: this.uniforms.uFormColor },
      transparent: true,
      depthWrite: false,
      vertexShader: `${SHARED_VERT_DECL}
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
void main(){
  vec3 transformed = position;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vN = normalize(normalMatrix * normal);
  #include <logdepthbuf_vertex>
  ${SHARED_VERT_BODY}
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
${SHARED_FRAG_DECL}
${DATA_TEX}
uniform float uFade; uniform float uMode; uniform float uResLogMin; uniform float uResLogMax; uniform vec3 uFormColor[32];
varying vec3 vN;
void main(){
  #include <logdepthbuf_fragment>
  vec4 A = fetchNearest(uDataA, vMd);
  vec4 B = fetchNearest(uDataB, vMd);
  vec4 C = fetchNearest(uDataC, vMd);
  int fi = int(B.w + 0.5);
  vec3 c = B.w < -0.5 ? vec3(0.55, 0.62, 0.7) : uFormColor[fi] * 1.4;
  if (uMode > 0.5 && uMode < 1.5 && A.x > -900.0) c = lutColor((A.x - uResLogMin) / (uResLogMax - uResLogMin));
  if (uMode > 2.5 && C.w > -900.0) c = ropColor(C.w);
  if (uMode > 1.5 && uMode < 2.5) {
    c = vec3(0.45, 0.5, 0.56);
    if (B.x > -900.0) c = mix(vec3(0.2, 0.5, 0.82), vec3(1.0, 0.62, 0.15), clamp(1.0 - B.x, 0.0, 1.0));
    if (C.x > 0.5) c = vec3(1.0, 0.75, 0.3);
  }
  float rim = pow(clamp(1.0 - abs(vN.z), 0.0, 1.0), 1.5);
  c *= 0.75 + 0.6 * rim;
  c += vec3(0.35, 0.8, 1.0) * mdRing(vMd, uCursorMd, 12.0) * 1.2;
  gl_FragColor = vec4(c * 1.25, uFade * (0.85 + 0.15 * rim));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    this.overviewTube = new THREE.Mesh(geo, mat);
    this.overviewTube.renderOrder = 45;
    this.overviewTube.userData = { kind: 'wall', wellId: this.well.id };
    this.group.add(this.overviewTube);
  }

  // ------------------------------------------------------------------ runtime state
  setMode(mode: PropertyMode) {
    this.mode = mode;
    this.uniforms.uMode.value = mode === 'lithology' ? 0 : mode === 'resistivity' ? 1 : mode === 'hydrocarbon' ? 2 : 3;
    this.shells.forEach((m, i) => {
      m.visible = mode === 'resistivity' || mode === 'hydrocarbon';
      m.material = mode === 'hydrocarbon' ? this.shellMatFluid[i] : this.shellMatRes[i];
    });
    this.payGroup.visible = mode === 'hydrocarbon';
  }

  /**
   * Swap in re-computed log / interpretation textures without rebuilding any
   * geometry, so camera, cut-away and opacity settings are preserved.
   */
  updateTextures(tex: WellTextures) {
    const old = this.tex;
    this.tex = tex;
    this.uniforms.uDataA.value = tex.a;
    this.uniforms.uDataB.value = tex.b;
    this.uniforms.uDataC.value = tex.c;
    this.uniforms.uDataCount.value = tex.count;
    this.uniforms.uDataMd0.value = tex.md0;
    this.uniforms.uDataStep.value = tex.step;
    for (const t of [old.a, old.b, old.c]) t.dispose();
    this.buildPay();
    this.payGroup.visible = this.mode === 'hydrocarbon';
  }

  setLut(t: THREE.Texture) {
    this.uniforms.uLut.value = t;
  }

  setWallOpacity(o: number) {
    this.uniforms.uWallOpacity.value = o;
    const tr = o < 0.99;
    if (this.wallMat.transparent !== tr) {
      this.wallMat.transparent = tr;
      this.wallMat.depthWrite = !tr;
      this.wallMat.needsUpdate = true;
    }
  }

  setCasingOpacity(o: number) {
    for (const m of this.casings) {
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = o;
      const tr = o < 0.99;
      if (mat.transparent !== tr) {
        mat.transparent = tr;
        mat.depthWrite = !tr;
        mat.needsUpdate = true;
      }
      m.visible = o > 0.01;
    }
  }

  setCursor(md: number) {
    this.uniforms.uCursorMd.value = md;
    const fr = this.frameAt(md);
    this.cursor.position.copy(fr.pos);
    this.cursor.lookAt(fr.pos.clone().add(fr.tan));
    this.cursor.scale.setScalar(fr.radius * 1.25);
  }

  update(camera: THREE.Camera, time: number, labelsVisible: boolean, focusMd: number, tunnel = false) {
    this.uniforms.uTime.value = time;
    const camPos = camera.position;
    // ribbon width & opacity scale with distance so the path stays legible from the field view
    const dist = camPos.distanceTo(this.frameAt(focusMd).pos);
    const fade = Math.min(1, Math.max(0, (dist - 350) / 900));
    const um = (this.overviewTube.material as THREE.ShaderMaterial).uniforms;
    um.uFade.value = fade;
    this.overviewTube.visible = fade > 0.01;
    const target = Math.max(0.6, dist / 700);
    if (Math.abs(target - this.overviewTube.userData.scale) > 0.05 || this.overviewTube.userData.scale === undefined) {
      this.overviewTube.userData.scale = target;
      this.refitRibbon(target);
    }
    // declutter labels: show those near the camera or near the focus depth
    for (const o of this.labels.children as CSS2DObject[]) {
      const d = o.position.distanceTo(camPos);
      const md = (o.userData.md as number) ?? 0;
      const near = Math.abs(md - focusMd) < 600;
      const cls = o.userData.cls as string;
      const maxD = cls === 'tick' ? 900 : 2600;
      o.visible = tunnel ? labelsVisible && md > focusMd - 5 && md < focusMd + 140 && cls !== 'tick' : labelsVisible && (d < maxD || (near && d < 5000));
      o.element.style.opacity = String(Math.max(0.15, Math.min(1, 1.4 - d / maxD)));
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const l of this.labels.children as CSS2DObject[]) l.element.remove();
  }
}
