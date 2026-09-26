import type { Thread } from './types';

/*
 * A tiny external store for `useSyncExternalStore`: `set` stores the next
 * snapshot and publishes it on an animation frame, at most every
 * `MIN_INTERVAL_MS` (streaming tokens re-render the panel about 30 times a
 * second: smooth to read, and half the layout work of every frame, which the
 * host's own animation keeps); `set(next, {flush: true})` publishes at once
 * (status changes, actions).
 */

/** Shortest time between two published snapshots while values stream in. */
export const MIN_INTERVAL_MS = 33;

export interface Store<T> {
  /** the published snapshot (what subscribers have been told about) */
  get: () => T;
  /** the latest value, published or not */
  peek: () => T;
  set: (next: T, opts?: { flush?: boolean }) => void;
  subscribe: (listener: () => void) => () => void;
  /** publishes a pending value now */
  flush: () => void;
  dispose: () => void;
}

type Cancel = () => void;

function schedule(fn: () => void, delay: number): Cancel {
  if (delay > 0) {
    let inner: Cancel | null = null;
    const t = setTimeout(() => (inner = schedule(fn, 0)), delay);
    return () => {
      clearTimeout(t);
      inner?.();
    };
  }
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
    const id = requestAnimationFrame(fn);
    // a hidden tab gets no frames: fall back to a timer so the transcript still completes
    const t = setTimeout(fn, 100);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }
  const t = setTimeout(fn, 16);
  return () => clearTimeout(t);
}

/** Creates a frame-batched store. */
export function createStore<T>(initial: T): Store<T> {
  let published = initial;
  let latest = initial;
  let cancel: Cancel | null = null;
  let publishedAt = -Infinity;
  const listeners = new Set<() => void>();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const publish = () => {
    cancel?.();
    cancel = null;
    if (published === latest) return;
    published = latest;
    publishedAt = clock();
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        // one broken listener must not stop the others
        setTimeout(() => {
          throw e;
        });
      }
    }
  };

  return {
    get: () => published,
    peek: () => latest,
    set(next, opts) {
      latest = next;
      if (opts?.flush) publish();
      else if (!cancel) cancel = schedule(publish, Math.max(0, MIN_INTERVAL_MS - (clock() - publishedAt)));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: publish,
    dispose() {
      cancel?.();
      cancel = null;
      listeners.clear();
    },
  };
}

/** A thread title from its first message: the first ~48 characters, cut at a word. */
export function titleFrom(text: string, max = 48): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** A thread without its messages, for the list. */
export const threadMeta = (t: Thread) => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt });
