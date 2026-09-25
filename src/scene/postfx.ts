import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * Draws the scene into its own multisampled target, then resolves it into the
 * composer's single-sampled buffer in one full-screen pass that also applies
 * the ambient occlusion (when on) and replaces NaN / Inf pixels before bloom
 * can smear them. Only the scene draw pays for MSAA: every post pass reads and
 * writes plain targets (each one used to write, and resolve, a 4× target).
 *
 * The occlusion understands three.js' logarithmic and reversed depth buffers
 * (the stock SSAO / SAO / GTAO passes assume a standard perspective depth and
 * break with both). View distance is recovered from the log depth as
 * w = 2^(d · log2(far + 1)) − 1, or from the reversed depth as
 * w = near · far / (d · (far − near) + near); view position from the projection matrix
 * (including the side-panel view offset). The sampling radius scales with
 * distance so creases read at every zoom level, from casing couplings to the
 * edges of the geological block.
 */
export class ScenePass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  /** screen-space ambient occlusion (it comes with the sun shadows) */
  ao = false;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    samples: number,
  ) {
    super();
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    // depth is sampled by the occlusion (log-depth aware)
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uAO: { value: 0 },
        uProj: { value: new THREE.Matrix4() },
        uLogFar: { value: 1 },
        uReversed: { value: 0 },
        uNearFar: { value: new THREE.Vector2(0.1, 1000) },
        uRes: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: 1.1 },
        uRadius: { value: 0.022 },
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform float uAO; uniform mat4 uProj; uniform float uLogFar; uniform vec2 uRes;
uniform float uStrength; uniform float uRadius; uniform float uReversed; uniform vec2 uNearFar;
varying vec2 vUv;
float viewW(vec2 uv){
  float d = texture2D(tDepth, uv).x;
  if (uReversed > 0.5) return uNearFar.x * uNearFar.y / (d * (uNearFar.y - uNearFar.x) + uNearFar.x);
  return exp2(d * uLogFar) - 1.0;
}
vec3 viewPos(vec2 uv){
  float w = viewW(uv);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(w * (ndc.x + uProj[2][0]) / uProj[0][0], w * (ndc.y + uProj[2][1]) / uProj[1][1], -w);
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float occlusion(){
  float d0 = texture2D(tDepth, vUv).x;
  // background: the depth clear value (far plane) of either encoding
  if (uReversed > 0.5 ? d0 <= 0.0 : d0 >= 0.99999) return 1.0;
  vec2 px = 1.0 / uRes;
  vec3 p = viewPos(vUv);
  // normal from the flatter neighbour on each axis (avoids halos at silhouettes)
  vec3 pr = viewPos(vUv + vec2(px.x, 0.0)), pl = viewPos(vUv - vec2(px.x, 0.0));
  vec3 pu = viewPos(vUv + vec2(0.0, px.y)), pd = viewPos(vUv - vec2(0.0, px.y));
  vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
  vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy));
  if (!(dot(n, n) > 0.5)) return 1.0;
  float w = -p.z;
  float R = clamp(w * uRadius, 0.12, 45.0);
  float rPx = clamp(R * uProj[1][1] * 0.5 * uRes.y / w, 3.0, 48.0);
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float fi = (float(i) + 0.5) / float(N);
    float a = rot + float(i) * 2.3999632;
    vec2 off = vec2(cos(a), sin(a)) * sqrt(fi) * rPx * px;
    vec2 suv = vUv + off;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    vec3 v = viewPos(suv) - p;
    float dist = length(v);
    float c = max(dot(n, v) / (dist + 1e-4) - 0.08, 0.0);
    occ += c * (1.0 - smoothstep(R * 0.5, R * 1.6, dist));
  }
  return clamp(1.0 - uStrength * occ / float(N) * 1.6, 0.35, 1.0);
}
bool bad(float v){ return !(v == v) || abs(v) > 60000.0; }
void main(){
  vec4 c = texture2D(tDiffuse, vUv);
  if (uAO > 0.5) c.rgb *= occlusion();
  if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 48.0), clamp(c.a, 0.0, 1.0));
}`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get samples() {
    return this.target.samples;
  }
  set samples(n: number) {
    if (this.target.samples === n) return;
    this.target.samples = n;
    this.target.dispose();
  }

  setSize(w: number, h: number) {
    this.target.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    // the multisampled depth is copied out only when the occlusion reads it
    this.target.resolveDepthBuffer = this.ao;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    const u = this.material.uniforms;
    u.tDiffuse.value = this.target.texture;
    u.tDepth.value = this.target.depthTexture;
    u.uAO.value = this.ao ? 1 : 0;
    if (this.ao) {
      u.uProj.value.copy(this.camera.projectionMatrix);
      u.uLogFar.value = Math.log2(this.camera.far + 1);
      u.uReversed.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
      u.uNearFar.value.set(this.camera.near, this.camera.far);
    }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);

/**
 * UnrealBloomPass (half resolution, five blurred mips) without its last step:
 * the full-resolution additive blend onto the frame. `FinalPass` adds the glow
 * while it tone-maps, which saves a full-screen read-modify-write per frame.
 */
export class GlowPass extends UnrealBloomPass {
  private quad = new FullScreenQuad();
  private oldClear = new THREE.Color();

  /** the composited glow (half resolution) */
  get texture() {
    return this.renderTargetsHorizontal[0].texture;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    renderer.getClearColor(this.oldClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    const pass = (m: THREE.Material, to: THREE.WebGLRenderTarget) => {
      this.quad.material = m;
      renderer.setRenderTarget(to);
      renderer.clear();
      this.quad.render(renderer);
    };
    // 1. bright areas, 2. blur every mip, 3. composite the mips
    const hp = this.highPassUniforms as Record<string, THREE.IUniform>;
    hp.tDiffuse.value = readBuffer.texture;
    hp.luminosityThreshold.value = this.threshold;
    pass(this.materialHighPassFilter, this.renderTargetBright);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = BLUR_X;
      pass(m, this.renderTargetsHorizontal[i]);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = BLUR_Y;
      pass(m, this.renderTargetsVertical[i]);
      input = this.renderTargetsVertical[i];
    }
    const c = this.compositeMaterial.uniforms;
    c.bloomStrength.value = this.strength;
    c.bloomRadius.value = this.radius;
    c.bloomTintColors.value = this.bloomTintColors;
    pass(this.compositeMaterial, this.renderTargetsHorizontal[0]);
    renderer.setClearColor(this.oldClear, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    super.dispose();
    this.quad.dispose();
  }
}

/**
 * The last pass: adds the glow, tone-maps to sRGB (three's OutputPass) and
 * applies the film grade (vignette, split tone, grain) in the same draw.
 */
export class FinalPass extends OutputPass {
  /** vignette, grade and grain (off with the glow from the Display panel) */
  grade = true;

  constructor(private glow: GlowPass) {
    super();
    Object.assign(this.uniforms, {
      tBloom: { value: null },
      uBloom: { value: 0 },
      uGrade: { value: 1 },
      uTime: { value: 0 },
      uVignette: { value: 0.85 },
      uGrain: { value: 0.035 },
    });
    this.material.fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform float uBloom;
uniform float uGrade; uniform float uTime; uniform float uVignette; uniform float uGrain;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec4 c = texture2D(tDiffuse, vUv);
  if (uBloom > 0.5) c.rgb += texture2D(tBloom, vUv).rgb;
  #if defined( LINEAR_TONE_MAPPING )
    c.rgb = LinearToneMapping(c.rgb);
  #elif defined( REINHARD_TONE_MAPPING )
    c.rgb = ReinhardToneMapping(c.rgb);
  #elif defined( CINEON_TONE_MAPPING )
    c.rgb = CineonToneMapping(c.rgb);
  #elif defined( ACES_FILMIC_TONE_MAPPING )
    c.rgb = ACESFilmicToneMapping(c.rgb);
  #elif defined( AGX_TONE_MAPPING )
    c.rgb = AgXToneMapping(c.rgb);
  #elif defined( NEUTRAL_TONE_MAPPING )
    c.rgb = NeutralToneMapping(c.rgb);
  #endif
  #ifdef SRGB_TRANSFER
    c = sRGBTransferOETF(c);
  #endif
  if (uGrade > 0.5) {
    vec2 d = vUv - 0.5;
    float v = smoothstep(0.95, 0.25, length(d * vec2(1.0, 0.85)) * uVignette * 1.2);
    c.rgb *= mix(0.72, 1.0, v);
    // gentle cool shadows / warm highlights grade
    float l = dot(c.rgb, vec3(0.299,0.587,0.114));
    c.rgb += (vec3(-0.006, 0.0, 0.012) * (1.0 - l) + vec3(0.01, 0.004, -0.008) * l);
    c.rgb += (h(vUv * 1000.0 + uTime) - 0.5) * uGrain * (1.0 - l * 0.6);
  }
  gl_FragColor = c;
}`;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const u = this.uniforms;
    u.tBloom.value = this.glow.texture;
    u.uBloom.value = this.glow.enabled ? 1 : 0;
    u.uGrade.value = this.grade ? 1 : 0;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

/**
 * Lens depth-of-field for the inside-the-hole view: the camera looks down the
 * borehole axis, so sharpness is kept at the vanishing point and the wall that
 * rushes past near the lens is blurred along the radial direction.
 */
export const LensBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.012 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse; uniform float uStrength; uniform vec2 uCenter; uniform float uAspect; varying vec2 vUv;
void main(){
  vec2 d = vUv - uCenter; d.x *= uAspect;
  float r = length(d);
  float amt = uStrength * smoothstep(0.18, 0.85, r);
  vec2 dir = normalize(vUv - uCenter + 1e-5);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -5; i <= 5; i++) {
    float t = float(i) / 5.0;
    float w = 1.0 - abs(t) * 0.6;
    // radial + slight tangential spread gives a soft bokeh rather than a zoom streak
    vec2 o = dir * t * amt + vec2(-dir.y, dir.x) * t * amt * 0.35;
    acc += texture2D(tDiffuse, vUv + o) * w; wsum += w;
  }
  gl_FragColor = acc / wsum;
}`,
};

/** Drifting drilling-fluid particles that follow the camera inside the hole. */
export class MudParticles {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(count = 900) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(count * 3);
    const r = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      p[i * 3] = Math.random();
      p[i * 3 + 1] = Math.random();
      p[i * 3 + 2] = Math.random();
      r[i] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(r, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: 10 },
        uScale: { value: 400 },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aRand; uniform vec3 uCam; uniform float uTime; uniform float uBox; uniform float uScale;
varying float vA;
void main(){
  vec3 drift = vec3(sin(aRand * 40.0 + uTime * 0.3), -0.35 - aRand * 0.4, cos(aRand * 23.0 + uTime * 0.2)) * uTime * 0.06;
  vec3 q = position * uBox + drift;
  vec3 rel = mod(q - uCam + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 wp = uCam + rel;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  gl_PointSize = clamp((0.012 + aRand * 0.03) * uScale / max(dist, 0.05), 0.6, 9.0);
  vA = (1.0 - smoothstep(uBox * 0.25, uBox * 0.5, length(rel))) * smoothstep(0.05, 0.4, dist);
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uOpacity; varying float vA;
void main(){
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5; float r = length(c);
  float a = (1.0 - smoothstep(0.2, 0.5, r)) * vA * uOpacity;
  gl_FragColor = vec4(vec3(0.85, 0.72, 0.52) * a, a);
}`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 70;
    this.points.visible = false;
  }

  update(cam: THREE.PerspectiveCamera, time: number, on: boolean, boxSize: number, viewportH: number) {
    this.points.visible = on;
    if (!on) return;
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam.position);
    u.uTime.value = time;
    u.uBox.value = boxSize;
    u.uScale.value = viewportH / (2 * Math.tan((cam.fov * Math.PI) / 360));
    u.uOpacity.value = Math.min(1, u.uOpacity.value + 0.03);
  }
}
