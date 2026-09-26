import { a2uiPromptGuide } from '../a2ui';
import { RENDER_UI, builtinTools } from './builtinTools';
import { requestHistory } from './compaction';
import { estimateRequest, workingWindow } from './context';
import { buildSystemPrompt } from './systemPrompt';
import { FIND_TOOLS, findToolsTool, isAlwaysOffered, shouldDeferTools } from './toolSearch';
import { sanitizeToolName } from './toolNames';
import type { AssistantHost, AssistantTool, AutonomyMode, ChatMessage, Compaction, ProviderConfig, Thread, WireTool } from './types';

/*
 * What a request is made of, apart from the messages: the tools offered
 * (all of them, or the core ones plus `find_tools` in a small window) and
 * the system prompt. Shared by the agent loop and by the controller's
 * estimate of how full the context is.
 */

export interface PlanInput {
  host: AssistantHost;
  config: ProviderConfig;
  autonomy: AutonomyMode;
  thread: Pick<Thread, 'toolMode' | 'enabledTools'>;
  /** the model's context window (tokens) */
  window: number;
  /** `find_tools` as the running turn executes it (the estimate uses an inert one) */
  findTools?: AssistantTool;
}

export interface ToolPlan {
  /** the tools offered in this step */
  tools: AssistantTool[];
  byName: Map<string, AssistantTool>;
  /** tools that exist but are not offered (found with `find_tools`) */
  hidden: AssistantTool[];
  deferred: boolean;
  /** the tool mode the thread keeps for this connection */
  mode: { connection: string; deferred: boolean };
}

/** The connection a thread's tool mode was chosen for. */
export const connectionKey = (c: Pick<ProviderConfig, 'id' | 'model'>) => `${c.id}|${c.model}`;

const inertFindTools = findToolsTool({ deferred: () => [], enable: () => {} });

/** The tools a step offers. */
export function planTools(input: PlanInput): ToolPlan {
  const connection = connectionKey(input.config);
  const all = new Map<string, AssistantTool>();
  if (input.config.tools !== false) {
    let hostTools: AssistantTool[] = [];
    try {
      hostTools = input.host.tools() ?? [];
    } catch {
      /* a failing host keeps the built-ins */
    }
    const builtins = builtinTools().map((t) => ({ ...t, kind: 'read' as const }));
    for (const t of [...hostTools, ...builtins]) {
      if (all.has(t.name) || t.name === FIND_TOOLS) continue;
      if (input.autonomy === 'read' && (t.kind ?? 'write') !== 'read') continue;
      all.set(t.name, t);
    }
  }
  const list = [...all.values()];
  const deferred = input.thread.toolMode?.connection === connection ? input.thread.toolMode.deferred && list.length > 0 : shouldDeferTools(list, workingWindow(input.window));
  const mode = { connection, deferred };
  if (!deferred) return { tools: list, byName: all, hidden: [], deferred, mode };
  const enabled = new Set(input.thread.enabledTools ?? []);
  const tools: AssistantTool[] = [];
  const hidden: AssistantTool[] = [];
  for (const t of list) (isAlwaysOffered(t) || enabled.has(t.name) ? tools : hidden).push(t);
  tools.push(input.findTools ?? inertFindTools);
  return { tools, byName: new Map(tools.map((t) => [t.name, t])), hidden, deferred, mode };
}

/** The system prompt for a tool plan (the same for every step and turn while the plan's mode holds). */
export function planSystem(input: Pick<PlanInput, 'host' | 'autonomy'>, plan: Pick<ToolPlan, 'tools' | 'deferred'>): string {
  let guide: string | undefined;
  if (plan.tools.some((t) => t.name === RENDER_UI)) {
    try {
      guide = typeof a2uiPromptGuide === 'function' ? a2uiPromptGuide() : undefined;
    } catch {
      guide = undefined;
    }
  }
  return buildSystemPrompt({ host: input.host, autonomy: input.autonomy, tools: plan.tools.length > 0, a2uiGuide: guide, deferredTools: plan.deferred });
}

/** Tools as sent (names sanitised). */
export const wireToolsOf = (tools: AssistantTool[], toWire: (name: string) => string = sanitizeToolName): WireTool[] =>
  tools.map((t) => ({ name: toWire(t.name), description: t.description, parameters: t.parameters }));

/**
 * The estimated tokens of the next request of a thread (before calibration):
 * system prompt, tools and the request history (summary, shortened results).
 */
export function estimateNextRequest(input: PlanInput & { messages: ChatMessage[]; compactions?: Compaction[] }): number {
  const plan = planTools(input);
  const system = planSystem(input, plan);
  return estimateRequest({ system, tools: wireToolsOf(plan.tools), messages: requestHistory(input.messages, input.compactions) });
}
