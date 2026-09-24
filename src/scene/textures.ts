import * as THREE from 'three';

/**
 * CC0 photo textures (Poly Haven, see public/textures/CREDITS.md) packed into
 * three 2D-array textures so any shader can pick a layer at run time — the
 * borehole wall changes rock type along the hole in a single draw call.
 * Layer order: 0 = seabed sand, 1..8 = LITHO_INDEX (clay … red beds),
 * 9 = casing steel, 10 = cement.
 */
export const TEX_LAYERS = ['seabed', 'clay', 'sand', 'chalk', 'marl', 'blackshale', 'siltshale', 'heterolithic', 'redbed', 'steel', 'cement'] as const;
export const LAYER_STEEL = 9;
export const LAYER_CEMENT = 10;
const N = TEX_LAYERS.length;
const SIZE = 512;

function placeholder(r: number, g: number, b: number): THREE.DataArrayTexture {
  const d = new Uint8Array(4 * N);
  for (let i = 0; i < N; i++) d.set([r, g, b, 255], i * 4);
  const t = new THREE.DataArrayTexture(d, 1, 1, N);
  t.needsUpdate = true;
  return t;
}

/** Shared by every material that can switch to photo textures. */
export const REAL = {
  uRealistic: { value: 0 },
  tRAlb: { value: placeholder(128, 128, 128) as THREE.DataArrayTexture },
  tRNrm: { value: placeholder(128, 128, 255) as THREE.DataArrayTexture },
  tRArm: { value: placeholder(255, 200, 0) as THREE.DataArrayTexture },
  uRMean: { value: Array.from({ length: N }, () => new THREE.Vector3(0.5, 0.5, 0.5)) },
};

let loading: Promise<void> | null = null;
export let texturesLoaded = false;

async function image(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/** Download and pack the textures (once). */
export function loadRealisticTextures(base = './textures/'): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = SIZE;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    const pack = async (suffix: string, means = false) => {
      const data = new Uint8Array(SIZE * SIZE * 4 * N);
      const imgs = await Promise.all(TEX_LAYERS.map((n) => image(`${base}${n}_${suffix}.jpg`)));
      imgs.forEach((img, i) => {
        g.clearRect(0, 0, SIZE, SIZE);
        g.drawImage(img, 0, 0, SIZE, SIZE);
        const px = g.getImageData(0, 0, SIZE, SIZE).data;
        data.set(px, i * SIZE * SIZE * 4);
        if (means) {
          // mean linear colour, used to tint the photo towards each formation's colour
          let r = 0, gg = 0, b = 0;
          for (let k = 0; k < px.length; k += 64) {
            r += Math.pow(px[k] / 255, 2.2);
            gg += Math.pow(px[k + 1] / 255, 2.2);
            b += Math.pow(px[k + 2] / 255, 2.2);
          }
          const n = px.length / 64;
          REAL.uRMean.value[i].set(r / n, gg / n, b / n);
        }
      });
      const t = new THREE.DataArrayTexture(data, SIZE, SIZE, N);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
      if (suffix === 'albedo') t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    const [alb, nrm, arm] = await Promise.all([pack('albedo', true), pack('normal'), pack('arm')]);
    for (const [k, t] of [
      ['tRAlb', alb],
      ['tRNrm', nrm],
      ['tRArm', arm],
    ] as const) {
      REAL[k].value.dispose();
      REAL[k].value = t;
    }
    texturesLoaded = true;
  })();
  return loading;
}

/**
 * GLSL helpers. `realTri` = triplanar sampling for the regional slabs (no UVs),
 * `realCyl` = cylindrical mapping for the borehole wall, casing and cement.
 */
export const REAL_GLSL = /* glsl */ `
uniform float uRealistic;
uniform sampler2DArray tRAlb; uniform sampler2DArray tRNrm; uniform sampler2DArray tRArm;
uniform vec3 uRMean[${N}];
vec3 rAlb(vec2 uv, float l){ return texture(tRAlb, vec3(uv, l)).rgb; }
vec3 rArm(vec2 uv, float l){ return texture(tRArm, vec3(uv, l)).rgb; }
vec3 rNrm(vec2 uv, float l){ return texture(tRNrm, vec3(uv, l)).rgb * 2.0 - 1.0; }
// Triplanar with UDN normal blending. Scale-aware: a near tile and a 10× far tile,
// both fading to the photo's mean colour as a pixel covers more of the tile, so the
// repetition of a 512 px photo never shows as a grid from the field view.
// fw = world-space size of one pixel.
void realTri(float l, vec3 p, vec3 wn, float tile, float fw, out vec3 alb, out vec3 arm, out vec3 nW){
  vec3 w = pow(abs(wn), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-5);
  vec3 mean = uRMean[int(l)];
  float wf = smoothstep(0.01, 0.06, fw / tile);
  float wm = smoothstep(0.012, 0.07, fw / (tile * 10.0));
  vec2 ux = p.zy / tile, uy = p.xz / tile, uz = p.xy / tile;
  vec3 aN = rAlb(ux, l) * w.x + rAlb(uy, l) * w.y + rAlb(uz, l) * w.z;
  vec2 fx = ux * 0.1 + 0.37, fy = uy * 0.1 + 0.37, fz = uz * 0.1 + 0.37;
  vec3 aF = rAlb(fx, l) * w.x + rAlb(fy, l) * w.y + rAlb(fz, l) * w.z;
  alb = mix(mix(aN, aF, wf), mean, wm);
  arm = rArm(ux, l) * w.x + rArm(uy, l) * w.y + rArm(uz, l) * w.z;
  arm = mix(arm, vec3(1.0, arm.g, arm.b), wf);
  vec3 tx = rNrm(ux, l), ty = rNrm(uy, l), tz = rNrm(uz, l);
  tx.xy *= 1.0 - wf; ty.xy *= 1.0 - wf; tz.xy *= 1.0 - wf;
  tx = vec3(tx.xy + wn.zy, wn.x); ty = vec3(ty.xy + wn.xz, wn.y); tz = vec3(tz.xy + wn.xy, wn.z);
  nW = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
// fade factor for single-projection (cylindrical) sampling
float realFade(float fw, float tile){ return smoothstep(0.01, 0.07, fw / tile); }
// photo albedo pulled towards a target colour (keeps each formation's identity)
vec3 realTint(vec3 alb, float l, vec3 target, float k){
  vec3 m = max(uRMean[int(l)], vec3(0.02));
  return mix(alb, alb / m * target, k);
}
`;
