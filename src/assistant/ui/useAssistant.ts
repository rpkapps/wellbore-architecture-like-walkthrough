import { useRef, useSyncExternalStore } from 'react';
import type { AssistantController, AssistantSnapshot } from '../core/types';

/** The whole snapshot: re-renders on every change (header, dialogs). Rows use `useAssistantSelector`. */
export function useAssistant(controller: AssistantController): AssistantSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

interface SelectorCache<T> {
  snapshot: AssistantSnapshot;
  selector: (snapshot: AssistantSnapshot) => T;
  value: T;
}

/**
 * A slice of the snapshot: the component re-renders only when the slice
 * changes (by `isEqual`, `Object.is` by default; pass `shallowEqual` for a
 * selector that builds an object or an array).
 */
export function useAssistantSelector<T>(
  controller: AssistantController,
  selector: (snapshot: AssistantSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<SelectorCache<T> | null>(null);
  const read = (): T => {
    const snapshot = controller.getSnapshot();
    const current = cache.current;
    if (current && current.snapshot === snapshot && current.selector === selector) return current.value;
    const next = selector(snapshot);
    if (current && isEqual(current.value, next)) {
      cache.current = { snapshot, selector, value: current.value };
      return current.value;
    }
    cache.current = { snapshot, selector, value: next };
    return next;
  };
  return useSyncExternalStore(controller.subscribe, read, read);
}

/** Equal when both are the same, or arrays / plain objects whose entries are `Object.is`-equal. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
