import type { Thread } from './types';

/*
 * A tiny external store for `useSyncExternalStore`: `set` stores the next
 * snapshot and publishes it at most once per animation frame (streaming
 * tokens do not re-render the panel more often than the screen refreshes);
 * `set(next, {flush: true})` publishes at once (status changes, actions).
 */

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

function schedule(fn: () => void): Cancel {
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
  const listeners = new Set<() => void>();

  const publish = () => {
    cancel?.();
    cancel = null;
    if (published === latest) return;
    published = latest;
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
      else if (!cancel) cancel = schedule(publish);
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
