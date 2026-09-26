import type { ErrorPart, ProviderConfig } from '../core/types';

/**
 * A failed provider request, with a message a person can act on ("The API
 * key was rejected (401)…") and the raw detail for the transcript's
 * "details" disclosure. `config` means the fix is in Settings (key, model,
 * base URL, CORS proxy); `retryable` means trying again may work.
 */
export class ProviderError extends Error {
  override name = 'ProviderError';
  status?: number;
  detail?: string;
  retryable: boolean;
  config: boolean;
  /** how long the provider asked to wait (from `retry-after` or the error body) */
  retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; detail?: string; retryable?: boolean; config?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.status = opts.status;
    this.detail = opts.detail;
    this.retryable = opts.retryable ?? false;
    this.config = opts.config ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Whether an error is an abort (the person pressed stop, or a timeout aborted the request). */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** The provider's own message from an error body (OpenAI, Anthropic, Gemini, FastAPI-style and plain-text bodies). */
export function extractProviderMessage(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  try {
    const json = JSON.parse(text) as unknown;
    const pick = (v: unknown): string | undefined => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return pick(v[0]);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return pick(o.error) ?? pick(o.message) ?? pick(o.detail) ?? pick(o.msg);
      }
      return undefined;
    };
    return pick(json) ?? text.slice(0, 500);
  } catch {
    // an HTML error page from a proxy says little: keep its first line only
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
  }
}

/** Milliseconds to wait, from `retry-after` / `retry-after-ms` headers or a Gemini `RetryInfo.retryDelay` ("30s"). */
export function parseRetryAfter(headers: Headers | undefined, body?: string): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers?.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const m = body && /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (m) return Number(m[1]) * 1000;
  return undefined;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Reads a non-OK response's body and turns it into a `ProviderError` with a human message. */
export async function toProviderError(res: Response, config?: Pick<ProviderConfig, 'model' | 'label' | 'baseUrl'>): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* the body could not be read: the status says enough */
  }
  return errorFromStatus(res.status, body, res.headers, config);
}

/** The `ProviderError` for an HTTP status and error body (also used for errors reported inside a stream). */
export function errorFromStatus(status: number, body: string, headers?: Headers, config?: Pick<ProviderConfig, 'model' | 'label' | 'baseUrl'>): ProviderError {
  const said = extractProviderMessage(body);
  const detail = `HTTP ${status}${said ? `: ${said}` : ''}`;
  const lower = (said ?? '').toLowerCase();
  const who = config?.label || 'The provider';
  const retryAfterMs = parseRetryAfter(headers, body);
  const mk = (message: string, o: { retryable?: boolean; config?: boolean } = {}) => new ProviderError(message, { status, detail, retryAfterMs, ...o });

  if (status === 401) return mk(`The API key was rejected (401). Check the key for ${who} in Settings.`, { config: true });
  if (status === 403) {
    if (/region|country|location|territory/.test(lower)) return mk(`${who} refused the request from this region (403).`, { config: true });
    return mk(`Access denied (403): the key may not have access to ${config?.model ? `“${config.model}”` : 'this model'}. Check the key and model in Settings.`, { config: true });
  }
  if (status === 402 || /insufficient.?(balance|quota|credit)|billing|exceeded your current quota|credit balance/.test(lower))
    return mk(`${who} reports the account is out of credit or quota${status === 402 ? ' (402)' : ''}. Top it up or pick another provider.`, { config: true });
  if (status === 404 || /model.{0,40}(not found|does not exist|not exist|unknown|invalid model|not supported)|no such model|unknown model/.test(lower)) {
    if (status === 404 && !/model/.test(lower)) return mk(`Nothing answered at this address (404). Check the base URL in Settings.`, { config: true });
    return mk(`Model not found${config?.model ? `: “${config.model}”` : ''}. Pick another model in Settings.`, { config: true });
  }
  if (status === 429) {
    const wait = retryAfterMs !== undefined ? ` — retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s` : ' — wait a moment and retry';
    return mk(`Rate limited${wait}.`, { retryable: true });
  }
  if (status === 413 || /context.{0,20}(length|window)|too many tokens|maximum.{0,30}tokens|prompt is too long|input.{0,20}too long|reduce the length/.test(lower))
    return mk('The conversation is too long for this model. Start a new thread or remove attachments.', {});
  if (status === 408 || status === 504) return mk(`${who} timed out (${status}). Try again.`, { retryable: true });
  if (status === 529 || /overloaded/.test(lower)) return mk(`${who} is overloaded right now (${status}). Try again in a moment.`, { retryable: true });
  if (status >= 500) return mk(`${who} had a server error (${status}). Try again.`, { retryable: true });
  if (status === 400 || status === 422) return mk(`${who} rejected the request (${status})${said ? `: ${said.slice(0, 240)}` : '.'}`, {});
  return mk(`${who} answered with an error (${status})${said ? `: ${said.slice(0, 240)}` : '.'}`, {});
}

/**
 * A fetch that failed before any response (`TypeError: Failed to fetch`):
 * offline, a wrong address, a local server that is not running, or, most
 * often from a browser, a provider that does not allow cross-origin requests.
 */
export function networkError(err: unknown, url: string, config?: Pick<ProviderConfig, 'label' | 'baseUrl' | 'corsProxy'>): ProviderError {
  const host = hostOf(url);
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
  const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const target = url.startsWith('http:');
  const hints: string[] = [];
  if (local) {
    hints.push(
      'Make sure the local server is running and allows requests from this page’s origin (Ollama: start it with OLLAMA_ORIGINS=*; LM Studio: enable CORS in the server settings).',
    );
  } else {
    hints.push(
      `${config?.label || 'The provider'} may block requests made directly from a browser (CORS). Set a CORS proxy for this connection in Settings, or use a provider that allows browser requests.`,
    );
  }
  if (pageHttps && target && !local) hints.push('This page is served over HTTPS, so the browser blocks plain-HTTP endpoints (mixed content).');
  const message = `Could not reach ${host}. ${hints.join(' ')}`;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new ProviderError(message, { detail, retryable: true, config: true });
}

/** Any thrown value as a `ProviderError` (aborts are passed through unchanged by callers before this). */
export function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error) return new ProviderError(err.message || 'Something went wrong.', { detail: err.stack?.split('\n').slice(0, 3).join('\n'), retryable: false });
  return new ProviderError(String(err));
}

/** The transcript's error part for an error. */
export function toErrorPart(err: unknown): ErrorPart {
  const e = asProviderError(err);
  const part: ErrorPart = { type: 'error', message: e.message };
  if (e.detail) part.detail = e.detail;
  if (e.retryable) part.retryable = true;
  if (e.config) part.config = true;
  return part;
}
