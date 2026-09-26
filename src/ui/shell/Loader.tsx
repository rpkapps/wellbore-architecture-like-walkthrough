import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { useEffect, useRef } from 'react';
import { Logo } from '../logo';
import { cssVar } from '../tokens';
import { createMorph, hexRgb, type MorphColors } from './loaderArt';

/** The loader's colours, read from the theme. */
function colors(): MorphColors {
  return {
    oil: hexRgb(cssVar('--tecton-palette-saffron-560')),
    accent: hexRgb(cssVar('--tecton-palette-orchid-460')),
    water: hexRgb(cssVar('--tecton-palette-azure-560')),
    hot: hexRgb(cssVar('--tecton-palette-violet-1440', '#efebf4')),
  };
}

/**
 * The form-morph particle field: particles hold a form, swirl and flare white
 * while they travel to the next, and burst outward when loading is done.
 * Drawn in a worker when the browser can hand a canvas to one, so the
 * animation never stalls behind the loading work on the page.
 */
function Morph({ leaving }: { leaving: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const api = useRef<{ leave: () => void } | null>(null);
  useEffect(() => {
    if (leaving) api.current?.leave();
  }, [leaving]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dims = () => ({ w: c.clientWidth || 1, h: c.clientHeight || 1, dpr: Math.min(2, devicePixelRatio || 1) });
    if ('transferControlToOffscreen' in c && typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' });
        const off = c.transferControlToOffscreen();
        worker.postMessage({ type: 'init', canvas: off, colors: colors(), ...dims() }, [off]);
        const ro = new ResizeObserver(() => worker.postMessage({ type: 'resize', ...dims() }));
        ro.observe(c);
        api.current = { leave: () => worker.postMessage({ type: 'leave' }) };
        return () => {
          ro.disconnect();
          worker.postMessage({ type: 'stop' });
          // let the burst finish before the worker goes
          setTimeout(() => worker.terminate(), 2000);
        };
      } catch {
        /* fall through to drawing on the page */
      }
    }
    const g = c.getContext('2d');
    if (!g) return;
    const m = createMorph(g, colors(), (n) => Object.assign(document.createElement('canvas'), { width: n, height: n }));
    api.current = { leave: () => m.leave(performance.now()) };
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const d = dims();
      if (c.width !== Math.round(d.w * d.dpr)) {
        c.width = Math.round(d.w * d.dpr);
        c.height = Math.round(d.h * d.dpr);
      }
      m.draw(now, d.w, d.h, d.dpr);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={cv} aria-hidden className="size-full" />;
}

/**
 * The loading line. The steps arrive unevenly and the work between them
 * blocks the page, so the line never jumps to a step: it glides there, then
 * keeps creeping on toward the end, slower and slower, until the next step
 * arrives. It is a transform animation, which the compositor runs even while
 * the page is busy, and it never moves back.
 */
function ProgressLine({ f }: { f: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    // where the line is now (a running animation's value)
    const m = /matrix\(([^,]+)/.exec(getComputedStyle(el).transform);
    const now = Math.max(shown.current, m ? parseFloat(m[1]) : 0);
    const to = Math.max(now, f);
    for (const a of el.getAnimations()) a.cancel();
    const out = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    if (f >= 1) el.animate([{ transform: `scaleX(${now})`, easing: out }, { transform: 'scaleX(1)' }], { duration: 450, fill: 'forwards' });
    else {
      // glide to the step in 0.7 s, then creep on a third of what is left over about ten seconds
      const glide = 700;
      const creep = 10000;
      el.animate(
        [
          { transform: `scaleX(${now})`, easing: out },
          { transform: `scaleX(${to})`, offset: glide / (glide + creep), easing: 'cubic-bezier(0.05, 0.5, 0.3, 1)' },
          { transform: `scaleX(${to + (0.985 - to) * 0.35})` },
        ],
        { duration: glide + creep, fill: 'forwards' },
      );
    }
    shown.current = to;
  }, [f]);
  return (
    <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-border-subtle">
      <div ref={bar} className="absolute inset-0 origin-left rounded-full bg-ui-accent shadow-[0_0_12px_var(--ui-accent)]" style={{ transform: 'scaleX(0)' }} />
      <div className="loader-sheen absolute inset-y-0 w-1/4" />
    </div>
  );
}

/**
 * The page loader: the particle form morph over the app background, the
 * wordmark and what is loading below it, and a progress line. On exit the
 * particles burst; the view transition blurs the loader away and carries the
 * logo up into the top bar.
 */
export function Loader({ progress, failed, leaving }: { progress: { msg: string; f: number }; failed: string | null; leaving: boolean }) {
  return (
    <div role="status" aria-live="polite" data-leaving={leaving || undefined} className="loader fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background">
      <div aria-hidden className="loader-vignette pointer-events-none absolute inset-0" />
      <div className="loader-in relative aspect-square w-[min(58vmin,440px)]">
        <Morph leaving={leaving} />
      </div>
      <div className="relative -mt-4 flex w-[min(90vw,420px)] flex-col items-center gap-3 text-center">
        <div className="loader-in flex items-center gap-3 [animation-delay:120ms]">
          <span className="brand-logo flex">
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
          <div className="loader-in loader-status mt-3 flex w-full flex-col gap-2 [animation-delay:320ms]">
            <ProgressLine f={progress.f} />
            {/* the step now under way; each new one slides in over the last */}
            <div className="relative h-5 overflow-hidden">
              <span key={progress.msg} className="loader-step type-caption absolute inset-x-0 top-0 truncate font-mono">
                {progress.msg}
              </span>
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
