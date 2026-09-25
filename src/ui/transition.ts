import { flushSync } from 'react-dom';

type StartViewTransition = (cb: () => void) => { finished: Promise<void> };

/**
 * Apply a layout change inside a view transition, so named elements (the
 * workspace's panel groups, the overlays) glide to their new place instead of
 * jumping. The page itself is not animated (the 3D view keeps drawing live);
 * without the API, or with reduced motion, the change is simply applied.
 */
export function withTransition(change: () => void) {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!start || document.documentElement.hasAttribute('data-reduce-motion')) {
    change();
    return;
  }
  start.call(document, () => flushSync(change));
}
