import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';

type Listener = () => void;

/**
 * A value the imperative side (controller, engine, feature modules) owns and
 * the React chrome renders. `set` notifies only when the value changes, so a
 * per-frame writer re-renders its subscribers only when what they show moves.
 */
export class Signal<T> {
  private listeners = new Set<Listener>();

  constructor(private v: T) {}

  get value(): T {
    return this.v;
  }

  set(v: T) {
    if (Object.is(v, this.v)) return;
    this.v = v;
    for (const l of [...this.listeners]) l();
  }

  update(fn: (v: T) => T) {
    this.set(fn(this.v));
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/**
 * Revision counter for mutable state that lives outside React (geology layer
 * state, feature options, well data): bump it after mutating, and components
 * that read the state through `useRev` render again.
 */
export class Rev extends Signal<number> {
  constructor() {
    super(0);
  }

  bump() {
    this.set(this.value + 1);
  }
}

export function useSignal<T>(s: Signal<T>): T {
  return useSyncExternalStore(s.subscribe, () => s.value);
}

/** Subscribe to one or more revision counters; returns their sum so callers can key memos on it. */
export function useRev(...revs: Rev[]): number {
  let sum = 0;
  for (const r of revs) sum += useSignal(r);
  return sum;
}

/** Renders whatever a signal of React content currently holds (read-outs features update per frame). */
export function Live({ s }: { s: Signal<ReactNode> }): ReactNode {
  return createElement(Fragment, null, useSignal(s));
}
