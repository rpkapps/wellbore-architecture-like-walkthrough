/*
 * Checks a complete A2UI stream against the protocol and the two catalogs,
 * and phrases each problem so a model can fix it on its next try: where it
 * is (`messages[1].updateComponents.components[3] (id "chart", Chart)`),
 * what is wrong, and what would be right (the allowed values, the dataset's
 * columns, the ids that do exist).
 */
import type { Dataset } from '../core/types';
import { CHART_COLORS, COMPONENTS, ICON_NAMES, PROP_HINTS, refsOf, type PropSpec } from './catalog/schema';
import { isBinding, isFunctionCall, isKnownFunction } from './functions';
import { flattenMessages, normalizeMessage, parseMessagesText } from './normalize';
import { getAt, resolvePath, setAt, removeAt } from './pointer';
import { DATA_CATALOG_ID, MESSAGE_KINDS, SUPPORTED_CATALOG_IDS } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (s: unknown) => JSON.stringify(s);
const list = (xs: readonly string[], max = 12) => (xs.length > max ? `${xs.slice(0, max).join(', ')}, …` : xs.join(', '));

export interface ValidateOptions {
  /** the thread's datasets, to check `dataset` ids and column names */
  datasets?: Record<string, Dataset> | ReadonlyMap<string, Dataset>;
}

interface SurfaceInfo {
  catalogId: string;
  created: string;
  components: Map<string, { c: Rec; where: string }>;
  model: unknown;
  legacyRoot?: string;
}

/**
 * Validates a stream (an array of messages, a JSON string, JSONL, or a
 * `{messages}` wrapper). Returns one message per problem; empty means valid.
 */
export function validateMessages(messages: unknown, opts: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  const raw: unknown[] = [];
  const top = Array.isArray(messages) ? messages : [messages];
  for (const item of top) {
    if (typeof item === 'string') {
      const parsed = parseMessagesText(item);
      if (parsed.error) errors.push(`The A2UI JSON does not parse: ${parsed.error}. Send a JSON array of message objects.`);
      raw.push(...parsed.messages);
    } else raw.push(...flattenMessages(item));
  }
  if (!raw.length) return errors.length ? errors : ['No A2UI messages: expected a non-empty array of messages (createSurface first, then updateComponents).'];

  const datasets = toDatasetMap(opts.datasets);
  const surfaces = new Map<string, SurfaceInfo>();
  const pendingComponentChecks: { surface: string; c: Rec; where: string }[] = [];

  raw.forEach((msg, i) => {
    const at = `messages[${i}]`;
    if (!isRec(msg)) {
      errors.push(`${at}: each message must be a JSON object, got ${Array.isArray(msg) ? 'an array' : typeof msg}.`);
      return;
    }
    if (msg.version !== undefined && msg.version !== 'v0.9' && msg.version !== 'v0.9.1') errors.push(`${at}.version: must be "v0.9" (got ${q(msg.version)}).`);
    const legacy = ['surfaceUpdate', 'dataModelUpdate', 'beginRendering'].find((k) => k in msg);
    const kinds = MESSAGE_KINDS.filter((k) => k in msg);
    if (!legacy && kinds.length !== 1) {
      const extra = Object.keys(msg).filter((k) => k !== 'version');
      errors.push(
        kinds.length
          ? `${at}: a message holds exactly one of createSurface, updateComponents, updateDataModel, deleteSurface (found ${kinds.join(' and ')}); split it into separate messages.`
          : `${at}: unknown message (keys: ${list(extra)}); use one of createSurface, updateComponents, updateDataModel, deleteSurface.`,
      );
      return;
    }
    for (const m of normalizeMessage(msg)) {
      if (!isRec(m)) continue;
      const kind = MESSAGE_KINDS.find((k) => k in m)!;
      const body = m[kind];
      const bat = legacy ? `${at}.${legacy}` : `${at}.${kind}`;
      if (!isRec(body)) {
        errors.push(`${bat}: must be an object.`);
        continue;
      }
      const sid = body.surfaceId;
      if (typeof sid !== 'string' || !sid) {
        errors.push(`${bat}.surfaceId: required (a non-empty string).`);
        continue;
      }
      if (kind === 'createSurface') {
        if (surfaces.has(sid) && !legacy) errors.push(`${bat}: surface ${q(sid)} already exists; use a new surfaceId or send deleteSurface first.`);
        const catalogId = typeof body.catalogId === 'string' ? body.catalogId : '';
        if (!catalogId) errors.push(`${bat}.catalogId: required; use ${q(DATA_CATALOG_ID)}.`);
        else if (!(SUPPORTED_CATALOG_IDS as readonly string[]).includes(catalogId)) errors.push(`${bat}.catalogId: unknown catalog ${q(catalogId)}; use ${q(DATA_CATALOG_ID)}.`);
        const existing = surfaces.get(sid);
        if (existing && legacy) existing.catalogId = catalogId || existing.catalogId;
        else surfaces.set(sid, { catalogId: catalogId || DATA_CATALOG_ID, created: bat, components: new Map(), model: {}, legacyRoot: typeof body.root === 'string' ? body.root : undefined });
        if (legacy && typeof body.root === 'string') surfaces.get(sid)!.legacyRoot = body.root;
        continue;
      }
      let s = surfaces.get(sid);
      if (!s && kind !== 'deleteSurface') {
        if (legacy) {
          s = { catalogId: DATA_CATALOG_ID, created: bat, components: new Map(), model: {} };
          surfaces.set(sid, s);
        } else {
          errors.push(`${bat}: surface ${q(sid)} was not created; send {"version":"v0.9","createSurface":{"surfaceId":${q(sid)},"catalogId":${q(DATA_CATALOG_ID)}}} before it.`);
          continue;
        }
      }
      if (kind === 'deleteSurface') {
        surfaces.delete(sid);
        continue;
      }
      if (kind === 'updateComponents') {
        if (!Array.isArray(body.components) || !body.components.length) {
          errors.push(`${bat}.components: required, a non-empty array of components.`);
          continue;
        }
        const seen = new Set<string>();
        body.components.forEach((c, ci) => {
          const cat = `${bat}.components[${ci}]`;
          if (!isRec(c)) return void errors.push(`${cat}: must be an object like {"id":"title","component":"Text","text":"…"}.`);
          if (typeof c.id !== 'string' || !c.id) return void errors.push(`${cat}: "id" is required (a unique string).`);
          if (typeof c.component !== 'string' || !c.component)
            return void errors.push(`${cat} (id ${q(c.id)}): "component" is required, the type name as a string, e.g. "component":"Text" (props go next to it, not inside).`);
          if (seen.has(c.id)) errors.push(`${cat}: duplicate id ${q(c.id)} in the same message; ids must be unique within a surface.`);
          seen.add(c.id);
          const where = `${cat} (id ${q(c.id)}, ${c.component})`;
          s!.components.set(c.id, { c, where });
          pendingComponentChecks.push({ surface: sid, c, where });
        });
        continue;
      }
      if (kind === 'updateDataModel') {
        const path = body.path === undefined ? '/' : body.path;
        if (typeof path !== 'string' || (path !== '/' && !path.startsWith('/'))) {
          errors.push(`${bat}.path: must be a JSON Pointer starting with "/" (got ${q(path)}).`);
          continue;
        }
        s!.model = !('value' in body) ? removeAt(s!.model, path) : path === '/' ? body.value : setAt(s!.model, path, body.value);
      }
    }
  });

  // component-level checks, once every surface's final data model is known
  for (const { surface, c, where } of pendingComponentChecks) {
    const s = surfaces.get(surface);
    if (!s) continue;
    checkComponent(c, where, s, datasets, errors);
  }

  // tree checks per surface
  for (const [sid, s] of surfaces) {
    const rootId = s.legacyRoot ?? 'root';
    if (!s.components.size) {
      errors.push(`surface ${q(sid)}: has no components; send an updateComponents message with a component whose id is "root".`);
      continue;
    }
    if (!s.components.has(rootId)) {
      errors.push(`surface ${q(sid)}: no component has id "root"; exactly one component (usually a Column) must be the root. Ids present: ${list([...s.components.keys()])}.`);
      continue;
    }
    for (const { c, where } of s.components.values())
      for (const r of refsOf(c))
        if (!s.components.has(r.id)) errors.push(`${where}.${r.prop}: refers to ${q(r.id)}, which is not defined; add a component with that id or remove the reference.`);
    const cycle = findCycle(s, rootId);
    if (cycle) errors.push(`surface ${q(sid)}: components form a cycle (${cycle.join(' → ')}); a component cannot contain itself.`);
  }
  return errors;
}

function toDatasetMap(d: ValidateOptions['datasets']): Map<string, Dataset> | null {
  if (!d) return null;
  if (d instanceof Map) return d as Map<string, Dataset>;
  return new Map(Object.entries(d as Record<string, Dataset>));
}

function findCycle(s: SurfaceInfo, rootId: string): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    const node = s.components.get(id);
    if (!node) return null;
    state.set(id, 1);
    stack.push(id);
    for (const r of refsOf(node.c)) {
      const found = visit(r.id);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  return visit(rootId) ?? [...s.components.keys()].reduce<string[] | null>((acc, id) => acc ?? visit(id), null);
}

// ------------------------------------------------------------------ one component

function checkComponent(c: Rec, where: string, s: SurfaceInfo, datasets: Map<string, Dataset> | null, errors: string[]): void {
  const type = String(c.component);
  const spec = COMPONENTS[type];
  if (!spec) {
    const near = Object.keys(COMPONENTS).find((k) => k.toLowerCase() === type.toLowerCase());
    errors.push(`${where}: unknown component ${q(type)}${near ? `; did you mean ${q(near)}?` : `. Available: ${list(Object.keys(COMPONENTS), 40)}.`}`);
    return;
  }
  if (spec.catalog === 'data' && s.catalogId !== DATA_CATALOG_ID)
    errors.push(`${where}: ${type} is in the data catalog, not ${q(s.catalogId)}; set createSurface.catalogId to ${q(DATA_CATALOG_ID)}.`);
  for (const p of spec.required) if (c[p] === undefined) errors.push(`${where}: missing required prop ${q(p)} (${type}: ${spec.summary}).`);
  const hints = PROP_HINTS[type] ?? {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'id' || k === 'component' || k === 'accessibility' || k === 'weight') continue;
    const p = spec.props[k];
    if (!p) {
      if (hints[k]) errors.push(`${where}: unknown prop ${q(k)}; use ${hints[k]}.`);
      continue;
    }
    checkProp(v, p, `${where}.${k}`, errors);
  }
  checkSpecific(type, c, where, s, datasets, errors);
}

function checkDynamic(v: unknown, at: string, expect: string, errors: string[]): boolean {
  if (isBinding(v)) {
    const keys = Object.keys(v);
    if (keys.length > 1) errors.push(`${at}: a binding is exactly {"path": "…"}; remove ${list(keys.filter((k) => k !== 'path'))}.`);
    return true;
  }
  if (isFunctionCall(v)) {
    checkCall(v as unknown as Rec, at, errors);
    return true;
  }
  if (isRec(v)) {
    errors.push(`${at}: expected ${expect}, {"path": "/pointer"} or {"call": …}; got an object with keys ${list(Object.keys(v))}.`);
    return true;
  }
  return false;
}

function checkCall(v: Rec, at: string, errors: string[]): void {
  if (!isKnownFunction(String(v.call))) errors.push(`${at}: unknown function ${q(v.call)}; available: required, regex, length, numeric, email, formatString, formatNumber, formatCurrency, formatDate, pluralize, openUrl, and, or, not.`);
  if (v.args !== undefined && !isRec(v.args)) errors.push(`${at}.args: must be an object of named arguments.`);
}

function checkProp(v: unknown, p: PropSpec, at: string, errors: string[]): void {
  switch (p.t) {
    case 'dstring':
      if (!checkDynamic(v, at, 'a string', errors) && typeof v !== 'string' && typeof v !== 'number') errors.push(`${at}: expected a string (got ${typeofJson(v)}).`);
      return;
    case 'dnumber':
      if (!checkDynamic(v, at, 'a number', errors) && typeof v !== 'number') errors.push(`${at}: expected a number (got ${typeofJson(v)}).`);
      return;
    case 'dbool':
      if (!checkDynamic(v, at, 'a boolean', errors) && typeof v !== 'boolean') errors.push(`${at}: expected true/false or {"path": …} (got ${typeofJson(v)}).`);
      return;
    case 'dlist':
      if (!checkDynamic(v, at, 'an array of strings', errors) && !(Array.isArray(v) && v.every((x) => typeof x === 'string')))
        errors.push(`${at}: expected an array of strings (even for a single choice) or {"path": …}.`);
      return;
    case 'dany':
    case 'any':
      checkDynamic(v, at, 'a value', errors);
      return;
    case 'string':
      if (typeof v !== 'string') errors.push(`${at}: expected a string (got ${typeofJson(v)}).`);
      return;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${at}: expected a number (got ${typeofJson(v)}).`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${at}: expected true or false (got ${typeofJson(v)}).`);
      return;
    case 'object':
      if (!isRec(v)) errors.push(`${at}: expected an object (got ${typeofJson(v)}).`);
      return;
    case 'array':
      if (!Array.isArray(v)) errors.push(`${at}: expected an array (got ${typeofJson(v)}).`);
      return;
    case 'enum':
      if (typeof v !== 'string' || !p.values.includes(v)) errors.push(`${at}: ${q(v)} is not allowed; use one of ${p.values.join(', ')}.`);
      return;
    case 'ref':
      if (typeof v !== 'string') errors.push(`${at}: expected a component id (a string), got ${typeofJson(v)}; define the child as its own component and reference its id.`);
      return;
    case 'children':
      if (Array.isArray(v)) {
        v.forEach((x, i) => typeof x !== 'string' && errors.push(`${at}[${i}]: children are component ids (strings); define the child as its own component and list its id.`));
      } else if (isRec(v)) {
        if (typeof v.componentId !== 'string' || typeof v.path !== 'string') errors.push(`${at}: a template is {"componentId": "<id>", "path": "/array"}.`);
      } else errors.push(`${at}: expected an array of component ids or a template {"componentId", "path"} (got ${typeofJson(v)}).`);
      return;
    case 'action':
      if (!isRec(v)) return void errors.push(`${at}: expected {"event": {"name": "…", "context": {…}}}.`);
      if (isRec(v.event)) {
        if (typeof v.event.name !== 'string' || !v.event.name) errors.push(`${at}.event.name: required (a string).`);
        if (v.event.context !== undefined && !isRec(v.event.context)) errors.push(`${at}.event.context: must be an object of name → value or {"path": …}.`);
        else if (isRec(v.event.context)) for (const [k, cv] of Object.entries(v.event.context)) checkDynamic(cv, `${at}.event.context.${k}`, 'a value', errors);
      } else if (isRec(v.functionCall)) checkCall(v.functionCall, `${at}.functionCall`, errors);
      else if (typeof v.name === 'string') errors.push(`${at}: v0.9 wraps the action: {"event": {"name": ${q(v.name)}, "context": {…}}}.`);
      else errors.push(`${at}: expected {"event": {"name": "…"}} or {"functionCall": {"call": "openUrl", "args": {"url": "…"}}}.`);
      return;
    case 'checks':
      if (!Array.isArray(v)) return void errors.push(`${at}: expected an array of {"condition": {"call": …}, "message": "…"}.`);
      v.forEach((rule, i) => {
        if (!isRec(rule)) return void errors.push(`${at}[${i}]: expected {"condition": …, "message": "…"}.`);
        if (typeof rule.message !== 'string') errors.push(`${at}[${i}].message: required (a string).`);
        const cond = rule.condition ?? (isFunctionCall(rule) ? rule : undefined);
        if (cond === undefined) errors.push(`${at}[${i}].condition: required, e.g. {"call": "required", "args": {"value": {"path": "/form/name"}}}.`);
        else if (typeof cond !== 'boolean') checkDynamic(cond, `${at}[${i}].condition`, 'a boolean', errors);
      });
      return;
  }
}

function typeofJson(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  return `${typeof v} ${q(v)}`.slice(0, 60);
}

// ------------------------------------------------------------------ per-type rules

interface Source {
  columns: string[] | null;
  label: string;
}

function resolveSource(c: Rec, where: string, s: SurfaceInfo, datasets: Map<string, Dataset> | null, errors: string[], required: boolean): Source | null {
  const given = ['dataset', 'rows', 'path'].filter((k) => c[k] !== undefined);
  if (!given.length) {
    if (required) errors.push(`${where}: needs its data: "dataset": "<id>" (a dataset a tool returned), "rows": [{…}] or "path": "/pointer".`);
    return null;
  }
  if (given.length > 1) errors.push(`${where}: give one of dataset, rows or path (got ${given.join(' and ')}).`);
  if (typeof c.dataset === 'string') {
    if (!datasets) return { columns: null, label: `dataset ${q(c.dataset)}` };
    const ds = datasets.get(c.dataset);
    if (!ds) {
      errors.push(`${where}.dataset: no dataset ${q(c.dataset)}${datasets.size ? `; available: ${list([...datasets.values()].map((d) => `${d.id} (${d.title})`), 8)}` : '; no tool has returned a dataset in this thread yet — call a data tool first, or pass "rows"'}.`);
      return null;
    }
    return { columns: ds.columns.map((col) => col.key), label: `dataset ${q(ds.id)}` };
  }
  if (c.rows !== undefined) {
    if (!Array.isArray(c.rows)) {
      errors.push(`${where}.rows: expected an array of row objects like [{"x": 1, "y": 2}].`);
      return null;
    }
    const bad = c.rows.findIndex((r) => !isRec(r));
    if (bad >= 0) errors.push(`${where}.rows[${bad}]: each row must be an object of column → value.`);
    const cols = new Set<string>();
    for (const r of c.rows.slice(0, 200)) if (isRec(r)) Object.keys(r).forEach((k) => cols.add(k));
    return { columns: c.rows.length ? [...cols] : null, label: 'rows' };
  }
  if (typeof c.path === 'string') {
    const v = getAt(s.model, resolvePath(c.path));
    if (v === undefined) return { columns: null, label: `path ${q(c.path)}` };
    if (!Array.isArray(v)) {
      errors.push(`${where}.path: ${q(c.path)} holds ${typeofJson(v)}, not an array of rows.`);
      return null;
    }
    const cols = new Set<string>();
    for (const r of v.slice(0, 200)) if (isRec(r)) Object.keys(r).forEach((k) => cols.add(k));
    return { columns: v.length ? [...cols] : null, label: `path ${q(c.path)}` };
  }
  return null;
}

function checkColumn(col: unknown, at: string, src: Source | null, errors: string[]): void {
  if (typeof col !== 'string' || !col) return void errors.push(`${at}: expected a column name (a string).`);
  if (src?.columns && !src.columns.includes(col)) errors.push(`${at}: ${src.label} has no column ${q(col)}; columns: ${list(src.columns, 30)}.`);
}

function checkColor(v: unknown, at: string, errors: string[]): void {
  if (v !== undefined && !(CHART_COLORS as readonly string[]).includes(String(v))) errors.push(`${at}: ${q(v)} is not allowed; use one of ${CHART_COLORS.join(', ')}.`);
}

function checkSpecific(type: string, c: Rec, where: string, s: SurfaceInfo, datasets: Map<string, Dataset> | null, errors: string[]): void {
  switch (type) {
    case 'Icon': {
      const n = c.name;
      if (typeof n === 'string' && !(ICON_NAMES as readonly string[]).includes(n)) errors.push(`${where}.name: unknown icon ${q(n)}; use one of ${list([...ICON_NAMES], 60)}.`);
      else if (isRec(n) && typeof n.svgPath !== 'string' && typeof n.path !== 'string') errors.push(`${where}.name: expected an icon name, {"svgPath": "…"} or {"path": "…"}.`);
      return;
    }
    case 'Tabs':
      if (Array.isArray(c.tabs)) {
        if (!c.tabs.length) errors.push(`${where}.tabs: needs at least one tab.`);
        c.tabs.forEach((t, i) => {
          if (!isRec(t) || t.title === undefined || typeof t.child !== 'string') errors.push(`${where}.tabs[${i}]: expected {"title": "…", "child": "<component id>"}.`);
        });
      }
      return;
    case 'ChoicePicker':
      if (Array.isArray(c.options))
        c.options.forEach((o, i) => {
          if (!isRec(o) || o.label === undefined || typeof o.value !== 'string') errors.push(`${where}.options[${i}]: expected {"label": "…", "value": "<string>"}.`);
        });
      return;
    case 'Slider':
      if (typeof c.max === 'number' && typeof c.min === 'number' && c.min >= c.max) errors.push(`${where}: min (${c.min}) must be below max (${c.max}).`);
      return;
    case 'Chart': {
      const src = resolveSource(c, where, s, datasets, errors, true);
      if (c.x !== undefined) checkColumn(c.x, `${where}.x`, src, errors);
      if (Array.isArray(c.series)) {
        if (!c.series.length) errors.push(`${where}.series: needs at least one series, e.g. [{"column": "rate"}].`);
        c.series.forEach((se, i) => {
          const at = `${where}.series[${i}]`;
          if (typeof se === 'string') return checkColumn(se, at, src, errors);
          if (!isRec(se)) return void errors.push(`${at}: expected {"column": "<name>", "label": "…"}.`);
          checkColumn(se.column, `${at}.column`, src, errors);
          checkColor(se.color, `${at}.color`, errors);
          if (se.kind !== undefined && !['line', 'area', 'bar', 'scatter'].includes(String(se.kind))) errors.push(`${at}.kind: use one of line, area, bar, scatter.`);
          if (se.axis !== undefined && se.axis !== 'left' && se.axis !== 'right') errors.push(`${at}.axis: use "left" or "right".`);
        });
      }
      if (c.height !== undefined && (typeof c.height !== 'number' || c.height < 80 || c.height > 900)) errors.push(`${where}.height: a number of pixels between 80 and 900.`);
      return;
    }
    case 'DepthChart': {
      const src = resolveSource(c, where, s, datasets, errors, true);
      if (c.depth !== undefined) checkColumn(c.depth, `${where}.depth`, src, errors);
      if (c.tracks === undefined && c.curves === undefined) errors.push(`${where}: needs "tracks": [{"curves": [{"column": "<name>"}]}] (or "curves" for one track per curve).`);
      const curveList = (cs: unknown, at: string) => {
        if (!Array.isArray(cs) || !cs.length) return void errors.push(`${at}: expected a non-empty array of {"column": "<name>"}.`);
        cs.forEach((cv, j) => {
          if (typeof cv === 'string') return checkColumn(cv, `${at}[${j}]`, src, errors);
          if (!isRec(cv)) return void errors.push(`${at}[${j}]: expected {"column": "<name>"}.`);
          checkColumn(cv.column, `${at}[${j}].column`, src, errors);
          checkColor(cv.color, `${at}[${j}].color`, errors);
        });
      };
      if (Array.isArray(c.tracks))
        c.tracks.forEach((t, i) => {
          if (!isRec(t)) return void errors.push(`${where}.tracks[${i}]: expected {"curves": [{"column": "<name>"}], "scale": "linear"}.`);
          curveList(t.curves, `${where}.tracks[${i}].curves`);
          if (t.scale !== undefined && t.scale !== 'linear' && t.scale !== 'log') errors.push(`${where}.tracks[${i}].scale: use "linear" or "log".`);
        });
      if (c.curves !== undefined) curveList(c.curves, `${where}.curves`);
      if (Array.isArray(c.bands))
        c.bands.forEach((b, i) => {
          if (!isRec(b) || typeof b.from !== 'number' || typeof b.to !== 'number') errors.push(`${where}.bands[${i}]: expected {"from": <depth>, "to": <depth>, "label": "…"}.`);
          else checkColor(b.color, `${where}.bands[${i}].color`, errors);
        });
      if (Array.isArray(c.markers))
        c.markers.forEach((m, i) => {
          if (!isRec(m) || typeof m.depth !== 'number') errors.push(`${where}.markers[${i}]: expected {"depth": <number>, "label": "…"}.`);
        });
      return;
    }
    case 'DataTable': {
      const src = resolveSource(c, where, s, datasets, errors, true);
      if (Array.isArray(c.columns))
        c.columns.forEach((col, i) => {
          if (typeof col === 'string') return checkColumn(col, `${where}.columns[${i}]`, src, errors);
          if (!isRec(col)) return void errors.push(`${where}.columns[${i}]: expected {"key": "<column>", "label": "…"}.`);
          checkColumn(col.key, `${where}.columns[${i}].key`, src, errors);
          if (col.format !== undefined && !['number', 'integer', 'percent', 'date', 'datetime', 'text'].includes(String(col.format)))
            errors.push(`${where}.columns[${i}].format: use one of number, integer, percent, date, datetime, text.`);
        });
      return;
    }
    case 'Metric':
      if (isRec(c.sparkline)) {
        const src = resolveSource(c.sparkline, `${where}.sparkline`, s, datasets, errors, true);
        checkColumn(c.sparkline.column, `${where}.sparkline.column`, src, errors);
      }
      return;
    case 'KeyValue':
      if (Array.isArray(c.items))
        c.items.forEach((it, i) => {
          if (!isRec(it) || it.label === undefined || it.value === undefined) errors.push(`${where}.items[${i}]: expected {"label": "…", "value": …, "unit": "…"}.`);
        });
      return;
  }
}
