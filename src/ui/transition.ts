import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Signal } from './signal';

/**
 * Layout changes that animate (docking, undocking, maximising, folding, hiding
 * the panels, an overlay collapsing to its chip) run through `withTransition`
 * or `animate`. Each is a morph of the real panels, not of snapshots: every
 * element marked `data-morph` is measured, the change is rendered at once, and
 * each element that moved or resized travels from its old box to its new one.
 * Its contents are laid out at their final size from the start and revealed as
 * its frame grows (clipped, never stretched); a frame that shrinks is a plain
 * panel-coloured box that closes around them. Only transform, clip and opacity
 * animate, so the 3D view and the panels' contents keep drawing live.
 *
 * `data-morph` holds the element's keys, most specific first ("p:<panel>
 * g:<group>"): an element that is new after the change grows from the old
 * element sharing one of its keys (a panel undocked grows out of the group it
 * left, a panel opened grows out of its rail button), else it fades in.
 * `data-morph-anchor` ("tl", "tr", "bl", "br", default "tl") is the corner
 * its contents are pinned to while it morphs.
 */

const MORPH_MS = 220;
const ENTER_MS = 170;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function reducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduce-motion');
}

/**
 * A layout change from outside an event handler (a menu action, a key, the app): applied on the
 * next frame, morphing. `grow: false` fades in whatever appears rather than growing it out of
 * what it came from (showing every panel at once should not fly them all out of the rail).
 */
export function withTransition(change: () => void, opts: { grow?: boolean } = {}) {
  if (reducedMotion()) {
    change();
    return;
  }
  // on the next frame: never inside a render, and after the menu that asked for it has let go
  requestAnimationFrame(() => morph(change, opts.grow ?? true));
}

/** A change made in an event handler (local state included) that should morph the panels it moves. */
export function animate(fn: () => void) {
  if (reducedMotion()) fn();
  else morph(fn);
}

/** A signal's value as React state (the workspace frame reads its layout through it). */
export function useAnimatedSignal<T>(s: Signal<T>): T {
  const [v, setV] = useState(s.value);
  useLayoutEffect(() => {
    const sync = () => setV(s.value);
    sync();
    return s.subscribe(sync);
  }, [s]);
  return v;
}

// ---------------------------------------------------------------- the morph

type Box = { el: HTMLElement; r: DOMRect };
const running = new Set<Animation>();
const ghosts = new Set<HTMLElement>();

function shown(el: HTMLElement): boolean {
  return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions) : true;
}

function measure(): { all: Set<HTMLElement>; byEl: Map<HTMLElement, DOMRect>; byKey: Map<string, Box> } {
  const all = new Set<HTMLElement>();
  const byEl = new Map<HTMLElement, DOMRect>();
  const byKey = new Map<string, Box>();
  for (const el of document.querySelectorAll<HTMLElement>('[data-morph]')) {
    all.add(el);
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    byEl.set(el, r);
    for (const k of (el.dataset.morph ?? '').split(' ')) if (k && !byKey.has(k)) byKey.set(k, { el, r });
  }
  return { all, byEl, byKey };
}

/** End the morph in flight where it is: the next one starts from what is on screen. */
function settle() {
  for (const a of running) a.cancel();
  running.clear();
  for (const g of ghosts) g.remove();
  ghosts.clear();
}

function play(el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
  const a = el.animate(frames, { easing: EASE, ...opts });
  running.add(a);
  a.finished.then(
    () => running.delete(a),
    () => running.delete(a),
  );
  return a;
}

function morph(change: () => void, grow = true) {
  // where things are now, mid-morph included (a box's measure carries its transform)
  const before = measure();
  settle();
  flushSync(change);
  const after = measure();
  const radius = getComputedStyle(document.documentElement).getPropertyValue('--radius-lg').trim() || '8px';
  for (const [el, r] of after.byEl) {
    let from = before.byEl.get(el);
    // new (not just hidden before, like the other groups while one was maximised, which fade back
    // in place): grow out of the element it came from, preferring one that has gone
    if (!from && grow && !before.all.has(el)) {
      let alt: DOMRect | undefined;
      for (const k of (el.dataset.morph ?? '').split(' ')) {
        const b = k ? before.byKey.get(k) : undefined;
        if (!b) continue;
        if (!after.byEl.has(b.el)) {
          from = b.r;
          break;
        }
        alt ??= b.r;
      }
      from ??= alt;
    }
    if (from) move(el, from, r, radius);
    else play(el, [{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: ENTER_MS });
  }
}

function move(el: HTMLElement, a: DOMRect, b: DOMRect, radius: string) {
  if (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5) return;
  const anchor = el.dataset.morphAnchor ?? 'tl';
  const right = anchor[1] === 'r';
  const bottom = anchor[0] === 'b';
  // the contents ride on the anchored corner of the frame…
  const dx = right ? a.right - b.right : a.left - b.left;
  const dy = bottom ? a.bottom - b.bottom : a.top - b.top;
  // …and are uncovered as it grows
  const gw = Math.max(0, b.width - a.width);
  const gh = Math.max(0, b.height - a.height);
  const inset = [bottom ? gh : 0, right ? 0 : gw, bottom ? 0 : gh, right ? gw : 0].map((v) => `${v}px`).join(' ');
  play(
    el,
    [
      { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${inset} round ${radius})` },
      { transform: 'translate(0px, 0px)', clipPath: `inset(0px 0px 0px 0px round ${radius})` },
    ],
    { duration: MORPH_MS },
  );
  // a frame that shrinks: a panel-coloured box closes from the old size around the contents
  if (a.width > b.width + 0.5 || a.height > b.height + 0.5) shrinkFrame(el, a, b, radius);
}

function shrinkFrame(el: HTMLElement, a: DOMRect, b: DOMRect, radius: string) {
  const parent = el.parentElement;
  if (!parent) return;
  const g = document.createElement('div');
  g.setAttribute('aria-hidden', 'true');
  const z = getComputedStyle(el).zIndex;
  Object.assign(g.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${b.width}px`,
    height: `${b.height}px`,
    pointerEvents: 'none',
    background: 'var(--panel-bg)',
    boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
    borderRadius: radius,
    transformOrigin: '0 0',
    zIndex: z === 'auto' ? '' : z,
  });
  // just before the element: under it, and out of any flex layout it is in
  parent.insertBefore(g, el);
  ghosts.add(g);
  const cb = (g.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? new DOMRect();
  g.style.left = `${b.left - cb.left}px`;
  g.style.top = `${b.top - cb.top}px`;
  const t0 = `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`;
  const done = () => {
    g.remove();
    ghosts.delete(g);
  };
  play(g, [{ transform: t0 }, { transform: 'none' }], { duration: MORPH_MS }).finished.then(done, done);
  // fade out as it closes, so the frame never shows doubled on the panel's own
  play(g, [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: MORPH_MS, easing: 'linear' });
}
