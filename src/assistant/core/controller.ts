import { adapterFor } from '../providers';
import { ProviderError, asProviderError, isAbortError } from '../providers/errors';
import { presetById } from '../providers/presets';
import type { FetchLike } from '../providers/shared';
import { finalizeStopped, runTurn } from './agent';
import { datasetSeq } from './datasets';
import { newId } from './ids';
import { safeJsonStringify } from './json';
import { createPersistence, type Persistence, type ThreadMeta } from './persistence';
import { createStore, threadMeta, titleFrom } from './store';
import { buildTurnState } from './systemPrompt';
import type {
  AssistantController,
  AssistantHost,
  AssistantSettings,
  AssistantSnapshot,
  ChatMessage,
  ChatStatus,
  Dataset,
  ErrorPart,
  ModelInfo,
  OutgoingMessage,
  Part,
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  TextPart,
  Thread,
  ToolCallPart,
  UIEventPart,
} from './types';

/*
 * The assistant's controller: owns the threads, the settings and the
 * running turn, and publishes immutable snapshots for the UI. Create one per
 * app (it is cheap until the panel is used) and dispose it on unmount.
 */

export interface CreateAssistantOptions {
  /** adapters to use instead of the built-in ones (per protocol) */
  adapters?: Partial<Record<ProviderKind, ProviderAdapter>>;
  /** the fetch the built-in adapters use (a mock for demos and tests) */
  fetch?: FetchLike;
  /** `memory` keeps nothing across reloads */
  storage?: 'auto' | 'memory';
  /** where threads and settings live, instead of the browser's storage (tests, apps with their own) */
  persistence?: Persistence;
  /** waits before the automatic retry of a transient failure (tests pass a fast one) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The controller plus lifecycle. */
export interface AssistantEngine extends AssistantController {
  /** resolves when the saved threads have been listed (and the last open one reopened) */
  ready: Promise<void>;
  /** stops the running turn, writes pending saves and drops listeners */
  dispose: () => void;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  providers: [],
  activeProviderId: null,
  autonomy: 'ask',
  rememberKeys: false,
  maxSteps: 12,
  showReasoning: true,
};

const TEST_TIMEOUT_MS = 20_000;

interface ActiveTurn {
  threadId: string;
  messageId: string;
  abort: AbortController;
  approvals: Map<string, { resolve: (ok: boolean) => void; toolName: string }>;
}

const emptyThread = (): Thread => {
  const t = Date.now();
  return { id: newId('t'), title: 'New chat', createdAt: t, updatedAt: t, messages: [], datasets: {} };
};

function normaliseSettings(s: Partial<AssistantSettings> | null): AssistantSettings {
  const out: AssistantSettings = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  out.providers = Array.isArray(out.providers) ? out.providers.filter((p) => p && typeof p.id === 'string') : [];
  if (!['read', 'ask', 'auto'].includes(out.autonomy)) out.autonomy = 'ask';
  out.maxSteps = Math.min(50, Math.max(1, Math.round(Number(out.maxSteps) || DEFAULT_SETTINGS.maxSteps)));
  if (out.activeProviderId && !out.providers.some((p) => p.id === out.activeProviderId)) out.activeProviderId = out.providers[0]?.id ?? null;
  return out;
}

/** Dataset ids that the given messages' tool calls produced. */
const datasetsOf = (messages: ChatMessage[]) => {
  const ids = new Set<string>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool-call') p.datasets?.forEach((d) => ids.add(d));
  return ids;
};

/**
 * A thread read back from storage: a turn that was cut off by a reload reads
 * as stopped, and datasets no message refers to (left by a regenerated
 * answer in an older version) are dropped, their ids not reused.
 */
function reviveThread(t: Thread): Thread {
  let changed = false;
  const messages = t.messages.map((m) => {
    if (m.status !== 'streaming' && !m.parts.some((p) => p.type === 'tool-call' && (p.state === 'streaming' || p.state === 'running' || p.state === 'awaiting-approval')))
      return m;
    changed = true;
    return finalizeStopped(m);
  });
  const used = datasetsOf(messages);
  const unused = Object.keys(t.datasets).filter((id) => !used.has(id));
  if (!changed && !unused.length) return t;
  const out: Thread = { ...t, messages };
  if (unused.length) {
    out.nextDatasetSeq = datasetSeq(t);
    out.datasets = Object.fromEntries(Object.entries(t.datasets).filter(([id]) => used.has(id)));
  }
  return out;
}

/** Creates the assistant for a host. */
export function createAssistant(host: AssistantHost, opts: CreateAssistantOptions = {}): AssistantEngine {
  const storageKey = host.storageKey || host.appName || 'app';
  const persistence = opts.persistence ?? createPersistence(storageKey, opts.storage ?? 'auto');
  let settings = normaliseSettings(persistence.loadSettings());
  let metas: ThreadMeta[] = [];
  const threads = new Map<string, Thread>();
  let current = emptyThread();
  threads.set(current.id, current);
  let status: ChatStatus = 'ready';
  let error: ErrorPart | null = null;
  let turn: ActiveTurn | null = null;
  const always = new Map<string, Set<string>>();
  /** threads being read from storage (shown as a placeholder meanwhile) */
  const loading = new Map<string, Promise<void>>();
  let disposed = false;

  // ------------------------------------------------------------ snapshots

  let lastMetas: ThreadMeta[] | null = null;
  let lastList: AssistantSnapshot['threads'] = [];
  let lastPending: ToolCallPart[] = [];
  const pendingOf = (t: Thread): ToolCallPart[] => {
    const out: ToolCallPart[] = [];
    const last = t.messages[t.messages.length - 1];
    if (last?.role === 'assistant') for (const p of last.parts) if (p.type === 'tool-call' && p.state === 'awaiting-approval') out.push(p);
    if (out.length === lastPending.length && out.every((p, i) => p === lastPending[i])) return lastPending;
    return (lastPending = out);
  };
  const listOf = () => {
    if (metas !== lastMetas) {
      lastMetas = metas;
      lastList = [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return lastList;
  };
  const build = (): AssistantSnapshot => ({
    thread: current,
    threads: listOf(),
    status,
    pendingApprovals: pendingOf(current),
    settings,
    provider: settings.providers.find((p) => p.id === settings.activeProviderId) ?? null,
    error,
  });
  const store = createStore<AssistantSnapshot>(build());
  const publish = (flush = true) => {
    if (!disposed) store.set(build(), { flush });
  };

  // ------------------------------------------------------------ threads

  const setMeta = (t: Thread) => {
    const m = threadMeta(t);
    const i = metas.findIndex((x) => x.id === t.id);
    metas = i >= 0 ? metas.map((x, j) => (j === i ? m : x)) : [m, ...metas];
  };
  /** Replaces a thread; publishes when it is the one on screen. */
  const putThread = (next: Thread, flush = true) => {
    threads.set(next.id, next);
    if (current.id === next.id) {
      current = next;
      publish(flush);
    }
  };
  const persist = (t: Thread) => {
    if (t.messages.length) {
      setMeta(t);
      persistence.saveThread(t);
    }
  };
  const activeProvider = () => settings.providers.find((p) => p.id === settings.activeProviderId) ?? null;

  const effectiveConfig = (c: ProviderConfig): ProviderConfig => {
    const out: ProviderConfig = { ...c, baseUrl: (c.baseUrl || presetById(c.presetId)?.baseUrl || '').replace(/\/+$/, '') };
    if (c.presetId === 'openrouter' && !Object.keys(c.headers ?? {}).some((k) => /^x-(openrouter-)?title$/i.test(k))) out.headers = { ...(c.headers ?? {}), 'X-Title': host.appName };
    return out;
  };
  const adapterOf = (kind: ProviderKind) => opts.adapters?.[kind] ?? adapterFor(kind, { fetch: opts.fetch });

  // ------------------------------------------------------------ turns

  const stopTurn = () => {
    const t = turn;
    if (!t) return;
    turn = null;
    t.abort.abort();
    for (const a of t.approvals.values()) a.resolve(false);
    t.approvals.clear();
    const thread = threads.get(t.threadId);
    if (thread) {
      const next = { ...thread, messages: thread.messages.map((m) => (m.id === t.messageId ? finalizeStopped(m) : m)), updatedAt: Date.now() };
      if (t.threadId === current.id) status = 'ready';
      putThread(next);
      persist(next);
    }
  };

  const startTurn = (threadId: string) => {
    const thread = threads.get(threadId);
    if (!thread) return;
    const provider = activeProvider();
    const preset = provider ? presetById(provider.presetId) : undefined;
    const base: ChatMessage = { id: newId('m'), role: 'assistant', parts: [], createdAt: Date.now() };
    let problem: ErrorPart | null = null;
    if (!provider) problem = { type: 'error', message: 'Connect a model to start: open Settings and add a provider.', config: true };
    else if (!provider.model) problem = { type: 'error', message: `Choose a model for ${provider.label} in Settings.`, config: true };
    else if (preset?.needsKey && !provider.apiKey) problem = { type: 'error', message: `Add an API key for ${provider.label} in Settings.`, config: true };
    else if (!provider.baseUrl && !preset?.baseUrl) problem = { type: 'error', message: `Set the server address for ${provider.label} in Settings.`, config: true };
    if (problem || !provider) {
      const msg: ChatMessage = { ...base, parts: [problem!], status: 'error', finishReason: 'error' };
      const next = { ...thread, messages: [...thread.messages, msg], updatedAt: Date.now() };
      if (threadId === current.id) {
        status = 'error';
        error = problem;
      }
      putThread(next);
      persist(next);
      return;
    }

    const config = effectiveConfig(provider);
    const message: ChatMessage = { ...base, provider: config.presetId, model: config.model, status: 'streaming' };
    const t: ActiveTurn = { threadId, messageId: message.id, abort: new AbortController(), approvals: new Map() };
    turn = t;
    status = 'submitted';
    error = null;
    putThread({ ...thread, messages: [...thread.messages, message], updatedAt: Date.now() });

    const commit = (m: ChatMessage, o?: { flush?: boolean }) => {
      const th = threads.get(threadId);
      if (!th || disposed) return;
      const i = th.messages.findIndex((x) => x.id === m.id);
      if (i < 0) return; // regenerated or deleted meanwhile
      const messages = th.messages.slice();
      messages[i] = m;
      putThread({ ...th, messages }, !!o?.flush);
    };

    void runTurn({
      host,
      adapter: adapterOf(config.kind),
      config,
      settings,
      getThread: () => threads.get(threadId) ?? thread,
      message,
      commit,
      addDatasets: (ds: Dataset[]) => {
        const th = threads.get(threadId);
        if (!th) return;
        const datasets = { ...th.datasets };
        for (const d of ds) datasets[d.id] = d;
        putThread({ ...th, datasets, nextDatasetSeq: datasetSeq({ datasets, nextDatasetSeq: th.nextDatasetSeq }) }, false);
      },
      requestApproval: (part) =>
        new Promise<boolean>((resolve) => {
          if (turn !== t) return resolve(false);
          t.approvals.set(part.id, { resolve, toolName: part.name });
          publish();
        }),
      isAlwaysApproved: (name) => always.get(threadId)?.has(name) ?? false,
      onPhase: (s) => {
        if (turn === t && threadId === current.id && status !== s) {
          status = s;
          publish();
        }
      },
      signal: t.abort.signal,
      sleep: opts.sleep,
    })
      .then((result) => {
        const th = threads.get(threadId);
        if (turn === t) {
          turn = null;
          if (threadId === current.id) {
            status = result.error ? 'error' : 'ready';
            error = result.error ?? null;
          }
        }
        if (th && !disposed) {
          const next = { ...th, updatedAt: Date.now() };
          putThread(next);
          persist(next);
        }
      })
      .catch(() => {
        /* runTurn reports its errors in the message */
      });
  };

  /** The parts with the app's state at this moment recorded in their context part (added when there is none). */
  const withState = (parts: Part[], thread: Thread): Part[] => {
    const state = buildTurnState({ host, datasets: Object.values(thread.datasets) });
    const i = parts.findIndex((p) => p.type === 'context');
    if (i < 0) return [{ type: 'context', items: [], state }, ...parts];
    return parts.map((p, j) => (j === i && p.type === 'context' ? { ...p, state } : p));
  };

  /**
   * Runs an action on the thread on screen once it is loaded: a message sent
   * while a saved thread is still being read waits for its history, so the
   * request carries it and the save does not overwrite it.
   */
  const whenLoaded = (action: (threadId: string) => void) => {
    const id = current.id;
    if (!loading.has(id)) return action(id);
    void (async () => {
      for (let p = loading.get(id); p; p = loading.get(id)) await p;
      if (!disposed && threads.has(id)) action(id);
    })();
  };

  const appendUserMessage = (threadId: string, parts: Part[]) => {
    stopTurn();
    const thread = threads.get(threadId);
    if (!thread) return;
    const msg: ChatMessage = { id: newId('m'), role: 'user', parts: withState(parts, thread), createdAt: Date.now() };
    const first = !thread.messages.some((m) => m.role === 'user');
    let title = thread.title;
    if (first) {
      const text = parts.find((p): p is TextPart => p.type === 'text')?.text;
      const event = parts.find((p): p is UIEventPart => p.type === 'ui-event');
      const file = parts.find((p) => p.type === 'file' || p.type === 'image') as { name?: string } | undefined;
      title = titleFrom(text || event?.label || event?.name || file?.name || 'New chat');
    }
    const next: Thread = { ...thread, title, messages: [...thread.messages, msg], updatedAt: Date.now() };
    if (next.id === current.id) {
      error = null;
      status = 'ready';
      persistence.saveCurrentThreadId(next.id);
    }
    putThread(next);
    persist(next);
    startTurn(next.id);
  };

  /** Drops messages from `index` on, and the datasets only they produced. */
  const truncate = (thread: Thread, index: number): Thread => {
    const kept = thread.messages.slice(0, index);
    const dropped = datasetsOf(thread.messages.slice(index));
    const stillUsed = datasetsOf(kept);
    const datasets: Record<string, Dataset> = {};
    for (const [id, d] of Object.entries(thread.datasets)) if (!dropped.has(id) || stillUsed.has(id)) datasets[id] = d;
    // the dropped ids are not given again: a new dataset never takes a saved one's key
    return { ...thread, messages: kept, datasets, nextDatasetSeq: datasetSeq(thread), updatedAt: Date.now() };
  };

  /** Drops the last assistant turn and asks again. */
  const regenerate = (threadId: string) => {
    stopTurn();
    const thread = threads.get(threadId);
    if (!thread) return;
    let li = -1;
    for (let i = thread.messages.length - 1; i >= 0; i--)
      if (thread.messages[i].role === 'user') {
        li = i;
        break;
      }
    if (li < 0) return publish();
    const next = truncate(thread, li + 1);
    if (threadId === current.id) {
      error = null;
      status = 'ready';
    }
    putThread(next);
    persist(next);
    startTurn(next.id);
  };

  /** Replaces a user message's text, drops what came after it and asks again. */
  const editAndResend = (threadId: string, messageId: string, text: string) => {
    stopTurn();
    const thread = threads.get(threadId);
    if (!thread) return;
    const i = thread.messages.findIndex((m) => m.id === messageId && m.role === 'user');
    if (i < 0) return publish();
    const old = thread.messages[i];
    const oldText = old.parts.find((p) => p.type === 'text') as { text: string } | undefined;
    const parts: Part[] = old.parts.filter((p) => p.type !== 'text');
    if (text.trim()) parts.push({ type: 'text', text });
    if (!parts.length) return publish();
    const edited: ChatMessage = { ...old, parts, createdAt: Date.now() };
    const cut = truncate(thread, i);
    edited.parts = withState(edited.parts, cut);
    const firstUser = thread.messages.findIndex((m) => m.role === 'user') === i;
    const title = firstUser && thread.title === titleFrom(oldText?.text ?? '') ? titleFrom(text) : thread.title;
    const next: Thread = { ...cut, title, messages: [...cut.messages, edited] };
    if (threadId === current.id) {
      error = null;
      status = 'ready';
    }
    putThread(next);
    persist(next);
    startTurn(next.id);
  };

  // ------------------------------------------------------------ loading

  const openLoaded = (id: string) => {
    const known = threads.get(id);
    if (known) {
      current = known;
      publish();
      return;
    }
    const m = metas.find((x) => x.id === id);
    const placeholder: Thread = { id, title: m?.title ?? 'Chat', createdAt: m?.createdAt ?? Date.now(), updatedAt: m?.updatedAt ?? Date.now(), messages: [], datasets: {} };
    threads.set(id, placeholder);
    current = placeholder;
    publish();
    const load = persistence
      .loadThread(id)
      .catch(() => null)
      .then((loaded) => {
        if (loading.get(id) === load) loading.delete(id);
        const now = threads.get(id);
        if (disposed || !loaded || !now) return; // deleted meanwhile, or nothing saved
        const revived = reviveThread(loaded);
        if (now === placeholder) return putThread(revived);
        // changed while it loaded (renamed, a message): the saved history comes first
        const datasets = { ...revived.datasets, ...now.datasets };
        const merged: Thread = {
          ...revived,
          title: now.title,
          messages: [...revived.messages, ...now.messages],
          datasets,
          nextDatasetSeq: Math.max(datasetSeq(revived), datasetSeq({ datasets, nextDatasetSeq: now.nextDatasetSeq })),
          updatedAt: Math.max(revived.updatedAt, now.updatedAt),
        };
        putThread(merged);
        persist(merged);
      });
    loading.set(id, load);
  };

  const ready = (async () => {
    const saved = await persistence.listThreads();
    if (disposed) return;
    const inMemory = new Set(metas.map((m) => m.id));
    metas = [...metas, ...saved.filter((m) => !inMemory.has(m.id))];
    const last = persistence.loadCurrentThreadId();
    if (last && current.messages.length === 0 && !turn && metas.some((m) => m.id === last) && current.id !== last) {
      threads.delete(current.id);
      openLoaded(last);
    } else publish();
  })().catch(() => {});

  // ------------------------------------------------------------ export

  const exportMarkdown = (threadId?: string): string => {
    const t = threadId ? threads.get(threadId) : current;
    if (!t) return '';
    const lines: string[] = [`# ${t.title}`, '', `_Exported from ${host.appName} on ${new Date().toISOString().slice(0, 10)}_`, ''];
    const table = (d: Dataset) => {
      const cols = d.columns.slice(0, 12);
      const head = `| ${cols.map((c) => `${c.label ?? c.key}${c.unit ? ` (${c.unit})` : ''}`).join(' | ')} |`;
      const sep = `| ${cols.map(() => '---').join(' | ')} |`;
      const rows = d.rows.slice(0, 20).map((r) => `| ${cols.map((c) => String(r[c.key] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
      const more = d.rows.length > 20 ? [`_…${d.rows.length - 20} more rows_`] : [];
      return [`**${d.id} · ${d.title}**${d.source ? ` — ${d.source}` : ''}`, '', head, sep, ...rows, ...more, ''];
    };
    for (const m of t.messages) {
      lines.push(m.role === 'user' ? '## You' : `## Assistant${m.model ? ` (${m.model})` : ''}`, '');
      for (const p of m.parts) {
        switch (p.type) {
          case 'text':
            if (p.text.trim()) lines.push(p.text.trim(), '');
            break;
          case 'context':
            if (p.items.length) lines.push(`> Context: ${p.items.map((i) => i.label).join(', ')}`, '');
            break;
          case 'file':
            lines.push(`> Attached file: ${p.name}`, '');
            break;
          case 'image':
            lines.push(`> Attached image${p.name ? `: ${p.name}` : ''}`, '');
            break;
          case 'ui-event':
            lines.push(`> ${p.label ?? `Action “${p.name}”`}`, '');
            break;
          case 'tool-call': {
            const outcome = p.state === 'done' ? '' : ` (${p.state}${p.error ? `: ${p.error}` : ''})`;
            lines.push(`- Ran \`${p.name}\` ${safeJsonStringify(p.args, 200)}${outcome}`);
            for (const id of p.datasets ?? []) if (t.datasets[id]) lines.push('', ...table(t.datasets[id]));
            break;
          }
          case 'ui':
            lines.push('[interactive view]', '');
            break;
          case 'error':
            lines.push(`> Error: ${p.message}`, '');
            break;
          default:
            break;
        }
      }
      if (lines[lines.length - 1] !== '') lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  };

  // ------------------------------------------------------------ the controller

  const engine: AssistantEngine = {
    host,
    ready,
    getSnapshot: () => store.get(),
    subscribe: (l) => store.subscribe(l),

    send(message: OutgoingMessage) {
      const parts: Part[] = [];
      if (message.context?.length) parts.push({ type: 'context', items: message.context });
      for (const f of message.files ?? []) parts.push(f);
      for (const i of message.images ?? []) parts.push(i);
      if (message.text.trim()) parts.push({ type: 'text', text: message.text });
      if (!parts.some((p) => p.type !== 'context')) return;
      whenLoaded((id) => appendUserMessage(id, parts));
    },

    stop() {
      if (!turn) return;
      stopTurn();
      publish();
    },

    approve(toolCallId, approved, o) {
      const t = turn;
      const a = t?.approvals.get(toolCallId);
      if (!t || !a) return;
      t.approvals.delete(toolCallId);
      if (approved && o?.always) {
        let set = always.get(t.threadId);
        if (!set) always.set(t.threadId, (set = new Set()));
        set.add(a.toolName);
        for (const [id, other] of [...t.approvals]) {
          if (other.toolName !== a.toolName) continue;
          t.approvals.delete(id);
          other.resolve(true);
        }
      }
      a.resolve(approved);
    },

    uiAction(event) {
      whenLoaded((id) => appendUserMessage(id, [{ type: 'ui-event', ...event }]));
    },

    regenerate() {
      whenLoaded(regenerate);
    },

    editAndResend(messageId, text) {
      whenLoaded((id) => editAndResend(id, messageId, text));
    },

    newThread() {
      stopTurn();
      if (!current.messages.length) return publish();
      current = emptyThread();
      threads.set(current.id, current);
      status = 'ready';
      error = null;
      persistence.saveCurrentThreadId(null);
      publish();
    },

    openThread(id) {
      if (id === current.id) return;
      if (!threads.has(id) && !metas.some((m) => m.id === id)) return;
      stopTurn();
      status = 'ready';
      error = null;
      // an untouched empty thread is not worth keeping (one still loading is kept: its load fills it)
      if (!current.messages.length && !loading.has(current.id)) threads.delete(current.id);
      persistence.saveCurrentThreadId(id);
      openLoaded(id);
    },

    deleteThread(id) {
      if (turn?.threadId === id) stopTurn();
      metas = metas.filter((m) => m.id !== id);
      threads.delete(id);
      always.delete(id);
      void persistence.deleteThread(id);
      if (current.id === id) {
        current = emptyThread();
        threads.set(current.id, current);
        status = 'ready';
        error = null;
        persistence.saveCurrentThreadId(null);
      }
      publish();
    },

    renameThread(id, title) {
      const t = threads.get(id);
      const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!clean) return;
      if (t) {
        const next = { ...t, title: clean };
        putThread(next);
        persist(next);
        if (!next.messages.length) publish();
      } else {
        const m = metas.find((x) => x.id === id);
        if (!m) return;
        metas = metas.map((x) => (x.id === id ? { ...x, title: clean } : x));
        void persistence.loadThread(id).then((loaded) => loaded && persistence.saveThread({ ...loaded, title: clean }));
      }
      publish();
    },

    updateSettings(patch) {
      settings = normaliseSettings({ ...settings, ...patch });
      persistence.saveSettings(settings);
      publish();
    },

    saveProvider(config) {
      const clean: ProviderConfig = { ...config, baseUrl: (config.baseUrl ?? '').trim().replace(/\/+$/, ''), model: (config.model ?? '').trim() };
      if (clean.apiKey !== undefined) clean.apiKey = clean.apiKey.trim() || undefined;
      const i = settings.providers.findIndex((p) => p.id === clean.id);
      const providers = i >= 0 ? settings.providers.map((p, j) => (j === i ? clean : p)) : [...settings.providers, clean];
      settings = normaliseSettings({ ...settings, providers, activeProviderId: settings.activeProviderId ?? clean.id });
      persistence.saveSettings(settings);
      if (status === 'error' && error?.config) {
        status = 'ready';
        error = null;
      }
      publish();
    },

    removeProvider(id) {
      const providers = settings.providers.filter((p) => p.id !== id);
      settings = normaliseSettings({ ...settings, providers, activeProviderId: settings.activeProviderId === id ? (providers[0]?.id ?? null) : settings.activeProviderId });
      persistence.saveSettings(settings);
      publish();
    },

    async testProvider(config) {
      const cfg: ProviderConfig = { ...effectiveConfig(config), maxOutputTokens: 32, reasoning: 'off' };
      delete cfg.temperature;
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, TEST_TIMEOUT_MS);
      try {
        let text = '';
        const messages: ChatMessage[] = [{ id: 'test', role: 'user', parts: [{ type: 'text', text: 'Reply with the word OK.' }], createdAt: Date.now() }];
        for await (const ev of adapterOf(cfg.kind).stream({ config: cfg, system: 'You are checking that a connection works. Answer with one word.', messages, tools: [], signal: ac.signal }))
          if (ev.type === 'text-delta') text += ev.text;
        return text.trim() || 'Connected (the model sent no text within the test’s token limit).';
      } catch (err) {
        if (timedOut) throw new ProviderError(`${cfg.label || 'The provider'} did not answer within ${TEST_TIMEOUT_MS / 1000} s.`, { retryable: true });
        if (isAbortError(err)) throw err;
        throw asProviderError(err);
      } finally {
        clearTimeout(timer);
      }
    },

    async listModels(config): Promise<ModelInfo[]> {
      const cfg = effectiveConfig(config);
      const adapter = adapterOf(cfg.kind);
      if (!adapter.listModels) return (presetById(cfg.presetId)?.models ?? []).map((id) => ({ id }));
      try {
        return await adapter.listModels(cfg);
      } catch (err) {
        throw asProviderError(err);
      }
    },

    exportMarkdown,

    dispose() {
      if (disposed) return;
      stopTurn();
      disposed = true;
      store.dispose();
      persistence.dispose();
    },
  };
  return engine;
}
