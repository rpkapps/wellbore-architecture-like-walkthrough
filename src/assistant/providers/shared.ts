import type { ChatMessage, ContextPart, FilePart, Part, ProviderConfig, ReasoningPart, TextPart, ToolCallPart, UIEventPart } from '../core/types';
import { ProviderError, isAbortError, networkError, toProviderError } from './errors';

/*
 * What the three adapters share: the one HTTP helper (CORS proxy, extra
 * headers, abort, error translation), the text form of non-text user parts,
 * the result a tool call reports, and the split of an assistant message into
 * model steps.
 */

/** A `fetch`-compatible function (the browser's, or a mock). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The request URL, behind the connection's CORS proxy when one is set (`{url}` in the proxy is replaced by the encoded URL). */
export function withProxy(url: string, corsProxy?: string): string {
  const p = corsProxy?.trim();
  if (!p) return url;
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
  return p + url;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

/**
 * Sends a request to a provider: applies the CORS proxy and the connection's
 * extra headers, always passes the abort signal, and throws a
 * `ProviderError` for network failures and non-OK responses (aborts are
 * rethrown as they are).
 */
export async function request(config: ProviderConfig, url: string, opts: RequestOptions = {}): Promise<Response> {
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  for (const [k, v] of Object.entries(config.headers ?? {})) if (k.trim() && v !== undefined) headers[k] = v;
  if (opts.body !== undefined) headers['content-type'] ??= 'application/json';
  const target = withProxy(url, config.corsProxy);
  let res: Response;
  try {
    res = await f(target, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) throw err;
    throw networkError(err, url, config);
  }
  if (!res.ok) throw await toProviderError(res, config);
  return res;
}

/**
 * Request-shape quirks a server taught us with its 400s (an optional field it
 * rejects, a value it needs), remembered per base URL and model for the
 * session so later requests are right the first time.
 */
export interface QuirkMemory<Q extends string> {
  get: (config: ProviderConfig) => Set<Q>;
  set: (config: ProviderConfig, quirks: ReadonlySet<Q>) => void;
  clear: () => void;
}

/** A new, empty quirk memory. */
export function quirkMemory<Q extends string>(): QuirkMemory<Q> {
  const map = new Map<string, Set<Q>>();
  const key = (c: ProviderConfig) => `${c.baseUrl}|${c.model}`;
  return {
    get: (c) => new Set(map.get(key(c)) ?? []),
    set: (c, q) => void map.set(key(c), new Set(q)),
    clear: () => map.clear(),
  };
}

/**
 * Sends a POST built from the remembered quirks; after a 400/422 that `learn`
 * maps to a new quirk, remembers it and sends again (at most `retries` times).
 * The shared "drop the optional field the server named" loop of the adapters.
 */
export async function requestLearning<Q extends string>(
  config: ProviderConfig,
  memory: QuirkMemory<Q>,
  build: (quirks: ReadonlySet<Q>) => { url: string; body: Record<string, unknown>; headers?: Record<string, string> },
  learn: (err: ProviderError, body: Record<string, unknown>, quirks: ReadonlySet<Q>) => Q | undefined,
  opts: { signal?: AbortSignal; fetch?: FetchLike; retries?: number } = {},
): Promise<Response> {
  const quirks = memory.get(config);
  for (let attempt = 0; ; attempt++) {
    const { url, body, headers } = build(quirks);
    try {
      return await request(config, url, { body, signal: opts.signal, fetch: opts.fetch, headers });
    } catch (err) {
      const q = err instanceof ProviderError && (err.status === 400 || err.status === 422) && attempt < (opts.retries ?? 2) ? learn(err, body, quirks) : undefined;
      if (!q || quirks.has(q)) throw err;
      quirks.add(q);
      memory.set(config, quirks);
    }
  }
}

/** Joins a base URL and a path without doubling slashes. */
export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

// ------------------------------------------------------------------ user parts as text

const json = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** The `<context>` block for a context part. */
export function contextText(part: ContextPart): string {
  const out: string[] = [];
  if (part.state) out.push(`<app_state>\n${part.state}\n</app_state>`);
  if (part.items.length) {
    const items = part.items.map((i) => ({ label: i.label, ...(i.description ? { description: i.description } : {}), data: i.data }));
    out.push(`<context>\nWhat the person attached to this message:\n${json(items)}\n</context>`);
  }
  return out.join('\n');
}

/** A text file attachment, inlined. */
export function fileText(part: FilePart): string {
  const note = part.truncated ? '\n[the file is longer: this is its beginning]' : '';
  return `<file name=${json(part.name)} type=${json(part.mediaType)}>\n${part.text}${note}\n</file>`;
}

/** An interaction with a generated interface, as the model reads it. */
export function uiEventText(part: UIEventPart): string {
  const payload: Record<string, unknown> = { surfaceId: part.surfaceId, action: part.name };
  if (part.sourceComponentId) payload.sourceComponentId = part.sourceComponentId;
  if (part.context && Object.keys(part.context).length) payload.context = part.context;
  const label = part.label ? `${part.label}\n` : '';
  return `<ui_event>\n${label}${json(payload)}\n</ui_event>`;
}

/** The text a user part contributes, or null for parts sent otherwise (images) or not at all. */
export function userPartText(part: Part): string | null {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'context':
      return part.items.length || part.state ? contextText(part) : null;
    case 'file':
      return fileText(part);
    case 'ui-event':
      return uiEventText(part);
    default:
      return null;
  }
}

/** A note in place of an image the model cannot see. */
export const IMAGE_OMITTED = '[image omitted: the model has no vision]';

// ------------------------------------------------------------------ tool results

/** What a call that was running when the person stopped the turn reports: it may have finished anyway. */
export const INTERRUPTED_RESULT = {
  interrupted: true,
  message: 'Stopped while it was running; it may have taken effect. Check the app state before repeating it.',
} as const;

/** What a tool call reports to the model, whatever state it ended in. */
export function toolResultFor(part: ToolCallPart): { value: unknown; isError: boolean } {
  switch (part.state) {
    case 'done':
      return { value: part.result === undefined ? { ok: true } : part.result, isError: false };
    case 'error':
      return { value: part.result ?? { error: part.error ?? 'The tool failed.' }, isError: true };
    case 'denied':
      return { value: part.result ?? { denied: true, message: 'The person declined this action.' }, isError: false };
    default:
      if (part.interrupted) return { value: part.result ?? INTERRUPTED_RESULT, isError: false };
      return { value: { cancelled: true, message: 'The person stopped the turn before this call ran.' }, isError: true };
  }
}

/** A tool result as the string most providers take. */
export function toolResultString(part: ToolCallPart): string {
  const { value } = toolResultFor(part);
  return typeof value === 'string' ? value : json(value);
}

// ------------------------------------------------------------------ assistant steps

/** One model round-trip inside an assistant message: what it said, then the calls it made. */
export interface AssistantStep {
  reasoning: ReasoningPart[];
  text: TextPart[];
  /** the text and reasoning in the order they came */
  content: (TextPart | ReasoningPart)[];
  calls: ToolCallPart[];
}

/**
 * Splits an assistant message into steps: a step ends with its tool calls,
 * and text or reasoning after a call starts the next one. UI and error
 * parts are dropped (a `render_ui` call carries its UI).
 */
export function assistantSteps(message: ChatMessage): AssistantStep[] {
  const steps: AssistantStep[] = [];
  let cur: AssistantStep = { reasoning: [], text: [], content: [], calls: [] };
  const flush = () => {
    if (cur.content.length || cur.calls.length) steps.push(cur);
    cur = { reasoning: [], text: [], content: [], calls: [] };
  };
  for (const p of message.parts) {
    if (p.type === 'text' || p.type === 'reasoning') {
      if (cur.calls.length) flush();
      if (p.type === 'text') cur.text.push(p);
      else cur.reasoning.push(p);
      cur.content.push(p);
    } else if (p.type === 'tool-call') {
      // a call from a later round-trip starts a new step, even with no text between
      const last = cur.calls[cur.calls.length - 1];
      if (last && p.step !== undefined && last.step !== undefined && p.step !== last.step) flush();
      cur.calls.push(p);
    }
  }
  flush();
  return steps;
}

/** The text of a step, joined. */
export const stepText = (step: AssistantStep) => step.text.map((t) => t.text).join('');

/** Arguments to replay for a call: an object (providers want JSON objects), `{}` when it had none. */
export function replayArgs(part: ToolCallPart): Record<string, unknown> {
  const a = part.args;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

/** Parses a finished tool call's argument JSON: `{}` for empty, or the error. */
export function parseToolArgs(text: string): { args: unknown; argsError?: string } {
  const t = text.trim();
  if (!t) return { args: {} };
  try {
    return { args: JSON.parse(t) };
  } catch (e) {
    return { args: {}, argsError: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

/** Whether the last message of the request is the assistant message being continued (a later step of the same turn). */
export const currentTurnAssistant = (messages: ChatMessage[]) => {
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' ? last : undefined;
};
