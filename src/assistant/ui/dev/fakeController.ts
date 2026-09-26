/*
 * An in-memory `AssistantController` for the visual harness and demos: it
 * simulates streaming text, reasoning, tool calls (one waiting for
 * approval), a generated interface and errors, without any provider. Only
 * dev harnesses import it; nothing in the kit's production graph does.
 */
import { createElement } from 'react';
import { ActivityIcon, BookOpenIcon, ChartLineIcon, LayersIcon, MapPinIcon } from 'lucide-react';
import type {
  AssistantController,
  AssistantHost,
  AssistantSettings,
  AssistantSnapshot,
  AssistantTool,
  ChatMessage,
  ChatStatus,
  Compaction,
  ContextItem,
  ContextUsage,
  ErrorPart,
  ModelInfo,
  OutgoingMessage,
  Part,
  ProviderConfig,
  Thread,
  ToolCallPart,
  UIEventPart,
} from '../../core/types';

export type FakeScenario = 'empty' | 'onboarding' | 'conversation' | 'approval' | 'error' | 'compacted';

export interface FakeControllerOptions {
  scenario?: FakeScenario;
  host?: Partial<AssistantHost>;
  /** multiplies every simulated delay (0.2 = five times faster) */
  speed?: number;
}

const now = Date.now();
let seq = 0;
const uid = (p: string) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PROVIDERS: ProviderConfig[] = [
  { id: 'c_deepseek', presetId: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo-deepseek', model: 'deepseek-v4-flash', tools: true, vision: false, reasoning: 'medium' },
  { id: 'c_anthropic', presetId: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-demo', model: 'claude-sonnet-4-5', tools: true, vision: true, reasoning: 'low' },
  { id: 'c_openai', presetId: 'openai', label: 'OpenAI', kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo', model: 'gpt-5-mini', tools: true, vision: true },
  { id: 'c_ollama', presetId: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:14b', tools: true, vision: false },
];

const TOOLS: AssistantTool[] = [
  { name: 'wells.get_log', title: 'Read log curve', description: 'Reads samples of a log curve', parameters: { type: 'object' }, kind: 'read', execute: () => null },
  { name: 'wells.list_tops', title: 'List formation tops', description: 'Lists the tops of a well', parameters: { type: 'object' }, kind: 'read', execute: () => null },
  { name: 'view.color_by', description: 'Colours the wellbore tube by a curve', parameters: { type: 'object' }, execute: () => null },
  { name: 'camera.fly_to', title: 'Fly camera to', description: 'Moves the camera', parameters: { type: 'object' }, execute: () => null },
  { name: 'tops.delete', title: 'Delete formation top', description: 'Deletes an interpreted top', parameters: { type: 'object' }, needsApproval: true, execute: () => null },
];

const ICONS: Record<string, typeof ActivityIcon> = { log: ActivityIcon, layers: LayersIcon, chart: ChartLineIcon, pin: MapPinIcon, book: BookOpenIcon };

/** A believable host for the harness. */
export function fakeHost(overrides: Partial<AssistantHost> = {}): AssistantHost {
  let context: ContextItem[] = [
    { id: 'selection:formation:hugin', label: 'Hugin Fm.', description: 'Selected formation', data: { formation: 'Hugin' }, icon: 'layers' },
    { id: 'well:15/9-F-11 A', label: '15/9-F-11 A', description: 'Open well', data: { well: '15/9-F-11 A' }, icon: 'pin' },
  ];
  const listeners = new Set<() => void>();
  const host: AssistantHost & { setContext: (items: ContextItem[]) => void } = {
    appName: 'BoreWalk',
    instructions: () => 'You are the BoreWalk assistant.',
    tools: () => TOOLS,
    context: () => context,
    subscribeContext: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setContext: (items) => {
      context = items;
      listeners.forEach((l) => l());
    },
    suggestions: () => [
      { label: 'Summarise this well', description: 'Trajectory, casing and key tops of F-11 A', icon: 'book' },
      { label: 'Chart gamma ray across Hugin', description: 'Plot GR with the formation tops', icon: 'chart' },
      { label: 'Colour the tube by porosity', description: 'Operate the 3D view', icon: 'log' },
      { label: 'Which wells reach the Hugin?', description: 'Compare tops across the field', icon: 'layers' },
    ],
    captureView: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext('2d');
      if (g) {
        const grad = g.createLinearGradient(0, 0, 320, 200);
        grad.addColorStop(0, '#0b1d33');
        grad.addColorStop(1, '#3b2a5c');
        g.fillStyle = grad;
        g.fillRect(0, 0, 320, 200);
        g.strokeStyle = '#7fe3ff';
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(160, 0);
        g.bezierCurveTo(160, 90, 180, 140, 280, 180);
        g.stroke();
      }
      return { mediaType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] };
    },
    renderIcon: (name) => (ICONS[name] ? createElement(ICONS[name]) : null),
    onLink: (href) => console.info('[assistant] app link', href),
    ...overrides,
  };
  return host;
}

// ------------------------------------------------------------------ seeded transcripts

const ANSWER_MD = `### Gamma ray across the Hugin Fm.

The Hugin in **15/9-F-11 A** is a clean, *shallow-marine* sandstone: GR stays low through most of the interval, with two shaly breaks.

| Zone | Top (m MD) | Base (m MD) | GR mean (API) | Net/gross |
|---|---:|---:|---:|---:|
| Upper Hugin | 3 012.4 | 3 041.0 | 38.2 | 0.86 |
| Shale break | 3 041.0 | 3 046.5 | 96.7 | 0.12 |
| Lower Hugin | 3 046.5 | 3 098.8 | 41.9 | 0.81 |

- The **shale break** at ~3 041 m correlates with the flooding surface seen in F-1 C.
- Below 3 090 m GR rises again toward the ~~Skagerrak~~ Sleipner contact.
  - check the density-neutron crossover there
- [x] Loaded GR samples
- [ ] Compare with F-15 D

To reproduce the cut-off, use \`vsh = (gr - gr_min) / (gr_max - gr_min)\`:

\`\`\`python
import numpy as np

def vshale(gr, gr_min=30.0, gr_max=120.0):
    """Linear shale volume from gamma ray."""
    return np.clip((gr - gr_min) / (gr_max - gr_min), 0, 1)
\`\`\`

> Values are from the Volve open dataset; depths are measured depth from RKB.

[Fly to the top of Hugin](app://camera/fly?target=top:hugin) · source: https://www.equinor.com/energy/volve-data-sharing`;

const A2UI_SAMPLE: unknown[] = [
  { version: 'v0.9.1', createSurface: { surfaceId: 'gr_summary', catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' } },
  {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId: 'gr_summary',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'body', 'actions'] },
        { id: 'title', component: 'Text', text: 'Hugin Fm. · F-11 A', variant: 'h4' },
        { id: 'body', component: 'Text', text: 'Net pay 71.3 m · mean porosity 21 %' },
        { id: 'actions', component: 'Row', children: ['go'] },
        { id: 'go', component: 'Button', child: 'go_label', action: { event: { name: 'show_in_3d' } } },
        { id: 'go_label', component: 'Text', text: 'Show in 3D' },
      ],
    },
  },
];

const SUMMARY_MD = `**Goal.** Review the Hugin Fm. in **15/9-F-11 A**: gamma ray by zone, then show it in 3D.

- Tops: Hugin 3 012.4 m MD, Sleipner 3 098.8 m MD (operator picks).
- GR zones: Upper Hugin 38.2 API (N/G 0.86), shale break 3 041–3 046.5 m (96.7 API), Lower Hugin 41.9 API (N/G 0.81). Dataset \`ds_1\` holds 1 001 GR samples.
- The tube is coloured by GR and the camera sits at the top of the Hugin; a seismic layer does not exist in this project.
- Open question: compare with F-15 D.`;

/** A compaction of the seeded conversation's first four messages. */
const SEEDED_COMPACTION: Compaction = { id: 'cmp_1', throughMessageId: 'm4', summary: SUMMARY_MD, createdAt: now - 10 * 60_000, auto: true, messages: 4, tokensBefore: 48_210, tokensAfter: 2_980 };

function tool(name: string, args: unknown, state: ToolCallPart['state'], extra: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: 'tool-call', id: uid('call'), name, args, argsText: JSON.stringify(args), state, startedAt: now - 60_000, endedAt: state === 'done' || state === 'error' ? now - 60_000 + 640 : undefined, ...extra };
}

function seedConversation(scenario: FakeScenario): ChatMessage[] {
  const t = (m: number) => now - m * 60_000;
  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      createdAt: t(14),
      parts: [
        { type: 'context', items: fakeHost().context?.() ?? [] },
        { type: 'text', text: 'How does the gamma ray look across the Hugin in F-11 A? Chart it and give me the zones.' },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: t(14),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'done',
      usage: { inputTokens: 4180, outputTokens: 612 },
      parts: [
        { type: 'reasoning', text: 'The user wants GR over the Hugin interval in F-11 A. I should list the tops to get the interval, read the GR curve between them, then summarise zones and render a chart bound to the dataset.', durationMs: 12_400 },
        tool('wells.list_tops', { well: '15/9-F-11 A' }, 'done', { result: { tops: [{ name: 'Hugin Fm.', md: 3012.4 }, { name: 'Sleipner Fm.', md: 3098.8 }] } }),
        tool('wells.get_log', { well: '15/9-F-11 A', curve: 'GR', from_md: 3000, to_md: 3100 }, 'done', { result: { dataset: 'ds_1', rows: 1001 }, datasets: ['ds_1'], endedAt: now - 60_000 + 1320 }),
        tool('render_ui', { messages: '…' }, 'done'),
        { type: 'ui', id: 'ui_1', messages: A2UI_SAMPLE },
        { type: 'text', text: ANSWER_MD },
      ],
    },
    { id: 'm3', role: 'user', createdAt: t(12), parts: [{ type: 'ui-event', surfaceId: 'gr_summary', name: 'show_in_3d', label: 'Show in 3D' }] },
    {
      id: 'm4',
      role: 'assistant',
      createdAt: t(12),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'done',
      usage: { inputTokens: 5210, outputTokens: 88 },
      parts: [
        tool('view.color_by', { curve: 'GR', palette: 'viridis' }, 'done', { result: { ok: true } }),
        tool('camera.fly_to', { target: 'top:hugin', well: '15/9-F-11 A' }, 'done', { result: { ok: true } }),
        tool('view.show_layer', { layer: 'seismic' }, 'error', { error: 'Unknown layer "seismic": available layers are tops, casing, logs.' }),
        { type: 'text', text: 'Done — the tube is coloured by **GR** and the camera is at the top of the Hugin. The seismic layer is not available in this project.' },
      ],
    },
    {
      id: 'm5',
      role: 'user',
      createdAt: t(8),
      parts: [
        { type: 'image', mediaType: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1d33"/><stop offset="1" stop-color="#3b2a5c"/></linearGradient></defs><rect width="160" height="100" fill="url(#g)"/><path d="M80 0 C80 45 90 70 140 90" stroke="#7fe3ff" stroke-width="3" fill="none"/></svg>'), name: 'view.png' },
        { type: 'file', name: 'F-11A_core_plugs.csv', mediaType: 'text/csv', text: 'md,phi,k\n3015.2,0.23,420\n' },
        { type: 'text', text: 'Here is the view and the core plugs. Do the plugs agree with the log porosity?' },
      ],
    },
    {
      id: 'm6',
      role: 'assistant',
      createdAt: t(8),
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      status: 'done',
      usage: { inputTokens: 9120, outputTokens: 240 },
      parts: [
        { type: 'reasoning', text: 'Compare plug porosity with PHIE at the same depths.', durationMs: 3200 },
        { type: 'text', text: 'Mostly yes: the plugs read **1–2 p.u. higher** than PHIE in the upper Hugin, which is typical of unconfined plug measurements. Below 3 046 m they agree within 1 p.u.' },
      ],
    },
  ];
  if (scenario === 'approval') {
    messages.push(
      { id: 'm7', role: 'user', createdAt: t(2), parts: [{ type: 'text', text: 'Delete the interpreted top "Hugin base (JK)" and recompute net pay.' }] },
      {
        id: 'm8',
        role: 'assistant',
        createdAt: t(2),
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'streaming',
        parts: [
          { type: 'reasoning', text: 'Deleting a top changes the person’s interpretation: it needs approval.', durationMs: 2100 },
          { type: 'text', text: 'I’ll remove that top, then recompute net pay over the new interval.' },
          tool('tops.delete', { well: '15/9-F-11 A', top: 'Hugin base (JK)', interpreter: 'JK' }, 'awaiting-approval', { endedAt: undefined }),
        ],
      },
    );
  }
  if (scenario === 'error') {
    messages.push(
      { id: 'm7', role: 'user', createdAt: t(2), parts: [{ type: 'text', text: 'Now compare with all the other wells.' }] },
      {
        id: 'm8',
        role: 'assistant',
        createdAt: t(2),
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'error',
        parts: [
          tool('wells.list_tops', { well: '*' }, 'done', { result: { wells: 24 } }),
          { type: 'error', message: 'The provider rejected the key (401 Unauthorized).', detail: 'HTTP 401\n{"error":{"message":"Authentication Fails, Your api key: ****demo is invalid","type":"authentication_error"}}', config: true },
        ],
      },
    );
  }
  return messages;
}

// ------------------------------------------------------------------ controller

/** An in-memory controller: see the file comment. */
export function createFakeController(options: FakeControllerOptions = {}): AssistantController & { hostHandle: AssistantHost & { setContext?: (items: ContextItem[]) => void } } {
  const scenario = options.scenario ?? 'conversation';
  const speed = options.speed ?? 1;
  const host = fakeHost(options.host);
  const listeners = new Set<() => void>();

  const seeded = scenario === 'conversation' || scenario === 'approval' || scenario === 'error' || scenario === 'compacted';
  let threads: Thread[] = [
    {
      id: 't_main',
      title: seeded ? 'Gamma ray across the Hugin' : 'New chat',
      createdAt: now - 900_000,
      updatedAt: now - 60_000,
      messages: seeded ? seedConversation(scenario) : [],
      datasets: {},
      ...(scenario === 'compacted' ? { compactions: [SEEDED_COMPACTION] } : {}),
    },
    ...(seeded
      ? [
          { id: 't_2', title: 'Casing design of F-1 C', createdAt: now - 3 * 3_600_000, updatedAt: now - 3 * 3_600_000, messages: [], datasets: {} },
          { id: 't_3', title: 'Production decline, F-14', createdAt: now - 26 * 3_600_000, updatedAt: now - 26 * 3_600_000, messages: [], datasets: {} },
          { id: 't_4', title: 'Anti-collision check F-15 D vs F-11 A', createdAt: now - 4 * 86_400_000, updatedAt: now - 4 * 86_400_000, messages: [], datasets: {} },
        ]
      : []),
  ];
  let activeId = 't_main';
  let status: ChatStatus = scenario === 'approval' ? 'streaming' : 'ready';
  let error: ErrorPart | null = null;
  let settings: AssistantSettings = {
    providers: scenario === 'onboarding' ? [] : PROVIDERS,
    activeProviderId: scenario === 'onboarding' ? null : 'c_deepseek',
    autonomy: 'ask',
    rememberKeys: true,
    maxSteps: 12,
    showReasoning: true,
  };
  let turn = 0;
  // estimated tokens of the next request, and whether a summary is being written
  let used = scenario === 'compacted' ? 99_840 : seeded ? 21_500 : 3_200;
  let compacting = false;
  let draft: AssistantSnapshot['draft'] = null;
  let approvalWaiter: ((approved: boolean) => void) | null = null;
  const alwaysAllowed = new Set<string>();

  const active = () => threads.find((t) => t.id === activeId) ?? threads[0];
  const provider = () => settings.providers.find((p) => p.id === settings.activeProviderId) ?? null;
  const contextWindow = () => provider()?.contextWindow ?? 128_000;
  const contextUsage = (): ContextUsage | null => (provider() ? { used, window: contextWindow(), compacting } : null);

  let snapshot: AssistantSnapshot;
  const build = (): AssistantSnapshot => {
    const thread = active();
    const pendingApprovals = thread.messages.flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === 'tool-call' && p.state === 'awaiting-approval'));
    return {
      thread,
      threads: [...threads].sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })),
      status,
      pendingApprovals,
      settings,
      provider: provider(),
      error,
      context: contextUsage(),
      draft,
    };
  };
  snapshot = build();
  let frame = 0;
  const emit = () => {
    snapshot = build();
    if (frame) return;
    const flush = () => {
      frame = 0;
      listeners.forEach((l) => l());
    };
    frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (setTimeout(flush, 16) as unknown as number);
  };

  const setThread = (fn: (t: Thread) => Thread) => {
    threads = threads.map((t) => (t.id === activeId ? fn(t) : t));
  };
  const setMessages = (fn: (messages: ChatMessage[]) => ChatMessage[]) => setThread((t) => ({ ...t, messages: fn(t.messages), updatedAt: Date.now() }));
  const patchMessage = (id: string, fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  const patchLastPart = (id: string, fn: (p: Part) => Part) => patchMessage(id, (m) => ({ ...m, parts: [...m.parts.slice(0, -1), fn(m.parts[m.parts.length - 1])] }));
  const addPart = (id: string, part: Part) => patchMessage(id, (m) => ({ ...m, parts: [...m.parts, part] }));
  const patchTool = (msgId: string, callId: string, fn: (p: ToolCallPart) => ToolCallPart) =>
    patchMessage(msgId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === 'tool-call' && p.id === callId ? fn(p) : p)) }));

  const sleep = (ms: number, token: number) =>
    new Promise<boolean>((resolve) => setTimeout(() => resolve(token === turn), ms * speed));

  async function streamText(msgId: string, text: string, token: number, kind: 'text' | 'reasoning') {
    addPart(msgId, kind === 'text' ? { type: 'text', text: '' } : { type: 'reasoning', text: '' });
    emit();
    const words = text.split(/(?<=\s)/);
    for (let i = 0; i < words.length; i += 3) {
      if (!(await sleep(28, token))) return false;
      const chunk = words.slice(i, i + 3).join('');
      patchLastPart(msgId, (p) => (p.type === 'text' || p.type === 'reasoning' ? { ...p, text: p.text + chunk } : p));
      if (status !== 'streaming') status = 'streaming';
      emit();
    }
    return true;
  }

  async function runTool(msgId: string, name: string, args: unknown, token: number, result: unknown, needsApproval = false): Promise<boolean> {
    const id = uid('call');
    const gated = needsApproval && settings.autonomy !== 'auto' && !alwaysAllowed.has(name);
    addPart(msgId, { type: 'tool-call', id, name, args, argsText: JSON.stringify(args), state: gated ? 'awaiting-approval' : 'running', startedAt: Date.now() });
    emit();
    if (gated) {
      const approved = await new Promise<boolean>((resolve) => (approvalWaiter = resolve));
      approvalWaiter = null;
      if (token !== turn) return false;
      if (!approved) {
        patchTool(msgId, id, (p) => ({ ...p, state: 'denied', endedAt: Date.now() }));
        emit();
        return false;
      }
      patchTool(msgId, id, (p) => ({ ...p, state: 'running', startedAt: Date.now() }));
      emit();
    }
    if (!(await sleep(650, token))) return false;
    patchTool(msgId, id, (p) => ({ ...p, state: 'done', result, endedAt: Date.now() }));
    emit();
    return true;
  }

  /** Summarises everything but the last turn (the last two messages), as the kit does with more care. */
  async function summarise(auto: boolean, token?: number): Promise<boolean> {
    const ms = active().messages;
    const through = ms.length - 3;
    const already = active().compactions?.at(-1);
    const from = already ? ms.findIndex((m) => m.id === already.throughMessageId) + 1 : 0;
    if (through < from || through < 0) return true;
    compacting = true;
    emit();
    await new Promise((r) => setTimeout(r, 1600 * speed));
    compacting = false;
    if (token !== undefined && token !== turn) return false;
    const before = used;
    used = Math.round(contextWindow() * 0.14);
    const c: Compaction = { id: uid('cmp'), throughMessageId: ms[through].id, summary: SUMMARY_MD, createdAt: Date.now(), auto, messages: through - from + 1, tokensBefore: before, tokensAfter: 3_050 };
    setThread((t) => ({ ...t, compactions: [...(t.compactions ?? []), c] }));
    emit();
    return true;
  }

  async function runTurn(prompt: string) {
    const token = ++turn;
    error = null;
    status = 'submitted';
    const conf = provider();
    const msgId = uid('msg');
    setMessages((ms) => [...ms, { id: msgId, role: 'assistant', parts: [], createdAt: Date.now(), status: 'streaming', provider: conf?.presetId, model: conf?.model }]);
    emit();
    // past 85 % of the window the conversation is summarised before the model is asked
    if (used / contextWindow() > 0.85 && !(await summarise(true, token))) return;
    if (!(await sleep(900, token))) return;
    if (/error|fail/i.test(prompt)) {
      addPart(msgId, { type: 'error', message: 'The provider is overloaded (529). Try again in a moment.', detail: 'HTTP 529\n{"type":"overloaded_error"}', retryable: true });
      error = { type: 'error', message: 'The provider is overloaded (529).', retryable: true };
      patchMessage(msgId, (m) => ({ ...m, status: 'error' }));
      status = 'error';
      emit();
      return;
    }
    const start = Date.now();
    if (!(await streamText(msgId, 'The person asks about the open well. I should read the relevant curve first, then answer with the numbers and offer to chart them.', token, 'reasoning'))) return;
    patchLastPart(msgId, (p) => (p.type === 'reasoning' ? { ...p, durationMs: Date.now() - start } : p));
    if (!(await runTool(msgId, 'wells.get_log', { well: '15/9-F-11 A', curve: 'GR', from_md: 3000, to_md: 3100 }, token, { dataset: 'ds_2', rows: 1001 }))) return;
    if (/delete|remove/i.test(prompt)) {
      if (!(await streamText(msgId, 'I’ll remove that top, then recompute net pay.', token, 'text'))) return;
      const ok = await runTool(msgId, 'tops.delete', { well: '15/9-F-11 A', top: 'Hugin base (JK)' }, token, { deleted: 1 }, true);
      if (token !== turn) return;
      if (!(await streamText(msgId, ok ? '\n\nDone: the top is deleted and net pay is now **74.1 m**.' : '\n\nUnderstood, I left the top in place.', token, 'text'))) return;
    } else if (!(await streamText(msgId, ANSWER_MD, token, 'text'))) return;
    patchMessage(msgId, (m) => ({ ...m, status: 'done', finishReason: 'stop', usage: { inputTokens: 3000 + Math.round(Math.random() * 3000), outputTokens: 200 + Math.round(Math.random() * 600) } }));
    used = Math.min(contextWindow(), used + 9_000);
    status = 'ready';
    emit();
  }

  const userMessage = (msg: OutgoingMessage): ChatMessage => ({
    id: uid('msg'),
    role: 'user',
    createdAt: Date.now(),
    parts: [
      ...(msg.context?.length ? [{ type: 'context' as const, items: msg.context }] : []),
      ...(msg.images ?? []),
      ...(msg.files ?? []),
      ...(msg.text ? [{ type: 'text' as const, text: msg.text }] : []),
    ],
  });

  const lastUserText = () => {
    const ms = active().messages;
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return ms[i].parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return '';
  };

  const controller: AssistantController & { hostHandle: typeof host } = {
    host,
    hostHandle: host,
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    send: (msg) => {
      if (status === 'submitted' || status === 'streaming') return;
      setMessages((ms) => [...ms, userMessage(msg)]);
      if (active().title === 'New chat' && msg.text) setThread((t) => ({ ...t, title: msg.text.slice(0, 48) }));
      void runTurn(msg.text);
    },
    stop: () => {
      turn++;
      approvalWaiter?.(false);
      setMessages((ms) =>
        ms.map((m) =>
          m.status === 'streaming'
            ? { ...m, status: 'stopped', parts: m.parts.map((p) => (p.type === 'tool-call' && (p.state === 'running' || p.state === 'awaiting-approval' || p.state === 'streaming') ? { ...p, state: 'cancelled' } : p)) }
            : m,
        ),
      );
      status = 'ready';
      emit();
    },
    approve: (toolCallId, approved, opts) => {
      const call = snapshot.pendingApprovals.find((p) => p.id === toolCallId);
      if (call && opts?.always) alwaysAllowed.add(call.name);
      if (approvalWaiter) approvalWaiter(approved);
      else {
        // a seeded pending call: resolve it in place
        setMessages((ms) =>
          ms.map((m) =>
            m.parts.some((p) => p.type === 'tool-call' && p.id === toolCallId)
              ? {
                  ...m,
                  status: 'done',
                  parts: [
                    ...m.parts.map((p) => (p.type === 'tool-call' && p.id === toolCallId ? { ...p, state: approved ? ('done' as const) : ('denied' as const), endedAt: Date.now(), result: approved ? { deleted: 1 } : undefined } : p)),
                    { type: 'text' as const, text: approved ? 'Deleted. Net pay over the Hugin is now **74.1 m** (was 71.3 m).' : 'Understood — I left the top in place.' },
                  ],
                }
              : m,
          ),
        );
        status = 'ready';
      }
      emit();
    },
    uiAction: (event: Omit<UIEventPart, 'type'>) => {
      setMessages((ms) => [...ms, { id: uid('msg'), role: 'user', createdAt: Date.now(), parts: [{ type: 'ui-event', ...event }] }]);
      void runTurn(event.label ?? event.name);
    },
    regenerate: () => {
      const ms = active().messages;
      let i = ms.length - 1;
      while (i >= 0 && ms[i].role === 'assistant') i--;
      setMessages(() => ms.slice(0, i + 1));
      void runTurn(lastUserText());
    },
    editAndResend: (messageId, text) => {
      const ms = active().messages;
      const i = ms.findIndex((m) => m.id === messageId);
      if (i < 0) return;
      const edited: ChatMessage = { ...ms[i], parts: [...ms[i].parts.filter((p) => p.type !== 'text'), { type: 'text', text }] };
      setMessages(() => [...ms.slice(0, i), edited]);
      void runTurn(text);
    },
    newThread: () => {
      const t: Thread = { id: uid('t'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [], datasets: {} };
      threads = [t, ...threads];
      activeId = t.id;
      status = 'ready';
      used = 3_200;
      emit();
    },
    openThread: (id) => {
      activeId = id;
      status = 'ready';
      emit();
    },
    deleteThread: (id) => {
      threads = threads.filter((t) => t.id !== id);
      if (!threads.length) threads = [{ id: uid('t'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [], datasets: {} }];
      if (activeId === id) activeId = threads[0].id;
      emit();
    },
    renameThread: (id, title) => {
      threads = threads.map((t) => (t.id === id ? { ...t, title } : t));
      emit();
    },
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      emit();
    },
    saveProvider: (config) => {
      const exists = settings.providers.some((p) => p.id === config.id);
      settings = {
        ...settings,
        providers: exists ? settings.providers.map((p) => (p.id === config.id ? config : p)) : [...settings.providers, config],
        activeProviderId: settings.activeProviderId ?? config.id,
      };
      emit();
    },
    removeProvider: (id) => {
      const providers = settings.providers.filter((p) => p.id !== id);
      settings = { ...settings, providers, activeProviderId: settings.activeProviderId === id ? (providers[0]?.id ?? null) : settings.activeProviderId };
      emit();
    },
    testProvider: async (config) => {
      await new Promise((r) => setTimeout(r, 900 * speed));
      if (config.baseUrl.includes('fail') || (!config.apiKey && !/localhost|127\.0\.0\.1/.test(config.baseUrl))) throw new Error('401 Unauthorized: the key was rejected by the provider.');
      return 'Hello! The connection works.';
    },
    listModels: async (config): Promise<ModelInfo[]> => {
      await new Promise((r) => setTimeout(r, 700 * speed));
      if (config.baseUrl.includes('fail')) throw new Error('Could not list models (CORS).');
      const byKind: Record<string, string[]> = {
        openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'o4-mini', 'deepseek-v4-flash', 'deepseek-reasoner'],
        'openai-responses': ['gpt-6-sol', 'gpt-6-luna', 'gpt-5', 'gpt-5-mini', 'gpt-4.1'],
        anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
        gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      };
      const windows: Record<string, number> = { openai: 400_000, 'openai-responses': 400_000, anthropic: 200_000, gemini: 1_048_576 };
      return byKind[config.kind].map((id) => ({ id, contextWindow: id.startsWith('deepseek') ? 128_000 : windows[config.kind] }));
    },
    compact: () => {
      if (status === 'submitted' || status === 'streaming' || compacting) return;
      void summarise(false);
    },
    compose: (text) => {
      draft = { id: (draft?.id ?? 0) + 1, text };
      emit();
    },
    exportMarkdown: (threadId) => {
      const t = threads.find((x) => x.id === (threadId ?? activeId)) ?? active();
      return [`# ${t.title}`, '', ...t.messages.map((m) => `**${m.role === 'user' ? 'You' : host.appName}:** ${m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}\n`)].join('\n');
    },
  };
  return controller;
}
