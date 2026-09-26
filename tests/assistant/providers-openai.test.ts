import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenAIBody, createOpenAIAdapter, mistralCallId, parseOpenAIStream, resetOpenAIQuirks, toOpenAIMessages } from '../../src/assistant/providers/openai';
import { ProviderError } from '../../src/assistant/providers/errors';
import { chop, collect, config, fold, msg, sampleRequest, streamOf } from './core-helpers';

afterEach(() => resetOpenAIQuirks());

const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta: unknown, finish: string | null = null) => line({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta, finish_reason: finish }] });

/** OpenAI streaming two parallel tool calls, arguments split mid-token, then a usage-only chunk. */
const PARALLEL = [
  chunk({ role: 'assistant', content: null }),
  chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'view__color_by', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"mo' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'nav__go_to_depth', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'de": "gr"}' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"md": 3050.5}' } }] }),
  chunk({}, 'tool_calls'),
  line({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 812, completion_tokens: 41, total_tokens: 853, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: 12 } } }),
  'data: [DONE]\n\n',
].join('');

/** DeepSeek thinking mode: reasoning_content deltas before the answer. */
const DEEPSEEK = [
  chunk({ role: 'assistant', content: null, reasoning_content: '' }),
  chunk({ content: null, reasoning_content: 'GR above 75 API ' }),
  chunk({ content: null, reasoning_content: 'means shale.' }),
  chunk({ content: 'Mostly ', reasoning_content: null }),
  chunk({ content: 'shale.' }),
  chunk({ content: '' }, 'stop'),
  line({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, prompt_cache_hit_tokens: 16 } }),
  'data: [DONE]\n\n',
].join('');

describe('OpenAI stream parsing', () => {
  it('accumulates parallel tool calls by index, even when split mid-token across chunks', async () => {
    const r = fold(await collect(parseOpenAIStream(streamOf(chop(PARALLEL, 11)))));
    expect(r.calls).toEqual([
      { id: 'call_a', name: 'view__color_by', argsText: '{"mode": "gr"}', args: { mode: 'gr' }, argsError: undefined, providerMeta: undefined },
      { id: 'call_b', name: 'nav__go_to_depth', argsText: '{"md": 3050.5}', args: { md: 3050.5 }, argsError: undefined, providerMeta: undefined },
    ]);
    expect(r.finish).toBe('tool-calls');
    expect(r.usage).toEqual({ inputTokens: 812, outputTokens: 41, cachedInputTokens: 512, reasoningTokens: 12 });
  });

  it('reads DeepSeek reasoning_content and OpenRouter reasoning as reasoning deltas', async () => {
    const r = fold(await collect(parseOpenAIStream(streamOf(chop(DEEPSEEK, 5)))));
    expect(r.reasoning).toBe('GR above 75 API means shale.');
    expect(r.text).toBe('Mostly shale.');
    expect(r.finish).toBe('stop');
    expect(r.usage?.cachedInputTokens).toBe(16);
    const or = fold(await collect(parseOpenAIStream(streamOf([chunk({ reasoning: 'hmm' }), chunk({ content: 'ok' }, 'stop')]))));
    expect(or.reasoning).toBe('hmm');
  });

  it('maps finish reasons, treats "stop" after tool calls as tool-calls, and reports invalid argument JSON', async () => {
    const r = fold(
      await collect(
        parseOpenAIStream(
          streamOf([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{"a": ' } }] }), chunk({}, 'stop')]),
        ),
      ),
    );
    expect(r.finish).toBe('tool-calls');
    expect(r.calls[0].argsError).toBeTruthy();
    const len = fold(await collect(parseOpenAIStream(streamOf([chunk({ content: 'x' }, 'length')]))));
    expect(len.finish).toBe('length');
  });

  it('handles tool calls without an index (whole call in one chunk) and object arguments', async () => {
    const r = fold(
      await collect(
        parseOpenAIStream(
          streamOf([chunk({ tool_calls: [{ id: 'x1', function: { name: 'a', arguments: { q: 1 } } }, { id: 'x2', function: { name: 'b', arguments: '{}' } }] }), chunk({}, 'tool_calls')]),
        ),
      ),
    );
    expect(r.calls.map((c) => [c.id, c.name, c.args])).toEqual([
      ['x1', 'a', { q: 1 }],
      ['x2', 'b', {}],
    ]);
  });

  it('throws a ProviderError for an error object inside the stream', async () => {
    const body = streamOf([chunk({ content: 'Hi' }), line({ error: { code: 429, message: 'Rate limit exceeded upstream' } })]);
    await expect(collect(parseOpenAIStream(body))).rejects.toMatchObject({ name: 'ProviderError', status: 429, retryable: true });
  });
});

describe('OpenAI request conversion', () => {
  it('converts the transcript: system, context as text, images per vision, tool calls and results', () => {
    const req = sampleRequest(config({ vision: true }));
    const msgs = toOpenAIMessages(req);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are a test.' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('<context>');
    expect(msgs[1].content).toContain('"Hugin Fm."');
    expect(msgs[1].content).toContain('Colour by GR');
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Switching.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view__color_by', arguments: '{"mode":"gr"}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
    expect(msgs[4]).toEqual({ role: 'assistant', content: 'Done: coloured by gamma ray.' });
    expect(msgs[5]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        { type: 'text', text: 'What is this?' },
      ],
    });
    // no vision: a note instead of the picture, as plain text
    const blind = toOpenAIMessages(sampleRequest(config({ vision: false })));
    expect(blind[5].content).toBe('[image omitted: the model has no vision]\n\nWhat is this?');
  });

  it('sends reasoning_content back only for DeepSeek, only within the current turn', () => {
    const cfg = config({ presetId: 'deepseek' });
    const current = msg('assistant', [
      { type: 'reasoning', text: 'Need depth first.' },
      { type: 'tool-call', id: 'c9', name: 'nav__go_to_depth', args: { md: 1 }, state: 'done', result: { ok: true } },
    ]);
    const req = sampleRequest(cfg);
    const msgs = toOpenAIMessages({ ...req, messages: [...req.messages, current] });
    const withTools = msgs.filter((m) => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls);
    expect(withTools[0]).not.toHaveProperty('reasoning_content'); // earlier turn
    expect(withTools[1]).toMatchObject({ reasoning_content: 'Need depth first.' });
    const openai = toOpenAIMessages({ ...req, config: config(), messages: [...req.messages, current] });
    expect(openai.some((m) => 'reasoning_content' in m)).toBe(false);
  });

  it('reports unfinished, failed and denied calls so every tool call gets a result', () => {
    const m = msg('assistant', [
      { type: 'tool-call', id: 'a', name: 't', args: {}, state: 'error', error: 'boom', result: { error: 'boom' } },
      { type: 'tool-call', id: 'b', name: 't', args: {}, state: 'denied' },
      { type: 'tool-call', id: 'c', name: 't', args: {}, state: 'cancelled' },
    ]);
    const out = toOpenAIMessages({ config: config(), system: '', messages: [msg('user', [{ type: 'text', text: 'go' }]), m] });
    expect(out.filter((x) => x.role === 'tool').map((x) => JSON.parse(x.content as string))).toEqual([
      { error: 'boom' },
      { denied: true, message: 'The person declined this action.' },
      { cancelled: true, message: 'The person stopped the turn before this call ran.' },
    ]);
  });

  it('builds the body: tools, usage option, token field per preset, effort only where accepted', () => {
    const req = sampleRequest(config({ presetId: 'openai', maxOutputTokens: 900, reasoning: 'high', temperature: 0.2 }));
    const body = buildOpenAIBody(req);
    expect(body).toMatchObject({ model: 'test-model', stream: true, stream_options: { include_usage: true }, tool_choice: 'auto', max_completion_tokens: 900, reasoning_effort: 'high', temperature: 0.2 });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'view__color_by', description: 'Colours the well.', parameters: req.tools[0].parameters } }]);
    expect(body).not.toHaveProperty('parallel_tool_calls');
    const ds = buildOpenAIBody(sampleRequest(config({ presetId: 'deepseek', maxOutputTokens: 900, reasoning: 'high' })));
    expect(ds.max_tokens).toBe(900);
    expect(ds).not.toHaveProperty('reasoning_effort');
    expect(buildOpenAIBody(sampleRequest(config({ presetId: 'openrouter', reasoning: 'low' }))).reasoning).toEqual({ effort: 'low' });
    expect(buildOpenAIBody({ ...req, tools: [] })).not.toHaveProperty('tools');
  });

  it('gives Mistral the 9-character call ids it requires, consistently', () => {
    const id = mistralCallId('toolu_01A09q90qw90lq917835lq9');
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(mistralCallId('toolu_01A09q90qw90lq917835lq9')).toBe(id);
    expect(mistralCallId('abcDEF123')).toBe('abcDEF123');
    const out = toOpenAIMessages(sampleRequest(config({ presetId: 'mistral' })));
    const call = out.find((m) => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls);
    const tool = out.find((m) => m.role === 'tool');
    expect(call && 'tool_calls' in call && call.tool_calls![0].id).toBe(tool && 'tool_call_id' in tool && tool.tool_call_id);
  });
});

describe('OpenAI adapter over HTTP', () => {
  it('posts to /chat/completions with auth, proxy prefix and extra headers, and streams', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init! });
      return new Response(streamOf([chunk({ content: 'OK' }, 'stop'), 'data: [DONE]\n\n']), { status: 200 });
    };
    const adapter = createOpenAIAdapter({ fetch });
    const cfg = config({ corsProxy: 'https://proxy.example/', headers: { 'X-Org': 'acme' } });
    const r = fold(await collect(adapter.stream(sampleRequest(cfg))));
    expect(r.text).toBe('OK');
    expect(seen[0].url).toBe('https://proxy.example/https://api.example.com/v1/chat/completions');
    const h = seen[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer sk-test');
    expect(h['X-Org']).toBe('acme');
    expect(seen[0].init.signal).toBeDefined();
  });

  it('retries without stream_options when the server rejects it, and remembers', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(init!.body as string) as Record<string, unknown>;
      bodies.push(b);
      if ('stream_options' in b) return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }), { status: 400 });
      return new Response(streamOf([chunk({ content: 'fine' }, 'stop')]), { status: 200 });
    };
    const adapter = createOpenAIAdapter({ fetch });
    expect(fold(await collect(adapter.stream(sampleRequest(config())))).text).toBe('fine');
    await collect(adapter.stream(sampleRequest(config())));
    expect(bodies.map((b) => 'stream_options' in b)).toEqual([true, false, false]);
  });

  it('turns HTTP errors into ProviderErrors with human messages', async () => {
    const adapter = createOpenAIAdapter({ fetch: async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }) });
    const err = await collect(adapter.stream(sampleRequest(config()))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 401, config: true, retryable: false });
    expect((err as Error).message).toContain('API key was rejected (401)');
  });

  it('lists models sorted by id', async () => {
    const adapter = createOpenAIAdapter({ fetch: async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a', context_length: 128000 }] })) });
    expect(await adapter.listModels!(config())).toEqual([{ id: 'a', contextWindow: 128000 }, { id: 'b' }]);
  });
});
