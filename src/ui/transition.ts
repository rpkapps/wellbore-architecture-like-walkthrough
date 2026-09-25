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
/** when something last asked for a synchronous render (a toast): a view transition waits it out */
let lastSync = 0;

/** until when a view transition may still be preparing or running */
let busyUntil = 0;

/** Call before an update that will flush synchronously (sonner adds toasts with flushSync). */
export function noteSyncUpdate() {
  lastSync = performance.now();
}

/**
 * View transitions in flight. React starts them itself; watching the
 * document's method tells us when one is preparing or running, however long
 * a slow frame makes it.
 */
let running = 0;
if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = ((arg?: Parameters<typeof start>[0]) => {
    const t = start(arg);
    running++;
    void t.finished.finally(() => running--);
    return t;
  }) as typeof document.startViewTransition;
}

/** Milliseconds to wait before a synchronous render is safe (0: now). A toast waits this long. */
export function transitionBusyFor(): number {
  if (running > 0) return 60;
  return Math.max(0, busyUntil - performance.now());
}

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
    // a toast renders on a later tick, which a long task can delay: keep clear of it for a while
    const busy = document.querySelector('[data-exiting]') || performance.now() - lastSync < 400;
    if (busy && performance.now() - t0 < 600) {
      requestAnimationFrame(go);
      return;
    }
    animating++;
    busyUntil = performance.now() + 500;
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
  else {
    busyUntil = performance.now() + 500;
    startTransition(fn);
  }
}
