import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * Screen-space ambient occlusion that understands three.js' logarithmic depth
 * buffer (the stock SSAO / SAO / GTAO passes assume a perspective depth and
 * break with it). View distance is recovered from the log depth as
 * w = 2^(d · log2(far + 1)) − 1, view position from the projection matrix
 * (including the side-panel view offset). The sampling radius scales with
 * distance so creases read at every zoom level, from casing couplings to the
 * edges of the geological block.
 */
export class LogDepthAOPass extends Pass {
  private quad: FullScreenQuad;
  readonly material: THREE.ShaderMaterial;

  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uLogFar: { value: 1 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: 1.1 },
        uRadius: { value: 0.022 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform mat4 uProj; uniform float uLogFar; uniform vec2 uRes;
uniform float uStrength; uniform float uRadius;
varying vec2 vUv;
float viewW(vec2 uv){ float d = texture2D(tDepth, uv).x; return exp2(d * uLogFar) - 1.0; }
vec3 viewPos(vec2 uv){
  float w = viewW(uv);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(w * (ndc.x + uProj[2][0]) / uProj[0][0], w * (ndc.y + uProj[2][1]) / uProj[1][1], -w);
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec4 col = texture2D(tDiffuse, vUv);
  float d0 = texture2D(tDepth, vUv).x;
  if (d0 >= 0.99999) { gl_FragColor = col; return; }
  vec2 px = 1.0 / uRes;
  vec3 p = viewPos(vUv);
  // normal from the flatter neighbour on each axis (avoids halos at silhouettes)
  vec3 pr = viewPos(vUv + vec2(px.x, 0.0)), pl = viewPos(vUv - vec2(px.x, 0.0));
  vec3 pu = viewPos(vUv + vec2(0.0, px.y)), pd = viewPos(vUv - vec2(0.0, px.y));
  vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
  vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy));
  if (!(dot(n, n) > 0.5)) { gl_FragColor = col; return; }
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
  float ao = clamp(1.0 - uStrength * occ / float(N) * 1.6, 0.35, 1.0);
  gl_FragColor = vec4(col.rgb * ao, col.a);
}`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w: number, h: number) {
    this.material.uniforms.uRes.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProj.value.copy(this.camera.projectionMatrix);
    u.uLogFar.value = Math.log2(this.camera.far + 1);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
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
