import { startTransition, useLayoutEffect, useState } from 'react';
import type { Signal } from './signal';

/**
 * Layout changes that should animate (docking, folding, hiding the panels)
 * run through `withTransition`. The signals they set are mirrored into React
 * state by `useAnimatedSignal`, which applies a change made inside
 * `withTransition` with `startTransition`, so the `<ViewTransition>`
 * boundaries around the groups animate it. Everything else (a resize drag
 * ending, a restore) applies at once. React starts the browser's view
 * transition itself; nothing here calls `document.startViewTransition`.
 */
let animating = 0;

export function reducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduce-motion');
}

export function withTransition(change: () => void) {
  if (reducedMotion()) {
    change();
    return;
  }
  // after any menu or popover that triggered it has finished closing: React
  // Aria ends an exit animation with flushSync, which would cancel the
  // view transition while it prepares
  const t0 = performance.now();
  const go = () => {
    if (document.querySelector('[data-exiting]') && performance.now() - t0 < 600) {
      requestAnimationFrame(go);
      return;
    }
    animating++;
    try {
      change();
    } finally {
      animating--;
    }
  };
  requestAnimationFrame(go);
}

/** A signal's value as React state; changes made inside `withTransition` render as a Transition. */
export function useAnimatedSignal<T>(s: Signal<T>): T {
  const [v, setV] = useState(s.value);
  useLayoutEffect(() => {
    const sync = () => {
      const next = s.value;
      if (animating > 0) startTransition(() => setV(next));
      else setV(next);
    };
    sync();
    return s.subscribe(sync);
  }, [s]);
  return v;
}

/** A local state change that should animate through the `<ViewTransition>`s it affects. */
export function animate(fn: () => void) {
  if (reducedMotion()) fn();
  else startTransition(fn);
}
