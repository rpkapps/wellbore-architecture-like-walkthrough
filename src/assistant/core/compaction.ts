import { asProviderError, isAbortError } from '../providers/errors';
import { abortError } from '../providers/sse';
import { toolResultString } from '../providers/shared';
import { inputBudget, estimateText, workingWindow } from './context';
import { newId } from './ids';
import { safeJsonStringify } from './json';
import { MAX_RETRIES, abortableSleep, retryDelay } from './retry';
import type { ChatMessage, Compaction, Dataset, Part, ProviderAdapter, ProviderConfig, ToolCallPart } from './types';

/*
 * Keeping a long conversation inside the model's context window, without the
 * person having to think about it. Three tiers:
 *
 * 1. Every request: results of older tool calls are shortened to a stub
 *    (their datasets stay usable by id), the app state recorded with older
 *    messages and older reasoning are left out. Only the request changes;
 *    the transcript keeps everything.
 * 2. When a request would fill most of the budget: one model call writes a
 *    summary of everything but the last turns. It is stored on the thread
 *    (`Compaction`, append-only), and requests send it in place of the
 *    messages it covers.
 * 3. When the provider still rejects a request as too long: everything
 *    before the current turn is summarised (or outlined, if even that
 *    fails) and the request is sent again, once.
 */

/** Tool results of the last this-many turns are sent whole. */
export const RECENT_USER_TURNS = 3;
/**
 * The shortened region grows this many turns at a time, so the request's
 * prefix changes (and prompt caches miss) once every few turns rather than
 * at every turn.
 */
export const ELIDE_STEP = 4;
/** Results longer than this (as sent) are shortened… */
export const ELIDE_MIN_CHARS = 1_500;
/** …to their first this-many characters. */
export const ELIDE_HEAD_CHARS = 300;
/** Turns a summary leaves out (sent whole after it), when they fit. */
export const KEEP_TURNS = 2;
/** The longest summary, in words… */
export const SUMMARY_WORDS = 1_200;
/** …and at most this share of the input budget (a small window gets a shorter one). */
const SUMMARY_SHARE = 0.08;

/** How many words a summary may take in a window of `window` tokens. */
export const summaryWords = (config: Pick<ProviderConfig, 'kind' | 'maxOutputTokens'>, window: number) =>
  Math.max(150, Math.min(SUMMARY_WORDS, Math.floor(inputBudget(config, window) * SUMMARY_SHARE * 0.75)));
/** What a summary of that length is assumed to cost before it is written. */
export const summaryTokens = (config: Pick<ProviderConfig, 'kind' | 'maxOutputTokens'>, window: number) => Math.ceil(summaryWords(config, window) * 1.4);

// ------------------------------------------------------------------ tier 1: the request history

const TERMINAL = new Set(['done', 'error', 'denied', 'cancelled']);

/** A finished call's result, shortened to a stub when it is long (datasets stay usable by id). */
export function elideToolCall(p: ToolCallPart): ToolCallPart {
  if (!TERMINAL.has(p.state)) return p;
  const text = toolResultString(p);
  if (text.length <= ELIDE_MIN_CHARS) return p;
  const stub: Record<string, unknown> = { elided: true, summary: text.slice(0, ELIDE_HEAD_CHARS) };
  if (p.datasets?.length) stub.datasets = p.datasets;
  return { ...p, result: stub };
}

type ElideMode = 'old' | 'aggressive';
const elideCache: Record<ElideMode, WeakMap<ChatMessage, ChatMessage>> = { old: new WeakMap(), aggressive: new WeakMap() };

/**
 * A message as sent once it is old: long tool results shortened, reasoning
 * and the recorded app state left out; `aggressive` also leaves out images.
 */
export function elideMessage(m: ChatMessage, mode: ElideMode = 'old'): ChatMessage {
  const cache = elideCache[mode];
  const hit = cache.get(m);
  if (hit) return hit;
  let changed = false;
  const parts: Part[] = [];
  for (const p of m.parts) {
    if (p.type === 'reasoning') {
      changed = true;
      continue;
    }
    if (p.type === 'context' && p.state !== undefined) {
      changed = true;
      const next = { ...p };
      delete next.state;
      parts.push(next);
      continue;
    }
    if (p.type === 'image' && mode === 'aggressive') {
      changed = true;
      parts.push({ type: 'text', text: `[an image${p.name ? ` (${p.name})` : ''} was attached here; left out to save space]` });
      continue;
    }
    if (p.type === 'tool-call') {
      const e = elideToolCall(p);
      if (e !== p) changed = true;
      parts.push(e);
      continue;
    }
    parts.push(p);
  }
  const out = changed ? { ...m, parts } : m;
  if (m.status !== 'streaming') cache.set(m, out);
  return out;
}

/** The latest compaction that applies to these messages, and the index of its boundary message. */
export function latestCompaction(messages: ChatMessage[], compactions: Compaction[] | undefined): { compaction: Compaction; index: number } | null {
  if (!compactions?.length) return null;
  for (let c = compactions.length - 1; c >= 0; c--) {
    const index = messages.findIndex((m) => m.id === compactions[c].throughMessageId);
    if (index >= 0) return { compaction: compactions[c], index };
  }
  return null;
}

/** The text that stands in for the messages a compaction covers. */
export const summaryText = (c: Compaction) =>
  `<conversation_summary>\nThe earlier part of this conversation was condensed into this summary to save space. Datasets it mentions can still be used by id.\n\n${c.summary.trim()}\n</conversation_summary>`;

const withSummary = new WeakMap<ChatMessage, { compaction: Compaction; message: ChatMessage }>();

/**
 * The messages a request sends, in kit form: the latest summary (merged into
 * the first user message after its boundary) and the messages after it,
 * older ones shortened (tier 1). `aggressive` (overflow recovery) shortens
 * everything before the last turn, and the earlier steps of the turn itself.
 * The stored transcript is never changed.
 */
export function requestHistory(messages: ChatMessage[], compactions?: Compaction[], opts: { aggressive?: boolean } = {}): ChatMessage[] {
  const latest = latestCompaction(messages, compactions);
  const kept = latest ? messages.slice(latest.index + 1) : messages;
  const users: number[] = [];
  kept.forEach((m, i) => m.role === 'user' && users.push(i));
  let cut = 0;
  if (opts.aggressive) cut = users.length ? users[users.length - 1] : 0;
  else {
    const n = Math.floor(Math.max(0, users.length - RECENT_USER_TURNS) / ELIDE_STEP) * ELIDE_STEP;
    if (n > 0) cut = users[n];
  }
  const mode: ElideMode = opts.aggressive ? 'aggressive' : 'old';
  const out = cut > 0 ? kept.map((m, i) => (i < cut ? elideMessage(m, mode) : m)) : kept.slice();

  if (opts.aggressive) {
    // the turn's own earlier steps: only the latest step's results are sent whole
    const last = out[out.length - 1];
    if (last?.role === 'assistant') {
      const maxStep = Math.max(-1, ...last.parts.map((p) => (p.type === 'tool-call' ? (p.step ?? 0) : -1)));
      if (maxStep > 0) out[out.length - 1] = { ...last, parts: last.parts.map((p) => (p.type === 'tool-call' && (p.step ?? 0) < maxStep ? elideToolCall(p) : p)) };
    }
  }

  if (latest) {
    const first = out[0];
    if (first?.role === 'user') {
      const hit = withSummary.get(first);
      if (hit && hit.compaction === latest.compaction) out[0] = hit.message;
      else {
        const message: ChatMessage = { ...first, parts: [{ type: 'text', text: summaryText(latest.compaction) }, ...first.parts] };
        if (first.status !== 'streaming') withSummary.set(first, { compaction: latest.compaction, message });
        out[0] = message;
      }
    } else out.unshift({ id: `${latest.compaction.id}:summary`, role: 'user', parts: [{ type: 'text', text: summaryText(latest.compaction) }], createdAt: latest.compaction.createdAt });
  }
  return out;
}

// ------------------------------------------------------------------ tier 2: summaries

/**
 * Where a summary of `messages[from…]` can end so that the last
 * `recentUsers` user messages (and what followed them) stay whole: the index
 * of a finished assistant message followed by a user message (or ending the
 * list), never inside a turn or between a call and its result. -1 when there
 * is nothing new to summarise.
 */
export function compactionBoundary(messages: ChatMessage[], from: number, recentUsers: number): number {
  let candidate: number;
  if (recentUsers <= 0) candidate = messages.length - 1;
  else {
    const users: number[] = [];
    messages.forEach((m, i) => i >= from && m.role === 'user' && users.push(i));
    if (users.length < recentUsers) return -1;
    candidate = users[users.length - recentUsers] - 1;
  }
  for (let i = candidate; i >= from; i--) {
    const m = messages[i];
    const next = messages[i + 1];
    if (m.role === 'assistant' && m.status !== 'streaming' && (!next || next.role === 'user')) return i;
  }
  return -1;
}

/** The instructions of the summarising call. */
export function summaryPrompt(appName: string, words = SUMMARY_WORDS): string {
  return [
    `You condense a conversation between a person and the assistant built into ${appName}. Your summary replaces the conversation: the assistant continues from it with no other record of these messages, so everything it needs to carry on must be in it.`,
    '',
    `Write Markdown, at most about ${words} words, with these sections (leave a section out when it would be empty):`,
    '## Goal — what the person is trying to achieve, and how their request developed.',
    '## Key facts — findings and figures, every number with its unit, names and identifiers exactly as written (wells, formations, dates, ids); say which tool or dataset each came from.',
    '## Decisions and preferences — what was decided, chosen or declined, and how the person likes answers.',
    '## App state — what the assistant changed in the app and what the app shows now, as far as the conversation tells.',
    '## Datasets — each dataset id (ds_…) that may still matter, with what it holds (title, source, columns with units, number of rows).',
    '## Open questions and next steps — what is unanswered or unfinished, what the assistant offered or promised, what the person is likely to ask next.',
    '',
    'Rules: keep exact values, ids and units; never invent or round away details that may matter; drop greetings, retries and chatter. When an earlier summary is given, merge it with the new messages and keep what is still relevant. Write only the summary.',
  ].join('\n');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

/** A conversation as plain text for the summariser (tool results clipped to `resultChars`). */
export function renderTranscript(messages: ChatMessage[], datasets: Record<string, Dataset>, resultChars = ELIDE_MIN_CHARS): string {
  const out: string[] = [];
  const used = new Set<string>();
  let lastState: string | undefined;
  for (const m of messages) {
    const lines: string[] = [];
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          if (p.text.trim()) lines.push(p.text.trim());
          break;
        case 'context':
          if (p.state) lastState = p.state;
          if (p.items.length) lines.push(`(attached context: ${p.items.map((i) => `${i.label} ${safeJsonStringify(i.data, 300)}`).join('; ')})`);
          break;
        case 'file':
          lines.push(`(attached file ${p.name}:\n${clip(p.text, resultChars)})`);
          break;
        case 'image':
          lines.push(`(attached an image${p.name ? ` ${p.name}` : ''})`);
          break;
        case 'ui-event':
          lines.push(`(in a generated interface: ${p.label ?? p.name} ${p.context ? safeJsonStringify(p.context, 300) : ''})`);
          break;
        case 'tool-call': {
          p.datasets?.forEach((d) => used.add(d));
          const result = TERMINAL.has(p.state) ? clip(toolResultString(p), resultChars) : '';
          const ds = p.datasets?.length ? ` [datasets ${p.datasets.join(', ')}]` : '';
          lines.push(`→ ${p.name} ${safeJsonStringify(p.args, 400)} — ${p.state}${ds}${result ? `: ${result}` : ''}`);
          break;
        }
        case 'error':
          lines.push(`(error: ${p.message})`);
          break;
        default:
          break;
      }
    }
    if (lines.length) out.push(`[${m.role === 'user' ? 'Person' : 'Assistant'}]\n${lines.join('\n')}`);
  }
  if (lastState) out.push(`[App state when the last of these messages was sent]\n${clip(lastState, 3000)}`);
  const ds = [...used].map((id) => datasets[id]).filter(Boolean);
  if (ds.length)
    out.push(
      `[Datasets]\n${ds
        .map((d) => `- ${d.id} “${d.title}”${d.source ? ` (${d.source})` : ''}: ${d.trimmed?.rowCount ?? d.rows.length} rows; columns ${d.columns.map((c) => `${c.key}${c.unit ? ` [${c.unit}]` : ''}`).join(', ')}`)
        .join('\n')}`,
    );
  return out.join('\n\n');
}

/** The summariser's input, fitted to `maxTokens`: tool results clipped harder, then the middle of the conversation left out. */
export function summaryInput(previous: string | undefined, messages: ChatMessage[], datasets: Record<string, Dataset>, maxTokens: number): string {
  const wrap = (t: string) =>
    `${previous ? `<earlier_summary>\n${previous.trim()}\n</earlier_summary>\n\n` : ''}<conversation>\n${t}\n</conversation>\n\nWrite the summary now.`;
  let text = wrap(renderTranscript(messages, datasets));
  if (estimateText(text) <= maxTokens) return text;
  const short = renderTranscript(messages, datasets, ELIDE_HEAD_CHARS);
  text = wrap(short);
  if (estimateText(text) <= maxTokens) return text;
  // keep the beginning (the goal) and as much of the end as fits
  const room = Math.max(1_000, Math.floor((maxTokens - estimateText(previous)) * 3.6) - 400);
  const head = Math.floor(room * 0.2);
  return wrap(`${short.slice(0, head)}\n\n[… part of the conversation left out …]\n\n${short.slice(short.length - (room - head))}`);
}

export interface SummaryOptions {
  adapter: ProviderAdapter;
  config: ProviderConfig;
  /** the model's context window (tokens) */
  window: number;
  appName: string;
  /** the summary the new one extends */
  previous?: string;
  /** the messages to summarise (whole turns) */
  messages: ChatMessage[];
  datasets: Record<string, Dataset>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Writes a summary with one model call on the connection (retried on transient errors; a shorter input when it did not fit). */
export async function writeSummary(opts: SummaryOptions): Promise<string> {
  const { adapter, signal } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const w = workingWindow(opts.window);
  const config: ProviderConfig = { ...opts.config, reasoning: 'off', maxOutputTokens: Math.max(1_024, Math.min(6_000, Math.floor(w / 4))) };
  delete config.temperature;
  const system = summaryPrompt(opts.appName, summaryWords(opts.config, opts.window));
  let maxTokens = inputBudget(config, opts.window) - estimateText(system) - 200;
  let shrunk = false;
  for (let attempt = 0; ; ) {
    const input = summaryInput(opts.previous, opts.messages, opts.datasets, maxTokens);
    const messages: ChatMessage[] = [{ id: 'summary-request', role: 'user', parts: [{ type: 'text', text: input }], createdAt: 0 }];
    let text = '';
    let got = false;
    try {
      for await (const ev of adapter.stream({ config, system, messages, tools: [], signal })) {
        if (signal.aborted) throw abortError(signal);
        got = true;
        if (ev.type === 'text-delta') text += ev.text;
      }
      text = text.trim();
      if (!text) throw new Error('The model wrote an empty summary.');
      return text;
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err;
      const pe = asProviderError(err);
      if (!got && pe.contextOverflow && !shrunk) {
        shrunk = true;
        maxTokens = Math.floor(maxTokens / 2);
        continue;
      }
      const wait = !got && pe.retryable && attempt < MAX_RETRIES ? retryDelay(attempt, pe.retryAfterMs) : undefined;
      if (wait === undefined) throw pe;
      attempt++;
      await sleep(wait, signal);
    }
  }
}

/** How an outline (`fallbackSummary`) begins. */
export const OUTLINE_NOTE = '_A summary could not be written; this outline of the earlier conversation stands in for it._';

/**
 * An outline of the conversation made without the model, when a summary
 * could not be written: the earlier summary, what the person asked, the
 * datasets, and the last answer.
 */
export function fallbackSummary(previous: string | undefined, messages: ChatMessage[], datasets: Record<string, Dataset>): string {
  const out: string[] = [OUTLINE_NOTE];
  if (previous?.trim()) out.push(previous.trim());
  const asks = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'ui-event' ? `(${p.label ?? p.name})` : p.type === 'file' ? `(file ${p.name})` : '')).join(' ').trim())
    .filter(Boolean)
    .slice(-20);
  if (asks.length) out.push(`## What the person asked\n${asks.map((a) => `- ${clip(a.replace(/\s+/g, ' '), 240)}`).join('\n')}`);
  const ids = new Set<string>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool-call') p.datasets?.forEach((d) => ids.add(d));
  const ds = [...ids].map((id) => datasets[id]).filter(Boolean);
  if (ds.length) out.push(`## Datasets\n${ds.map((d) => `- ${d.id} “${d.title}”${d.source ? ` (${d.source})` : ''}: ${d.trimmed?.rowCount ?? d.rows.length} rows`).join('\n')}`);
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.trim()));
  if (last)
    out.push(
      `## The last answer\n${clip(
        last.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('')
          .trim(),
        1_500,
      )}`,
    );
  return out.join('\n\n');
}

export interface CompactOptions extends Omit<SummaryOptions, 'messages' | 'previous'> {
  /** the history to compact: whole turns, without a turn in progress */
  messages: ChatMessage[];
  compactions?: Compaction[];
  /**
   * Turns to keep, tried in order: the first whose boundary exists and that
   * `fits` is taken (else the last that exists). A running turn's user
   * message counts as one of them.
   */
  keep: number[];
  /** whether keeping the messages from this index on leaves the request small enough */
  fits?: (keptFrom: number) => boolean;
  /** made automatically (vs `/compact`) */
  auto: boolean;
  /** write an outline instead of failing when the model cannot summarise */
  fallback: boolean;
  now?: () => number;
}

/** Summarises the older part of a history into a new `Compaction` (null when there is nothing to summarise). Rejects when the summary fails and `fallback` is off. */
export async function compactHistory(opts: CompactOptions): Promise<Compaction | null> {
  const { messages } = opts;
  const latest = latestCompaction(messages, opts.compactions);
  const from = latest ? latest.index + 1 : 0;
  let boundary = -1;
  for (const keep of opts.keep) {
    const b = compactionBoundary(messages, from, keep);
    if (b < 0) continue;
    boundary = b;
    if (!opts.fits || opts.fits(b + 1)) break;
  }
  if (boundary < 0) return null;
  const previous = latest?.compaction.summary;
  let summary: string;
  try {
    summary = await writeSummary({ ...opts, previous, messages: messages.slice(from, boundary + 1) });
  } catch (err) {
    if (opts.signal.aborted || isAbortError(err) || !opts.fallback) throw err;
    // no summary: an outline, and only the fewest turns kept (a turn in progress may be what did not fit)
    const least = compactionBoundary(messages, from, Math.min(...opts.keep));
    if (least > boundary) boundary = least;
    summary = fallbackSummary(previous, messages.slice(from, boundary + 1), opts.datasets);
  }
  return {
    id: newId('c'),
    throughMessageId: messages[boundary].id,
    summary,
    createdAt: (opts.now ?? Date.now)(),
    auto: opts.auto,
    messages: boundary + 1,
  };
}
