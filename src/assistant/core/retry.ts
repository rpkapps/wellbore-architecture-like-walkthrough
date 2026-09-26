import { abortError } from '../providers/sse';

/*
 * Automatic retries of transient provider failures (rate limits, overload,
 * server errors, a dropped connection) that happen before any output
 * arrived: exponential backoff with jitter, the provider's `retry-after`
 * honoured when it is short enough to wait for.
 */

/** Retries after the first attempt. */
export const MAX_RETRIES = 3;
/** The longest wait the kit sits through; a provider asking for longer gets its error shown. */
export const MAX_RETRY_WAIT_MS = 20_000;
const BASE_DELAY_MS = 1_000;

/**
 * The wait before retry number `attempt` (0-based): the provider's
 * `retry-after` when it gave one, else 1 s, 2 s, 4 s… with ±20 % jitter so
 * clients that failed together do not retry together. `undefined` when the
 * provider asked for longer than `MAX_RETRY_WAIT_MS`.
 */
export function retryDelay(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs > MAX_RETRY_WAIT_MS ? undefined : Math.max(0, retryAfterMs);
  return Math.round(BASE_DELAY_MS * 2 ** attempt * (0.8 + 0.4 * random()));
}

/** Waits, or rejects with an AbortError as soon as the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
