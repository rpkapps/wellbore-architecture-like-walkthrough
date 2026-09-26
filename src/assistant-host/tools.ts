import { z } from 'zod';
import type { AssistantTool, Json, JSONSchema } from '../assistant/core/types';
import type { AnyAction } from '../actions/registry';
import type { ContactsFeature } from '../features/contacts';
import type { SimulationFeature } from '../features/simulation';
import type { App } from '../ui/app';
import { locate } from '../ui/workspace/layout';
import { dataTools, zodTool, type DataContext } from './dataTools';

/*
 * The tools BoreWalk gives its assistant: every action of the app (the same
 * registry the command palette and the keys run, so a tool call does exactly
 * what the person could do), the read-only data tools, and the selection's
 * details. Read at the start of every step, so the choices listed in the
 * descriptions (wells, panels, workspaces) are the current ones.
 */

/**
 * Actions an assistant should not call: its own (it would open or talk to
 * itself) and full screen, which a browser only grants to a click.
 */
const EXCLUDED = (id: string) => id.startsWith('assistant.') || id === 'app.fullscreen';

/** Actions that only read: never need approval. */
const READS = new Set(['app.state', 'data.list', 'data.plugins']);

/**
 * Actions that ask first even when the person lets the assistant act on its
 * own: a connection to an address the model chose, and discarding a
 * workspace's layout.
 */
const ALWAYS_ASK = new Set(['data.connect', 'workspace.reset']);

/** Whether an action waits for the person's approval (the assistant asks first; an answer's `app://action` link refuses it). */
export const actionNeedsApproval = (a: Pick<AnyAction<App>, 'id' | 'needsApproval'>): boolean => !!a.needsApproval || ALWAYS_ASK.has(a.id);

/** Most choices listed in a tool's description. */
const MAX_CHOICES = 30;

const schemaCache = new WeakMap<AnyAction<App>, JSONSchema>();

/** An action's input as a JSON Schema of type object (tool parameters must be objects). */
function schemaOf(a: AnyAction<App>): JSONSchema {
  const hit = schemaCache.get(a);
  if (hit) return hit;
  let s: JSONSchema = { type: 'object', properties: {} };
  if (a.input)
    try {
      const raw = z.toJSONSchema(a.input, { io: 'input', unrepresentable: 'any' }) as JSONSchema;
      const { $schema: _drop, ...rest } = raw;
      void _drop;
      // an optional object input comes out as anyOf [object, null-ish]: keep the object
      const obj = rest.type === 'object' ? rest : ((rest.anyOf as JSONSchema[] | undefined)?.find((x) => x.type === 'object') ?? null);
      if (obj) s = obj;
    } catch {
      /* not representable: the registry still validates what the model sends */
    }
  schemaCache.set(a, s);
  return s;
}

/** Does the schema take a free id (a string without an enum, or an index) the model can only learn from the choices? */
function takesIds(s: JSONSchema): boolean {
  const props = (s.properties ?? {}) as Record<string, JSONSchema>;
  return Object.values(props).some((p) => (p.type === 'string' && !p.enum) || p.type === 'integer');
}

/** The action's current choices, in a line the model can copy from: `Well logs {"panel":"logs"}`. */
function choicesLine(app: App, a: AnyAction<App>): string {
  if (!a.choices || !takesIds(schemaOf(a))) return '';
  let list: ReturnType<NonNullable<typeof a.choices>>;
  try {
    list = a.choices(app);
  } catch {
    return '';
  }
  if (!list.length) return '';
  const shown = list.slice(0, MAX_CHOICES).map((c) => `${c.label}${c.current ? ' (current)' : ''} ${JSON.stringify(c.input)}`);
  return ` Current choices: ${shown.join('; ')}${list.length > MAX_CHOICES ? `; … ${list.length - MAX_CHOICES} more` : ''}.`;
}

/** One action as a tool. */
function actionTool(app: App, a: AnyAction<App>): AssistantTool {
  const where = a.where ? ` Where in the UI: ${a.where}.` : '';
  const applies = a.appliesTo ? ` Acts on a selected ${a.appliesTo.join(' / ')} (its id from app.state.selection).` : '';
  const shortcut = a.shortcut ? ` Key: ${a.shortcut}.` : '';
  return {
    name: a.id,
    title: a.title,
    description: `${a.title}. ${a.description}${where}${applies}${shortcut}${choicesLine(app, a)}`,
    parameters: schemaOf(a),
    kind: READS.has(a.id) ? 'read' : 'write',
    needsApproval: actionNeedsApproval(a),
    execute: async (args) => {
      if (!app.actions.enabled(a)) throw new Error(`“${a.title}” (${a.id}) is not available right now. Read app.state to see why (e.g. no selection, the well has no logs, the feature is off).`);
      const r = await keepChatInView(app, () => app.actions.run(a.id, a.input ? (args ?? {}) : undefined));
      if (!r.ok) throw new Error(r.error);
      return (r.result ?? { done: true }) as Json;
    },
  };
}

/**
 * Runs an action without letting it hide the conversation: a panel it brings
 * to the front of the assistant's own tab group (asked to open the well
 * logs, which share the right sidebar with it) moves to the sidebar's other
 * slot instead, so the person sees both the chat and what it opened.
 */
export async function keepChatInView<T>(app: App, run: () => Promise<T>): Promise<T> {
  const ws = app.workspace;
  const shown = ws.isShown('assistant');
  const result = await run();
  if (!shown || ws.isShown('assistant')) return result;
  const at = locate(ws.value, 'assistant');
  if (at?.kind !== 'dock' || at.zone === 'bottom') return result;
  const cover = at.stack.active;
  if (cover === 'assistant') return result;
  ws.dock(cover, at.zone, at.index === 0 ? 'bottom' : 'top');
  ws.activate('assistant');
  return result;
}

/** What the data tools read from the app. */
export function dataContext(app: App): DataContext {
  return {
    field: app.field,
    activeWell: () => app.engine?.activeWell,
    contacts: () => (app.flags?.on('owc') ? app.feature<ContactsFeature>('owc')?.estimate : null),
    simulation: () => app.feature<SimulationFeature>('simulation')?.model,
    extraWellsOn: () => !!app.flags?.on('extraWells'),
  };
}

/** The selected object's details (the Properties read-out) as JSON. */
function selectionTool(app: App): AssistantTool {
  return zodTool({
    name: 'ui.selection_details',
    title: 'Selection details',
    description: 'The selected object (well, formation, pick, contact, overlay or interval) and every read-out Properties shows for it, with provenance. Null when nothing is selected.',
    input: z.object({}),
    run: () => {
      const sel = app.selection.value;
      const v = app.inspector.value;
      if (!sel || !v) return { selection: null };
      return { selection: sel as unknown as Json, title: v.title, subtitle: v.sub, details: inspectorRows(v.rows) };
    },
  });
}

/** Inspector rows as JSON: sections by heading, each a list of label, value and provenance. */
export function inspectorRows(rows: NonNullable<App['inspector']['value']>['rows']): Json {
  const out: { section: string | null; rows: Json[] }[] = [{ section: null, rows: [] }];
  for (const r of rows) {
    if (r === 'sep') continue;
    if (!Array.isArray(r)) out.push({ section: r.h, rows: [] });
    else {
      const [label, value, prov] = r;
      out[out.length - 1].rows.push(prov ? { label, value, provenance: prov } : { label, value });
    }
  }
  return out.filter((s) => s.rows.length) as unknown as Json;
}

/** The tools that do not change with the app's state, built once per app. */
const fixedTools = new WeakMap<App, AssistantTool[]>();

/** Every tool the assistant may call in BoreWalk: the app's actions, the data tools and the selection read-out. */
export function appTools(app: App): AssistantTool[] {
  const actions = app.actions
    .list()
    .filter((a) => !EXCLUDED(a.id))
    .map((a) => actionTool(app, a));
  const fixed = fixedTools.get(app) ?? fixedTools.set(app, [...dataTools(dataContext(app)), selectionTool(app)]).get(app)!;
  return [...actions, ...fixed];
}
