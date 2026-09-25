/**
 * The loader's form-morph particle field, drawn on a 2D canvas. It runs in a
 * worker on an OffscreenCanvas (so it keeps moving while the main thread
 * parses the dataset and compiles shaders), or on the page as a fallback.
 */
export type RGB = [number, number, number];
export interface MorphColors {
  oil: RGB;
  accent: RGB;
  water: RGB;
  hot: RGB;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Sprite = HTMLCanvasElement | OffscreenCanvas;

const N = 1100;
const HOLD = 1.5; // s a form holds
const MORPH = 1.6; // s between forms
const TAU = Math.PI * 2;

type P = [number, number];

/** Points spread along line segments (outlines), with a little jitter. */
function alongSegments(segs: [P, P][], n: number): P[] {
  let total = 0;
  const lens = segs.map(([a, b]) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += l;
    return l;
  });
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    let d = Math.random() * total;
    let k = 0;
    while (d > lens[k] && k < lens.length - 1) d -= lens[k++];
    const [a, b] = segs[k];
    const q = d / lens[k];
    out.push([a[0] + (b[0] - a[0]) * q + (Math.random() - 0.5) * 0.022, a[1] + (b[1] - a[1]) * q + (Math.random() - 0.5) * 0.022]);
  }
  return out;
}

const circle = (r: number, n: number, cx = 0, cy = 0): [P, P][] =>
  Array.from({ length: n }, (_, i) => {
    const a1 = (i / n) * TAU;
    const a2 = ((i + 1) / n) * TAU;
    return [
      [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r],
      [cx + Math.cos(a2) * r, cy + Math.sin(a2) * r],
    ];
  });

/** The forms, in [-1, 1]: a crude drop, a derrick, a wellbore landing horizontally, a barrel and a valve wheel. */
function forms(): { pts: P[]; name: string; tone: 'oil' | 'accent' | 'water' }[] {
  const drop: P[] = [];
  for (let i = 0; i < N; i++) {
    const th = Math.random() * TAU;
    const rr = Math.random() < 0.42 ? 1 : Math.sqrt(Math.random());
    drop.push([0.8 * Math.sin(th) * Math.sin(th / 2) * rr, -Math.cos(th) * 0.95 * rr + 0.12 * (1 - rr)]);
  }
  const leg = (f: number, side: number): P => [side * (0.6 - 0.5 * f), 0.85 - 1.75 * f];
  const derrick: [P, P][] = [
    [leg(0, -1), leg(1, -1)],
    [leg(0, 1), leg(1, 1)],
    [leg(1, -1), leg(1, 1)],
    [
      [-0.85, 0.85],
      [0.85, 0.85],
    ],
  ];
  [0, 0.25, 0.5, 0.75].forEach((a) => {
    const b = a + 0.25;
    derrick.push([leg(a, -1), leg(b, 1)], [leg(a, 1), leg(b, -1)], [leg(b, -1), leg(b, 1)]);
  });
  // a wellbore: rig on the surface, vertical hole, build section, horizontal lateral in a reservoir band
  const well: [P, P][] = [
    [
      [-1, -0.62],
      [1, -0.62],
    ],
    [
      [-0.72, -0.62],
      [-0.6, -0.9],
    ],
    [
      [-0.48, -0.62],
      [-0.6, -0.9],
    ],
    [
      [-0.6, -0.62],
      [-0.6, 0.05],
    ],
  ];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    const b = ((i + 1) / 12) * (Math.PI / 2);
    well.push([
      [-0.6 + 0.45 * (1 - Math.cos(a)), 0.05 + 0.45 * Math.sin(a)],
      [-0.6 + 0.45 * (1 - Math.cos(b)), 0.05 + 0.45 * Math.sin(b)],
    ]);
  }
  well.push(
    [
      [-0.15, 0.5],
      [0.95, 0.5],
    ],
    [
      [-0.4, 0.38],
      [1, 0.38],
    ],
    [
      [-0.4, 0.66],
      [1, 0.66],
    ],
  );
  const barrel: [P, P][] = [
    [
      [-0.5, -0.75],
      [0.5, -0.75],
    ],
    [
      [0.5, -0.75],
      [0.5, 0.75],
    ],
    [
      [0.5, 0.75],
      [-0.5, 0.75],
    ],
    [
      [-0.5, 0.75],
      [-0.5, -0.75],
    ],
    [
      [-0.5, -0.28],
      [0.5, -0.28],
    ],
    [
      [-0.5, 0.28],
      [0.5, 0.28],
    ],
  ];
  const valve = [...circle(0.75, 48), ...circle(0.15, 16)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU - Math.PI / 2;
    valve.push([
      [Math.cos(a) * 0.15, Math.sin(a) * 0.15],
      [Math.cos(a) * 0.75, Math.sin(a) * 0.75],
    ]);
  }
  // matching points by angle keeps the swirl between forms coherent
  const sort = (p: P[]) => p.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  return [
    { pts: sort(drop), name: 'Crude', tone: 'oil' },
    { pts: sort(alongSegments(derrick, N)), name: 'Derrick', tone: 'accent' },
    { pts: sort(alongSegments(well, N)), name: 'Wellbore', tone: 'water' },
    { pts: sort(alongSegments(barrel, N)), name: 'Barrel', tone: 'oil' },
    { pts: sort(alongSegments(valve, N)), name: 'Valve', tone: 'accent' },
  ];
}

export function hexRgb(css: string, fallback: RGB = [185, 84, 253]): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: number[], b: number[], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** Builds the particle field; call `draw` every frame with the canvas's CSS size, and `leave` to burst it. */
export function createMorph(g: Ctx, colors: MorphColors, sprite: (size: number) => Sprite) {
  const F = forms();
  const tones = { oil: colors.oil, accent: colors.accent, water: colors.water };
  const hot = colors.hot;
  const glowCache = new Map<string, Sprite>();
  const glow = (col: RGB) => {
    const k = col.join(',');
    let s = glowCache.get(k);
    if (!s) {
      s = sprite(64);
      const x = s.getContext('2d') as Ctx;
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, `rgba(${k},1)`);
      gr.addColorStop(0.22, `rgba(${k},.45)`);
      gr.addColorStop(1, `rgba(${k},0)`);
      x.fillStyle = gr;
      x.fillRect(0, 0, 64, 64);
      glowCache.set(k, s);
    }
    return s;
  };
  const burst = Array.from({ length: N }, () => {
    const a = Math.random() * TAU;
    const v = 0.6 + Math.random() * 1.8;
    return [Math.cos(a) * v, Math.sin(a) * v];
  });
  let t0 = -1;
  let leaveAt: number | null = null;
  return {
    leave(now: number) {
      if (leaveAt === null) leaveAt = now;
    },
    draw(now: number, w: number, h: number, dpr: number) {
      if (t0 < 0) t0 = now;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const t = Math.max(0, now - t0) / 1000;
      const P = HOLD + MORPH;
      const k = Math.floor(t / P) % F.length;
      const u = (t % P) / P;
      const m = u < HOLD / P ? 0 : (u - HOLD / P) / (MORPH / P);
      const A = F[k];
      const B = F[(k + 1) % F.length];
      const ca = tones[A.tone];
      const cb = tones[B.tone];
      const s = Math.min(w, h);
      const sc = s * 0.34;
      const cx = w / 2;
      const cy = h / 2;
      const out = leaveAt === null ? 0 : Math.min(1, (now - leaveAt) / 700);
      const fade = 1 - out;
      // halo behind the form, brighter mid-morph
      const halo = mix(ca, cb, m);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = (0.12 + 0.12 * Math.sin(m * Math.PI)) * fade;
      g.drawImage(glow(halo), cx - s * 0.55, cy - s * 0.55, s * 1.1, s * 1.1);
      for (let i = 0; i < N; i++) {
        const mm = Math.max(0, Math.min(1, (m - (i / N) * 0.35) / 0.65));
        const e = mm < 0.5 ? 4 * mm ** 3 : 1 - (-2 * mm + 2) ** 3 / 2;
        const bu = Math.sin(mm * Math.PI);
        const x = A.pts[i][0] + (B.pts[i][0] - A.pts[i][0]) * e;
        const y = A.pts[i][1] + (B.pts[i][1] - A.pts[i][1]) * e;
        const ro = bu * 0.7;
        const ex = 1 + bu * 0.35 + out * 0.4;
        let X = (x * Math.cos(ro) - y * Math.sin(ro)) * ex + Math.sin(t * 2 + i) * 0.006;
        let Y = (x * Math.sin(ro) + y * Math.cos(ro)) * ex + Math.cos(t * 1.7 + i) * 0.006;
        if (out > 0) {
          const q = out * out;
          X += burst[i][0] * q;
          Y += burst[i][1] * q;
        }
        const base = mix(ca, cb, e);
        const col = bu > 0.05 ? mix(base, hot, 0.35 + 0.55 * bu) : base;
        g.globalAlpha = (bu > 0.05 ? 0.45 + 0.5 * bu : 0.55 + 0.35 * Math.sin(t * 3 + i)) * fade;
        g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        const r = 0.8 + bu * 0.5;
        g.fillRect(cx + X * sc - r, cy + Y * sc - r, r * 2, r * 2);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    },
  };
}
