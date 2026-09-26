import type { FinishReason, ModelInfo, ModelRequest, ProviderAdapter, ProviderConfig, StreamEvent, Usage } from '../core/types';
import { ProviderError, errorFromStatus } from './errors';
import type { AdapterOptions } from './openai';
import { readSSE } from './sse';
import { IMAGE_OMITTED, assistantSteps, parseToolArgs, replayArgs, request, toolResultFor, toolResultString, userPartText } from './shared';

/*
 * The Anthropic Messages API, called from the browser (the
 * `anthropic-dangerous-direct-browser-access` header opts into CORS).
 * Thinking follows the model generation: adaptive thinking with an effort
 * level on current models, a token budget on older ones.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

type Block = Record<string, unknown> & { type: string };
export interface AMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/** What a Claude model id says about its request surface. */
export interface ClaudeTraits {
  /** `thinking: {type: 'adaptive'}` + `output_config.effort` (Claude 4.6 and later) */
  adaptive: boolean;
  /** thinks when `thinking` is omitted (Claude 5 family) */
  thinksByDefault: boolean;
  /** `temperature` is rejected */
  noSampling: boolean;
  /** `{type: 'enabled', budget_tokens}` is the way to think (Claude 3.7 – 4.5) */
  budget: boolean;
  /** thinking blocks are bound to the conversation prefix: send `block_binding` so an edited prefix drops them instead of failing */
  binding: boolean;
  /** the output cap when the connection sets none */
  defaultMaxTokens: number;
}

/** Reads the generation from a model id (`claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-3-5-sonnet-latest`…). */
export function claudeTraits(model: string): ClaudeTraits {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  if (!m) {
    const v37 = /claude-3-7/.test(model);
    return { adaptive: false, thinksByDefault: false, noSampling: false, budget: v37, binding: false, defaultMaxTokens: v37 ? 16000 : /claude-3-5/.test(model) ? 8192 : /claude-3/.test(model) ? 4096 : 16000 };
  }
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  const atLeast = (a: number, b: number) => major > a || (major === a && minor >= b);
  const topTier = family === 'fable' || family === 'mythos';
  const adaptive = family !== 'haiku' && atLeast(4, 6);
  return {
    adaptive,
    thinksByDefault: topTier || (adaptive && major >= 5),
    noSampling: adaptive && !(major === 4 && minor === 6),
    budget: !adaptive && atLeast(3, 7),
    binding: (family === 'fable' || family === 'opus') && atLeast(5, 1),
    defaultMaxTokens: 16000,
  };
}

const BUDGET = { low: 2048, medium: 8192, high: 24576 } as const;

/** The transcript in Messages form: alternating roles, tool results first in the user message that follows a tool call. */
export function toAnthropicMessages(req: Pick<ModelRequest, 'config' | 'messages'>): AMessage[] {
  const out: AMessage[] = [];
  const push = (role: AMessage['role'], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  const vision = req.config.vision !== false;
  const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

  for (const m of req.messages) {
    if (m.role === 'user') {
      const blocks: Block[] = [];
      for (const p of m.parts) {
        if (p.type === 'image') {
          blocks.push(vision ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } } : { type: 'text', text: IMAGE_OMITTED });
          continue;
        }
        const t = userPartText(p);
        if (t && t.trim()) blocks.push({ type: 'text', text: t });
      }
      push('user', blocks);
      continue;
    }
    for (const step of assistantSteps(m)) {
      const blocks: Block[] = [];
      for (const p of step.content) {
        if (p.type === 'reasoning') {
          if (p.redacted) blocks.push({ type: 'redacted_thinking', data: p.redacted });
          // a thinking block is only valid with its signature (other providers' reasoning has none)
          else if (p.signature) blocks.push({ type: 'thinking', thinking: p.text, signature: p.signature });
        } else if (p.text.trim()) blocks.push({ type: 'text', text: p.text });
      }
      for (const c of step.calls) blocks.push({ type: 'tool_use', id: safeId(c.id), name: c.name, input: replayArgs(c) });
      // an assistant turn made only of thinking is rejected
      if (!blocks.some((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')) continue;
      push('assistant', blocks);
      if (step.calls.length) {
        push(
          'user',
          step.calls.map((c) => {
            const block: Block = { type: 'tool_result', tool_use_id: safeId(c.id), content: toolResultString(c) };
            if (toolResultFor(c).isError) block.is_error = true;
            return block;
          }),
        );
      }
    }
  }
  // the conversation must open with the person
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

type Droppable = 'temperature' | 'output_config' | 'eager_input_streaming' | 'block_binding' | 'thinking';

/** The request body and headers (exported for tests). */
export function buildAnthropicRequest(req: ModelRequest, drop: ReadonlySet<Droppable> = new Set()): { body: Record<string, unknown>; beta?: string } {
  const { config } = req;
  const traits = claudeTraits(config.model);
  const body: Record<string, unknown> = { model: config.model, stream: true };
  let maxTokens = config.maxOutputTokens || traits.defaultMaxTokens;

  let thinking: Record<string, unknown> | undefined;
  let effort: string | undefined;
  const r = config.reasoning;
  if (!drop.has('thinking')) {
    if (r && r !== 'off') {
      if (traits.adaptive) {
        thinking = { type: 'adaptive', display: 'summarized' };
        effort = r;
      } else if (traits.budget) {
        const budget = BUDGET[r];
        thinking = { type: 'enabled', budget_tokens: budget };
        if (maxTokens <= budget) maxTokens = budget + 8192;
      }
    } else if (traits.thinksByDefault) {
      // it thinks anyway: ask for readable summaries rather than empty blocks, and keep it brief when "off"
      thinking = { type: 'adaptive', display: 'summarized' };
      if (r === 'off') effort = 'low';
    }
  }
  let beta: string | undefined;
  if (thinking && traits.binding && !drop.has('block_binding')) {
    thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
    beta = BINDING_BETA;
  }
  body.max_tokens = maxTokens;
  if (thinking) body.thinking = thinking;
  if (effort && !drop.has('output_config')) body.output_config = { effort };
  if (config.temperature !== undefined && !thinking && !traits.noSampling && !drop.has('temperature')) body.temperature = config.temperature;

  if (req.system.trim()) body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  if (req.tools.length) {
    const tools: Record<string, unknown>[] = req.tools.map((t) => {
      const tool: Record<string, unknown> = { name: t.name, description: t.description, input_schema: t.parameters };
      // stream large arguments (a generated interface) as they are written
      if (!drop.has('eager_input_streaming')) tool.eager_input_streaming = true;
      return tool;
    });
    tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  const messages = toAnthropicMessages(req);
  // a moving breakpoint on the newest block: each step of a turn reads the previous one from the cache
  const last = messages[messages.length - 1];
  const lastBlock = last?.content[last.content.length - 1];
  if (lastBlock && last.role === 'user') last.content[last.content.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
  body.messages = messages;
  return { body, beta };
}

function headers(config: ProviderConfig, beta?: string): Record<string, string> {
  const h: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
  if (config.apiKey) h['x-api-key'] = config.apiKey;
  if (beta) h['anthropic-beta'] = beta;
  return h;
}

const baseOf = (config: ProviderConfig) => (config.baseUrl || ANTHROPIC_BASE_URL).replace(/\/v1\/?$/, '');

const STOP: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool-calls',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'content-filter',
  pause_turn: 'other',
};

/** Parses a Messages SSE stream into kit stream events (exported for tests). */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal, config?: ProviderConfig): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, { type: string; id?: string; json: string; signature: string }>();
  const usage: Usage = {};
  let stop: string | undefined;
  let sawUsage = false;
  for await (const ev of readSSE(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (data.type as string) ?? ev.event;
    switch (type) {
      case 'message_start': {
        const u = ((data.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        usage.inputTokens = (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
        if (cacheRead) usage.cachedInputTokens = cacheRead;
        if (u.output_tokens) usage.outputTokens = u.output_tokens;
        sawUsage = true;
        break;
      }
      case 'content_block_start': {
        const index = data.index as number;
        const cb = (data.content_block ?? {}) as Record<string, unknown>;
        const t = cb.type as string;
        blocks.set(index, { type: t, id: cb.id as string | undefined, json: '', signature: '' });
        if (t === 'tool_use') yield { type: 'tool-call-start', id: cb.id as string, name: cb.name as string };
        else if (t === 'redacted_thinking') yield { type: 'reasoning-redacted', data: cb.data as string };
        else if (t === 'text' && typeof cb.text === 'string' && cb.text) yield { type: 'text-delta', text: cb.text };
        else if (t === 'thinking' && typeof cb.thinking === 'string' && cb.thinking) yield { type: 'reasoning-delta', text: cb.thinking };
        break;
      }
      case 'content_block_delta': {
        const b = blocks.get(data.index as number);
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (d.type === 'text_delta' && typeof d.text === 'string') yield { type: 'text-delta', text: d.text };
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') yield { type: 'reasoning-delta', text: d.thinking };
        else if (d.type === 'signature_delta' && b) b.signature += String(d.signature ?? '');
        else if (d.type === 'input_json_delta' && b && typeof d.partial_json === 'string' && d.partial_json) {
          b.json += d.partial_json;
          yield { type: 'tool-call-delta', id: b.id!, argsText: d.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks.get(data.index as number);
        if (!b) break;
        if (b.type === 'thinking') {
          // an empty thinking block (display "omitted") still has to be replayed: surface it through its signature
          if (b.signature) yield { type: 'reasoning-signature', signature: b.signature };
        } else if (b.type === 'tool_use') {
          const { args, argsError } = parseToolArgs(b.json);
          yield argsError ? { type: 'tool-call-end', id: b.id!, args, argsError } : { type: 'tool-call-end', id: b.id!, args };
        }
        break;
      }
      case 'message_delta': {
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === 'string') stop = d.stop_reason;
        const u = (data.usage ?? {}) as Record<string, number>;
        if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
        if (typeof u.input_tokens === 'number' && u.input_tokens > (usage.inputTokens ?? 0)) usage.inputTokens = u.input_tokens;
        sawUsage = true;
        break;
      }
      case 'error': {
        const e = (data.error ?? {}) as { type?: string; message?: string };
        const status = e.type === 'overloaded_error' ? 529 : e.type === 'rate_limit_error' ? 429 : e.type === 'api_error' ? 500 : e.type === 'invalid_request_error' ? 400 : 500;
        throw errorFromStatus(status, JSON.stringify(data), undefined, config);
      }
      case 'message_stop':
        break;
      default:
        break; // ping and future events
    }
  }
  if (sawUsage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: stop ? (STOP[stop] ?? 'other') : 'other' };
}

function droppable(err: ProviderError, body: Record<string, unknown>, beta?: string): Droppable | undefined {
  const text = `${err.detail ?? ''}`.toLowerCase();
  if (beta && (text.includes('block_binding') || text.includes(beta))) return 'block_binding';
  if ('temperature' in body && text.includes('temperature')) return 'temperature';
  if ('output_config' in body && /output_config|effort/.test(text)) return 'output_config';
  if (text.includes('eager_input_streaming')) return 'eager_input_streaming';
  if ('thinking' in body && /thinking|budget_tokens|adaptive/.test(text)) return 'thinking';
  return undefined;
}

/** The Anthropic adapter. */
export function createAnthropicAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    kind: 'anthropic',
    async *stream(req) {
      const { config, signal } = req;
      const drop = new Set<Droppable>();
      let res: Response | undefined;
      for (let attempt = 0; !res; attempt++) {
        const { body, beta } = buildAnthropicRequest(req, drop);
        try {
          res = await request(config, `${baseOf(config)}/v1/messages`, { body, signal, fetch: opts.fetch, headers: { ...headers(config, beta), accept: 'text/event-stream' } });
        } catch (err) {
          // a model that rejects an optional field (sampling on a thinking model, an unknown beta): drop it and ask again
          const f = err instanceof ProviderError && err.status === 400 && attempt < 3 ? droppable(err, body, beta) : undefined;
          if (!f || drop.has(f)) throw err;
          drop.add(f);
        }
      }
      if (!res.body) throw new ProviderError('The provider sent an empty response.', { retryable: true });
      yield* parseAnthropicStream(res.body, signal, config);
    },
    async listModels(config, signal) {
      const res = await request(config, `${baseOf(config)}/v1/models?limit=1000`, { signal, fetch: opts.fetch, headers: headers(config) });
      const json = (await res.json()) as { data?: { id: string; display_name?: string; max_input_tokens?: number }[] };
      return (json.data ?? []).map((m) => {
        const info: ModelInfo = { id: m.id };
        if (m.display_name) info.label = m.display_name;
        if (m.max_input_tokens) info.contextWindow = m.max_input_tokens;
        return info;
      });
    },
  };
}
