/*
 * Turns whatever a model or an SDK hands over into a flat list of v0.9
 * message objects: a JSON string (array, single object or JSONL), a
 * `{ messages: [...] }` wrapper, nested arrays, a missing `version`, and the
 * legacy v0.8 vocabulary (`surfaceUpdate`, `dataModelUpdate`,
 * `beginRendering`, wrapped component types and `literalString` values).
 */
import { BASIC_CATALOG_ID, MESSAGE_KINDS } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parses JSON text holding A2UI messages: one value (array or object), or one object per line (JSONL). */
export function parseMessagesText(text: string): { messages: unknown[]; error?: string } {
  const src = text.trim();
  if (!src) return { messages: [] };
  try {
    return { messages: flattenMessages(JSON.parse(src)) };
  } catch (err) {
    // JSONL: one message per non-empty line
    const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const out: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          out.push(...flattenMessages(JSON.parse(lines[i])));
        } catch (lineErr) {
          return { messages: out, error: `line ${i + 1} is not valid JSON (${(lineErr as Error).message})` };
        }
      }
      return { messages: out };
    }
    return { messages: [], error: `not valid JSON (${(err as Error).message})` };
  }
}

/** Flattens arrays, `{messages: [...]}` wrappers and JSON strings into a list of message candidates. */
export function flattenMessages(input: unknown): unknown[] {
  if (typeof input === 'string') return parseMessagesText(input).messages;
  if (Array.isArray(input)) return input.flatMap((m) => (typeof m === 'string' || Array.isArray(m) || (isRec(m) && Array.isArray(m.messages)) ? flattenMessages(m) : [m]));
  if (isRec(input) && Array.isArray(input.messages)) return flattenMessages(input.messages);
  return input === undefined || input === null ? [] : [input];
}

// ------------------------------------------------------------------ v0.8 → v0.9

const V08_PROP_RENAMES: Record<string, Record<string, string>> = {
  Text: { usageHint: 'variant' },
  Image: { altText: 'description' },
  Row: { distribution: 'justify', alignment: 'align' },
  Column: { distribution: 'justify', alignment: 'align' },
  List: { alignment: 'align' },
  Tabs: { tabItems: 'tabs' },
  Modal: { entryPointChild: 'trigger', contentChild: 'content' },
  TextField: { text: 'value', textFieldType: 'variant' },
  Slider: { minValue: 'min', maxValue: 'max' },
};

/** Unwraps v0.8 value wrappers (`{literalString: "x"}`), child lists and templates, recursively. */
function convertV08Value(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(convertV08Value);
  if (!isRec(v)) return v;
  if ('path' in v && typeof v.path === 'string') return { path: v.path };
  for (const key of ['literalString', 'literalNumber', 'literalBoolean', 'literalArray']) if (key in v) return v[key];
  if (Array.isArray(v.explicitList)) return v.explicitList;
  if (isRec(v.template)) return { componentId: v.template.componentId, path: v.template.dataBinding ?? v.template.path };
  const out: Rec = {};
  for (const [k, val] of Object.entries(v)) out[k] = convertV08Value(val);
  return out;
}

/** Converts one component from either version's shape to the flat v0.9 one. */
export function normalizeComponent(raw: unknown): unknown {
  if (!isRec(raw)) return raw;
  if (!isRec(raw.component)) return raw;
  // v0.8: { id, weight, component: { Text: { … } } }
  const entries = Object.entries(raw.component);
  if (entries.length !== 1) return raw;
  let [type, props] = entries[0] as [string, unknown];
  const out: Rec = { id: raw.id };
  if (raw.weight !== undefined) out.weight = raw.weight;
  const renames = V08_PROP_RENAMES[type] ?? {};
  const p: Rec = {};
  for (const [k, v] of Object.entries(isRec(props) ? props : {})) p[renames[k] ?? k] = convertV08Value(v);
  if (type === 'Image' && p.fit === 'scale-down') p.fit = 'scaleDown';
  if (type === 'TextField' && p.variant === 'date') p.variant = 'shortText';
  if (type === 'Button') {
    if (p.primary === true) p.variant = 'primary';
    delete p.primary;
    const action = p.action;
    if (isRec(action) && typeof action.name === 'string') {
      const context: Rec = {};
      if (Array.isArray(action.context)) {
        for (const e of action.context) if (isRec(e) && typeof e.key === 'string') context[e.key] = e.value;
      } else if (isRec(action.context)) Object.assign(context, action.context);
      p.action = { event: { name: action.name, context } };
    }
  }
  if (type === 'MultipleChoice') {
    type = 'ChoicePicker';
    const style = p.variant;
    p.value = p.selections ?? [];
    delete p.selections;
    p.variant = p.maxAllowedSelections === 1 ? 'mutuallyExclusive' : 'multipleSelection';
    delete p.maxAllowedSelections;
    p.displayStyle = style === 'chips' ? 'chips' : 'checkbox';
  }
  if (type === 'Tabs' && Array.isArray(p.tabs)) p.tabs = p.tabs.map((t) => (isRec(t) ? { title: t.title, child: t.child } : t));
  return { ...out, component: type, ...p };
}

/** Converts v0.8 data-model entries (`[{key, valueString}]`) to a plain object. */
function convertV08Contents(contents: unknown): unknown {
  if (!Array.isArray(contents)) return contents;
  const out: Rec = {};
  for (const e of contents) {
    if (!isRec(e) || typeof e.key !== 'string') continue;
    if ('valueString' in e) out[e.key] = e.valueString;
    else if ('valueNumber' in e) out[e.key] = e.valueNumber;
    else if ('valueBoolean' in e) out[e.key] = e.valueBoolean;
    else if ('valueMap' in e) out[e.key] = convertV08Contents(e.valueMap);
    else if ('valueArray' in e) out[e.key] = e.valueArray;
    else if ('value' in e) out[e.key] = e.value;
  }
  return out;
}

/**
 * Normalises one message candidate to zero or more v0.9 messages (a v0.8
 * `dataModelUpdate` becomes one upsert per key, so it merges like v0.8 did).
 * A v0.8 `beginRendering` becomes a `createSurface` that also carries
 * `root`. Unrecognisable input is returned unchanged for the validator to name.
 */
export function normalizeMessage(raw: unknown): unknown[] {
  if (!isRec(raw)) return [raw];
  const version = raw.version === 'v0.9.1' ? 'v0.9.1' : 'v0.9';
  if (isRec(raw.surfaceUpdate)) {
    const su = raw.surfaceUpdate;
    return [{ version, updateComponents: { surfaceId: su.surfaceId, components: Array.isArray(su.components) ? su.components.map(normalizeComponent) : su.components } }];
  }
  if (isRec(raw.dataModelUpdate)) {
    const du = raw.dataModelUpdate;
    const base = typeof du.path === 'string' && du.path !== '/' ? du.path.replace(/\/$/, '') : '';
    if (!Array.isArray(du.contents)) return [{ version, updateDataModel: { surfaceId: du.surfaceId, path: du.path, value: du.contents } }];
    const value = convertV08Contents(du.contents) as Rec;
    return Object.entries(value).map(([k, v]) => ({ version, updateDataModel: { surfaceId: du.surfaceId, path: `${base}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: v } }));
  }
  if (isRec(raw.beginRendering)) {
    const br = raw.beginRendering;
    return [{ version, createSurface: { surfaceId: br.surfaceId, catalogId: typeof br.catalogId === 'string' ? br.catalogId : BASIC_CATALOG_ID, root: br.root, legacy: true } }];
  }
  const kinds = MESSAGE_KINDS.filter((k) => k in raw);
  if (kinds.length !== 1) return [raw];
  const kind = kinds[0];
  const body = raw[kind];
  if (kind === 'updateComponents' && isRec(body) && Array.isArray(body.components)) {
    const needs = body.components.some((c) => isRec(c) && isRec(c.component));
    return [{ ...raw, version: raw.version ?? version, updateComponents: needs ? { ...body, components: body.components.map(normalizeComponent) } : body }];
  }
  if (kind === 'createSurface' && isRec(body) && (Array.isArray(body.components) || 'dataModel' in body)) {
    // v1.0 lets createSurface carry the first components and data inline
    const { components, dataModel, ...create } = body;
    const out: unknown[] = [{ version, createSurface: create }];
    if (Array.isArray(components) && components.length) out.push({ version, updateComponents: { surfaceId: body.surfaceId, components: components.map(normalizeComponent) } });
    if (dataModel !== undefined) out.push({ version, updateDataModel: { surfaceId: body.surfaceId, path: '/', value: dataModel } });
    return out;
  }
  return [raw.version === undefined ? { ...raw, version } : raw];
}

/** Flattens and normalises a whole stream. */
export function normalizeMessages(input: unknown): unknown[] {
  return flattenMessages(input).flatMap(normalizeMessage);
}
