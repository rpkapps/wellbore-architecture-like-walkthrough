/// <reference lib="webworker" />
import { createMorph, type MorphColors } from './loaderArt';

/**
 * Draws the loader's particle field on an OffscreenCanvas, off the main
 * thread: it keeps moving while the page parses the dataset, builds the
 * geology and compiles shaders.
 */
type Msg =
  | { type: 'init'; canvas: OffscreenCanvas; colors: MorphColors; w: number; h: number; dpr: number }
  | { type: 'resize'; w: number; h: number; dpr: number }
  | { type: 'leave' }
  | { type: 'stop' };

let size = { w: 1, h: 1, dpr: 1 };
let morph: ReturnType<typeof createMorph> | null = null;
let canvas: OffscreenCanvas | null = null;
let running = true;
const raf: (cb: (t: number) => void) => void = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(performance.now()), 16);

function fit() {
  if (!canvas) return;
  const W = Math.max(1, Math.round(size.w * size.dpr));
  const H = Math.max(1, Math.round(size.h * size.dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
}

function frame(now: number) {
  if (!running || !morph) return;
  morph.draw(now, size.w, size.h, size.dpr);
  raf(frame);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'init') {
    canvas = m.canvas;
    size = { w: m.w, h: m.h, dpr: m.dpr };
    fit();
    const g = canvas.getContext('2d');
    if (!g) return;
    morph = createMorph(g, m.colors, (n) => new OffscreenCanvas(n, n));
    raf(frame);
  } else if (m.type === 'resize') {
    size = { w: m.w, h: m.h, dpr: m.dpr };
    fit();
  } else if (m.type === 'leave') morph?.leave(performance.now());
  else if (m.type === 'stop') running = false;
};
