import { describe, expect, it } from 'vitest';
import type { AssistantTool, ChatMessage, Compaction, ToolCallPart } from '../../src/assistant/core/types';
import {
  CALIBRATION_MAX,
  CALIBRATION_MIN,
  IMAGE_TOKENS,
  calibrationRatio,
  estimateMessage,
  estimatePart,
  estimateText,
  inputBudget,
  resolveContextWindow,
  workingWindow,
} from '../../src/assistant/core/context';
import { ELIDE_HEAD_CHARS, compactionBoundary, fallbackSummary, latestCompaction, requestHistory, summaryInput } from '../../src/assistant/core/compaction';
import { MAX_RETRY_WAIT_MS, retryDelay } from '../../src/assistant/core/retry';
import { firstSentence, rankTools, shouldDeferTools, tokenize } from '../../src/assistant/core/toolSearch';
import { MAX_WORKING_CONTEXT, defaultContextWindow } from '../../src/assistant/providers/presets';
import { errorFromStatus, isContextOverflow } from '../../src/assistant/providers/errors';
import { contextLengthError } from '../../src/assistant/testing/mockLLM';

let n = 0;
const user = (text: string, extra: ChatMessage['parts'] = []): ChatMessage => ({
  id: `u${++n}`,
  role: 'user',
  parts: [{ type: 'context', items: [], state: `App state ${'s'.repeat(400)}` }, ...extra, { type: 'text', text }],
  createdAt: n,
});
const call = (id: string, result: unknown, patch: Partial<ToolCallPart> = {}): ToolCallPart => ({ type: 'tool-call', id, name: 'data.read_log', args: { well: 'A' }, state: 'done', result, ...patch });
const answer = (text: string, parts: ChatMessage['parts'] = [], patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `a${++n}`,
  role: 'assistant',
  parts: [{ type: 'reasoning', text: 'Thinking it over.', signature: 'sig' }, ...parts, { type: 'text', text }],
  createdAt: n,
  status: 'done',
  ...patch,
});
const big = (tag: string) => ({ tag, rows: Array.from({ length: 200 }, (_, i) => ({ md: i, gr: i * 1.5 })) });

/** A thread of `turns` turns, each with a large tool result. */
function transcript(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 1; t <= turns; t++) out.push(user(`Question ${t}`), answer(`Answer ${t}`, [call(`c${t}`, big(`r${t}`), { datasets: [`ds_${t}`] })]));
  return out;
}

describe('token estimates', () => {
  it('counts characters, images at a fixed cost, and tool calls with their results', () => {
    expect(estimateText('')).toBe(0);
    expect(estimateText('x'.repeat(360))).toBe(100);
    expect(estimatePart({ type: 'image', mediaType: 'image/png', data: 'A'.repeat(1_000_000) })).toBe(IMAGE_TOKENS);
    const small = estimatePart(call('c', { ok: true }));
    const large = estimatePart(call('c', big('x')));
    expect(large - small).toBeGreaterThan(1000);
    expect(estimatePart({ type: 'ui', id: 'u', messages: [{ big: 'x'.repeat(5000) }] })).toBe(0);
    const m = answer('hello');
    expect(estimateMessage(m)).toBe(estimateMessage(m));
  });

  it('calibrates by the reported usage, within bounds', () => {
    expect(calibrationRatio(1200, 1000)).toBeCloseTo(1.2);
    expect(calibrationRatio(100, 10_000)).toBe(CALIBRATION_MIN);
    expect(calibrationRatio(100_000, 1_000)).toBe(CALIBRATION_MAX);
    expect(calibrationRatio(undefined, 1000)).toBeUndefined();
    expect(calibrationRatio(0, 1000)).toBeUndefined();
  });
});

describe('context windows', () => {
  it('takes the connection’s setting, then the model list, then a default by preset or model family', () => {
    expect(resolveContextWindow({ presetId: 'openai', model: 'gpt-5.5', contextWindow: 50_000 }, 400_000)).toBe(50_000);
    expect(resolveContextWindow({ presetId: 'openrouter', model: 'some/model' }, 64_000)).toBe(64_000);
    expect(resolveContextWindow({ presetId: 'openrouter', model: 'some/model' })).toBe(128_000);
    expect(defaultContextWindow('anthropic', 'claude-sonnet-5')).toBe(1_000_000);
    expect(defaultContextWindow('anthropic', 'claude-opus-4-6')).toBe(1_000_000);
    expect(defaultContextWindow('anthropic', 'claude-haiku-4-5')).toBe(200_000);
    expect(defaultContextWindow('openrouter', 'anthropic/claude-sonnet-5')).toBe(1_000_000);
    expect(defaultContextWindow('openai', 'gpt-5.5')).toBe(400_000);
    expect(defaultContextWindow('gemini', 'gemini-3.5-flash')).toBe(1_048_576);
    expect(defaultContextWindow('deepseek', 'deepseek-v4-flash')).toBe(128_000);
    expect(defaultContextWindow('ollama', 'llama3.3:70b')).toBe(8_192);
    expect(defaultContextWindow('lmstudio', 'qwen3-30b')).toBe(8_192);
    expect(defaultContextWindow('custom', 'my-model')).toBe(32_768);
    expect(defaultContextWindow('mistral', 'mistral-large-latest')).toBe(128_000);
  });

  it('caps the working window and keeps room for the answer', () => {
    expect(workingWindow(1_000_000)).toBe(MAX_WORKING_CONTEXT);
    expect(inputBudget({ kind: 'openai' }, 1_000_000)).toBe(MAX_WORKING_CONTEXT - 8_192);
    expect(inputBudget({ kind: 'anthropic' }, 200_000)).toBe(184_000);
    expect(inputBudget({ kind: 'openai', maxOutputTokens: 2_000 }, 128_000)).toBe(126_000);
    // a small window keeps a quarter free
    expect(inputBudget({ kind: 'openai' }, 8_192)).toBe(6_144);
    expect(inputBudget({ kind: 'openai', maxOutputTokens: 100 }, 8_192)).toBe(6_144);
  });
});

describe('tier 1: the request history', () => {
  it('shortens old tool results, reasoning and app state in the request only', () => {
    const messages = transcript(8);
    const before = JSON.stringify(messages);
    const out = requestHistory(messages);
    expect(JSON.stringify(messages)).toBe(before); // the transcript is untouched
    expect(out).toHaveLength(16);
    // 8 user turns, 3 recent, shortened 4 at a time: the first 4 turns are shortened
    const results = out.filter((m) => m.role === 'assistant').map((m) => (m.parts.find((p) => p.type === 'tool-call') as ToolCallPart).result as Record<string, unknown>);
    expect(results.slice(0, 4).every((r) => r.elided === true)).toBe(true);
    expect(results[0]).toEqual({ elided: true, summary: JSON.stringify(big('r1')).slice(0, ELIDE_HEAD_CHARS), datasets: ['ds_1'] });
    expect(results.slice(4).every((r) => (r as { tag?: string }).tag)).toBe(true);
    expect(out[1].parts.some((p) => p.type === 'reasoning')).toBe(false);
    expect(out[15].parts.some((p) => p.type === 'reasoning')).toBe(true);
    expect(out[0].parts.find((p) => p.type === 'context')).toEqual({ type: 'context', items: [] });
    expect(out[14].parts.find((p) => p.type === 'context')).toMatchObject({ state: expect.any(String) });
    // the same messages give the same objects (stable prefix, counted once)
    expect(requestHistory(messages)[1]).toBe(out[1]);
    // with 6 turns nothing is shortened yet
    expect(requestHistory(transcript(6)).every((m, i, a) => m === a[i])).toBe(true);
  });

  it('aggressive: everything before the last turn, and the turn’s earlier steps', () => {
    const messages = transcript(2);
    const current: ChatMessage = { ...answer('', [call('s0', big('s0'), { step: 0 }), call('s1', big('s1'), { step: 1 })]), status: 'streaming' };
    messages.push(user('Now', [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]), current);
    const out = requestHistory(messages, undefined, { aggressive: true });
    expect(((out[1].parts[0] as ToolCallPart).result as { elided?: boolean }).elided).toBe(true);
    const last = out[out.length - 1].parts.filter((p): p is ToolCallPart => p.type === 'tool-call');
    expect((last[0].result as { elided?: boolean }).elided).toBe(true);
    expect((last[1].result as { tag: string }).tag).toBe('s1');
    // the last turn's own image is kept
    expect(out[4].parts.some((p) => p.type === 'image')).toBe(true);
  });

  it('sends the latest summary merged into the first user message after its boundary', () => {
    const messages = transcript(3);
    const c: Compaction = { id: 'c1', throughMessageId: messages[1].id, summary: 'Goal: GR.', createdAt: 0, auto: true, messages: 2 };
    const out = requestHistory(messages, [c]);
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe('user');
    expect(out[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<conversation_summary>') });
    expect((out[0].parts[0] as { text: string }).text).toContain('Goal: GR.');
    expect(out[0].parts.at(-1)).toEqual({ type: 'text', text: 'Question 2' });
    expect(requestHistory(messages, [c])[0]).toBe(out[0]);
    // a compaction whose boundary is gone (regenerated) is skipped for the one before it
    const gone: Compaction = { ...c, id: 'c2', throughMessageId: 'nope' };
    expect(latestCompaction(messages, [c, gone])?.compaction).toBe(c);
    // a boundary at the very end: the summary travels alone
    const all: Compaction = { ...c, id: 'c3', throughMessageId: messages[5].id };
    expect(requestHistory(messages, [all])).toEqual([expect.objectContaining({ role: 'user', parts: [expect.objectContaining({ type: 'text' })] })]);
  });
});

describe('tier 2: the boundary', () => {
  it('ends after a finished assistant message followed by the person, never inside a turn', () => {
    const m = transcript(4);
    expect(compactionBoundary(m, 0, 2)).toBe(3); // keeps turns 3 and 4
    expect(compactionBoundary(m, 0, 0)).toBe(7);
    expect(compactionBoundary(m, 4, 2)).toBe(-1); // nothing new before the kept turns
    expect(compactionBoundary(m, 0, 5)).toBe(-1);
    // two user messages in a row (a turn that could not start): the boundary moves back
    const odd = [user('a'), answer('b'), user('c'), user('d'), answer('e'), user('f')];
    expect(compactionBoundary(odd, 0, 2)).toBe(1);
    // an assistant message still streaming is never a boundary
    const streaming = [user('a'), { ...answer('b'), status: 'streaming' as const }];
    expect(compactionBoundary(streaming, 0, 0)).toBe(-1);
  });

  it('fits the summariser’s input to its budget, and outlines without the model', () => {
    const messages = transcript(40);
    const whole = summaryInput(undefined, messages, {}, 1_000_000);
    expect(whole).toContain('data.read_log');
    const fitted = summaryInput('Earlier: goal.', messages, {}, 3_000);
    expect(estimateText(fitted)).toBeLessThan(3_600);
    expect(fitted).toContain('Question 1');
    expect(fitted).toContain('Question 40');
    expect(fitted).toContain('<earlier_summary>');
    const outline = fallbackSummary('Old summary.', messages, { ds_1: { id: 'ds_1', title: 'GR', columns: [], rows: [], createdAt: 0 } });
    expect(outline).toContain('Old summary.');
    expect(outline).toContain('- Question 40');
    expect(outline).toContain('ds_1 “GR”');
  });
});

describe('provider errors', () => {
  it('recognises each provider’s context-length error', () => {
    for (const protocol of ['openai', 'anthropic', 'gemini'] as const) {
      const e = contextLengthError(protocol);
      expect(isContextOverflow(errorFromStatus(e.status, JSON.stringify(e.body)))).toBe(true);
    }
    expect(isContextOverflow(errorFromStatus(400, '{"error":{"message":"input length and `max_tokens` exceed context limit: 190000 + 16000 > 200000"}}'))).toBe(true);
    expect(isContextOverflow(errorFromStatus(400, '{"type":"error","error":{"type":"invalid_request_error","message":"model_context_window_exceeded"}}'))).toBe(true);
    expect(isContextOverflow(errorFromStatus(413, 'Payload Too Large'))).toBe(true);
    expect(isContextOverflow(errorFromStatus(500, '{"error":"the request exceeds the available context size, try increasing it"}'))).toBe(true);
    expect(isContextOverflow(errorFromStatus(429, '{"error":{"message":"Rate limit reached"}}'))).toBe(false);
    expect(isContextOverflow(errorFromStatus(402, '{"error":{"message":"Insufficient Balance"}}'))).toBe(false);
    expect(isContextOverflow(errorFromStatus(400, '{"error":{"message":"Invalid value for temperature"}}'))).toBe(false);
  });

  it('backs off 1 s, 2 s, 4 s with jitter, or as long as the provider asks (up to 20 s)', () => {
    expect([0, 1, 2].map((a) => retryDelay(a, undefined, () => 0.5))).toEqual([1000, 2000, 4000]);
    expect(retryDelay(0, undefined, () => 0)).toBe(800);
    expect(retryDelay(0, undefined, () => 1)).toBe(1200);
    expect(retryDelay(1, 3_000)).toBe(3_000);
    expect(retryDelay(0, MAX_RETRY_WAIT_MS + 1)).toBeUndefined();
  });
});

describe('tool search', () => {
  const tool = (name: string, description: string, patch: Partial<AssistantTool> = {}): AssistantTool => ({
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: () => null,
    ...patch,
  });
  const tools = [
    tool('view.color_by', 'Colours the well path by a log (GR, resistivity). Use for “colour by”.', { title: 'Colour by log' }),
    tool('data.production', 'Reads monthly production history of a well.'),
    tool('camera.fly_to', 'Moves the camera to a depth on a well.'),
    tool('data.read_log', 'Reads log samples of a well over a depth interval.', { core: true }),
  ];

  it('ranks by name, title and description words', () => {
    expect(tokenize('view.color_by colorBy')).toEqual(['view', 'color', 'color']);
    expect(rankTools(tools, 'colour the well by gamma').map((t) => t.name)[0]).toBe('view.color_by');
    expect(rankTools(tools, 'production history').map((t) => t.name)).toEqual(['data.production']);
    expect(rankTools(tools, 'fly camera', 1).map((t) => t.name)).toEqual(['camera.fly_to']);
    expect(rankTools(tools, 'zzz')).toEqual([]);
    expect(firstSentence('Colours the well. Use it often.')).toBe('Colours the well.');
  });

  it('defers in a small window, or when the definitions take more than 15% of it', () => {
    expect(shouldDeferTools(tools, 16_000)).toBe(true);
    expect(shouldDeferTools(tools, 128_000)).toBe(false);
    const many = Array.from({ length: 200 }, (_, i) => tool(`t.tool_${i}`, `Does thing number ${i} to the app. ${'Details. '.repeat(40)}`));
    expect(shouldDeferTools(many, 128_000)).toBe(true);
    // nothing to defer: all core
    expect(shouldDeferTools([tools[3]], 8_000)).toBe(false);
  });
});
