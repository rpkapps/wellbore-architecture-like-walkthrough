/**
 * Scientific colour maps (polynomial fits of matplotlib viridis / inferno by
 * Matt Zucker, and Google's Turbo) evaluated identically in JS and in shaders
 * through a shared 256-entry lookup texture.
 */
export type ColormapName = 'turbo' | 'viridis' | 'inferno' | 'resistivity';

type RGB = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function poly(c: number[][], t: number): RGB {
  const out: RGB = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = 0;
    for (let i = c.length - 1; i >= 0; i--) v = v * t + c[i][k];
    out[k] = clamp01(v);
  }
  return out;
}

const VIRIDIS = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];

const INFERNO = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

function turbo(t: number): RGB {
  const x = clamp01(t);
  const v4 = [1, x, x * x, x * x * x];
  const v2 = [x * x * x * x, x * x * x * x * x];
  const r = 0.13572138 * v4[0] + 4.6153926 * v4[1] - 42.66032258 * v4[2] + 132.13108234 * v4[3] - 152.94239396 * v2[0] + 59.28637943 * v2[1];
  const g = 0.09140261 * v4[0] + 2.19418839 * v4[1] + 4.84296658 * v4[2] - 14.18503333 * v4[3] + 4.27729857 * v2[0] + 2.82956604 * v2[1];
  const b = 0.1066733 * v4[0] + 12.64194608 * v4[1] - 60.58204836 * v4[2] + 110.36276771 * v4[3] - 89.90310912 * v2[0] + 27.34824973 * v2[1];
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** Petrophysics-style resistivity ramp: conductive (brine) blues → resistive (hydrocarbon) ambers/reds. */
const RES_STOPS: [number, RGB][] = [
  [0.0, [0.07, 0.12, 0.33]],
  [0.18, [0.1, 0.33, 0.62]],
  [0.33, [0.16, 0.6, 0.72]],
  [0.46, [0.5, 0.78, 0.62]],
  [0.58, [0.9, 0.86, 0.5]],
  [0.72, [0.96, 0.6, 0.22]],
  [0.86, [0.82, 0.25, 0.14]],
  [1.0, [0.45, 0.07, 0.12]],
];

function stops(s: [number, RGB][], t: number): RGB {
  const x = clamp01(t);
  for (let i = 1; i < s.length; i++) {
    if (x <= s[i][0]) {
      const [t0, c0] = s[i - 1];
      const [t1, c1] = s[i];
      const f = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return s[s.length - 1][1];
}

export function colormap(name: ColormapName, t: number): RGB {
  switch (name) {
    case 'viridis':
      return poly(VIRIDIS, clamp01(t));
    case 'inferno':
      return poly(INFERNO, clamp01(t));
    case 'resistivity':
      return stops(RES_STOPS, t);
    default:
      return turbo(t);
  }
}

export const COLORMAPS: { id: ColormapName; label: string }[] = [
  { id: 'resistivity', label: 'Petrophysical (blue → red)' },
  { id: 'turbo', label: 'Turbo' },
  { id: 'viridis', label: 'Viridis (perceptually uniform)' },
  { id: 'inferno', label: 'Inferno (perceptually uniform)' },
];

export function lut(name: ColormapName, n = 256): Uint8Array {
  const a = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colormap(name, i / (n - 1));
    a[i * 4] = Math.round(c[0] * 255);
    a[i * 4 + 1] = Math.round(c[1] * 255);
    a[i * 4 + 2] = Math.round(c[2] * 255);
    a[i * 4 + 3] = 255;
  }
  return a;
}

export const toCss = (c: RGB) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

/** Log scale for resistivity (Ω·m). */
export const RES_RANGE = { min: 0.2, max: 2000 };
export const resToT = (r: number, min = RES_RANGE.min, max = RES_RANGE.max) =>
  clamp01((Math.log10(r) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)));

/** Fluid colours for the interpreted view. */
export const OIL_RGB: RGB = [0.62, 0.36, 0.07];
export const WATER_RGB: RGB = [0.16, 0.42, 0.66];
export function saturationColor(sw: number): RGB {
  const s = clamp01(sw);
  return [OIL_RGB[0] + (WATER_RGB[0] - OIL_RGB[0]) * s, OIL_RGB[1] + (WATER_RGB[1] - OIL_RGB[1]) * s, OIL_RGB[2] + (WATER_RGB[2] - OIL_RGB[2]) * s];
}
