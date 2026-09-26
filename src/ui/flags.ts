import { useCallback, useSyncExternalStore } from 'react';
import type { FeatureFlags, FeatureId } from '../features/registry';

/**
 * Whether each of some features is on, re-rendering the caller only when one
 * of those changes (not when any other feature is switched): for the places
 * features live now (the Overlays folder, Settings › Graphics, the well
 * picker's footer).
 */
export function useFlags(flags: FeatureFlags, ids: readonly FeatureId[]): boolean[] {
  const subscribe = useCallback((fn: () => void) => flags.onAny(fn), [flags]);
  // a string snapshot: the same while those features stay as they are
  const bits = useSyncExternalStore(subscribe, () => ids.map((id) => (flags.on(id) ? '1' : '0')).join(''));
  return [...bits].map((b) => b === '1');
}
