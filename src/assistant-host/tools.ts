import { z } from 'zod';
import type { AssistantTool, Json, JSONSchema } from '../assistant/core/types';
import { featureChoice } from '../actions/appActions';
import type { AnyAction } from '../actions/registry';
import { FEATURE_BY_ID, type FeatureId } from '../features/registry';
import type { ContactsFeature } from '../features/contacts';
import type { SimulationFeature } from '../features/simulation';
import type { App } from '../ui/app';
import { locate } from '../ui/workspace/layout';
import { dataTools, leanSchema, zodTool, type DataContext } from './dataTools';

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

/** Most choices listed in a tool's description; a call that misses is told every one. */
const MAX_CHOICES = 12;

/**
 * The tools the assistant needs most often (reading the app and the data,
 * travelling, colouring, the formations, the selection, the main views):
 * always offered, even when a small context window leaves room only for
 * these and the kit's `find_tools` finds the rest.
 */
const CORE = new Set([
  'app.state',
  'ui.selection_details',
  'nav.go_to_depth',
  'nav.select_well',
  'nav.overview',
  'nav.set_mode',
  'view.color_by',
  'view.display',
  'scene.isolate',
  'scene.formation',
  'selection.set',
  'selection.clear',
  'panels.reveal',
  'views.logs',
  'views.correlate',
  'views.section',
  'views.crossplot_zone',
  'features.set',
  'interp.set_parameter',
]);

/** A core tool: one of `CORE`, or any tool that reads data (`data.*` reads). */
export const isCoreTool = (t: Pick<AssistantTool, 'name' | 'kind'>): boolean => CORE.has(t.name) || (t.kind === 'read' && t.name.startsWith('data.'));

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
      if (obj) s = leanSchema(obj) as JSONSchema;
    } catch {
      /* not representable: the registry still validates what the model sends */
    }
  schemaCache.set(a, s);
  return s;
}

/** The keys of an input the model can only fill from the choices: strings without an enum, integers (an index). */
function idKeys(s: JSONSchema): string[] {
  const props = (s.properties ?? {}) as Record<string, JSONSchema>;
  return Object.entries(props)
    .filter(([, p]) => (p.type === 'string' && !p.enum) || p.type === 'integer')
    .map(([k]) => k);
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** What the labels of several choices with the same id share, up to a separator: "Scene: undock", "Scene: move to…" → "Scene". */
function sharedLabel(labels: string[]): string {
  let p = labels[0];
  for (const l of labels) while (!l.startsWith(p)) p = p.slice(0, -1);
  if (p === labels[0]) return p;
  const cut = Math.max(p.lastIndexOf(': '), p.lastIndexOf(' · '), p.lastIndexOf(' — '));
  return cut > 0 ? p.slice(0, cut) : '';
}

type Choice = { value: string; label: string; current: boolean };

/**
 * The action's current choices, one per value of the ids the model must copy
 * (`panel`, `id`, `index`…), with its label where the label says more than
 * the value: `panel: scene (current), logs (Well logs), …`. Values an enum in
 * the schema already lists are not repeated.
 */
function choicesOf(app: App, a: AnyAction<App>): { keys: string[]; list: Choice[] } | null {
  if (!a.choices) return null;
  let raw: ReturnType<NonNullable<typeof a.choices>>;
  try {
    raw = a.choices(app);
  } catch {
    return null;
  }
  // the id keys the choices fill (not a free `name` beside the `id`)
  const keys = idKeys(schemaOf(a)).filter((k) => raw.some((c) => (c.input as Record<string, unknown> | undefined)?.[k] !== undefined));
  if (!keys.length) return null;
  const byValue = new Map<string, { labels: string[]; current: boolean }>();
  for (const c of raw) {
    const input = (c.input ?? {}) as Record<string, unknown>;
    const ids = keys.filter((k) => input[k] !== undefined);
    if (!ids.length) continue;
    const value = keys.length === 1 ? String(input[keys[0]]) : JSON.stringify(Object.fromEntries(ids.map((k) => [k, input[k]])));
    const label = c.label.replace(/^\d+\.\s+/, '');
    const hit = byValue.get(value);
    if (hit) {
      hit.labels.push(label);
      hit.current ||= !!c.current;
    } else byValue.set(value, { labels: [label], current: !!c.current });
  }
  if (!byValue.size) return null;
  const list = [...byValue].map(([value, { labels, current }]) => {
    const label = sharedLabel(labels);
    return { value, label: squash(label) === squash(value) ? '' : label, current };
  });
  return { keys, list };
}

/** Choices as a line: `panel: scene (current), logs (Well logs); +3 more`. */
function choicesText(c: { keys: string[]; list: Choice[] }, max = Infinity): string {
  const shown = c.list.slice(0, max).map(({ value, label, current }) => {
    const note = [label, current ? 'current' : ''].filter(Boolean).join(', ');
    return note ? `${value} (${note})` : value;
  });
  const more = c.list.length > max ? `; +${c.list.length - max} more` : '';
  return `${c.keys.length === 1 ? `${c.keys[0]}: ` : 'Choices: '}${shown.join(', ')}${more}`;
}

/** Whether a title says nothing the tool's name and description do not (its words of four letters or more all appear there). */
function titleAddsNothing(title: string, name: string, description: string): boolean {
  const known = `${name.replace(/[._]/g, ' ')} ${description}`.toLowerCase();
  return title
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 4)
    .every((w) => known.includes(w.replace(/s$/, '')));
}

/** Whether two JSON values are equal: objects key by key (an undefined value is a missing key), arrays item by item. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!same(ra[k], rb[k])) return false;
  return true;
}

/**
 * Calls a choice's label cannot describe: a choice says what switching does
 * from the app's current state ("Hide Log curtain" while it shows), so a call
 * that asks for the state it already has matches none.
 */
const DESCRIBE: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  'features.set': ({ feature, on }) => {
    const f = typeof feature === 'string' ? FEATURE_BY_ID.get(feature as FeatureId) : undefined;
    return f && typeof on === 'boolean' ? featureChoice(f, !on) : undefined;
  },
};

/**
 * What a call of an action will do, in the app's words: the label of the
 * choice whose input is the call's arguments ("Close Crossplot", "Well
 * logs"), else the action's own phrase. Undefined when there is none: the
 * transcript then shows the title and the arguments.
 */
function describeCall(app: App, a: AnyAction<App>, args: unknown): string | undefined {
  try {
    if (!a.input || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const given = args as Record<string, unknown>;
    const own = DESCRIBE[a.id]?.(given);
    if (own) return own;
    const hit = a.choices?.(app).find((c) => same(c.input ?? {}, given));
    return hit?.label.replace(/^\d+\.\s+/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** One action as a tool. */
function actionTool(app: App, a: AnyAction<App>): AssistantTool {
  const title = titleAddsNothing(a.title, a.id, a.description) ? '' : `${a.title.replace(/[.…]+$/, '')}. `;
  const where = a.where ? ` UI: ${a.where}.` : '';
  const applies = a.appliesTo ? ` Acts on a selected ${a.appliesTo.join('/')}.` : '';
  const shortcut = a.shortcut ? ` Key: ${a.shortcut}.` : '';
  const choices = choicesOf(app, a);
  const tool: AssistantTool = {
    name: a.id,
    title: a.title,
    description: `${title}${a.description}${where}${applies}${shortcut}${choices ? ` ${choicesText(choices, MAX_CHOICES)}.` : ''}`,
    parameters: schemaOf(a),
    kind: READS.has(a.id) ? 'read' : 'write',
    needsApproval: actionNeedsApproval(a),
    describe: (args) => describeCall(app, a, args),
    execute: async (args) => {
      if (!app.actions.enabled(a)) throw new Error(`“${a.title}” (${a.id}) is not available right now. Read app.state to see why (e.g. no selection, the well has no logs, the feature is off).`);
      const r = await keepChatInView(app, () => app.actions.run(a.id, a.input ? (args ?? {}) : undefined));
      if (!r.ok) {
        // the description lists a few choices: a miss is told all of them
        const all = choicesOf(app, a);
        throw new Error(all ? `${r.error} ${choicesText(all)}.` : r.error);
      }
      return (r.result ?? { done: true }) as Json;
    },
  };
  if (isCoreTool(tool)) tool.core = true;
  return tool;
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

/** Sub-schemas this long are sent once: another tool's copy points at the core tool that has it. */
const SHARED_SCHEMA = 120;

/** A property schema without its `null` alternative (a nullable selection and an optional one are the same object). */
const nonNull = (p: JSONSchema): JSONSchema => {
  const alts = (p.anyOf as JSONSchema[] | undefined)?.filter((x) => x.type !== 'null');
  return alts?.length === 1 ? alts[0] : p;
};

const sharedCache = new WeakMap<JSONSchema, JSONSchema>();

/**
 * Replaces a property schema that a core tool already spells out under the
 * same name (the selection object, the formation ids) with a pointer to that
 * tool: the core tools are always offered, so the model has the full one.
 */
function shareSchemas(tools: AssistantTool[]): AssistantTool[] {
  const known = new Map<string, string>();
  for (const t of tools)
    if (t.core)
      for (const [k, p] of Object.entries((t.parameters.properties ?? {}) as Record<string, JSONSchema>)) {
        const json = JSON.stringify(nonNull(p));
        if (json.length >= SHARED_SCHEMA && !known.has(`${k} ${json}`)) known.set(`${k} ${json}`, t.name);
      }
  return tools.map((t) => {
    if (!t.parameters.properties) return t;
    let params = sharedCache.get(t.parameters);
    if (!params) {
      const props = t.parameters.properties as Record<string, JSONSchema>;
      const next = Object.fromEntries(
        Object.entries(props).map(([k, p]) => {
          const plain = nonNull(p);
          const owner = known.get(`${k} ${JSON.stringify(plain)}`);
          if (!owner || owner === t.name) return [k, p];
          const ref: JSONSchema = { type: plain.type ?? 'object', description: `As \`${k}\` of ${owner}` };
          if (plain.type === 'object') ref.properties = {};
          return [k, p === plain ? ref : { anyOf: [ref, { type: 'null' }] }];
        }),
      );
      params = Object.entries(next).some(([k, p]) => p !== props[k]) ? { ...t.parameters, properties: next } : t.parameters;
      sharedCache.set(t.parameters, params);
    }
    return params === t.parameters ? t : { ...t, parameters: params };
  });
}

/** Every tool the assistant may call in BoreWalk: the app's actions, the data tools and the selection read-out. */
export function appTools(app: App): AssistantTool[] {
  const actions = app.actions
    .list()
    .filter((a) => !EXCLUDED(a.id))
    .map((a) => actionTool(app, a));
  const fixed = fixedTools.get(app) ?? fixedTools.set(app, [...dataTools(dataContext(app)), selectionTool(app)].map((t) => (isCoreTool(t) ? { ...t, core: true } : t))).get(app)!;
  return shareSchemas([...actions, ...fixed]);
}
