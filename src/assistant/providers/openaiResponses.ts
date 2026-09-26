import type { ChatMessage, FinishReason, ModelRequest, ProviderAdapter, ProviderConfig, ReasoningPart, StreamEvent, Usage } from '../core/types';
import { ProviderError, errorFromStatus } from './errors';
import { authHeaders, createOpenAIAdapter, type AdapterOptions } from './openai';
import { readSSE } from './sse';
import {
  IMAGE_OMITTED,
  assistantSteps,
  currentTurnAssistant,
  joinUrl,
  parseToolArgs,
  quirkMemory,
  replayArgs,
  requestLearning,
  stepText,
  toolResultString,
  userPartText,
} from './shared';

/*
 * OpenAI's Responses API (`POST /responses`), used by the OpenAI preset:
 * OpenAI's reasoning models take function tools with reasoning only here.
 * Requests are stateless (`store: false`): the whole transcript is sent each
 * time, and the reasoning of the turn in progress comes back as encrypted
 * items (`include: ['reasoning.encrypted_content']`) that are replayed before
 * the function calls they led to, so the model keeps its train of thought
 * across tool round-trips.
 */

/** The `providerMeta` key of a reasoning part's encrypted reasoning item. */
export const RESPONSES_META = 'openai-responses';

/** What a reasoning part keeps of the Responses reasoning item it came from. */
export interface ResponsesReasoningMeta {
  id?: string;
  encryptedContent: string;
}

type InputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' };

export type ResponsesItem =
  | { role: 'user'; content: InputContent[] }
  | { role: 'assistant'; content: { type: 'output_text'; text: string }[] }
  | { type: 'reasoning'; id?: string; encrypted_content: string; summary: [] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

const metaOf = (p: ReasoningPart): ResponsesReasoningMeta | undefined => {
  const m = p.providerMeta?.[RESPONSES_META] as Partial<ResponsesReasoningMeta> | undefined;
  return m && typeof m.encryptedContent === 'string' && m.encryptedContent ? { id: typeof m.id === 'string' ? m.id : undefined, encryptedContent: m.encryptedContent } : undefined;
};

/** The transcript as Responses input items (exported for tests). */
export function toResponsesInput(req: Pick<ModelRequest, 'config' | 'messages'>): ResponsesItem[] {
  const { config } = req;
  const out: ResponsesItem[] = [];
  const current = currentTurnAssistant(req.messages);
  for (const m of req.messages) {
    if (m.role === 'user') {
      const content = userContent(m, !!config.vision);
      if (content.length) out.push({ role: 'user', content });
      continue;
    }
    // encrypted reasoning is valid for the model that wrote it, and only needed within the turn in progress
    const replay = m === current && (!m.model || m.model === config.model);
    for (const step of assistantSteps(m)) {
      if (replay && step.calls.length)
        for (const r of step.reasoning) {
          const meta = metaOf(r);
          if (meta) out.push(meta.id ? { type: 'reasoning', id: meta.id, encrypted_content: meta.encryptedContent, summary: [] } : { type: 'reasoning', encrypted_content: meta.encryptedContent, summary: [] });
        }
      const text = stepText(step);
      if (text.trim()) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const c of step.calls) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(replayArgs(c)) });
      for (const c of step.calls) out.push({ type: 'function_call_output', call_id: c.id, output: toolResultString(c) });
    }
  }
  return out;
}

function userContent(m: ChatMessage, vision: boolean): InputContent[] {
  const out: InputContent[] = [];
  for (const p of m.parts) {
    if (p.type === 'image') {
      out.push(vision ? { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}`, detail: 'auto' } : { type: 'input_text', text: IMAGE_OMITTED });
      continue;
    }
    const t = userPartText(p);
    if (t) out.push({ type: 'input_text', text: t });
  }
  return out;
}

/** Request fields a model may reject, dropped (and remembered per base URL and model) after a 400 that names them. */
export type ResponsesQuirk = 'include' | 'summary' | 'reasoning' | 'temperature';
const quirks = quirkMemory<ResponsesQuirk>();

/** The request body (exported for tests). */
export function buildResponsesBody(req: ModelRequest, drop: ReadonlySet<ResponsesQuirk> = new Set()): Record<string, unknown> {
  const { config } = req;
  const body: Record<string, unknown> = { model: config.model };
  if (req.system.trim()) body.instructions = req.system;
  body.input = toResponsesInput(req);
  body.stream = true;
  body.store = false;
  if (!drop.has('include')) body.include = ['reasoning.encrypted_content'];
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    body.tool_choice = 'auto';
  }
  const effort = config.reasoning;
  const thinking = !!effort && effort !== 'off';
  if (!drop.has('reasoning')) {
    // unset: the model's own effort, with its reasoning summarised for the transcript; "Off" asks it not to reason
    // (a model without these settings says so in a 400, and the field is dropped)
    if (thinking) body.reasoning = drop.has('summary') ? { effort } : { effort, summary: 'auto' };
    else if (effort === 'off') body.reasoning = { effort: 'none' };
    else if (!drop.has('summary')) body.reasoning = { summary: 'auto' };
  }
  if (config.maxOutputTokens) body.max_output_tokens = config.maxOutputTokens;
  if (config.temperature !== undefined && !thinking && !drop.has('temperature')) body.temperature = config.temperature;
  return body;
}

function learn(err: ProviderError, body: Record<string, unknown>): ResponsesQuirk | undefined {
  const text = `${err.detail ?? ''} ${err.message}`.toLowerCase();
  const reasoning = body.reasoning as { effort?: string; summary?: string } | undefined;
  if ('include' in body && /encrypted_content|\binclude\b/.test(text)) return 'include';
  // an organisation that is not verified for reasoning summaries
  if (reasoning?.summary && /summar/.test(text)) return 'summary';
  if (reasoning && (/reasoning/.test(text) || (reasoning.effort === 'none' && /'none'|"none"|\bnone\b/.test(text)))) return 'reasoning';
  if ('temperature' in body && /temperature/.test(text)) return 'temperature';
  return undefined;
}

/** The HTTP status an error code reported inside the stream stands for. */
function statusOfCode(code: unknown): number {
  const c = typeof code === 'string' ? code.toLowerCase() : '';
  if (/rate_limit|insufficient_quota/.test(c)) return 429;
  if (/unauthori[sz]ed|invalid_api_key/.test(c)) return 401;
  if (/context_length|invalid|bad_request|unsupported|not_found|too_large|too_long/.test(c)) return 400;
  if (/overloaded/.test(c)) return 529;
  if (typeof code === 'number' && code >= 400) return code;
  return 500;
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

function mapUsage(u: Record<string, unknown>): Usage {
  const out: Usage = {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  const cached = num((u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  if (cached !== undefined) out.cachedInputTokens = cached;
  const reasoning = num((u.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}

interface Call {
  callId: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
}

/** Parses a Responses SSE stream into kit stream events (exported for tests). */
export async function* parseResponsesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal, config?: ProviderConfig): AsyncGenerator<StreamEvent> {
  /** function calls by item id (and by output index, for servers that leave the id out of deltas) */
  const calls = new Map<string, Call>();
  const byIndex = new Map<number, Call>();
  /** reasoning items: which summary part was last streamed, and whether it streamed summaries or raw reasoning text */
  const reasoning = new Map<string, { summaryIndex: number; streamed: boolean; source?: 'summary' | 'text' }>();
  const textItems = new Set<string>();
  let usage: Usage | undefined;
  let finish: FinishReason | undefined;
  let sawText = false;

  const callOf = (data: Record<string, unknown>) =>
    (typeof data.item_id === 'string' ? calls.get(data.item_id) : undefined) ?? (typeof data.output_index === 'number' ? byIndex.get(data.output_index) : undefined);
  const startCall = function* (c: Call): Generator<StreamEvent> {
    if (c.started) return;
    c.started = true;
    yield { type: 'tool-call-start', id: c.callId, name: c.name || 'unknown' };
    if (c.args) yield { type: 'tool-call-delta', id: c.callId, argsText: c.args };
  };
  const endCall = function* (c: Call, final?: unknown): Generator<StreamEvent> {
    if (c.ended) return;
    yield* startCall(c);
    // the complete arguments, when the deltas missed some (or none were sent)
    if (typeof final === 'string' && final.length > c.args.length && final.startsWith(c.args)) {
      const rest = final.slice(c.args.length);
      c.args = final;
      yield { type: 'tool-call-delta', id: c.callId, argsText: rest };
    }
    c.ended = true;
    const { args, argsError } = parseToolArgs(c.args);
    yield argsError ? { type: 'tool-call-end', id: c.callId, args, argsError } : { type: 'tool-call-end', id: c.callId, args };
  };
  const reasoningDelta = function* (itemId: string, source: 'summary' | 'text', delta: unknown, index?: unknown): Generator<StreamEvent> {
    if (typeof delta !== 'string' || !delta) return;
    const r = reasoning.get(itemId) ?? { summaryIndex: 0, streamed: false };
    reasoning.set(itemId, r);
    // a server that streams both summaries and raw reasoning: keep the first
    if (r.source && r.source !== source) return;
    r.source = source;
    const i = typeof index === 'number' ? index : r.summaryIndex;
    // summary parts are separate paragraphs
    const sep = r.streamed && i !== r.summaryIndex ? '\n\n' : '';
    r.summaryIndex = i;
    r.streamed = true;
    yield { type: 'reasoning-delta', text: sep + delta };
  };
  const streamError = (e: { code?: unknown; message?: unknown } | undefined): ProviderError => {
    const error = { code: e?.code ?? 'server_error', message: typeof e?.message === 'string' ? e.message : 'The response failed.' };
    return errorFromStatus(statusOfCode(error.code), JSON.stringify({ error }), undefined, config);
  };

  for await (const ev of readSSE(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue; // `[DONE]` from some compatible servers, keep-alive noise
    }
    const type = typeof data.type === 'string' ? data.type : ev.event;
    switch (type) {
      case 'response.output_item.added': {
        const item = (data.item ?? {}) as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id : `item_${typeof data.output_index === 'number' ? data.output_index : calls.size}`;
        if (item.type === 'function_call') {
          const c: Call = { callId: String(item.call_id ?? id), name: String(item.name ?? ''), args: typeof item.arguments === 'string' ? item.arguments : '', started: false, ended: false };
          calls.set(id, c);
          if (typeof data.output_index === 'number') byIndex.set(data.output_index, c);
          if (c.name) yield* startCall(c);
        } else if (item.type === 'reasoning') reasoning.set(id, { summaryIndex: 0, streamed: false });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const c = callOf(data);
        if (!c || c.ended || typeof data.delta !== 'string' || !data.delta) break;
        c.args += data.delta;
        if (c.started) yield { type: 'tool-call-delta', id: c.callId, argsText: data.delta };
        break;
      }
      case 'response.function_call_arguments.done': {
        const c = callOf(data);
        if (c) yield* endCall(c, data.arguments);
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof data.delta !== 'string' || !data.delta) break;
        if (typeof data.item_id === 'string') textItems.add(data.item_id);
        sawText = true;
        yield { type: 'text-delta', text: data.delta };
        break;
      }
      case 'response.reasoning_summary_text.delta':
        yield* reasoningDelta(String(data.item_id ?? ''), 'summary', data.delta, data.summary_index);
        break;
      case 'response.reasoning_text.delta':
        yield* reasoningDelta(String(data.item_id ?? ''), 'text', data.delta, data.content_index);
        break;
      case 'response.output_item.done': {
        const item = (data.item ?? {}) as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id : undefined;
        if (item.type === 'function_call') {
          let c = (id ? calls.get(id) : undefined) ?? (typeof data.output_index === 'number' ? byIndex.get(data.output_index) : undefined);
          if (!c) {
            // a server that sends the call whole
            c = { callId: String(item.call_id ?? id ?? `call_${calls.size}`), name: String(item.name ?? ''), args: '', started: false, ended: false };
            calls.set(id ?? c.callId, c);
          }
          yield* endCall(c, item.arguments);
        } else if (item.type === 'reasoning') {
          const r = id ? reasoning.get(id) : undefined;
          // summaries that were not streamed
          if (!r?.streamed && Array.isArray(item.summary)) {
            const text = (item.summary as { text?: unknown }[])
              .map((s) => (typeof s.text === 'string' ? s.text : ''))
              .filter(Boolean)
              .join('\n\n');
            if (text) yield { type: 'reasoning-delta', text };
          }
          if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
            const meta: ResponsesReasoningMeta = id ? { id, encryptedContent: item.encrypted_content } : { encryptedContent: item.encrypted_content };
            yield { type: 'reasoning-meta', providerMeta: { [RESPONSES_META]: meta } };
          }
        } else if (item.type === 'message' && id && !textItems.has(id) && Array.isArray(item.content)) {
          const text = (item.content as { type?: unknown; text?: unknown; refusal?: unknown }[])
            .map((p) => (typeof p.text === 'string' ? p.text : typeof p.refusal === 'string' ? p.refusal : ''))
            .join('');
          if (text) {
            sawText = true;
            yield { type: 'text-delta', text };
          }
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = (data.response ?? {}) as Record<string, unknown>;
        if (r.usage && typeof r.usage === 'object') usage = mapUsage(r.usage as Record<string, unknown>);
        if (type === 'response.incomplete' || r.status === 'incomplete') {
          const reason = String((r.incomplete_details as { reason?: unknown } | null | undefined)?.reason ?? '');
          finish = /max_(output_)?tokens/.test(reason) ? 'length' : /content_filter/.test(reason) ? 'content-filter' : 'other';
        } else finish = calls.size ? 'tool-calls' : 'stop';
        break;
      }
      case 'response.failed': {
        const r = (data.response ?? {}) as Record<string, unknown>;
        throw streamError(r.error as { code?: unknown; message?: unknown } | undefined);
      }
      case 'error':
        throw streamError((data.error && typeof data.error === 'object' ? data.error : data) as { code?: unknown; message?: unknown });
      default:
        break; // created, in_progress, content parts, *.done text events, and future events
    }
  }
  for (const c of calls.values()) yield* endCall(c);
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: finish ?? (calls.size ? 'tool-calls' : sawText ? 'stop' : 'other') };
}

/** The OpenAI Responses adapter. */
export function createOpenAIResponsesAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    kind: 'openai-responses',
    async *stream(req) {
      const { config, signal } = req;
      const res = await requestLearning(
        config,
        quirks,
        (q) => ({ url: joinUrl(config.baseUrl, 'responses'), body: buildResponsesBody(req, q), headers: { ...authHeaders(config), accept: 'text/event-stream' } }),
        learn,
        { signal, fetch: opts.fetch, retries: 3 },
      );
      if (!res.body) throw new ProviderError('The provider sent an empty response.', { retryable: true });
      yield* parseResponsesStream(res.body, signal, config);
    },
    // the model list is the same `GET /models`
    listModels: createOpenAIAdapter(opts).listModels,
  };
}

/** Forgets the fields models rejected (tests). */
export function resetOpenAIResponsesQuirks() {
  quirks.clear();
}
