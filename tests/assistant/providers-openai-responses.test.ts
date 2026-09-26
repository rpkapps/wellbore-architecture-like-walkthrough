import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHost, AssistantSnapshot, AssistantTool, ChatMessage, ProviderConfig, StreamEvent, ToolCallPart } from '../../src/assistant/core/types';
import type { Persistence } from '../../src/assistant/core/persistence';
import { chop, collect, config, fold, msg, sampleRequest, streamOf } from './core-helpers';

// the generated-UI module is another agent's: a small stand-in keeps these tests about the adapter and the engine
vi.mock('../../src/assistant/a2ui', () => ({
  A2UISurface: () => null,
  a2uiPromptGuide: () => 'A2UI GUIDE: call render_ui.',
  renderUiTool: (): AssistantTool => ({
    name: 'render_ui',
    kind: 'read',
    description: 'Render an interface.',
    parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } } } },
    execute: () => ({ ok: true }),
  }),
  extractA2UIFences: (text: string) => ({ text, blocks: [] }),
}));

const { buildResponsesBody, createOpenAIResponsesAdapter, parseResponsesStream, resetOpenAIResponsesQuirks, toResponsesInput, RESPONSES_META } = await import(
  '../../src/assistant/providers/openaiResponses'
);
const { buildOpenAIBody, createOpenAIAdapter, resetOpenAIQuirks } = await import('../../src/assistant/providers/openai');
const { adapterFor } = await import('../../src/assistant/providers');
const { configFromPreset, presetById } = await import('../../src/assistant/providers/presets');
const { createAssistant } = await import('../../src/assistant/core/controller');
const { createPersistence } = await import('../../src/assistant/core/persistence');
const { createMockFetch } = await import('../../src/assistant/testing/mockLLM');

type Engine = ReturnType<typeof createAssistant>;
const engines: Engine[] = [];
afterEach(() => {
  resetOpenAIResponsesQuirks();
  resetOpenAIQuirks();
  engines.splice(0).forEach((e) => e.dispose());
});

const rcfg = (patch: Partial<ProviderConfig> = {}) => config({ kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', vision: true, ...patch });

/** A transcript whose last message is the turn in progress: the model reasoned, called a tool, and got its result. */
function inProgress(cfg: ProviderConfig) {
  const req = sampleRequest(cfg);
  const current: ChatMessage = msg(
    'assistant',
    [
      { type: 'reasoning', text: 'Check the tops first.', providerMeta: { [RESPONSES_META]: { id: 'rs_1', encryptedContent: 'gAAAA-enc-1' } } },
      { type: 'text', text: 'Looking up the tops.' },
      { type: 'tool-call', id: 'call_9', name: 'wells__tops', args: { well: 'F-11 A' }, state: 'done', result: { tops: 3 }, step: 0 },
    ],
    { model: 'gpt-6-sol' },
  );
  // an earlier turn's encrypted reasoning is not replayed
  req.messages[1] = { ...req.messages[1], parts: [{ type: 'reasoning', text: 'old', providerMeta: { [RESPONSES_META]: { id: 'rs_0', encryptedContent: 'gAAAA-old' } } }, ...req.messages[1].parts] };
  req.messages.push(current);
  return req;
}

describe('Responses request', () => {
  it('sends the system prompt as instructions and the transcript as input items, replaying this turn’s reasoning before its call', () => {
    const req = inProgress(rcfg({ reasoning: 'high', maxOutputTokens: 4000, temperature: 0.3 }));
    const body = buildResponsesBody(req);
    expect(body).toMatchObject({
      model: 'gpt-6-sol',
      instructions: 'You are a test.',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      reasoning: { effort: 'high', summary: 'auto' },
      max_output_tokens: 4000,
    });
    // no sampling with reasoning
    expect(body).not.toHaveProperty('temperature');
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'view__color_by',
        description: 'Colours the well.',
        parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
        strict: false,
      },
    ]);
    const input = body.input as Record<string, unknown>[];
    expect(input.map((i) => (i.type as string) ?? i.role)).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
      'assistant',
      'user',
      'reasoning',
      'assistant',
      'function_call',
      'function_call_output',
    ]);
    const first = input[0] as { content: { type: string; text: string }[] };
    expect(first.content[0].type).toBe('input_text');
    expect(first.content.map((c) => c.text).join('\n')).toContain('<context>');
    expect(input[1]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'Switching.' }] });
    expect(input[2]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'view__color_by', arguments: '{"mode":"gr"}' });
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' });
    expect(input[5]).toEqual({
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
        { type: 'input_text', text: 'What is this?' },
      ],
    });
    expect(input[6]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAA-enc-1', summary: [] });
    expect(input[8]).toEqual({ type: 'function_call', call_id: 'call_9', name: 'wells__tops', arguments: '{"well":"F-11 A"}' });
    expect(input[9]).toEqual({ type: 'function_call_output', call_id: 'call_9', output: '{"tops":3}' });
    expect(JSON.stringify(input)).not.toContain('gAAAA-old');
  });

  it('leaves the effort to the model when reasoning is unset, and still asks for summaries', () => {
    const body = buildResponsesBody(inProgress(rcfg({ reasoning: undefined })));
    expect(body.reasoning).toEqual({ summary: 'auto' });
  });

  it('asks for no reasoning when it is off, samples only then, and does not replay another model’s reasoning', () => {
    const req = inProgress(rcfg({ reasoning: 'off', temperature: 0.3 }));
    const body = buildResponsesBody(req);
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.temperature).toBe(0.3);
    expect(body).not.toHaveProperty('max_output_tokens');
    const other = toResponsesInput({ config: rcfg({ model: 'gpt-6-luna' }), messages: req.messages });
    expect(other.some((i) => 'type' in i && i.type === 'reasoning')).toBe(false);
    // images become a note without vision
    expect(JSON.stringify(toResponsesInput({ config: rcfg({ vision: false }), messages: req.messages }))).toContain('image omitted');
  });

  it('drops a field the model rejects, remembers it, and posts to /responses', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      seen.push({ url, body });
      if (body.reasoning)
        return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' } }), { status: 400 });
      return new Response(streamOf([`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'fine' })}\n\n`]), { status: 200 });
    };
    const adapter = createOpenAIResponsesAdapter({ fetch });
    const cfg = rcfg({ model: 'gpt-4.1' });
    expect(fold(await collect(adapter.stream(sampleRequest(cfg)))).text).toBe('fine');
    await collect(adapter.stream(sampleRequest(cfg)));
    expect(seen.map((s) => s.url)).toEqual(Array(3).fill('https://api.openai.com/v1/responses'));
    expect(seen.map((s) => 'reasoning' in s.body)).toEqual([true, false, false]);
  });

  it('is the OpenAI preset’s protocol; other OpenAI-compatible presets keep Chat Completions', () => {
    expect(presetById('openai')).toMatchObject({ kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
    expect(presetById('deepseek')!.kind).toBe('openai');
    expect(presetById('custom')!.kind).toBe('openai');
    expect(adapterFor('openai-responses').kind).toBe('openai-responses');
  });
});

// ------------------------------------------------------------------ stream

const ev = (type: string, data: Record<string, unknown>, seq: { n: number }) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq.n++, ...data })}\n\n`;

/** gpt-6-sol: a two-part reasoning summary, a function call whose arguments arrive in pieces, then (next step) text; usage at the end. */
function fixture(): string {
  const s = { n: 0 };
  const resp = { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-6-sol', store: false };
  return [
    ev('response.created', { response: { ...resp, status: 'in_progress', output: [], usage: null } }, s),
    ev('response.in_progress', { response: { ...resp, status: 'in_progress', output: [], usage: null } }, s),
    ev('response.output_item.added', { output_index: 0, item: { id: 'rs_abc', type: 'reasoning', summary: [] } }, s),
    ev('response.reasoning_summary_part.added', { item_id: 'rs_abc', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }, s),
    ev('response.reasoning_summary_text.delta', { item_id: 'rs_abc', output_index: 0, summary_index: 0, delta: '**Reading the tops**\n\nThe person ' }, s),
    ev('response.reasoning_summary_text.delta', { item_id: 'rs_abc', output_index: 0, summary_index: 0, delta: 'wants Hugin.' }, s),
    ev('response.reasoning_summary_text.done', { item_id: 'rs_abc', output_index: 0, summary_index: 0, text: '**Reading the tops**\n\nThe person wants Hugin.' }, s),
    ev('response.reasoning_summary_part.added', { item_id: 'rs_abc', output_index: 0, summary_index: 1, part: { type: 'summary_text', text: '' } }, s),
    ev('response.reasoning_summary_text.delta', { item_id: 'rs_abc', output_index: 0, summary_index: 1, delta: 'Call the tool.' }, s),
    ev(
      'response.output_item.done',
      { output_index: 0, item: { id: 'rs_abc', type: 'reasoning', summary: [{ type: 'summary_text', text: '…' }], encrypted_content: 'gAAAAB-secret' } },
      s,
    ),
    ev('response.output_item.added', { output_index: 1, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }, s),
    ev('response.content_part.added', { item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, s),
    ev('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Looking up ' }, s),
    ev('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'the tops — “Hugin”.' }, s),
    ev('response.output_text.done', { item_id: 'msg_1', output_index: 1, content_index: 0, text: 'Looking up the tops — “Hugin”.' }, s),
    ev('response.output_item.done', { output_index: 1, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Looking up the tops — “Hugin”.' }] } }, s),
    ev('response.output_item.added', { output_index: 2, item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_XYZ', name: 'wells__tops', arguments: '' } }, s),
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: '{"we' }, s),
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: 'll": "F-11 A", "for' }, s),
    ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: 'mation": "Hugin"}' }, s),
    ev('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 2, arguments: '{"well": "F-11 A", "formation": "Hugin"}' }, s),
    ev(
      'response.output_item.done',
      { output_index: 2, item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_XYZ', name: 'wells__tops', arguments: '{"well": "F-11 A", "formation": "Hugin"}' } },
      s,
    ),
    ev(
      'response.completed',
      {
        response: {
          ...resp,
          status: 'completed',
          incomplete_details: null,
          output: [],
          usage: { input_tokens: 1840, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 210, output_tokens_details: { reasoning_tokens: 128 }, total_tokens: 2050 },
        },
      },
      s,
    ),
  ].join('');
}

describe('Responses stream parsing', () => {
  it('turns summaries, text and a streamed function call into kit events, split at awkward places', async () => {
    const events = await collect(parseResponsesStream(streamOf(chop(fixture(), 13))));
    const r = fold(events);
    expect(r.reasoning).toBe('**Reading the tops**\n\nThe person wants Hugin.\n\nCall the tool.');
    expect(r.text).toBe('Looking up the tops — “Hugin”.');
    expect(r.calls).toEqual([
      { id: 'call_XYZ', name: 'wells__tops', argsText: '{"well": "F-11 A", "formation": "Hugin"}', args: { well: 'F-11 A', formation: 'Hugin' }, argsError: undefined, providerMeta: undefined },
    ]);
    expect(r.usage).toEqual({ inputTokens: 1840, cachedInputTokens: 1024, outputTokens: 210, reasoningTokens: 128 });
    expect(r.finish).toBe('tool-calls');
    // the encrypted reasoning ends the reasoning, before the text
    const meta = events.findIndex((e) => e.type === 'reasoning-meta');
    expect(events[meta]).toEqual({ type: 'reasoning-meta', providerMeta: { [RESPONSES_META]: { id: 'rs_abc', encryptedContent: 'gAAAAB-secret' } } });
    expect(meta).toBeLessThan(events.findIndex((e) => e.type === 'text-delta'));
    // one end per call
    expect(events.filter((e) => e.type === 'tool-call-end')).toHaveLength(1);
  });

  it('reports an answer cut short as length, and a plain answer as stop', async () => {
    const s = { n: 0 };
    const cut = [
      ev('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'Partial' }, s),
      ev('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 7 } } }, s),
    ].join('');
    expect(fold(await collect(parseResponsesStream(streamOf([cut]))))).toMatchObject({ text: 'Partial', finish: 'length', usage: { inputTokens: 5, outputTokens: 7 } });
    const done = [ev('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'Hi' }, s), ev('response.completed', { response: { status: 'completed', usage: null } }, s)].join('');
    expect(fold(await collect(parseResponsesStream(streamOf([done])))).finish).toBe('stop');
  });

  it('maps failures inside the stream to ProviderErrors (a context overflow can be compacted)', async () => {
    const s = { n: 0 };
    const overflow = ev('response.failed', { response: { status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } }, s);
    await expect(collect(parseResponsesStream(streamOf([overflow])))).rejects.toMatchObject({ name: 'ProviderError', status: 400, contextOverflow: true });
    const limited = ev('error', { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-6-sol.', param: null }, s);
    await expect(collect(parseResponsesStream(streamOf([limited])))).rejects.toMatchObject({ name: 'ProviderError', status: 429, retryable: true });
    const server = ev('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'The model failed to generate a response.' } } }, s);
    await expect(collect(parseResponsesStream(streamOf([server])))).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it('maps HTTP errors like the other adapters', async () => {
    const body = { error: { message: 'Your input exceeds the context window of this model.', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } };
    const adapter = createOpenAIResponsesAdapter({ fetch: async () => new Response(JSON.stringify(body), { status: 400 }) });
    await expect(collect(adapter.stream(sampleRequest(rcfg())))).rejects.toMatchObject({ name: 'ProviderError', contextOverflow: true });
    const bad = createOpenAIResponsesAdapter({ fetch: async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }) });
    await expect(collect(bad.stream(sampleRequest(rcfg())))).rejects.toMatchObject({ status: 401, config: true });
  });
});

// ------------------------------------------------------------------ Chat Completions fallback

describe('Chat Completions with a model that takes tools only without reasoning', () => {
  const REFUSAL = {
    error: {
      message: "Function tools with reasoning_effort are not supported for gpt-6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
      type: 'invalid_request_error',
      param: 'reasoning_effort',
      code: null,
    },
  };

  it('asks again with reasoning_effort "none" and remembers it for the base URL and model', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(init!.body as string) as Record<string, unknown>;
      bodies.push(b);
      if (b.reasoning_effort !== 'none') return new Response(JSON.stringify(REFUSAL), { status: 400 });
      return new Response(streamOf([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']), { status: 200 });
    };
    const adapter = createOpenAIAdapter({ fetch });
    // a custom gateway serving the model (no reasoning_effort sent at first) and the OpenAI preset on Chat Completions (effort set)
    for (const cfg of [config({ presetId: 'custom', baseUrl: 'https://gw.example/v1', model: 'gpt-6-sol' }), config({ presetId: 'openai', model: 'gpt-6-sol', reasoning: 'medium' })]) {
      bodies.length = 0;
      expect(fold(await collect(adapter.stream(sampleRequest(cfg)))).text).toBe('ok');
      await collect(adapter.stream(sampleRequest(cfg)));
      expect(bodies.map((b) => b.reasoning_effort)).toEqual([cfg.reasoning, 'none', 'none']);
      expect(bodies[1].tools).toBeDefined();
    }
    // the quirk is per model
    expect(buildOpenAIBody(sampleRequest(config({ reasoning: 'high' })))).toMatchObject({ reasoning_effort: 'high' });
  });

  it('drops reasoning_effort altogether when "none" is refused too', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(init!.body as string) as Record<string, unknown>;
      bodies.push(b);
      if ('reasoning_effort' in b) return new Response(JSON.stringify({ error: { message: 'reasoning_effort is not supported by this model.' } }), { status: 400 });
      return new Response(streamOf([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`]), { status: 200 });
    };
    const events: StreamEvent[] = await collect(createOpenAIAdapter({ fetch }).stream(sampleRequest(config({ reasoning: 'low' }))));
    expect(fold(events).text).toBe('ok');
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(['low', 'none', undefined]);
  });
});

// ------------------------------------------------------------------ the whole loop, and saved settings

function host(ran: unknown[]): AssistantHost {
  return {
    appName: 'BoreWalk',
    storageKey: `test-${Math.random()}`,
    instructions: () => 'BoreWalk shows wells in 3D.',
    tools: () => [
      {
        name: 'view.color_by',
        kind: 'read',
        description: 'Colours the well.',
        parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
        execute: (args) => {
          ran.push(args);
          return { ok: true, coloured: (args as { mode: string }).mode };
        },
      },
    ],
  };
}

function settled(engine: Engine): Promise<AssistantSnapshot> {
  return new Promise((resolve, reject) => {
    const done = (s: AssistantSnapshot) => (s.status === 'ready' || s.status === 'error') && s.thread.messages.at(-1)?.status !== 'streaming' && s.thread.messages.length > 0;
    const timer = setTimeout(() => reject(new Error('timed out')), 3000);
    const unsub = engine.subscribe(() => {
      const s = engine.getSnapshot();
      if (done(s)) {
        clearTimeout(timer);
        unsub();
        resolve(s);
      }
    });
  });
}

describe('agent loop over the Responses API', () => {
  it('calls a tool, sends its result with the encrypted reasoning, and answers', async () => {
    const ran: unknown[] = [];
    const fetch = createMockFetch(
      (req) => {
        expect(req.protocol).toBe('openai-responses');
        if (req.stepIndex === 0) return { reasoning: 'Colour it by GR.', toolCalls: [{ name: 'view__color_by', args: { mode: 'gr' }, id: 'call_gr' }] };
        return { text: `Done: ${JSON.stringify(req.toolResults[0].content)}` };
      },
      { chunkSize: 4 },
    );
    const engine = createAssistant(host(ran), { fetch, storage: 'memory', sleep: async () => {} });
    engines.push(engine);
    engine.saveProvider(configFromPreset(presetById('openai')!, { id: 'p1', apiKey: 'sk-key', baseUrl: 'https://mock.test/v1', model: 'gpt-6-sol', reasoning: 'medium' }));
    engine.send({ text: 'Colour the well by gamma ray' });
    const s = await settled(engine);
    expect(ran).toEqual([{ mode: 'gr' }]);
    const m = s.thread.messages.at(-1)!;
    expect(m).toMatchObject({ role: 'assistant', status: 'done', finishReason: 'stop', provider: 'openai', model: 'gpt-6-sol' });
    const call = m.parts.find((p): p is ToolCallPart => p.type === 'tool-call')!;
    expect(call).toMatchObject({ id: 'call_gr', name: 'view.color_by', state: 'done', args: { mode: 'gr' } });
    const reasoning = m.parts.find((p) => p.type === 'reasoning');
    expect(reasoning).toMatchObject({ text: 'Colour it by GR.', providerMeta: { [RESPONSES_META]: { encryptedContent: expect.stringMatching(/^enc_/) } } });
    expect(m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).toBe('Done: {"ok":true,"coloured":"gr"}');

    expect(fetch.calls.map((c) => c.url)).toEqual(['https://mock.test/v1/responses', 'https://mock.test/v1/responses']);
    expect(fetch.calls[0].headers.authorization).toBe('Bearer sk-key');
    const second = fetch.calls[1].body as { input: Record<string, unknown>[]; reasoning: unknown };
    expect(second.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    const kinds = second.input.map((i) => (i.type as string) ?? i.role);
    expect(kinds).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(second.input[1]).toMatchObject({ type: 'reasoning', id: expect.stringMatching(/^rs_/), encrypted_content: expect.stringMatching(/^enc_/), summary: [] });
    expect(second.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_gr', name: 'view__color_by', arguments: '{"mode":"gr"}' });
    expect(second.input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_gr' });
  });
});

describe('saved settings', () => {
  const load = (settings: Record<string, unknown>) => {
    const inner = createPersistence(`test-${Math.random()}`, 'memory');
    const persistence: Persistence = { ...inner, loadSettings: () => JSON.parse(JSON.stringify(settings)) as ReturnType<Persistence['loadSettings']> };
    const engine = createAssistant(host([]), { storage: 'memory', persistence, fetch: createMockFetch(() => ({ text: 'ok' })) });
    engines.push(engine);
    return engine;
  };
  const old = (patch: Partial<ProviderConfig>) => ({ id: 'x', presetId: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', ...patch });

  it('moves an OpenAI connection saved before the Responses API to it, and leaves the others', () => {
    const engine = load({ providers: [old({ id: 'a' }), old({ id: 'b', presetId: 'custom', baseUrl: 'https://gw.example/v1' }), old({ id: 'c', presetId: 'deepseek' })], activeProviderId: 'a' });
    const s = engine.getSnapshot();
    expect(s.settings.providers.map((p) => p.kind)).toEqual(['openai-responses', 'openai', 'openai']);
    expect(s.provider).toMatchObject({ id: 'a', kind: 'openai-responses', model: 'gpt-6-sol' });
    expect(s.settings.version).toBe(2);
  });

  it('keeps Chat Completions when the person chose it after the move', () => {
    const engine = load({ version: 2, providers: [old({ id: 'a' })], activeProviderId: 'a' });
    expect(engine.getSnapshot().provider!.kind).toBe('openai');
  });
});
