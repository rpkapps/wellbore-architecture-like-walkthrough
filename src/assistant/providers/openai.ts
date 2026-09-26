import type { ChatMessage, FinishReason, ModelInfo, ModelRequest, ProviderAdapter, ProviderConfig, StreamEvent, Usage } from '../core/types';
import { ProviderError, errorFromStatus } from './errors';
import { isDoneSentinel, readSSE } from './sse';
import {
  IMAGE_OMITTED,
  assistantSteps,
  currentTurnAssistant,
  joinUrl,
  parseToolArgs,
  quirkMemory,
  replayArgs,
  request,
  requestLearning,
  stepText,
  toolResultString,
  userPartText,
  type FetchLike,
} from './shared';

/*
 * The OpenAI Chat Completions protocol, spoken by OpenAI and by most other
 * providers (DeepSeek, OpenRouter, Groq, Mistral, xAI, Together, Fireworks,
 * Cerebras, Ollama, LM Studio). Provider quirks are keyed on the preset id.
 */

export interface AdapterOptions {
  /** the fetch to use (defaults to the global one): a mock in tests and demos */
  fetch?: FetchLike;
}

type OAIContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

export interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: OAIContent }
  | { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Mistral accepts only 9-character alphanumeric call ids: other providers' ids are hashed into that shape. */
export function mistralCallId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36) + '000000000').replace(/[^a-z0-9]/g, '').slice(0, 9);
}

/** The transcript in Chat Completions form. */
export function toOpenAIMessages(req: Pick<ModelRequest, 'config' | 'system' | 'messages'>): OAIMessage[] {
  const { config } = req;
  const out: OAIMessage[] = [];
  if (req.system.trim()) out.push({ role: 'system', content: req.system });
  const mistral = config.presetId === 'mistral' || /mistral\.ai/.test(config.baseUrl);
  const callId = (id: string) => (mistral ? mistralCallId(id) : id);
  const current = currentTurnAssistant(req.messages);
  const sendReasoning = config.presetId === 'deepseek';

  for (const m of req.messages) {
    if (m.role === 'user') {
      const content = userContent(m, !!config.vision);
      if (content !== null) out.push({ role: 'user', content });
      continue;
    }
    for (const step of assistantSteps(m)) {
      const text = stepText(step);
      if (!text && !step.calls.length) continue;
      const msg: OAIMessage & { role: 'assistant' } = { role: 'assistant', content: text || (step.calls.length ? null : '') };
      if (step.calls.length) {
        msg.tool_calls = step.calls.map((c) => ({ id: callId(c.id), type: 'function', function: { name: c.name, arguments: JSON.stringify(replayArgs(c)) } }));
        // DeepSeek thinking mode: the reasoning of a tool-calling step must come back within the same turn (and only then)
        if (sendReasoning && m === current) {
          const r = step.reasoning.map((p) => p.text).join('');
          if (r) msg.reasoning_content = r;
        }
      }
      out.push(msg);
      for (const c of step.calls) out.push({ role: 'tool', tool_call_id: callId(c.id), content: toolResultString(c) });
    }
  }
  return out;
}

function userContent(m: ChatMessage, vision: boolean): OAIContent | null {
  const blocks: Exclude<OAIContent, string> = [];
  let hasImage = false;
  for (const p of m.parts) {
    if (p.type === 'image') {
      if (vision) {
        hasImage = true;
        blocks.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
      } else blocks.push({ type: 'text', text: IMAGE_OMITTED });
      continue;
    }
    const t = userPartText(p);
    if (t) blocks.push({ type: 'text', text: t });
  }
  if (!blocks.length) return null;
  if (!hasImage) return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n');
  return blocks;
}

/** Presets whose Chat Completions endpoint takes `reasoning_effort`. */
const EFFORT_PRESETS = new Set(['openai', 'groq', 'xai']);

/** Optional request fields a server may reject: dropped (and remembered) after a 400 that names them. */
const OPTIONAL_FIELDS = ['stream_options', 'reasoning_effort', 'reasoning', 'max_completion_tokens', 'parallel_tool_calls'] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];
/**
 * What a server taught us: fields to leave out, and `effort-none`: the model
 * reasons by default but takes function tools on this endpoint only with
 * `reasoning_effort: 'none'` (OpenAI's newest models on /chat/completions).
 */
export type OpenAIQuirk = OptionalField | 'effort-none';
const quirks = quirkMemory<OpenAIQuirk>();

/** The request body (exported for tests). */
export function buildOpenAIBody(req: ModelRequest, drop: ReadonlySet<OpenAIQuirk> = new Set()): Record<string, unknown> {
  const { config } = req;
  const body: Record<string, unknown> = { model: config.model, messages: toOpenAIMessages(req), stream: true };
  if (!drop.has('stream_options')) body.stream_options = { include_usage: true };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (config.maxOutputTokens) {
    if (config.presetId === 'openai' && !drop.has('max_completion_tokens')) body.max_completion_tokens = config.maxOutputTokens;
    else body.max_tokens = config.maxOutputTokens;
  }
  const effort = config.reasoning;
  if (drop.has('effort-none')) {
    if (!drop.has('reasoning_effort')) body.reasoning_effort = 'none';
  } else if (effort && effort !== 'off') {
    if (config.presetId === 'openrouter') {
      if (!drop.has('reasoning')) body.reasoning = { effort };
    } else if (EFFORT_PRESETS.has(config.presetId) && !drop.has('reasoning_effort')) body.reasoning_effort = effort;
  }
  return body;
}

/** The bearer key and OpenRouter's referer (also used by the Responses adapter). */
export function authHeaders(config: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
  if (config.presetId === 'openrouter' && !Object.keys(config.headers ?? {}).some((k) => k.toLowerCase() === 'http-referer') && typeof location !== 'undefined')
    h['HTTP-Referer'] = location.origin;
  return h;
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', tool_calls: 'tool-calls', function_call: 'tool-calls', length: 'length', content_filter: 'content-filter' };

interface Accum {
  id: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
}

/** Parses a Chat Completions SSE stream into kit stream events (exported for tests). */
export async function* parseOpenAIStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal, config?: ProviderConfig): AsyncGenerator<StreamEvent> {
  const calls = new Map<number, Accum>();
  const order: number[] = [];
  let finish: string | undefined;
  let usage: Usage | undefined;
  let sawText = false;

  const endCalls = function* (): Generator<StreamEvent> {
    for (const idx of order) {
      const c = calls.get(idx)!;
      if (c.ended) continue;
      if (!c.started) {
        // a call whose name never arrived cannot be run: still report it so the model hears back
        c.started = true;
        yield { type: 'tool-call-start', id: c.id, name: c.name || 'unknown' };
        if (c.args) yield { type: 'tool-call-delta', id: c.id, argsText: c.args };
      }
      c.ended = true;
      const { args, argsError } = parseToolArgs(c.args);
      yield argsError ? { type: 'tool-call-end', id: c.id, args, argsError } : { type: 'tool-call-end', id: c.id, args };
    }
  };

  for await (const ev of readSSE(body, signal)) {
    if (isDoneSentinel(ev.data)) break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue; // keep-alive noise some proxies send as data
    }
    if (chunk.error) {
      const e = chunk.error as { code?: unknown; message?: unknown };
      const status = typeof e.code === 'number' ? e.code : 500;
      throw errorFromStatus(status, JSON.stringify(chunk), undefined, config);
    }
    if (chunk.usage && typeof chunk.usage === 'object') usage = mapUsage(chunk.usage as Record<string, unknown>);
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
    const choice = choices[0];
    if (!choice) continue;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
    if (typeof delta.content === 'string' && delta.content) {
      sawText = true;
      yield { type: 'text-delta', text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const tc = raw as { index?: number; id?: string; function?: { name?: string; arguments?: unknown } };
        let idx: number;
        if (typeof tc.index === 'number') idx = tc.index;
        else {
          // no index (Mistral, some proxies): match by id, else a new call when an id comes, else the last call continues
          const known = tc.id ? order.find((i) => calls.get(i)!.id === tc.id) : undefined;
          idx = known ?? (tc.id || !order.length ? Math.max(-1, ...order) + 1 : order[order.length - 1]);
        }
        let c = calls.get(idx);
        if (!c) {
          c = { id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: '', args: '', started: false, ended: false };
          calls.set(idx, c);
          order.push(idx);
        } else if (tc.id && !c.started && !c.name) c.id = tc.id;
        if (tc.function?.name && !c.started) c.name += tc.function.name;
        const a = tc.function?.arguments;
        const argText = typeof a === 'string' ? a : a && typeof a === 'object' ? JSON.stringify(a) : '';
        if (!c.started && c.name) {
          c.started = true;
          yield { type: 'tool-call-start', id: c.id, name: c.name };
          if (c.args) yield { type: 'tool-call-delta', id: c.id, argsText: c.args };
        }
        if (argText) {
          c.args += argText;
          if (c.started) yield { type: 'tool-call-delta', id: c.id, argsText: argText };
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finish = choice.finish_reason;
      yield* endCalls();
    }
  }
  yield* endCalls();
  if (usage) yield { type: 'usage', usage };
  let reason: FinishReason = finish ? (FINISH[finish] ?? 'other') : sawText || calls.size ? 'stop' : 'other';
  // some servers (Ollama, a few proxies) report `stop` after tool calls
  if (calls.size && reason === 'stop') reason = 'tool-calls';
  yield { type: 'finish', reason };
}

function mapUsage(u: Record<string, unknown>): Usage {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const out: Usage = {};
  const input = num(u.prompt_tokens) ?? num(u.input_tokens);
  const output = num(u.completion_tokens) ?? num(u.output_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  const pd = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(pd?.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  if (cached !== undefined) out.cachedInputTokens = cached;
  const cd = u.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoning = num(cd?.reasoning_tokens);
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}

/** The OpenAI-compatible adapter. */
export function createOpenAIAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    kind: 'openai',
    async *stream(req) {
      const { config, signal } = req;
      // a server that rejects an optional field: drop it, remember, and ask again
      const res = await requestLearning(
        config,
        quirks,
        (q) => ({ url: joinUrl(config.baseUrl, 'chat/completions'), body: buildOpenAIBody(req, q), headers: { ...authHeaders(config), accept: 'text/event-stream' } }),
        rejectedField,
        { signal, fetch: opts.fetch, retries: 3 },
      );
      if (!res.body) throw new ProviderError('The provider sent an empty response.', { retryable: true });
      yield* parseOpenAIStream(res.body, signal, config);
    },
    async listModels(config, signal) {
      const res = await request(config, joinUrl(config.baseUrl, 'models'), { signal, fetch: opts.fetch, headers: authHeaders(config) });
      const json = (await res.json()) as { data?: { id?: string; context_length?: number; context_window?: number; name?: string }[]; models?: { id?: string; name?: string }[] };
      const list = json.data ?? json.models ?? [];
      const out: ModelInfo[] = [];
      for (const m of list) {
        const id = m.id ?? m.name;
        if (!id) continue;
        const info: ModelInfo = { id };
        const ctx = (m as { context_length?: number; context_window?: number }).context_length ?? (m as { context_window?: number }).context_window;
        if (typeof ctx === 'number') info.contextWindow = ctx;
        out.push(info);
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

function rejectedField(err: ProviderError, body: Record<string, unknown>, known: ReadonlySet<OpenAIQuirk>): OpenAIQuirk | undefined {
  const text = `${err.detail ?? ''} ${err.message}`.toLowerCase();
  // "Function tools with reasoning_effort are not supported for <model> in /v1/chat/completions … set reasoning_effort to 'none'": ask again without reasoning
  if (!known.has('effort-none') && body.reasoning_effort !== 'none' && /reasoning_effort/.test(text) && /not supported|none/.test(text)) return 'effort-none';
  for (const f of OPTIONAL_FIELDS) if (f in body && text.includes(f)) return f;
  if ('stream_options' in body && /include_usage|extra (inputs|fields)|unrecognized|unknown (field|parameter)|additional properties/.test(text)) return 'stream_options';
  return undefined;
}

/** Forgets the fields servers rejected (tests). */
export function resetOpenAIQuirks() {
  quirks.clear();
}
