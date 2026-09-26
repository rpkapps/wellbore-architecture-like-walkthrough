import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHost, AssistantSnapshot, AssistantTool, ProviderConfig, ToolCallPart } from '../../src/assistant/core/types';

// the generated-UI module is another agent's: a small stand-in keeps these tests about the engine
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

const { createAssistant } = await import('../../src/assistant/core/controller');
const { createMockFetch, contextLengthError } = await import('../../src/assistant/testing/mockLLM');
const { configFromPreset, presetById } = await import('../../src/assistant/providers/presets');
type Engine = ReturnType<typeof createAssistant>;
type Script = Parameters<typeof createMockFetch>[0];
type MockReq = Parameters<Script>[0];

const engines: Engine[] = [];
afterEach(() => {
  engines.splice(0).forEach((e) => e.dispose());
});

const SUMMARISER = 'You condense a conversation';
const isSummary = (req: MockReq) => req.system.includes(SUMMARISER);
const tool = (name: string, description: string, patch: Partial<AssistantTool> = {}): AssistantTool => ({
  name,
  description,
  kind: 'read',
  parameters: { type: 'object', properties: { well: { type: 'string' } } },
  execute: () => ({ ok: true, name }),
  ...patch,
});

const PROVIDERS: Record<'openai' | 'anthropic' | 'gemini', Partial<ProviderConfig>> = {
  openai: { baseUrl: 'https://mock.test/v1', model: 'gpt-mock' },
  anthropic: { baseUrl: 'https://mock.test', model: 'claude-sonnet-5' },
  gemini: { baseUrl: 'https://mock.test/v1beta', model: 'gemini-3.5-flash' },
};

function setup(
  script: Script,
  opts: {
    preset?: keyof typeof PROVIDERS;
    tools?: AssistantTool[];
    config?: Partial<ProviderConfig>;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    mock?: Parameters<typeof createMockFetch>[1];
  } = {},
) {
  // the mock reports the request's size as its input tokens, like a provider would
  const fetch = createMockFetch(async (req) => ({ usage: { input: req.inputTokens }, ...(await script(req)) }), { chunkSize: 50, ...opts.mock });
  const host: AssistantHost = {
    appName: 'BoreWalk',
    storageKey: `test-${Math.random()}`,
    instructions: () => 'BoreWalk shows wells in 3D.',
    snapshot: () => ({ well: 'F-11 A' }),
    tools: () =>
      opts.tools ?? [
        tool('data.read_log', 'Reads a log.', {
          core: true,
          execute: () => ({ content: { samples: 3 }, datasets: [{ title: 'GR', columns: [{ key: 'md', unit: 'm' }], rows: [{ md: 1 }, { md: 2 }] }] }),
        }),
      ],
  };
  const engine = createAssistant(host, { fetch, storage: 'memory', sleep: opts.sleep ?? (async () => {}) });
  engines.push(engine);
  const preset = opts.preset ?? 'openai';
  engine.saveProvider(configFromPreset(presetById(preset)!, { id: 'p1', apiKey: 'key', ...PROVIDERS[preset], ...opts.config }));
  return { engine, fetch };
}

function waitFor(engine: Engine, pred: (s: AssistantSnapshot) => boolean, ms = 3000): Promise<AssistantSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = engine.getSnapshot();
      if (!pred(s)) return;
      clearTimeout(timer);
      unsub();
      resolve(s);
    };
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out; status=${engine.getSnapshot().status}`));
    }, ms);
    const unsub = engine.subscribe(check);
    check();
  });
}
const settled = (e: Engine) => waitFor(e, (s) => (s.status === 'ready' || s.status === 'error') && s.thread.messages.at(-1)?.status !== 'streaming');
const lastMsg = (s: AssistantSnapshot) => s.thread.messages[s.thread.messages.length - 1];
const posts = (fetch: ReturnType<typeof createMockFetch>) => fetch.calls.filter((c) => c.body !== undefined) as { url: string; body: Record<string, unknown> }[];
const says = (text: string) => ({ text });
const long = (tag: string) => `${tag}: ${'The gamma ray log reads between 40 and 120 API over the interval. '.repeat(25)}`;

/** Every OpenAI `tool` message answers a call of the assistant message just before it (and every call is answered). */
function assertToolPairs(messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = messages.slice(i + 1, i + 1 + m.tool_calls.length).map((x) => x.tool_call_id);
      expect(ids).toEqual(m.tool_calls.map((c) => c.id));
    }
    if (m.role === 'tool') {
      let j = i - 1;
      while (messages[j]?.role === 'tool') j--;
      expect(messages[j]?.role).toBe('assistant');
      expect(messages[j].tool_calls?.some((c) => c.id === m.tool_call_id)).toBe(true);
    }
  }
}

describe('tier 2: automatic summaries', () => {
  it('summarises the older turns when the request nears the budget, keeping the recent turns and tool pairs whole', async () => {
    const seen: { compacting: boolean; status: string }[] = [];
    let turn = 0;
    const { engine, fetch } = setup(
      (req) => {
        if (isSummary(req)) return says('## Goal\nGR review of F-11 A. ds_1 holds GR.');
        // turns 1 and 3 call a tool first
        if ((req.lastUserText.endsWith('Q1') || req.lastUserText.endsWith('Q3')) && req.stepIndex === 0) return { toolCalls: [{ name: 'data__read_log', args: { well: 'F-11 A' } }] };
        return says(long(`A${req.lastUserText.slice(-1)}`));
      },
      { config: { contextWindow: 10_000 } },
    );
    engine.subscribe(() => {
      const s = engine.getSnapshot();
      if (s.context?.compacting) seen.push({ compacting: true, status: s.status });
    });
    const before = engine.getSnapshot().context!;
    expect(before.window).toBe(10_000);
    expect(before.used).toBeGreaterThan(500);
    let usedBeforeCompaction = 0;
    for (turn = 1; turn <= 12; turn++) {
      engine.send({ text: `Q${turn}` });
      const s = await settled(engine);
      expect(lastMsg(s).status).toBe('done');
      if (!s.thread.compactions?.length) usedBeforeCompaction = s.context!.used;
      else break;
    }
    const s = engine.getSnapshot();
    expect(s.thread.compactions).toHaveLength(1);
    const c = s.thread.compactions![0];
    const at = s.thread.messages.findIndex((m) => m.id === c.throughMessageId);
    // the boundary is a finished assistant message followed by the person, two turns before the current one
    expect(s.thread.messages[at]).toMatchObject({ role: 'assistant', status: 'done' });
    expect(s.thread.messages[at + 1].role).toBe('user');
    expect(s.thread.messages.length - (at + 1)).toBe(6);
    expect(c).toMatchObject({ auto: true, messages: at + 1, summary: expect.stringContaining('GR review') });
    expect(c.tokensAfter!).toBeLessThan(c.tokensBefore!);
    expect(s.context!.used).toBeLessThan(usedBeforeCompaction + 1_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.status === 'submitted')).toBe(true);
    expect(s.context!.compacting).toBe(false);

    const bodies = posts(fetch).map((c) => c.body as { messages: { role: string; content: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[] });
    const summaryIdx = bodies.findIndex((b) => JSON.stringify(b.messages[0]).includes(SUMMARISER));
    expect(summaryIdx).toBeGreaterThan(0);
    // one call, no tools, the transcript as text including the tool call
    expect(posts(fetch)[summaryIdx].body.tools).toBeUndefined();
    const summaryInput = JSON.stringify(bodies[summaryIdx].messages);
    expect(summaryInput).toContain('Q1');
    expect(summaryInput).toContain('data.read_log');
    const next = bodies[summaryIdx + 1];
    const text = JSON.stringify(next.messages);
    expect(text).toContain('<conversation_summary>');
    expect(text).toContain('GR review of F-11 A');
    expect(text).not.toContain('"Q1');
    expect(next.messages[1].role).toBe('user');
    expect(next.messages.filter((m) => m.role === 'user').length).toBe(3);
    assertToolPairs(next.messages);
    // the system prompt is the same byte for byte before and after
    const systems = new Set(bodies.filter((_, i) => i !== summaryIdx).map((b) => JSON.stringify(b.messages[0])));
    expect(systems.size).toBe(1);
    // the transcript keeps every message
    expect(s.thread.messages[0].parts.find((p) => p.type === 'text')).toEqual({ type: 'text', text: 'Q1' });
  });

  it('/compact summarises now, keeping the last two turns; a no-op on an empty thread', async () => {
    const { engine, fetch } = setup((req) => (isSummary(req) ? says('Manual summary.') : says(`Answer to ${req.lastUserText.slice(-2)}`)));
    engine.compact();
    expect(engine.getSnapshot().status).toBe('ready');
    expect(fetch.calls).toHaveLength(0);
    for (const q of ['Q1', 'Q2', 'Q3']) {
      engine.send({ text: q });
      await settled(engine);
    }
    engine.compact();
    expect(engine.getSnapshot()).toMatchObject({ status: 'submitted', context: { compacting: true } });
    const s = await waitFor(engine, (x) => x.status === 'ready' && !!x.thread.compactions?.length);
    expect(s.context!.compacting).toBe(false);
    expect(s.thread.compactions![0]).toMatchObject({ auto: false, throughMessageId: s.thread.messages[1].id, summary: 'Manual summary.' });
    engine.send({ text: 'Q4' });
    await settled(engine);
    const last = posts(fetch).at(-1)!.body as { messages: { role: string; content: string }[] };
    expect(last.messages[1].content).toContain('Manual summary.');
    expect(last.messages[1].content).toContain('Q2');
    expect(JSON.stringify(last.messages)).not.toContain('"Q1');
    // regenerating the answer a summary covers drops the summary
    engine.editAndResend(s.thread.messages[0].id, 'Q1 again');
    const after = await settled(engine);
    expect(after.thread.compactions ?? []).toHaveLength(0);
  });

  it('a /compact that fails reports it and keeps the thread as it was', async () => {
    const { engine } = setup((req) => (isSummary(req) ? { error: { status: 400, body: { error: { message: 'bad request' } } } } : says('ok')));
    engine.send({ text: 'Q1' });
    await settled(engine);
    engine.compact();
    const s = await waitFor(engine, (x) => x.status === 'error');
    expect(s.error!.message).toContain('could not be summarised');
    expect(s.thread.compactions ?? []).toHaveLength(0);
  });
});

describe.each(['openai', 'anthropic', 'gemini'] as const)('tier 3 over %s', (preset) => {
  it('a context-length error compacts everything before the turn and retries once, transparently', async () => {
    const { engine, fetch } = setup(
      (req) => {
        if (isSummary(req)) return says('Summary of turns 1-3.');
        if (req.turnIndex >= 3 && !JSON.stringify(req.body).includes('conversation_summary')) return { error: contextLengthError(req.protocol) };
        return says(`Answer ${req.lastUserText}`);
      },
      { preset },
    );
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
      engine.send({ text: q });
      await settled(engine);
    }
    const s = engine.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.error).toBeNull();
    expect(lastMsg(s).parts.filter((p) => p.type === 'text')).toEqual([{ type: 'text', text: expect.stringContaining('Answer') }]);
    expect(s.thread.compactions).toHaveLength(1);
    expect(s.thread.compactions![0].throughMessageId).toBe(s.thread.messages[5].id);
    // 3 turns, the rejected request, the summary, the retry
    expect(posts(fetch)).toHaveLength(6);
  });
});

describe('tier 3 fallbacks', () => {
  it('an outline stands in when the summary fails, and the error shows when the retry fails too', async () => {
    let n = 0;
    const { engine, fetch } = setup((req) => {
      if (isSummary(req)) return { error: { status: 400, body: { error: { message: 'no summaries today' } } } };
      if (req.turnIndex >= 2 && n++ < 1) return { error: contextLengthError('openai') };
      return says(`Answer ${req.lastUserText}`);
    });
    for (const q of ['Q1', 'Q2', 'Q3']) {
      engine.send({ text: q });
      await settled(engine);
    }
    let s = engine.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.thread.compactions![0].summary).toContain('this outline of the earlier conversation');
    expect(s.thread.compactions![0].summary).toContain('- Q1');

    const always = setup((req) => (isSummary(req) ? says('Summary.') : req.lastUserText.endsWith('Q2') ? { error: contextLengthError('openai') } : says('first')));
    always.engine.send({ text: 'Q1' });
    await settled(always.engine);
    always.engine.send({ text: 'Q2' });
    s = await settled(always.engine);
    expect(s.status).toBe('error');
    expect(s.error!.message).toContain('too long');
    // the rejected request, the summary, the one retry
    expect(posts(always.fetch).length - 1).toBe(3);
    expect(fetch.calls.length).toBeGreaterThan(0);
  });
});

describe('tool deferral', () => {
  const many = [
    tool('data.read_log', 'Reads log samples of a well.', { core: true }),
    tool('view.color_by', 'Colours the well path by a log such as GR or resistivity.', { kind: 'write', execute: () => ({ ok: true, coloured: true }) }),
    tool('data.production', 'Reads monthly production history.'),
    tool('camera.fly_to', 'Moves the camera to a depth.'),
  ];

  it('offers the core tools and find_tools in a small window; found tools stay offered', async () => {
    const offered: string[][] = [];
    const systems: string[] = [];
    let found: unknown;
    const { engine } = setup(
      (req) => {
        offered.push(req.toolNames);
        systems.push(req.system);
        if (req.lastUserText.endsWith('Colour by GR')) {
          if (req.stepIndex === 0) return { toolCalls: [{ name: 'find_tools', args: { query: 'colour well by log' } }] };
          if (req.stepIndex === 1) {
            found = req.toolResults[0]?.content;
            return { toolCalls: [{ name: 'view__color_by', args: { mode: 'gr' } }] };
          }
          return says('Coloured.');
        }
        return says('Hi.');
      },
      { tools: many, config: { contextWindow: 16_000 } },
    );
    engine.updateSettings({ autonomy: 'auto' });
    engine.send({ text: 'Colour by GR' });
    let s = await settled(engine);
    expect(offered[0].sort()).toEqual(['data__read_log', 'find_tools', 'query_dataset', 'render_ui']);
    expect(systems[0]).toContain('find_tools');
    expect(found).toMatchObject({ tools: [{ name: 'view__color_by', description: 'Colours the well path by a log such as GR or resistivity.' }] });
    expect(offered[1]).toContain('view__color_by');
    expect(s.thread.messages.at(-1)!.parts.filter((p): p is ToolCallPart => p.type === 'tool-call').map((p) => [p.name, p.state])).toEqual([
      ['find_tools', 'done'],
      ['view.color_by', 'done'],
    ]);
    expect(s.thread.enabledTools).toEqual(['view.color_by']);
    expect(s.thread.toolMode).toEqual({ connection: 'p1|gpt-mock', deferred: true });
    engine.send({ text: 'Hello' });
    s = await settled(engine);
    expect(offered.at(-1)).toContain('view__color_by');
    expect(offered.at(-1)).not.toContain('data__production');
    expect(new Set(systems).size).toBe(1);
  });

  it('offers everything in a large window', async () => {
    let names: string[] = [];
    let system = '';
    const { engine } = setup(
      (req) => {
        names = req.toolNames;
        system = req.system;
        return says('ok');
      },
      { tools: many },
    );
    engine.send({ text: 'Hi' });
    await settled(engine);
    expect(names).toContain('camera__fly_to');
    expect(names).not.toContain('find_tools');
    expect(system).not.toContain('find_tools');
  });
});

describe('retries, calibration, the model list, compose and attachments', () => {
  it('retries transient errors up to three times with exponential backoff', async () => {
    const waits: number[] = [];
    let n = 0;
    const { engine, fetch } = setup(() => (n++ < 3 ? { error: { status: 503, body: { error: { message: 'busy' } } } } : says('Recovered.')), {
      sleep: async (ms) => void waits.push(ms),
    });
    engine.send({ text: 'Hi' });
    const s = await settled(engine);
    expect(s.status).toBe('ready');
    expect(fetch.calls).toHaveLength(4);
    expect(waits).toHaveLength(3);
    [1000, 2000, 4000].forEach((base, i) => {
      expect(waits[i]).toBeGreaterThanOrEqual(base * 0.8);
      expect(waits[i]).toBeLessThanOrEqual(base * 1.2);
    });

    const failing = setup(() => ({ error: { status: 429, body: {}, headers: { 'retry-after': '3' } } }), { sleep: async (ms) => void waits.push(ms) });
    waits.length = 0;
    failing.engine.send({ text: 'Hi' });
    const f = await settled(failing.engine);
    expect(f.status).toBe('error');
    expect(failing.fetch.calls).toHaveLength(4);
    expect(waits).toEqual([3000, 3000, 3000]);

    const tooLong = setup(() => ({ error: { status: 429, body: {}, headers: { 'retry-after': '60' } } }));
    tooLong.engine.send({ text: 'Hi' });
    await settled(tooLong.engine);
    expect(tooLong.fetch.calls).toHaveLength(1);
  });

  it('stop() during a backoff ends the turn at once', async () => {
    const { engine, fetch } = setup(() => ({ error: { status: 503 } }), {
      sleep: (_ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    engine.send({ text: 'Hi' });
    await waitFor(engine, () => fetch.calls.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    engine.stop();
    const s = engine.getSnapshot();
    expect(s.status).toBe('ready');
    expect(lastMsg(s).status).toBe('stopped');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch.calls).toHaveLength(1);
  });

  it('calibrates the estimate by the reported input tokens, per thread', async () => {
    let factor = 1;
    const { engine } = setup(() => ({ text: 'ok' }));
    const plain = setup((req) => ({ text: 'ok', usage: { input: Math.round(req.inputTokens * factor) } }));
    engine.send({ text: 'Hi' });
    const a = await settled(engine);
    factor = 2;
    plain.engine.send({ text: 'Hi' });
    const b = await settled(plain.engine);
    // the mock counts 4 characters per token, the kit 3.6: the same request, a ratio twice as high
    expect(b.context!.used / a.context!.used).toBeGreaterThan(1.8);
    expect(b.context!.used / a.context!.used).toBeLessThan(2.2);
    plain.engine.newThread();
    expect(plain.engine.getSnapshot().context!.used).toBeLessThan(b.context!.used);
  });

  it('takes the context window from the model list once it was fetched', async () => {
    const { engine } = setup(() => says('ok'), { preset: 'anthropic', mock: { models: ['claude-sonnet-5'], modelWindows: { 'claude-sonnet-5': 64_000 } } });
    expect(engine.getSnapshot().context!.window).toBe(200_000);
    const provider = engine.getSnapshot().provider!;
    const models = await engine.listModels(provider);
    expect(models[0]).toMatchObject({ id: 'claude-sonnet-5', contextWindow: 64_000 });
    engine.updateSettings({});
    expect(engine.getSnapshot().context!.window).toBe(64_000);
    engine.saveProvider({ ...provider, contextWindow: 32_000 });
    expect(engine.getSnapshot().context!.window).toBe(32_000);
  });

  it('compose() hands the composer a draft', () => {
    const { engine } = setup(() => says('ok'));
    expect(engine.getSnapshot().draft).toBeNull();
    engine.compose('Ask about Hugin');
    expect(engine.getSnapshot().draft).toEqual({ id: 1, text: 'Ask about Hugin' });
    engine.compose('Ask about Hugin');
    expect(engine.getSnapshot().draft).toEqual({ id: 2, text: 'Ask about Hugin' });
  });

  it.each(['openai', 'anthropic', 'gemini'] as const)('sends a message with only an image over %s', async (preset) => {
    const { engine, fetch } = setup(() => says('A well.'), { preset, config: { vision: true } });
    engine.send({ text: '', images: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
    const s = await settled(engine);
    expect(s.status).toBe('ready');
    expect(s.thread.title).toBe('New chat');
    const body = JSON.stringify(posts(fetch)[0].body);
    expect(body).toContain('iVBORw0KGgo=');
    expect(body).toContain('app_state');
  });
});
