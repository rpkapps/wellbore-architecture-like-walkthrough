import { describe, expect, it } from 'vitest';
import { buildAnthropicRequest, claudeTraits, createAnthropicAdapter, parseAnthropicStream, toAnthropicMessages } from '../../src/assistant/providers/anthropic';
import { chop, collect, config, fold, msg, sampleRequest, streamOf } from './core-helpers';

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Anthropic Messages streaming with a thinking block (signature), text, and a tool_use whose input streams as JSON deltas. */
const FIXTURE = [
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 25, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'The well is F-11 A; ' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'go to the Hugin top.' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3h' } }),
  ev('content_block_stop', { index: 0 }),
  'event: ping\ndata: {"type": "ping"}\n\n',
  ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Going to the top of Hugin — ' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '3 050 m MD.' } }),
  ev('content_block_stop', { index: 1 }),
  ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_01T1x', name: 'nav__go_to_depth', input: {} } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '' } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"md": 30' } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '50, "well": "F-11 A"}' } }),
  ev('content_block_stop', { index: 2 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 89 } }),
  ev('message_stop', {}),
].join('');

describe('Anthropic stream parsing', () => {
  it('reads thinking with its signature, text and a streamed tool_use input', async () => {
    const events = await collect(parseAnthropicStream(streamOf(chop(FIXTURE, 9))));
    const r = fold(events);
    expect(r.reasoning).toBe('The well is F-11 A; go to the Hugin top.');
    expect(events).toContainEqual({ type: 'reasoning-signature', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3h' });
    expect(r.text).toBe('Going to the top of Hugin — 3 050 m MD.');
    expect(r.calls).toEqual([{ id: 'toolu_01T1x', name: 'nav__go_to_depth', argsText: '{"md": 3050, "well": "F-11 A"}', args: { md: 3050, well: 'F-11 A' }, argsError: undefined, providerMeta: undefined }]);
    expect(r.finish).toBe('tool-calls');
    expect(r.usage).toEqual({ inputTokens: 1225, cachedInputTokens: 1000, outputTokens: 89 });
    // the signature closes the reasoning before the text starts
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('reasoning-signature')).toBeLessThan(kinds.indexOf('text-delta'));
  });

  it('maps stop reasons and surfaces redacted thinking', async () => {
    const body = [
      ev('message_start', { message: { usage: { input_tokens: 3 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'refusal' }, usage: { output_tokens: 2 } }),
    ].join('');
    const events = await collect(parseAnthropicStream(streamOf([body])));
    expect(events).toContainEqual({ type: 'reasoning-redacted', data: 'ENCRYPTED' });
    expect(fold(events).finish).toBe('content-filter');
  });

  it('throws a retryable ProviderError on an overloaded error event', async () => {
    const body = ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
    await expect(collect(parseAnthropicStream(streamOf([body])))).rejects.toMatchObject({ name: 'ProviderError', status: 529, retryable: true });
  });
});

describe('Anthropic request conversion', () => {
  const cfg = config({ presetId: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', vision: true });

  it('alternates roles: tool results open the next user message, followed by the person’s text', () => {
    const req = sampleRequest(cfg);
    const extra = msg('assistant', [
      { type: 'tool-call', id: 'call_x', name: 'view__color_by', args: { mode: 'res' }, state: 'done', result: { ok: 1 } },
    ]);
    const out = toAnthropicMessages({ ...req, messages: [...req.messages, extra, msg('user', [{ type: 'text', text: 'thanks' }])] });
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    // assistant step 1: thinking (signed) first, then text, then tool_use
    expect(out[1].content).toEqual([
      { type: 'thinking', thinking: 'The person wants GR.', signature: 'sig-1' },
      { type: 'text', text: 'Switching.' },
      { type: 'tool_use', id: 'call_1', name: 'view__color_by', input: { mode: 'gr' } },
    ]);
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' }]);
    // the image question merges after the assistant text; the last user message holds the result then the text
    expect(out[4].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(out[6].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_x', content: '{"ok":1}' },
      { type: 'text', text: 'thanks' },
    ]);
  });

  it('drops unsigned reasoning (from other providers) and marks failed results as errors', () => {
    const out = toAnthropicMessages({
      config: cfg,
      messages: [
        msg('user', [{ type: 'text', text: 'hi' }]),
        msg('assistant', [
          { type: 'reasoning', text: 'deepseek thoughts' },
          { type: 'tool-call', id: 'weird.id:1', name: 't', args: {}, state: 'error', error: 'bad', result: { error: 'bad' } },
        ]),
      ],
    });
    expect(out[1].content).toEqual([{ type: 'tool_use', id: 'weird_id_1', name: 't', input: {} }]);
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'weird_id_1', content: '{"error":"bad"}', is_error: true }]);
  });

  it('reads the model generation', () => {
    expect(claudeTraits('claude-opus-5-5')).toMatchObject({ adaptive: true, thinksByDefault: true, noSampling: true, binding: true });
    expect(claudeTraits('claude-sonnet-5')).toMatchObject({ adaptive: true, thinksByDefault: true, binding: false });
    expect(claudeTraits('claude-sonnet-4-6')).toMatchObject({ adaptive: true, thinksByDefault: false, noSampling: false });
    expect(claudeTraits('claude-haiku-4-5-20251001')).toMatchObject({ adaptive: false, budget: true });
    expect(claudeTraits('claude-sonnet-4-20250514')).toMatchObject({ adaptive: false, budget: true });
    expect(claudeTraits('claude-3-5-haiku-latest')).toMatchObject({ budget: false, defaultMaxTokens: 8192 });
  });

  it('builds the body: adaptive thinking + effort on current models, a budget on older ones, caching breakpoints', () => {
    const { body, beta } = buildAnthropicRequest(sampleRequest({ ...cfg, reasoning: 'medium', temperature: 0.5 }));
    expect(body).toMatchObject({ model: 'claude-sonnet-5', stream: true, max_tokens: 16000, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } });
    expect(body).not.toHaveProperty('temperature');
    expect(beta).toBeUndefined();
    expect(body.system).toEqual([{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral' } }]);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ name: 'view__color_by', input_schema: { type: 'object' }, eager_input_streaming: true, cache_control: { type: 'ephemeral' } });
    const msgs = body.messages as { content: Record<string, unknown>[] }[];
    expect(msgs[msgs.length - 1].content.at(-1)).toHaveProperty('cache_control');

    const old = buildAnthropicRequest(sampleRequest({ ...cfg, model: 'claude-haiku-4-5', reasoning: 'high' })).body;
    expect(old.thinking).toEqual({ type: 'enabled', budget_tokens: 24576 });
    expect(old.max_tokens as number).toBeGreaterThan(24576);

    const plain = buildAnthropicRequest(sampleRequest({ ...cfg, model: 'claude-haiku-4-5', temperature: 0.3 })).body;
    expect(plain).not.toHaveProperty('thinking');
    expect(plain.temperature).toBe(0.3);

    const bound = buildAnthropicRequest(sampleRequest({ ...cfg, model: 'claude-opus-5-5', reasoning: 'off' }));
    expect(bound.beta).toBe('thinking-binding-controls-2026-08-01');
    expect(bound.body.thinking).toMatchObject({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(bound.body.output_config).toEqual({ effort: 'low' });
  });

  it('calls /v1/messages with the browser-access headers and retries without a field the model rejects', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      calls.push({ url, headers: init!.headers as Record<string, string>, body });
      if ('temperature' in body) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature is not supported for this model' } }), { status: 400 });
      return new Response(streamOf([FIXTURE]), { status: 200 });
    };
    const adapter = createAnthropicAdapter({ fetch });
    const r = fold(await collect(adapter.stream(sampleRequest({ ...cfg, model: 'claude-future-9', temperature: 0.4 }))));
    expect(r.calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    expect(calls.map((c) => 'temperature' in c.body)).toEqual([true, false]);
  });
});
