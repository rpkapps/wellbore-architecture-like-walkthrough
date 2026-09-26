import { a2uiPromptGuide, extractA2UIFences } from '../a2ui';
import { asProviderError, isAbortError, toErrorPart } from '../providers/errors';
import { abortError } from '../providers/sse';
import { RENDER_UI, builtinTools } from './builtinTools';
import { capToolResult, isToolOutput, registerDatasets, summariseDataset } from './datasets';
import { parsePartialJson } from './json';
import { buildSystemPrompt } from './systemPrompt';
import { buildToolNameMap, type ToolNameMap } from './toolNames';
import type {
  AssistantHost,
  AssistantSettings,
  AssistantTool,
  ChatMessage,
  ChatStatus,
  Dataset,
  ErrorPart,
  FinishReason,
  ModelRequest,
  Part,
  ProviderAdapter,
  ProviderConfig,
  ReasoningPart,
  StreamEvent,
  TextPart,
  Thread,
  ToolCallPart,
  UIPart,
  Usage,
  WireTool,
} from './types';

/*
 * One assistant turn: ask the model, stream its answer into the assistant
 * message, run the tools it calls (asking the person first when the
 * autonomy mode says so), give it the results, and repeat until it answers
 * without calling tools, the step limit is reached, the person stops it, or
 * an error ends it. Every change produces a new message object; parts that
 * did not change keep their identity.
 */

export interface TurnOptions {
  host: AssistantHost;
  adapter: ProviderAdapter;
  config: ProviderConfig;
  settings: Pick<AssistantSettings, 'autonomy' | 'maxSteps'>;
  /** the thread as it is now (the history before `message`, and its datasets) */
  getThread: () => Thread;
  /** the assistant message to write (already in the thread) */
  message: ChatMessage;
  /** publishes a new version of the message; `flush` for state changes the UI must show at once */
  commit: (message: ChatMessage, opts?: { flush?: boolean }) => void;
  addDatasets: (datasets: Dataset[]) => void;
  /** asks the person about a call (its part is already `awaiting-approval`); resolves with the answer */
  requestApproval: (part: ToolCallPart) => Promise<boolean>;
  /** the person chose "always" for this tool in this thread */
  isAlwaysApproved: (toolName: string) => boolean;
  /** `streaming` once the first event arrives */
  onPhase?: (status: ChatStatus) => void;
  signal: AbortSignal;
  now?: () => number;
  /** waits before the automatic retry (tests pass a fast one) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface TurnResult {
  message: ChatMessage;
  error?: ErrorPart;
  stopped?: boolean;
}

const DENIED = { denied: true, message: 'The person declined this action.' };
const MAX_RETRY_WAIT_MS = 10_000;

/** A2UI messages from `render_ui` arguments (`{messages: [...]}`, or an `a2ui_json` string of a JSON array / JSONL), tolerating partial JSON. */
export function uiMessagesFromArgs(args: unknown): unknown[] | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const fromString = (s: string): unknown[] | undefined => {
    const whole = parsePartialJson(s);
    if (Array.isArray(whole)) return whole;
    if (whole && typeof whole === 'object') {
      const w = whole as Record<string, unknown>;
      return Array.isArray(w.messages) ? w.messages : [w];
    }
    // JSONL: one message per line
    const lines = s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return undefined;
    const out = lines.map((l) => parsePartialJson(l)).filter((x) => x && typeof x === 'object');
    return out.length ? out : undefined;
  };
  if (Array.isArray(a.messages)) return a.messages;
  if (typeof a.messages === 'string') return fromString(a.messages);
  const j = a.a2ui_json ?? a.a2uiJson;
  if (Array.isArray(j)) return j;
  if (typeof j === 'string') return fromString(j);
  return undefined;
}

/** The message as it stands when a turn is stopped: unfinished calls cancelled, status `stopped`. */
export function finalizeStopped(message: ChatMessage, now = Date.now()): ChatMessage {
  let changed = false;
  const parts = message.parts.map((p) => {
    if (p.type === 'tool-call' && (p.state === 'streaming' || p.state === 'awaiting-approval' || p.state === 'running')) {
      changed = true;
      return { ...p, state: 'cancelled' as const, endedAt: p.endedAt ?? now };
    }
    return p;
  });
  if (!changed && message.status === 'stopped') return message;
  return { ...message, parts: changed ? parts : message.parts, status: 'stopped' };
}

const sumUsage = (a: Usage | undefined, b: Usage): Usage => {
  const out: Usage = { ...(a ?? {}) };
  for (const k of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'] as const) if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves with the promise, or rejects with an AbortError as soon as the signal aborts. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface OfferedTools {
  tools: AssistantTool[];
  byName: Map<string, AssistantTool>;
  wire: WireTool[];
  names: ToolNameMap;
}

/** Runs one turn to its end. Never rejects: errors end up in the message. */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const { host, adapter, config, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  let msg: ChatMessage = opts.message;
  const set = (next: ChatMessage, flush = false) => {
    msg = next;
    opts.commit(msg, flush ? { flush: true } : undefined);
  };
  const setParts = (parts: Part[], flush = false) => set({ ...msg, parts }, flush);
  const replacePart = (index: number, part: Part, flush = false) => {
    const parts = msg.parts.slice();
    parts[index] = part;
    setParts(parts, flush);
  };
  const findCall = (id: string) => msg.parts.findIndex((p) => p.type === 'tool-call' && p.id === id);
  const updateCall = (id: string, patch: Partial<ToolCallPart>, flush = false) => {
    const i = findCall(id);
    if (i >= 0) replacePart(i, { ...(msg.parts[i] as ToolCallPart), ...patch }, flush);
  };

  const builtins = builtinTools().map((t) => ({ ...t, kind: 'read' as const }));
  const usesTools = config.tools !== false;
  const collectTools = (): OfferedTools => {
    const byName = new Map<string, AssistantTool>();
    if (usesTools) {
      let hostTools: AssistantTool[] = [];
      try {
        hostTools = host.tools() ?? [];
      } catch {
        /* a failing host keeps the built-ins */
      }
      for (const t of [...hostTools, ...builtins]) {
        if (byName.has(t.name)) continue;
        if (opts.settings.autonomy === 'read' && (t.kind ?? 'write') !== 'read') continue;
        byName.set(t.name, t);
      }
    }
    const tools = [...byName.values()];
    const historyNames: string[] = [];
    for (const m of opts.getThread().messages) for (const p of m.parts) if (p.type === 'tool-call') historyNames.push(p.name);
    for (const p of msg.parts) if (p.type === 'tool-call') historyNames.push(p.name);
    const names = buildToolNameMap([...tools.map((t) => t.name), ...historyNames]);
    const wire = tools.map((t) => ({ name: names.toWire(t.name), description: t.description, parameters: t.parameters }));
    return { tools, byName, wire, names };
  };

  const initialTools = collectTools();
  let guide: string | undefined;
  if (initialTools.byName.has(RENDER_UI)) {
    try {
      guide = typeof a2uiPromptGuide === 'function' ? a2uiPromptGuide() : undefined;
    } catch {
      guide = undefined;
    }
  }
  const system = buildSystemPrompt({
    host,
    autonomy: opts.settings.autonomy,
    tools: initialTools.tools.length > 0,
    a2uiGuide: guide,
  });

  const history = (names: ToolNameMap): ChatMessage[] => {
    const thread = opts.getThread();
    const idx = thread.messages.findIndex((m) => m.id === msg.id);
    const before = idx >= 0 ? thread.messages.slice(0, idx) : thread.messages.filter((m) => m.id !== msg.id);
    const all = msg.parts.length ? [...before, msg] : before;
    return all.map((m) =>
      m.role === 'assistant' && m.parts.some((p) => p.type === 'tool-call')
        ? { ...m, parts: m.parts.map((p) => (p.type === 'tool-call' ? { ...p, name: names.toWire(p.name) } : p)) }
        : m,
    );
  };

  let fenceCount = msg.parts.filter((p) => p.type === 'ui' && p.id.startsWith(`${msg.id}:fence:`)).length;
  let started = false;
  // written from the event handler: a holder, so control-flow narrowing does not freeze it
  const step$ = { finish: undefined as FinishReason | undefined };

  try {
    const maxSteps = Math.max(1, opts.settings.maxSteps || 12);
    for (let step = 0; ; step++) {
      if (step >= maxSteps) {
        const note: TextPart = {
          type: 'text',
          text: `\n\n_I stopped after ${maxSteps} steps, the limit for one request. Say “continue” if you want me to carry on._`,
        };
        set({ ...msg, parts: [...msg.parts, note], status: 'done', finishReason: 'other' }, true);
        return { message: msg };
      }
      const offered = step === 0 ? initialTools : collectTools();
      const request: ModelRequest = { config, system, messages: history(offered.names), tools: offered.wire, signal };

      // ---- stream one model response
      const stepStart = msg.parts.length;
      const callIds: string[] = [];
      const ended = new Set<string>();
      const argsErrors = new Map<string, string>();
      const providerToPart = new Map<string, string>();
      const partial = new Map<string, { text: string; parsedLen: number; parsedAt: number; render: boolean }>();
      let openReasoning = -1;
      let reasoningStart = 0;
      let openText = -1;
      step$.finish = undefined;

      const closeReasoning = () => {
        if (openReasoning < 0) return;
        const r = msg.parts[openReasoning] as ReasoningPart;
        if (r?.type === 'reasoning' && r.durationMs === undefined) replacePart(openReasoning, { ...r, durationMs: Math.max(0, now() - reasoningStart) });
        openReasoning = -1;
      };
      const takenIds = () => {
        const s = new Set<string>();
        for (const m of opts.getThread().messages) for (const p of m.parts) if (p.type === 'tool-call') s.add(p.id);
        for (const p of msg.parts) if (p.type === 'tool-call') s.add(p.id);
        return s;
      };
      const syncUi = (callId: string, args: unknown, flush = false) => {
        const messages = uiMessagesFromArgs(args);
        if (!messages) return;
        const i = msg.parts.findIndex((p) => p.type === 'ui' && p.id === callId);
        if (i >= 0) replacePart(i, { ...(msg.parts[i] as UIPart), messages }, flush);
      };

      const apply = (ev: StreamEvent) => {
        switch (ev.type) {
          case 'text-delta': {
            if (!ev.text) return;
            closeReasoning();
            const last = msg.parts.length - 1;
            if (openText === last && last >= 0 && msg.parts[last].type === 'text') {
              const t = msg.parts[last] as TextPart;
              replacePart(last, { ...t, text: t.text + ev.text });
            } else {
              setParts([...msg.parts, { type: 'text', text: ev.text }]);
              openText = msg.parts.length - 1;
            }
            return;
          }
          case 'reasoning-delta': {
            if (!ev.text) return;
            openText = -1;
            const last = msg.parts.length - 1;
            if (openReasoning === last && last >= 0) {
              const r = msg.parts[last] as ReasoningPart;
              replacePart(last, { ...r, text: r.text + ev.text });
            } else {
              closeReasoning();
              setParts([...msg.parts, { type: 'reasoning', text: ev.text }]);
              openReasoning = msg.parts.length - 1;
              reasoningStart = now();
            }
            return;
          }
          case 'reasoning-signature': {
            openText = -1;
            if (openReasoning >= 0) {
              const r = msg.parts[openReasoning] as ReasoningPart;
              replacePart(openReasoning, { ...r, signature: ev.signature });
              closeReasoning();
            } else setParts([...msg.parts, { type: 'reasoning', text: '', signature: ev.signature, durationMs: 0 }]);
            return;
          }
          case 'reasoning-redacted': {
            openText = -1;
            closeReasoning();
            setParts([...msg.parts, { type: 'reasoning', text: '', redacted: ev.data, durationMs: 0 }]);
            return;
          }
          case 'tool-call-start': {
            openText = -1;
            closeReasoning();
            let id = ev.id || `call_${Math.random().toString(36).slice(2, 10)}`;
            if (takenIds().has(id)) id = `${id}_${Math.random().toString(36).slice(2, 7)}`;
            providerToPart.set(ev.id, id);
            const kit = offered.names.toKit(ev.name) ?? ev.name;
            const part: ToolCallPart = { type: 'tool-call', id, name: kit, args: {}, argsText: '', state: 'streaming', step };
            if (ev.providerMeta) part.providerMeta = ev.providerMeta;
            callIds.push(id);
            const render = kit === RENDER_UI;
            partial.set(id, { text: '', parsedLen: 0, parsedAt: 0, render });
            const added: Part[] = [part];
            if (render) added.push({ type: 'ui', id, messages: [], toolCallId: id });
            setParts([...msg.parts, ...added], true);
            return;
          }
          case 'tool-call-delta': {
            const id = providerToPart.get(ev.id);
            const p = id && partial.get(id);
            if (!id || !p) return;
            p.text += ev.argsText;
            const t = now();
            // parsing partial JSON on every delta is quadratic: parse when enough arrived or enough time passed
            if (p.text.length - p.parsedLen >= 256 || t - p.parsedAt >= 40) {
              p.parsedLen = p.text.length;
              p.parsedAt = t;
              const parsed = parsePartialJson(p.text);
              updateCall(id, parsed !== undefined ? { argsText: p.text, args: parsed } : { argsText: p.text });
              if (p.render && parsed !== undefined) syncUi(id, parsed);
            }
            return;
          }
          case 'tool-call-end': {
            const id = providerToPart.get(ev.id);
            if (!id) return;
            ended.add(id);
            const p = partial.get(id);
            const argsText = p && p.text ? p.text : JSON.stringify(ev.args ?? {});
            let args = ev.args;
            if (ev.argsError) {
              argsErrors.set(id, ev.argsError);
              args = parsePartialJson(argsText) ?? {};
            }
            updateCall(id, { args, argsText });
            if (p?.render) syncUi(id, args);
            return;
          }
          case 'usage':
            set({ ...msg, usage: sumUsage(msg.usage, ev.usage) });
            return;
          case 'finish':
            step$.finish = ev.reason;
            return;
        }
      };

      for (let attempt = 0; ; attempt++) {
        let got = false;
        try {
          for await (const ev of adapter.stream(request)) {
            if (signal.aborted) throw abortError(signal);
            if (!got) {
              got = true;
              if (!started) {
                started = true;
                opts.onPhase?.('streaming');
              }
            }
            apply(ev);
          }
          break;
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
          const pe = asProviderError(err);
          // one automatic retry for a transient failure, only if nothing arrived yet
          if (!got && attempt === 0 && pe.retryable && (pe.retryAfterMs ?? 0) <= MAX_RETRY_WAIT_MS) {
            await sleep(pe.retryAfterMs ?? 1000, signal);
            continue;
          }
          throw pe;
        }
      }
      closeReasoning();
      if (signal.aborted) throw abortError(signal);

      // ---- ```a2ui fences in this step's text become interfaces
      if (typeof extractA2UIFences === 'function') {
        const parts: Part[] = msg.parts.slice(0, stepStart);
        let changed = false;
        for (const p of msg.parts.slice(stepStart)) {
          if (p.type === 'text' && p.text.includes('```a2ui')) {
            let res: { text: string; blocks: unknown[][] } | undefined;
            try {
              res = extractA2UIFences(p.text);
            } catch {
              res = undefined;
            }
            if (res && res.blocks.length) {
              changed = true;
              if (res.text.trim()) parts.push({ ...p, text: res.text });
              for (const block of res.blocks) parts.push({ type: 'ui', id: `${msg.id}:fence:${fenceCount++}`, messages: block });
              continue;
            }
          }
          parts.push(p);
        }
        if (changed) setParts(parts, true);
      }

      // ---- no calls: the answer is complete
      if (!callIds.length) {
        set({ ...msg, status: 'done', finishReason: step$.finish ?? 'stop' }, true);
        return { message: msg };
      }

      // ---- run the calls
      const threadNow = () => opts.getThread();
      interface Plan {
        id: string;
        tool?: AssistantTool;
        error?: string;
        approval?: Promise<boolean>;
      }
      const plans: Plan[] = callIds.map((id) => {
        const part = msg.parts[findCall(id)] as ToolCallPart;
        if (!ended.has(id))
          return { id, error: step$.finish === 'length' ? 'The call was cut off: the model reached its output limit. Try a smaller request.' : 'The call arrived incomplete.' };
        if (argsErrors.has(id)) return { id, error: `The arguments were not valid JSON (${argsErrors.get(id)}). Send them again as a JSON object.` };
        const tool = offered.byName.get(part.name);
        if (!tool) {
          const names = [...offered.byName.keys()].map((n) => offered.names.toWire(n));
          return { id, error: `Unknown tool "${offered.names.toWire(part.name)}". Available tools: ${names.join(', ') || 'none'}.` };
        }
        return { id, tool };
      });

      // ask for every approval at once, so the person sees them together
      for (const plan of plans) {
        if (!plan.tool) continue;
        const part = msg.parts[findCall(plan.id)] as ToolCallPart;
        if (needsApproval(plan.tool, part.args, opts.settings.autonomy, opts.isAlwaysApproved)) {
          updateCall(plan.id, { state: 'awaiting-approval' }, true);
          const current = msg.parts[findCall(plan.id)] as ToolCallPart;
          plan.approval = opts.requestApproval(current);
          plan.approval.catch(() => {});
        }
      }

      const run = async (plan: Plan) => {
        if (plan.error) {
          updateCall(plan.id, { state: 'error', error: plan.error, result: { error: plan.error }, endedAt: now() }, true);
          return;
        }
        const tool = plan.tool!;
        if (plan.approval) {
          const ok = await raceAbort(plan.approval, signal);
          if (!ok) {
            updateCall(plan.id, { state: 'denied', result: DENIED, endedAt: now() }, true);
            return;
          }
        }
        const part = msg.parts[findCall(plan.id)] as ToolCallPart;
        updateCall(plan.id, { state: 'running', startedAt: now() }, true);
        try {
          const thread = threadNow();
          const datasets = new Map(Object.entries(thread.datasets));
          const out = await raceAbort(
            Promise.resolve().then(() => tool.execute(part.args, { signal, toolCallId: plan.id, datasets })),
            signal,
          );
          let result: unknown = out === undefined ? { ok: true } : out;
          let ids: string[] | undefined;
          if (isToolOutput(out)) {
            const registered = registerDatasets(threadNow().datasets, out.datasets ?? [], now());
            if (registered.length) {
              opts.addDatasets(registered);
              ids = registered.map((d) => d.id);
            }
            const summaries = registered.map(summariseDataset);
            const content = out.content === undefined ? { ok: true } : out.content;
            result =
              summaries.length === 0
                ? content
                : content && typeof content === 'object' && !Array.isArray(content)
                  ? { ...content, datasets: summaries }
                  : { result: content, datasets: summaries };
          }
          const patch: Partial<ToolCallPart> = { state: 'done', result: capToolResult(result), endedAt: now() };
          if (ids) patch.datasets = ids;
          updateCall(plan.id, patch, true);
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
          const message = err instanceof Error ? err.message || err.name : typeof err === 'string' ? err : 'The tool failed.';
          updateCall(plan.id, { state: 'error', error: message, result: { error: message }, endedAt: now() }, true);
        }
      };

      // in order; consecutive reads that need no approval run together
      for (let i = 0; i < plans.length; ) {
        const p = plans[i];
        const parallel = (x: Plan) => !x.error && !x.approval && x.tool && (x.tool.kind ?? 'write') === 'read';
        if (parallel(p)) {
          let j = i;
          while (j < plans.length && parallel(plans[j])) j++;
          await Promise.all(plans.slice(i, j).map(run));
          i = j;
        } else {
          await run(p);
          i++;
        }
        if (signal.aborted) throw abortError(signal);
      }
    }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      closeOpenReasoning();
      set(finalizeStopped(msg, now()), true);
      return { message: msg, stopped: true };
    }
    const part = toErrorPart(err);
    closeOpenReasoning();
    const stopped = finalizeStopped(msg, now());
    set({ ...stopped, parts: [...stopped.parts, part], status: 'error', finishReason: 'error' }, true);
    return { message: msg, error: part };
  }

  function closeOpenReasoning() {
    const i = msg.parts.length - 1;
    const last = msg.parts[i];
    if (last && last.type === 'reasoning' && last.durationMs === undefined) {
      const parts = msg.parts.slice();
      parts[i] = { ...last, durationMs: 0 };
      msg = { ...msg, parts };
    }
  }
}

/** Whether a call must wait for the person. */
export function needsApproval(tool: AssistantTool, args: unknown, autonomy: AssistantSettings['autonomy'], isAlwaysApproved: (name: string) => boolean): boolean {
  if ((tool.kind ?? 'write') === 'read') return false;
  if (isAlwaysApproved(tool.name)) return false;
  if (autonomy !== 'auto') return true;
  try {
    return typeof tool.needsApproval === 'function' ? !!tool.needsApproval(args) : !!tool.needsApproval;
  } catch {
    return true;
  }
}
