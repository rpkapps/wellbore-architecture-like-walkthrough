import { MAX_WORKING_CONTEXT, defaultContextWindow } from '../providers/presets';
import { contextText, fileText, toolResultString, uiEventText } from '../providers/shared';
import type { ChatMessage, Part, ProviderConfig, WireTool } from './types';

/*
 * The context budget: how many tokens a request will take, how many the
 * model can take, and when the conversation has to be compacted. Estimates
 * are character counts (no tokenizer ships with the kit), corrected per
 * thread by what the provider reported for the last request.
 */

/** Characters per token for prose and JSON (English prose runs ~4, JSON and numbers ~3). */
export const CHARS_PER_TOKEN = 3.6;
/** What an image costs, whatever its size (providers scale images to about a megapixel: 1,100–1,800 tokens). */
export const IMAGE_TOKENS = 1_600;
/** Per message and per part: role markers, separators, tool-call framing. */
const MESSAGE_OVERHEAD = 6;
const PART_OVERHEAD = 3;
/** Output room when the connection does not cap the answer. */
export const DEFAULT_OUTPUT_RESERVE = 8_192;
/** Anthropic's adapter asks for 16,000 output tokens by default, and the API counts them against the window. */
const ANTHROPIC_OUTPUT_RESERVE = 16_000;
/** Windows up to this size keep a quarter of the window free (answers, tool arguments, estimate error). */
export const SMALL_WINDOW = 32_768;
/** Share of the input budget at which the conversation is summarised before the next request. */
export const COMPACT_AT = 0.7;
/** The calibration ratio (actual / estimated tokens) stays within these bounds. */
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 2.5;

/** Tokens of a string. */
export const estimateText = (s: string | undefined | null): number => (s ? Math.ceil(s.length / CHARS_PER_TOKEN) : 0);

const json = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  } catch {
    return '';
  }
};

/** Tokens of one part as the adapters send it (UI and error parts are not sent). */
export function estimatePart(p: Part): number {
  switch (p.type) {
    case 'text':
      return estimateText(p.text) + PART_OVERHEAD;
    case 'reasoning':
      return estimateText(p.text) + (p.redacted ? estimateText(p.redacted) : 0) + (p.signature ? 40 : 0) + PART_OVERHEAD;
    case 'image':
      return IMAGE_TOKENS;
    case 'file':
      return estimateText(fileText(p)) + PART_OVERHEAD;
    case 'context':
      return p.items.length || p.state ? estimateText(contextText(p)) + PART_OVERHEAD : 0;
    case 'ui-event':
      return estimateText(uiEventText(p)) + PART_OVERHEAD;
    case 'tool-call':
      // the call (name + arguments) and its result, each a block of its own
      return estimateText(p.name) + estimateText(p.argsText || json(p.args)) + estimateText(toolResultString(p)) + 2 * PART_OVERHEAD + 8;
    default:
      return 0;
  }
}

// messages are immutable: an unchanged message is counted once
const messageCache = new WeakMap<ChatMessage, number>();

/** Tokens of one message. */
export function estimateMessage(m: ChatMessage): number {
  let n = messageCache.get(m);
  if (n === undefined) {
    n = MESSAGE_OVERHEAD;
    for (const p of m.parts) n += estimatePart(p);
    // a streaming message changes with every token: counting it once is enough
    if (m.status !== 'streaming') messageCache.set(m, n);
  }
  return n;
}

/** Tokens of the tool definitions. */
export const estimateTools = (tools: WireTool[]): number => tools.reduce((n, t) => n + estimateText(t.name) + estimateText(t.description) + estimateText(json(t.parameters)) + 10, 0);

/** Tokens of a whole request (before calibration). */
export function estimateRequest(req: { system: string; tools: WireTool[]; messages: ChatMessage[] }): number {
  let n = estimateText(req.system) + estimateTools(req.tools) + 10;
  for (const m of req.messages) n += estimateMessage(m);
  return n;
}

/** The actual/estimated ratio for a request the provider reported `actual` input tokens for. */
export function calibrationRatio(actual: number | undefined, estimated: number): number | undefined {
  if (!actual || !Number.isFinite(actual) || actual <= 0 || estimated <= 0) return undefined;
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, actual / estimated));
}

/**
 * The model's context window: the connection's own setting, else what the
 * provider's model list reported (`known`), else a default for the preset or
 * model family (`providers/presets.ts`).
 */
export function resolveContextWindow(config: Pick<ProviderConfig, 'presetId' | 'model' | 'contextWindow'>, known?: number): number {
  const set = Number(config.contextWindow);
  if (Number.isFinite(set) && set >= 1_024) return Math.round(set);
  if (known && known >= 1_024) return known;
  return defaultContextWindow(config.presetId, config.model);
}

/** The window the kit works in: the model's, capped at `MAX_WORKING_CONTEXT`. */
export const workingWindow = (window: number): number => Math.max(1_024, Math.min(window, MAX_WORKING_CONTEXT));

/**
 * The input tokens a request may take: the working window minus room for the
 * answer (the connection's output cap, else ~8k or a quarter of a small
 * window), and never more than three quarters of a small window.
 */
export function inputBudget(config: Pick<ProviderConfig, 'kind' | 'maxOutputTokens'>, window: number): number {
  const w = workingWindow(window);
  const reserve = config.maxOutputTokens || Math.min(config.kind === 'anthropic' ? ANTHROPIC_OUTPUT_RESERVE : DEFAULT_OUTPUT_RESERVE, Math.floor(w / 4));
  let budget = Math.max(Math.floor(w / 2), w - reserve);
  if (w <= SMALL_WINDOW) budget = Math.min(budget, Math.floor(w * 0.75));
  return budget;
}
