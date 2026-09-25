import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { useEffect, useRef } from 'react';
import { Logo } from '../logo';
import { cssVar } from '../tokens';

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

function rgb(css: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [185, 84, 253];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The form-morph particle field: particles hold a form, swirl and flare white
 * while they travel to the next, and burst outward when loading is done.
 */
function Morph({ leaving }: { leaving: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const leave = useRef<number | null>(null);
  useEffect(() => {
    if (leaving && leave.current === null) leave.current = performance.now();
  }, [leaving]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const F = forms();
    const tones = { oil: rgb(cssVar('--tecton-palette-saffron-560')), accent: rgb(cssVar('--tecton-palette-orchid-460')), water: rgb(cssVar('--tecton-palette-azure-560')) };
    const hot = rgb(cssVar('--tecton-palette-violet-1440', '#efebf4'));
    const glowCache = new Map<string, HTMLCanvasElement>();
    const glow = (col: [number, number, number]) => {
      const k = col.join(',');
      let s = glowCache.get(k);
      if (!s) {
        s = document.createElement('canvas');
        s.width = s.height = 64;
        const x = s.getContext('2d')!;
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
    // scatter directions for the exit burst
    const burst = Array.from({ length: N }, () => {
      const a = Math.random() * TAU;
      const v = 0.6 + Math.random() * 1.8;
      return [Math.cos(a) * v, Math.sin(a) * v];
    });
    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
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
      const out = leave.current === null ? 0 : Math.min(1, (now - leave.current) / 700);
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
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={cv} aria-hidden className="size-full" />;
}

function mix(a: number[], b: number[], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/**
 * The page loader: the particle form morph over the app background, the
 * wordmark and what is loading below it, and a progress line. On exit the
 * particles burst; the view transition blurs the loader away and carries the
 * logo up into the top bar.
 */
export function Loader({ progress, failed, leaving }: { progress: { msg: string; f: number }; failed: string | null; leaving: boolean }) {
  const pct = Math.round(progress.f * 100);
  return (
    <div role="status" aria-live="polite" className="loader fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background" style={{ viewTransitionName: 'loader' }}>
      <div aria-hidden className="loader-vignette pointer-events-none absolute inset-0" />
      <div className="loader-in relative aspect-square w-[min(58vmin,440px)]">
        <Morph leaving={leaving} />
      </div>
      <div className="relative -mt-4 flex w-[min(90vw,420px)] flex-col items-center gap-3 text-center">
        <div className="loader-in flex items-center gap-3 [animation-delay:120ms]">
          <span className="flex" style={{ viewTransitionName: 'brand-logo' }}>
            <Logo className="size-8" />
          </span>
          <h1 className="text-[2rem] leading-none font-light tracking-[-0.02em] text-fg-1">
            Bore<span className="font-semibold">Walk</span>
          </h1>
        </div>
        <p className="loader-in type-label [animation-delay:220ms]">Walk a real wellbore in 3D · Equinor Volve open data</p>
        {failed ? (
          <Alert variant="destructive" className="mt-2 text-left">
            <AlertTitle>The dataset failed to load</AlertTitle>
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        ) : (
          <div className="loader-in mt-3 flex w-full flex-col gap-2 [animation-delay:320ms]">
            <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-border-subtle">
              <div className="absolute inset-y-0 left-0 rounded-full bg-ui-accent shadow-[0_0_12px_var(--ui-accent)] transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
              <div className="loader-sheen absolute inset-y-0 w-1/4" />
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="type-caption truncate font-mono">{progress.msg}</span>
              <span className="type-value text-[0.75rem]!">{pct}%</span>
            </div>
          </div>
        )}
      </div>
      <p className="type-caption loader-in absolute inset-x-0 bottom-5 mx-auto max-w-xl px-6 text-center text-[0.72rem]! [animation-delay:500ms]">
        Data: Equinor ASA and the Volve licence partners (ExxonMobil E&amp;P Norway, Bayerngas Norge), Equinor Open Data Licence. Calculated and reconstructed quantities are labelled throughout.
      </p>
    </div>
  );
}
