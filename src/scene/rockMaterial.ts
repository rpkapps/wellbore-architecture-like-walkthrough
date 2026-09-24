import * as THREE from 'three';
import { NOISE, ROCK } from './glsl';

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
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
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
vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uLitho; uniform vec3 uBase; uniform float uHighlight; uniform float uContours; uniform float uBump; uniform float uFade;
uniform vec3 uFocus; uniform float uFocusR; uniform float uFocusOn;
varying float vStrat; varying vec3 vWPos; varying vec3 vWNormal;
float gRough; float gH;
${NOISE}
${ROCK}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float fw = length(fwidth(vWPos));
vec3 rc = rockColor(uLitho, uBase, vWPos, vStrat, fw, gRough, gH);
// structural contours (every 25 m TVDSS) on up-facing horizon surfaces
if (uContours > 0.5 && vWNormal.y > 0.6) {
  float depth = -vWPos.y;
  float dl = abs(fract(depth / 25.0 + 0.5) - 0.5) * 25.0;
  float w = max(fw * 1.2, 0.15);
  float line = 1.0 - smoothstep(w * 0.5, w * 1.5, dl);
  float major = step(abs(fract(depth / 100.0 + 0.5) - 0.5) * 100.0, 12.5);
  rc = mix(rc, rc * (major > 0.5 ? 0.45 : 0.7), line * 0.7);
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
normal = perturbNormalH(-vViewPosition, normal, gH, uBump);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.9, 0.7, 0.3) * uHighlight * 0.08;`,
      );
  };
  mat.customProgramCacheKey = () => 'rock-v1';
  return mat;
}
