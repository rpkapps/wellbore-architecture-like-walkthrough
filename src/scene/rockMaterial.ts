import * as THREE from 'three';
import { NOISE, ROCK } from './glsl';
import { REAL, REAL_GLSL } from './textures';

export interface RockUniforms {
  uLitho: { value: number };
  uBase: { value: THREE.Color };
  uHighlight: { value: number };
  uContours: { value: number };
  uBump: { value: number };
  uTime: { value: number };
  uFade: { value: number };
  uFocus: { value: THREE.Vector3 };
  uFocusR: { value: number };
  uFocusOn: { value: number };
}

/** Shared by every formation slab: a clear "bubble" around the point of interest. */
export const FOCUS = {
  uFocus: { value: new THREE.Vector3() },
  uFocusR: { value: 250 },
  uFocusOn: { value: 0 },
};

/** Seabed detail (sand ripples) on the up-facing top of the shallowest unit. */
export const SEABED = {
  uSeabedOn: { value: 0 },
  uSeabedY: { value: -91.1 },
};

/**
 * PBR rock for the regional formation slabs: MeshStandardMaterial with
 * procedural lithology albedo / roughness / bump injected into the shader, and
 * optional structural contours on top surfaces.
 */
export function createRockMaterial(litho: number, color: string): THREE.MeshStandardMaterial & { userData: { uniforms: RockUniforms } } {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0.35,
    // double-sided so the block stays closed when the camera is inside it
    side: THREE.DoubleSide,
  }) as THREE.MeshStandardMaterial & { userData: { uniforms: RockUniforms } };
  const uniforms: RockUniforms = {
    uLitho: { value: litho },
    uBase: { value: new THREE.Color(color) },
    uHighlight: { value: 0 },
    uContours: { value: 1 },
    uBump: { value: 0.06 },
    uTime: { value: 0 },
    uFade: { value: 0 },
    ...FOCUS,
    ...SEABED,
  };
  const shaderUniforms = { ...uniforms, ...REAL };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shaderUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aStrat;
varying float vStrat;
varying vec3 vWPos;
varying vec3 vWNormal;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vStrat = aStrat;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec3 wn0 = mat3(modelMatrix) * objectNormal;
vWNormal = dot(wn0, wn0) > 1e-12 ? normalize(wn0) : vec3(0.0, 1.0, 0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uLitho; uniform vec3 uBase; uniform float uHighlight; uniform float uContours; uniform float uBump; uniform float uFade;
uniform vec3 uFocus; uniform float uFocusR; uniform float uFocusOn; uniform float uSeabedOn; uniform float uSeabedY;
varying float vStrat; varying vec3 vWPos; varying vec3 vWNormal;
float gRough; float gH; vec3 gRealN; float gReal;
${NOISE}
${ROCK}
${REAL_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float fw = length(fwidth(vWPos));
vec3 rc = rockColor(uLitho, uBase, vWPos, vStrat, fw, gRough, gH);
gReal = 0.0;
bool seabedHere = uSeabedOn > 0.5 && vWNormal.y > 0.6 && abs(vWPos.y - uSeabedY) < 6.0;
if (uRealistic > 0.5) {
  // CC0 photo texture of this lithology, tinted to the formation colour; the procedural
  // bedding still modulates it so strata read from the field view
  float layer = seabedHere ? 0.0 : uLitho;
  vec3 alb; vec3 arm; vec3 nW;
  realTri(layer, vWPos, vWNormal, seabedHere ? 2.5 : 4.0, fw, alb, arm, nW);
  float bed = dot(rc, vec3(0.299, 0.587, 0.114)) / max(dot(uBase, vec3(0.299, 0.587, 0.114)), 1e-3);
  vec3 photo = seabedHere ? alb : realTint(alb, layer, uBase, 0.55);
  rc = photo * mix(1.0, clamp(bed, 0.6, 1.4), 0.45) * mix(1.0, arm.r, 0.7);
  gRough = clamp(arm.g, 0.35, 1.0);
  gRealN = nW;
  gReal = 1.0;
}
// structural contours (every 25 m TVDSS) on up-facing horizon surfaces
if (uContours > 0.5 && vWNormal.y > 0.6) {
  float depth = -vWPos.y;
  float dl = abs(fract(depth / 25.0 + 0.5) - 0.5) * 25.0;
  float w = max(fw * 1.2, 0.15);
  float line = 1.0 - smoothstep(w * 0.5, w * 1.5, dl);
  float major = step(abs(fract(depth / 100.0 + 0.5) - 0.5) * 100.0, 12.5);
  rc = mix(rc, rc * (major > 0.5 ? 0.45 : 0.7), line * 0.7);
}
// seabed: wave-built sand ripples, megaripples and darker shell-hash patches where the water meets the rock
if (seabedHere) {
  vec2 q = vWPos.xz;
  float warp = snoise(vec3(q * 0.02, 1.7)) * 4.0;
  float rip = sin((dot(q, vec2(0.83, 0.56)) + warp) * 6.2831853 / 0.9);
  float mega = sin((dot(q, vec2(0.6, -0.8)) + warp * 3.0) * 6.2831853 / 18.0);
  float aaR = 1.0 - smoothstep(0.08, 0.35, fw);
  float aaM = 1.0 - smoothstep(1.5, 6.0, fw);
  float patchN = smoothstep(0.1, 0.6, snoise(vec3(q * 0.006, 3.1)));
  if (gReal > 0.5) {
    // photo sand, shaded and bent by the same wave ripples / megaripples
    rc *= mix(1.0, 0.7, patchN * 0.8) * (0.8 + 0.2 * rip * aaR + 0.14 * mega * aaM);
    float ph1 = (dot(q, vec2(0.83, 0.56)) + warp) * 6.2831853 / 0.9;
    float ph2 = (dot(q, vec2(0.6, -0.8)) + warp * 3.0) * 6.2831853 / 18.0;
    vec2 g = vec2(0.83, 0.56) * cos(ph1) * 0.4 * aaR + vec2(0.6, -0.8) * cos(ph2) * 0.15 * aaM;
    gRealN = normalize(gRealN + vec3(-g.x, 0.0, -g.y));
  } else {
    vec3 sand = vec3(0.47, 0.42, 0.33);
    vec3 hash = vec3(0.33, 0.31, 0.27);
    vec3 sb = mix(sand, hash, patchN * 0.8);
    sb *= 0.9 + 0.1 * rip * aaR + 0.08 * mega * aaM;
    sb *= 0.92 + 0.16 * aaNoise(vWPos * 0.5, 1.0, fw);
    rc = mix(rc, sb, 0.85);
    gH += (rip * 0.25 * aaR + mega * 0.6 * aaM);
    gRough = 0.95;
  }
}
// cut faces (vertical walls) read slightly cooler, like a sawn section
rc *= mix(1.0, 0.92, step(abs(vWNormal.y), 0.3));
rc = mix(rc, vec3(0.9, 0.75, 0.35), uHighlight * 0.25);
// proximity bubble: rock near the point of interest dissolves into a faint contour grid
float dF = distance(vWPos, uFocus);
float nearF = (1.0 - smoothstep(uFocusR * 0.55, uFocusR, dF)) * uFocusOn;
float grid = 0.0;
{
  vec2 gp = vWPos.xz / 50.0;
  vec2 gd = abs(fract(gp - 0.5) - 0.5) * 50.0;
  float gw = max(fw * 1.2, 0.2);
  grid = 1.0 - smoothstep(gw * 0.5, gw * 1.5, min(gd.x, gd.y));
  grid *= step(0.6, abs(vWNormal.y));
}
diffuseColor.rgb = rc;
diffuseColor.a *= 1.0 - uFade;
diffuseColor.a *= mix(1.0, 0.04 + grid * 0.35, nearF);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (gReal > 0.5) normal = normalize((viewMatrix * vec4(gRealN, 0.0)).xyz) * faceDirection;
else normal = perturbNormalH(-vViewPosition, normal, gH, uBump);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.9, 0.7, 0.3) * uHighlight * 0.08;`,
      );
  };
  mat.customProgramCacheKey = () => 'rock-v4';
  return mat;
}
