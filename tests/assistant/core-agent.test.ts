import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHost, AssistantSnapshot, AssistantTool, ProviderConfig, ToolCallPart, UIPart } from '../../src/assistant/core/types';

// the generated-UI module is another agent's: a small stand-in keeps these tests about the engine
vi.mock('../../src/assistant/a2ui', () => ({
  A2UISurface: () => null,
  a2uiPromptGuide: () => 'A2UI GUIDE: call render_ui.',
  renderUiTool: (): AssistantTool => ({
    name: 'render_ui',
    kind: 'read',
    description: 'Render an interface.',
    parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } } } },
    execute: (args) => ({ ok: Array.isArray((args as { messages?: unknown }).messages) }),
  }),
  extractA2UIFences: (text: string) => {
    const blocks: unknown[][] = [];
    const cleaned = text.replace(/```a2ui\n([\s\S]*?)```/g, (_m, body: string) => {
      blocks.push(JSON.parse(body) as unknown[]);
      return '';
    });
    return { text: cleaned, blocks };
  },
}));

const { createAssistant } = await import('../../src/assistant/core/controller');
const { createMockFetch } = await import('../../src/assistant/testing/mockLLM');
const { configFromPreset, presetById } = await import('../../src/assistant/providers/presets');
type Engine = ReturnType<typeof createAssistant>;
type Script = Parameters<typeof createMockFetch>[0];

const engines: Engine[] = [];
afterEach(() => {
  engines.splice(0).forEach((e) => e.dispose());
});

interface Ran {
  colorBy: unknown[];
  deleted: number;
}

function makeHost(ran: Ran, extra: Partial<AssistantHost> = {}): AssistantHost {
  return {
    appName: 'BoreWalk',
    storageKey: `test-${Math.random()}`,
    instructions: () => 'BoreWalk shows wells in 3D.',
    snapshot: () => ({ well: 'F-11 A' }),
    tools: () => [
      {
        name: 'data.read_log',
        kind: 'read',
        description: 'Reads a log.',
        parameters: { type: 'object', properties: { well: { type: 'string' } } },
        execute: (args) => ({
          content: { well: (args as { well: string }).well, samples: 3 },
          datasets: [{ title: 'GR', columns: [{ key: 'md', unit: 'm' }, { key: 'gr', unit: 'API' }], rows: [{ md: 1, gr: 50 }, { md: 2, gr: 80 }, { md: 3, gr: 65 }] }],
        }),
      },
      {
        name: 'view.color_by',
        description: 'Colours the well.',
        parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
        execute: (args) => {
          ran.colorBy.push(args);
          return { ok: true };
        },
      },
      {
        name: 'data.delete_all',
        description: 'Deletes everything.',
        needsApproval: true,
        parameters: { type: 'object', properties: {} },
        execute: () => {
          ran.deleted++;
          return { ok: true };
        },
      },
    ],
    ...extra,
  };
}

const PROVIDERS: Record<'openai' | 'anthropic' | 'gemini', Partial<ProviderConfig>> = {
  openai: { baseUrl: 'https://mock.test/v1', model: 'gpt-mock' },
  anthropic: { baseUrl: 'https://mock.test', model: 'claude-sonnet-5' },
  gemini: { baseUrl: 'https://mock.test/v1beta', model: 'gemini-3.5-flash' },
};

function setup(script: Script, opts: { preset?: keyof typeof PROVIDERS; delayMs?: number; host?: Partial<AssistantHost>; settings?: Partial<AssistantSnapshot['settings']> } = {}) {
  const ran: Ran = { colorBy: [], deleted: 0 };
  const fetch = createMockFetch(script, { delayMs: opts.delayMs, chunkSize: 5 });
  const engine = createAssistant(makeHost(ran, opts.host), { fetch, storage: 'memory', sleep: async () => {} });
  engines.push(engine);
  const preset = opts.preset ?? 'openai';
  engine.saveProvider(configFromPreset(presetById(preset)!, { id: 'p1', apiKey: 'key', ...PROVIDERS[preset] }));
  if (opts.settings) engine.updateSettings(opts.settings);
  return { engine, fetch, ran };
}

/** Resolves when the snapshot satisfies the predicate (checked on every publish). */
function waitFor(engine: Engine, pred: (s: AssistantSnapshot) => boolean, ms = 3000): Promise<AssistantSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = engine.getSnapshot();
      if (pred(s)) {
        clearTimeout(timer);
        unsub();
        resolve(s);
        return true;
      }
      return false;
    };
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out; status=${engine.getSnapshot().status} parts=${JSON.stringify(engine.getSnapshot().thread.messages.at(-1)?.parts).slice(0, 400)}`));
    }, ms);
    const unsub = engine.subscribe(() => void check());
    check();
  });
}
const settled = (e: Engine) => waitFor(e, (s) => (s.status === 'ready' || s.status === 'error') && s.thread.messages.at(-1)?.status !== 'streaming');
const lastMsg = (s: AssistantSnapshot) => s.thread.messages[s.thread.messages.length - 1];
const calls = (s: AssistantSnapshot) => lastMsg(s).parts.filter((p): p is ToolCallPart => p.type === 'tool-call');

describe.each(['openai', 'anthropic', 'gemini'] as const)('agent loop over %s', (preset) => {
  it('streams a text answer', async () => {
    const { engine } = setup(() => ({ reasoning: 'Easy one.', text: 'Hello from the mock — “ok”.' }), { preset });
    engine.send({ text: 'Say hello to the whole team please' });
    expect(engine.getSnapshot().status).toBe('submitted');
    const s = await settled(engine);
    expect(s.status).toBe('ready');
    expect(s.thread.title).toBe('Say hello to the whole team please');
    const m = lastMsg(s);
    expect(m).toMatchObject({ role: 'assistant', status: 'done', finishReason: 'stop', provider: preset, model: PROVIDERS[preset].model });
    expect(m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).toBe('Hello from the mock — “ok”.');
    const reasoning = m.parts.find((p) => p.type === 'reasoning');
    expect(reasoning).toMatchObject({ text: 'Easy one.' });
    expect((reasoning as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
    expect(m.usage?.inputTokens).toBe(100);
    expect(s.threads.map((t) => t.id)).toContain(s.thread.id);
  });

  it('runs a tool, registers its dataset, and answers with the result', async () => {
    const seen: { names: string[]; results: unknown[] } = { names: [], results: [] };
    const { engine } = setup(
      (req) => {
        if (req.stepIndex === 0) {
          seen.names = req.toolNames;
          return { text: 'Reading.', toolCalls: [{ name: 'data__read_log', args: { well: 'F-11 A' } }] };
        }
        seen.results = req.toolResults.map((r) => r.content);
        return { text: 'Mean GR is 65 API (ds_1).' };
      },
      { preset },
    );
    engine.send({ text: 'Summarise GR', context: [{ id: 'w', label: 'F-11 A', data: { well: 'F-11 A' } }] });
    const s = await settled(engine);
    expect(seen.names).toEqual(expect.arrayContaining(['data__read_log', 'view__color_by', 'query_dataset', 'render_ui']));
    const [call] = calls(s);
    expect(call).toMatchObject({ name: 'data.read_log', state: 'done', args: { well: 'F-11 A' }, datasets: ['ds_1'] });
    expect(s.thread.datasets.ds_1.rows).toHaveLength(3);
    const result = seen.results[0] as { well: string; datasets: { id: string; rowCount: number; stats: Record<string, { mean: number }> }[] };
    expect(result.well).toBe('F-11 A');
    expect(result.datasets[0]).toMatchObject({ id: 'ds_1', rowCount: 3 });
    expect(result.datasets[0].stats.gr.mean).toBe(65);
    expect(lastMsg(s).parts.at(-1)).toEqual({ type: 'text', text: 'Mean GR is 65 API (ds_1).' });
    expect(lastMsg(s).status).toBe('done');
  });
});

describe('approvals', () => {
  const colorScript: Script = (req) =>
    req.stepIndex === 0 ? { toolCalls: [{ name: 'view__color_by', args: { mode: 'gr' } }] } : { text: `Result: ${JSON.stringify(req.toolResults[0]?.content)}` };

  it('ask mode: a write call waits, runs once approved', async () => {
    const { engine, ran } = setup(colorScript);
    engine.send({ text: 'Colour by GR' });
    const waiting = await waitFor(engine, (s) => s.pendingApprovals.length === 1);
    expect(waiting.pendingApprovals[0]).toMatchObject({ name: 'view.color_by', state: 'awaiting-approval', args: { mode: 'gr' } });
    expect(waiting.status).toBe('streaming');
    expect(ran.colorBy).toEqual([]);
    engine.approve(waiting.pendingApprovals[0].id, true);
    const s = await settled(engine);
    expect(ran.colorBy).toEqual([{ mode: 'gr' }]);
    expect(calls(s)[0].state).toBe('done');
    expect(s.pendingApprovals).toEqual([]);
  });

  it('a denied call reports the refusal to the model', async () => {
    const { engine, ran } = setup(colorScript);
    engine.send({ text: 'Colour by GR' });
    const waiting = await waitFor(engine, (s) => s.pendingApprovals.length === 1);
    engine.approve(waiting.pendingApprovals[0].id, false);
    const s = await settled(engine);
    expect(ran.colorBy).toEqual([]);
    expect(calls(s)[0]).toMatchObject({ state: 'denied', result: { denied: true, message: 'The person declined this action.' } });
    expect((lastMsg(s).parts.at(-1) as { text: string }).text).toContain('"denied":true');
  });

  it('"always" approves the tool for the rest of the thread', async () => {
    const { engine, ran } = setup(colorScript);
    engine.send({ text: 'Colour by GR' });
    const waiting = await waitFor(engine, (s) => s.pendingApprovals.length === 1);
    engine.approve(waiting.pendingApprovals[0].id, true, { always: true });
    await settled(engine);
    engine.send({ text: 'Again' });
    await settled(engine);
    expect(ran.colorBy).toHaveLength(2);
  });

  it('auto mode runs ordinary writes but still asks for needsApproval tools; read mode offers no writes', async () => {
    const { engine, ran } = setup(
      (req) => (req.stepIndex === 0 ? { toolCalls: [{ name: 'view__color_by', args: { mode: 'res' } }, { name: 'data__delete_all', args: {} }] } : { text: 'ok' }),
      { settings: { autonomy: 'auto' } },
    );
    engine.send({ text: 'Do both' });
    const waiting = await waitFor(engine, (s) => s.pendingApprovals.length === 1);
    expect(waiting.pendingApprovals[0].name).toBe('data.delete_all');
    // the call before it in order already ran
    await waitFor(engine, () => ran.colorBy.length === 1);
    engine.approve(waiting.pendingApprovals[0].id, true);
    await settled(engine);
    expect(ran.deleted).toBe(1);

    let offered: string[] = [];
    const read = setup((req) => {
      offered = req.toolNames;
      return { text: 'I can only look.' };
    }, { settings: { autonomy: 'read' } });
    read.engine.send({ text: 'Colour it' });
    await settled(read.engine);
    expect(offered).toEqual(expect.arrayContaining(['data__read_log', 'query_dataset', 'render_ui']));
    expect(offered).not.toContain('view__color_by');
    expect(offered).not.toContain('data__delete_all');
  });
});

describe('stopping, errors and limits', () => {
  it('stop() mid-stream keeps the partial text, marks the message stopped, and ignores late chunks', async () => {
    const { engine } = setup(() => ({ text: 'word '.repeat(400) }), { delayMs: 2 });
    engine.send({ text: 'Talk a lot' });
    await waitFor(engine, (s) => s.status === 'streaming' && lastMsg(s).parts.some((p) => p.type === 'text'));
    engine.stop();
    const s = engine.getSnapshot();
    expect(s.status).toBe('ready');
    expect(lastMsg(s).status).toBe('stopped');
    const partial = (lastMsg(s).parts.find((p) => p.type === 'text') as { text: string }).text;
    await new Promise((r) => setTimeout(r, 60));
    const later = engine.getSnapshot();
    expect(lastMsg(later).status).toBe('stopped');
    expect((lastMsg(later).parts.find((p) => p.type === 'text') as { text: string }).text.length).toBeLessThan('word '.repeat(400).length);
    expect(partial.length).toBeGreaterThan(0);
  });

  it('stopping while a call awaits approval cancels it', async () => {
    const { engine, ran } = setup(() => ({ toolCalls: [{ name: 'view__color_by', args: { mode: 'gr' } }] }));
    engine.send({ text: 'Colour' });
    const waiting = await waitFor(engine, (s) => s.pendingApprovals.length === 1);
    engine.stop();
    const s = engine.getSnapshot();
    expect(calls(s)[0].state).toBe('cancelled');
    expect(s.pendingApprovals).toEqual([]);
    engine.approve(waiting.pendingApprovals[0].id, true); // too late: nothing happens
    await new Promise((r) => setTimeout(r, 30));
    expect(ran.colorBy).toEqual([]);
  });

  it('switching threads stops the turn and never writes into the new thread', async () => {
    const { engine } = setup(() => ({ text: 'x'.repeat(300) }), { delayMs: 2 });
    engine.send({ text: 'First' });
    const first = engine.getSnapshot().thread.id;
    await waitFor(engine, (s) => s.status === 'streaming');
    engine.newThread();
    const fresh = engine.getSnapshot().thread;
    expect(fresh.id).not.toBe(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.getSnapshot().thread.messages).toEqual([]);
    engine.openThread(first);
    expect(lastMsg(engine.getSnapshot()).status).toBe('stopped');
  });

  it('a rejected key ends the turn with a config error in the transcript', async () => {
    const { engine } = setup(() => ({ error: { status: 401, body: { error: { message: 'Incorrect API key provided: key.' } } } }));
    engine.send({ text: 'Hi' });
    const s = await settled(engine);
    expect(s.status).toBe('error');
    expect(s.error).toMatchObject({ type: 'error', config: true });
    expect(s.error!.message).toContain('API key was rejected (401)');
    expect(lastMsg(s)).toMatchObject({ status: 'error', finishReason: 'error' });
    expect(lastMsg(s).parts.at(-1)).toEqual(s.error);
  });

  it('retries once on a transient error before any token, then succeeds', async () => {
    let n = 0;
    const { engine, fetch } = setup(() => (n++ === 0 ? { error: { status: 503, body: { error: { message: 'busy' } } } } : { text: 'Recovered.' }));
    engine.send({ text: 'Hi' });
    const s = await settled(engine);
    expect(s.status).toBe('ready');
    expect(fetch.calls).toHaveLength(2);
    expect(lastMsg(s).parts).toEqual([{ type: 'text', text: 'Recovered.' }]);
  });

  it('stops after maxSteps with a note', async () => {
    const { engine, fetch } = setup(() => ({ toolCalls: [{ name: 'data__read_log', args: { well: 'A' } }] }), { settings: { maxSteps: 3 } });
    engine.send({ text: 'Loop forever' });
    const s = await settled(engine);
    expect(fetch.calls).toHaveLength(3);
    expect(calls(s)).toHaveLength(3);
    expect(new Set(calls(s).map((c) => c.id)).size).toBe(3);
    expect(Object.keys(s.thread.datasets)).toEqual(['ds_1', 'ds_2', 'ds_3']);
    const note = lastMsg(s).parts.at(-1) as { type: string; text: string };
    expect(note.type).toBe('text');
    expect(note.text).toContain('after 3 steps');
    expect(lastMsg(s).status).toBe('done');
  });

  it('reports an unknown tool and a throwing tool back to the model', async () => {
    const results: unknown[] = [];
    const { engine } = setup(
      (req) => {
        if (req.stepIndex === 0) return { toolCalls: [{ name: 'no_such_tool', args: {} }, { name: 'query_dataset', args: { dataset: 'ds_42' } }] };
        results.push(...req.toolResults.map((r) => r.content));
        return { text: 'Sorry.' };
      },
    );
    engine.send({ text: 'Break things' });
    const s = await settled(engine);
    expect(calls(s).map((c) => c.state)).toEqual(['error', 'error']);
    expect(results[0]).toMatchObject({ error: expect.stringContaining('Unknown tool "no_such_tool"') });
    expect(results[1]).toMatchObject({ error: expect.stringContaining('Unknown dataset "ds_42"') });
  });

  it('without a provider, the message explains how to connect one', async () => {
    const engine = createAssistant(makeHost({ colorBy: [], deleted: 0 }), { storage: 'memory' });
    engines.push(engine);
    engine.send({ text: 'Hello?' });
    const s = engine.getSnapshot();
    expect(s.status).toBe('error');
    expect(s.error).toMatchObject({ config: true });
    expect(lastMsg(s).parts[0]).toMatchObject({ type: 'error', config: true });
  });
});

describe('generated interfaces', () => {
  const ui = [
    { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
    { version: 'v0.9', updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Text', text: 'Hi' }] } },
  ];

  it('a render_ui call adds a UIPart right after the call, with the messages from its arguments', async () => {
    const { engine } = setup((req) => (req.stepIndex === 0 ? { toolCalls: [{ name: 'render_ui', args: { messages: ui } }] } : { text: 'Shown above.' }), { delayMs: 1 });
    engine.send({ text: 'Show a card' });
    const s = await settled(engine);
    const parts = lastMsg(s).parts;
    const i = parts.findIndex((p) => p.type === 'tool-call');
    const call = parts[i] as ToolCallPart;
    expect(call).toMatchObject({ name: 'render_ui', state: 'done', result: { ok: true } });
    expect(parts[i + 1]).toEqual({ type: 'ui', id: call.id, toolCallId: call.id, messages: ui });
  });

  it('accepts an a2ui_json string too', async () => {
    const { engine } = setup((req) => (req.stepIndex === 0 ? { toolCalls: [{ name: 'render_ui', args: { a2ui_json: JSON.stringify(ui) } }] } : { text: 'ok' }));
    engine.send({ text: 'Show' });
    const s = await settled(engine);
    expect((lastMsg(s).parts.find((p) => p.type === 'ui') as UIPart).messages).toEqual(ui);
  });

  it('```a2ui fences in the answer become UIParts and leave the text clean', async () => {
    const text = `Here it is.\n\`\`\`a2ui\n${JSON.stringify(ui)}\n\`\`\`\nAnything else?`;
    const { engine } = setup(() => ({ text }));
    engine.send({ text: 'Show' });
    const s = await settled(engine);
    const m = lastMsg(s);
    expect(m.parts).toEqual([
      { type: 'text', text: 'Here it is.\n\nAnything else?' },
      { type: 'ui', id: `${m.id}:fence:0`, messages: ui },
    ]);
  });

  it('a UI action is sent as the next user turn', async () => {
    let got = '';
    const { engine } = setup((req) => {
      got = req.lastUserText;
      return { text: 'Going there.' };
    });
    engine.uiAction({ surfaceId: 's1', name: 'go_to_top', context: { md: 3050 }, label: 'Pressed “Go to top”' });
    const s = await settled(engine);
    expect(s.thread.messages[0].parts[0]).toMatchObject({ type: 'ui-event', name: 'go_to_top' });
    expect(got).toContain('<ui_event>');
    expect(got).toContain('"action":"go_to_top"');
    expect(got).toContain('"md":3050');
  });
});

describe('threads', () => {
  it('regenerate and editAndResend drop the tail and ask again', async () => {
    let n = 0;
    const { engine, fetch } = setup(() => ({ text: `answer ${++n}` }));
    engine.send({ text: 'Question one' });
    await settled(engine);
    engine.regenerate();
    let s = await settled(engine);
    expect(s.thread.messages).toHaveLength(2);
    expect(lastMsg(s).parts).toEqual([{ type: 'text', text: 'answer 2' }]);
    engine.editAndResend(s.thread.messages[0].id, 'Question two');
    s = await settled(engine);
    expect(s.thread.messages).toHaveLength(2);
    expect(s.thread.messages[0].parts).toEqual([{ type: 'text', text: 'Question two' }]);
    expect(s.thread.title).toBe('Question two');
    expect(fetch.calls).toHaveLength(3);
  });

  it('lists, renames, reopens and deletes threads; exports Markdown', async () => {
    const { engine } = setup((req) => (req.stepIndex === 0 ? { toolCalls: [{ name: 'data__read_log', args: { well: 'F-11 A' } }] } : { text: 'GR loaded.' }));
    await engine.ready;
    engine.send({ text: 'Load GR' });
    const a = (await settled(engine)).thread.id;
    engine.newThread();
    engine.send({ text: 'Second chat' });
    await settled(engine);
    let s = engine.getSnapshot();
    expect(s.threads.map((t) => t.title)).toEqual(['Second chat', 'Load GR']);
    engine.renameThread(a, 'Gamma ray');
    engine.openThread(a);
    s = await waitFor(engine, (x) => x.thread.id === a && x.thread.messages.length === 2);
    expect(s.thread.title).toBe('Gamma ray');
    const md = engine.exportMarkdown();
    expect(md).toContain('# Gamma ray');
    expect(md).toContain('## You');
    expect(md).toContain('- Ran `data.read_log` {"well":"F-11 A"}');
    expect(md).toContain('| md (m) | gr (API) |');
    expect(md).toContain('GR loaded.');
    engine.deleteThread(a);
    s = engine.getSnapshot();
    expect(s.threads.map((t) => t.id)).not.toContain(a);
    expect(s.thread.messages).toEqual([]);
  });

  it('manages providers and tests a connection', async () => {
    const { engine } = setup(() => ({ text: 'OK' }));
    const cfg = engine.getSnapshot().provider!;
    expect(await engine.testProvider(cfg)).toBe('OK');
    expect(await engine.listModels(cfg)).toEqual([{ id: 'mock-model' }]);
    engine.saveProvider({ ...cfg, id: 'p2', label: 'Second' });
    expect(engine.getSnapshot().settings.providers).toHaveLength(2);
    engine.removeProvider('p1');
    expect(engine.getSnapshot().provider?.id).toBe('p2');
    const bad = setup(() => ({ error: { status: 404, body: { error: { message: 'model not found' } } } }));
    await expect(bad.engine.testProvider(bad.engine.getSnapshot().provider!)).rejects.toMatchObject({ name: 'ProviderError', config: true });
  });
});
