import type { GuidedView, NavMode } from '../../scene/cameraRig';
import type { PropertyMode } from '../../scene/wellbore';
import { Signal } from '../signal';

/**
 * The panel layout of the workspace: three fixed regions (the left and right
 * sidebars and the bottom panel) that hold tabbed groups, plus floating
 * windows. The 3D view and the timeline are never part of it: panels lie over
 * the view, so moving or resizing them never resizes the canvas.
 *
 * Docking is deliberately simple (P10): nothing creates a new region or a
 * further split. Each sidebar has a top slot and an optional bottom slot (a
 * draggable divider between them; the bottom slot disappears while empty),
 * and the bottom panel has one slot. A panel moves between them from its menus
 * ("Move to…"), and floats only when it is undocked on purpose; Dock back
 * returns it to the slot and tab it came from. Dragging a tab only reorders it
 * within its group. Every change made from a menu can be undone.
 *
 * The model is plain data (persisted per browser); the Workspace class holds
 * it in a signal and applies the edits the frame's menus and drags make.
 *
 * Workspaces work as in Blender: each one (the built-in Walkthrough,
 * Petrophysics and Geosteering, and the user's own) keeps its own live
 * layout. Edits save into the active workspace as they happen, switching
 * away and back finds the layout as it was left, and Reset puts back the
 * layout the workspace started from (its preset, or for a user workspace
 * the layout it was saved or duplicated with).
 */

export type Zone = 'left' | 'right' | 'bottom';
export const ZONES: Zone[] = ['left', 'right', 'bottom'];

/** A sidebar's two slots: the top one, and the one below its divider. */
export type Slot = 'top' | 'bottom';

/** How many groups (slots) each region holds: a sidebar splits once, the bottom panel not at all. */
export const MAX_STACKS: Record<Zone, number> = { left: 2, right: 2, bottom: 1 };

export interface Stack {
  id: string;
  panels: string[];
  active: string;
  /** share of the column's length */
  weight: number;
}

export interface Column {
  /** the slots in use, top first (at most `MAX_STACKS`) */
  stacks: Stack[];
  /** width (left / right) or height (bottom) in px */
  size: number;
  /** shown as a strip of icons */
  collapsed: boolean;
}

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a docked panel was: what Dock back (and reopening a closed panel) returns it to. */
export interface Origin {
  zone: Zone;
  slot: Slot;
  /** the group it was in (the slot is recreated if that group is gone) */
  stack: string;
  /** its tab position */
  index: number;
  /** the group's share of the sidebar, for a recreated slot */
  weight?: number;
  /** the other slot's group at the time: a top slot comes back above it */
  peer?: string;
}

export interface FloatWin extends FloatRect {
  id: string;
  panels: string[];
  active: string;
  /** where each of its panels came from (Dock back) */
  home?: Record<string, Origin>;
}

export interface Layout {
  v: 2;
  left: Column;
  right: Column;
  bottom: Column;
  /** back to front */
  floating: FloatWin[];
  /** each panel's last floating rectangle, used when it is undocked again */
  rects?: Record<string, FloatRect>;
}

/** A position among a group's tabs (the only place a tab can be dragged to). */
export interface TabTarget {
  stack: string;
  index: number;
}

export type Place = { kind: 'dock'; zone: Zone; stack: Stack; index: number } | { kind: 'float'; win: FloatWin; index: number };

/** smallest sizes of the columns; the largest is whatever the window leaves (the frame caps a drag) */
export const SIZE_LIMITS: Record<Zone, [number, number]> = { left: [220, 4000], right: [240, 4000], bottom: [120, 4000] };

/** how many layout changes Undo can take back */
const UNDO_DEPTH = 20;

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const col = (size: number, ...groups: string[][]): Column => ({ size, collapsed: false, stacks: groups.filter((g) => g.length).map((g) => ({ id: uid('s'), panels: g, active: g[0], weight: 1 })) });

export type PresetId = 'walkthrough' | 'petrophysics' | 'geosteering';

/**
 * What a workspace sets up besides the panels when you switch to it, so a
 * tab means a task and not only an arrangement: the colouring and the
 * navigation mode (with its guided camera). Unset parts are left as they are.
 */
export interface WorkspaceContext {
  colour?: PropertyMode;
  nav?: NavMode;
  /** the guided camera, when `nav` is 'guided' */
  guidedView?: GuidedView;
}

/** The built-in workspaces: their tab name, what they set up, and the layout Reset goes back to. */
export const PRESETS: { id: PresetId; label: string; context?: WorkspaceContext; build: () => Layout }[] = [
  {
    id: 'walkthrough',
    label: 'Walkthrough',
    build: () => ({ v: 2, left: col(300, ['scene', 'interpretation'], ['properties']), right: col(400, ['logs']), bottom: col(260), floating: [] }),
  },
  {
    id: 'petrophysics',
    label: 'Petrophysics',
    context: { colour: 'hydrocarbon' },
    build: () => ({ v: 2, left: col(320, ['interpretation', 'scene'], ['properties']), right: col(520, ['logs']), bottom: col(280, ['crossplot']), floating: [] }),
  },
  {
    id: 'geosteering',
    label: 'Geosteering',
    context: { nav: 'guided', guidedView: 'chase' },
    build: () => ({ v: 2, left: col(280, ['scene', 'interpretation'], ['properties']), right: col(420, ['logs']), bottom: col(300, ['geosteer', 'correlation', 'section']), floating: [] }),
  },
];

const isPreset = (id: string): id is PresetId => PRESETS.some((p) => p.id === id);

/**
 * The app's own panels. Unlike feature tool windows, whose feature decides
 * whether they are open, these belong to a workspace's layout, so switching
 * workspace does not carry them along.
 */
export const DOCK_PANELS: ReadonlySet<string> = new Set(['scene', 'properties', 'interpretation', 'logs', 'sources', 'live', 'assistant']);

/**
 * App panels that stay open across workspaces, like a feature's window: the
 * assistant keeps its conversation beside you (and can switch workspace itself).
 */
export const CARRIED_PANELS: ReadonlySet<string> = new Set(['assistant']);

/** Where a panel opens when it has no remembered place. */
export function defaultZone(id: string): Zone {
  return id === 'logs' || id === 'sources' || id === 'assistant' ? 'right' : id === 'scene' || id === 'properties' || id === 'interpretation' ? 'left' : 'bottom';
}

/** The end of a region's slot (by default its top slot): where a panel with no remembered place goes. */
export const defaultOrigin = (id: string, zone = defaultZone(id), slot: Slot = 'top'): Origin => ({ zone, slot, stack: '', index: 999 });

/** A group's slot in its region: the first is the top one. */
export const slotAt = (index: number): Slot => (index === 0 ? 'top' : 'bottom');

export function locate(L: Layout, id: string): Place | null {
  for (const zone of ZONES) {
    const c = L[zone];
    for (let i = 0; i < c.stacks.length; i++) if (c.stacks[i].panels.includes(id)) return { kind: 'dock', zone, stack: c.stacks[i], index: i };
  }
  for (let i = 0; i < L.floating.length; i++) if (L.floating[i].panels.includes(id)) return { kind: 'float', win: L.floating[i], index: i };
  return null;
}

export function openPanels(L: Layout): string[] {
  return [...ZONES.flatMap((z) => L[z].stacks.flatMap((s) => s.panels)), ...L.floating.flatMap((f) => f.panels)];
}

/** Where a docked panel is, as Dock back and a reopen need it. */
export function originOf(L: Layout, id: string): Origin | null {
  const p = locate(L, id);
  if (!p || p.kind !== 'dock') return null;
  const peer = L[p.zone].stacks[p.index === 0 ? 1 : 0]?.id;
  return { zone: p.zone, slot: slotAt(p.index), stack: p.stack.id, index: p.stack.panels.indexOf(id), weight: p.stack.weight, ...(peer ? { peer } : {}) };
}

const clone = (L: Layout): Layout => structuredClone(L);

function detach(L: Layout, id: string): Layout {
  const M = clone(L);
  for (const zone of ZONES) {
    const c = M[zone];
    for (const s of c.stacks) {
      s.panels = s.panels.filter((p) => p !== id);
      if (s.active === id) s.active = s.panels[0] ?? '';
    }
    // an empty slot goes: an empty bottom slot hides, and a sidebar's remaining group fills it
    c.stacks = c.stacks.filter((s) => s.panels.length);
  }
  for (const f of M.floating) {
    f.panels = f.panels.filter((p) => p !== id);
    if (f.active === id) f.active = f.panels[0] ?? '';
    if (f.home) delete f.home[id];
  }
  M.floating = M.floating.filter((f) => f.panels.length);
  return M;
}

/**
 * Dock a panel (not in the layout) at an origin: in its group if that still
 * exists; otherwise the slot is recreated when the region has room for it
 * (a bottom slot below the sidebar's group, a top slot above the group that
 * was below it), else it joins the group in that slot's place.
 */
function dockAt(L: Layout, id: string, o: Origin): Layout {
  const M = clone(L);
  const c = M[o.zone];
  const max = MAX_STACKS[o.zone];
  const fresh = (): Stack => ({ id: o.stack || uid('s'), panels: [id], active: id, weight: o.weight ?? c.stacks[0]?.weight ?? 1 });
  let s = c.stacks.find((x) => x.id === o.stack);
  if (!s) {
    if (!c.stacks.length) c.stacks.push(fresh());
    else if (o.slot === 'bottom' && max > 1) {
      if (c.stacks.length < max) c.stacks.push(fresh());
      else s = c.stacks[max - 1];
    } else if (o.slot === 'top' && c.stacks.length < max && o.peer && c.stacks[0].id === o.peer) c.stacks.unshift(fresh());
    else s = c.stacks[0];
  }
  if (s) {
    s.panels.splice(Math.max(0, Math.min(o.index, s.panels.length)), 0, id);
    s.active = id;
  }
  c.collapsed = false;
  return M;
}

/** Add a panel (not in the layout) as a tab of a group; a group that is gone sends it to its default place. */
function attachTab(L: Layout, id: string, t: TabTarget): Layout {
  const M = clone(L);
  const s = ZONES.flatMap((z) => M[z].stacks).find((x) => x.id === t.stack) ?? M.floating.find((x) => x.id === t.stack);
  if (!s) return dockAt(L, id, defaultOrigin(id));
  s.panels.splice(Math.max(0, Math.min(t.index, s.panels.length)), 0, id);
  s.active = id;
  return M;
}

const rectOf = (f: FloatRect): FloatRect => ({ x: f.x, y: f.y, w: f.w, h: f.h });

/** Float a panel (not in the layout) in a window of its own, remembering where it docks back to and its rectangle. */
function floatAt(L: Layout, id: string, r: FloatRect, home: Origin): Layout {
  const M = clone(L);
  M.floating.push({ id: uid('f'), panels: [id], active: id, ...rectOf(r), home: { [id]: home } });
  M.rects = { ...M.rects, [id]: rectOf(r) };
  return M;
}

/**
 * Bring a stored layout (of any earlier version) into the shape the regions
 * allow: groups beyond a region's slots merge into its last slot as tabs,
 * and floating windows keep floating with a remembered home (their panel's
 * default place) for Dock back. Idempotent.
 */
export function normalise(L: Layout | { v: number }): Layout {
  const M = structuredClone(L) as unknown as Layout;
  M.v = 2;
  for (const z of ZONES) {
    const c = M[z];
    const stacks = c.stacks.filter((s) => s && Array.isArray(s.panels) && s.panels.length);
    const max = MAX_STACKS[z];
    if (stacks.length > max) {
      const last = stacks[max - 1];
      for (const extra of stacks.slice(max)) for (const p of extra.panels) if (!last.panels.includes(p)) last.panels.push(p);
      stacks.length = max;
    }
    for (const s of stacks) if (!s.panels.includes(s.active)) s.active = s.panels[0];
    c.stacks = stacks;
  }
  M.floating = M.floating.filter((f) => f && Array.isArray(f.panels) && f.panels.length);
  for (const f of M.floating) {
    const home = (f.home ??= {});
    for (const p of f.panels) home[p] ??= defaultOrigin(p);
  }
  return M;
}

/** Remembered placements for closed panels, so they reopen where they were. */
interface Memory {
  /** its docked place (for a floating panel, where Dock back would take it), and its window if it floated */
  [panel: string]: { home: Origin; float?: FloatRect };
}

/** One layout change Undo can take back. */
interface UndoEntry {
  /** the workspace it was made in */
  ws: string;
  before: Layout;
  n: number;
}

/** A layout change made from a menu or button: the toast that reports it offers Undo. */
export interface LayoutChange {
  label: string;
  /** pass to `undo` to take back this change (and any made after it) */
  n: number;
}

function load<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the layout lasts for this session */
  }
}

function drop(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to drop */
  }
}

/** the single live layout of earlier versions (migrated into the Walkthrough workspace) */
const LEGACY_LAYOUT = 'bw.workspace.v1';
/** the single "My workspace" of earlier versions (moved into the named list) */
const CUSTOM = 'bw.workspace.custom.v1';
/** the user's workspaces: name, what Reset goes back to, and the task context */
const SAVED = 'bw.workspaces.v2';
/** the live layout of every workspace, and the active one */
const LIVE = 'bw.workspace.v2';

/** A workspace the user made (Save as, Duplicate, +). */
export interface SavedWorkspace {
  id: string;
  name: string;
  /** the layout it was saved or duplicated with: what Reset goes back to */
  layout: Layout;
  /** copied from the workspace it was duplicated from */
  context?: WorkspaceContext;
}

/** A tab: a built-in or a user workspace. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  builtin: boolean;
  context?: WorkspaceContext;
}

interface LiveState {
  v: 2;
  active: string;
  layouts: Record<string, Layout>;
}

function loadSaved(): SavedWorkspace[] {
  const list = load<SavedWorkspace[]>(SAVED);
  if (Array.isArray(list))
    return list.filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string' && !isPreset(w.id) && valid(w.layout)).map((w) => ({ ...w, layout: normalise(w.layout) }));
  const old = load<Layout>(CUSTOM);
  return valid(old) ? [{ id: uid('w'), name: 'My workspace', layout: normalise(old) }] : [];
}

/**
 * The live layouts and the active workspace. Earlier versions kept one live
 * layout: it becomes the Walkthrough's, so nobody loses the arrangement they
 * had. Anything unreadable falls back to the presets.
 */
function loadLive(exists: (id: string) => boolean): { active: string; layouts: Record<string, Layout> } {
  const st = load<LiveState>(LIVE);
  const layouts: Record<string, Layout> = {};
  if (st && typeof st === 'object' && st.layouts && typeof st.layouts === 'object') {
    for (const [id, L] of Object.entries(st.layouts)) if (exists(id) && valid(L)) layouts[id] = normalise(L);
    return { active: typeof st.active === 'string' && exists(st.active) ? st.active : PRESETS[0].id, layouts };
  }
  const legacy = load<Layout>(LEGACY_LAYOUT);
  if (valid(legacy)) layouts[PRESETS[0].id] = normalise(legacy);
  return { active: PRESETS[0].id, layouts };
}

/** A stored layout of this version or an earlier one (1: free docking, which `normalise` brings into the fixed regions). */
function valid(L: Layout | { v: number } | null | undefined): L is Layout {
  if (!L || typeof L !== 'object' || (L.v !== 1 && L.v !== 2)) return false;
  const M = L as Layout;
  return ZONES.every((z) => Array.isArray(M[z]?.stacks)) && Array.isArray(M.floating);
}

export class Workspace {
  /** the live layout of the active workspace */
  readonly layout: Signal<Layout>;
  /** Tab hides every panel for a clean view */
  readonly hidden = new Signal(false);
  /** the user's workspaces, in tab order after the built-in ones */
  readonly saved = new Signal<SavedWorkspace[]>(loadSaved());
  /** the active workspace */
  readonly current: Signal<string>;
  /** the live layouts of the workspaces (the active one's is kept in step with `layout`) */
  private live: Record<string, Layout>;
  private memory: Memory = {};

  constructor() {
    const st = loadLive((id) => this.has(id));
    this.live = st.layouts;
    this.current = new Signal(st.active);
    this.layout = new Signal(st.layouts[st.active] ?? this.base(st.active));
    // every edit saves into the active workspace
    this.layout.subscribe(() => {
      this.live[this.current.value] = this.layout.value;
      this.persist();
    });
    this.current.subscribe(() => this.persist());
    this.saved.subscribe(() => save(SAVED, this.saved.value));
    this.live[st.active] = this.layout.value;
    this.persist();
    // written back at once: a workspace migrated from an older key keeps its id from now on
    save(SAVED, this.saved.value);
    // the old single layout now lives in the Walkthrough workspace
    drop(LEGACY_LAYOUT);
  }

  private persist() {
    save(LIVE, { v: 2, active: this.current.value, layouts: this.live } satisfies LiveState);
  }

  /** Every workspace, as the tabs show them: the built-in ones, then the user's. */
  list(): WorkspaceInfo[] {
    return [
      ...PRESETS.map((p) => ({ id: p.id, name: p.label, builtin: true, context: p.context })),
      ...this.saved.value.map((w) => ({ id: w.id, name: w.name, builtin: false, context: w.context })),
    ];
  }

  info(id: string): WorkspaceInfo | undefined {
    return this.list().find((w) => w.id === id);
  }

  has(id: string) {
    return isPreset(id) || this.saved.value.some((w) => w.id === id);
  }

  /** The layout a workspace starts from and Reset goes back to. */
  private base(id: string): Layout {
    const p = PRESETS.find((x) => x.id === id);
    if (p) return p.build();
    const w = this.saved.value.find((x) => x.id === id);
    return w ? clone(w.layout) : PRESETS[0].build();
  }

  /** A workspace's live layout: as it was left, or its starting layout the first time. */
  layoutOf(id: string): Layout {
    return id === this.current.value ? this.value : (this.live[id] ?? this.base(id));
  }

  get value() {
    return this.layout.value;
  }

  isOpen(id: string) {
    return !!locate(this.value, id);
  }

  /** Is the panel open and the one showing in its group (and its column expanded)? */
  isShown(id: string) {
    const p = locate(this.value, id);
    if (!p) return false;
    if (p.kind === 'float') return p.win.active === id;
    return p.stack.active === id && !this.value[p.zone].collapsed;
  }

  /**
   * Where Reset location puts a panel: its place in the layout the active
   * workspace starts from (Properties below Scene, say), or the top slot of
   * its default region for a panel that layout does not name.
   */
  defaultPlace(id: string): { zone: Zone; slot: Slot } {
    const p = locate(this.base(this.current.value), id);
    return p?.kind === 'dock' ? { zone: p.zone, slot: slotAt(p.index) } : { zone: defaultZone(id), slot: 'top' };
  }

  /** Open (where it was last, or in its default place) and bring to the front; `where` opens it as a tab of a group. */
  open(id: string, where?: TabTarget) {
    const L = this.value;
    if (locate(L, id)) {
      this.activate(id);
      return;
    }
    const mem = this.memory[id];
    if (where) this.layout.set(attachTab(L, id, where));
    else if (mem?.float) this.layout.set(floatAt(L, id, mem.float, mem.home));
    else {
      const d = this.defaultPlace(id);
      this.layout.set(dockAt(L, id, mem?.home ?? defaultOrigin(id, d.zone, d.slot)));
    }
    this.activate(id);
  }

  close(id: string) {
    const L = this.value;
    const p = locate(L, id);
    if (!p) return;
    this.memory[id] = p.kind === 'dock' ? { home: originOf(L, id)! } : { home: p.win.home?.[id] ?? defaultOrigin(id), float: rectOf(p.win) };
    this.layout.set(detach(L, id));
  }

  toggle(id: string) {
    if (this.isShown(id)) this.close(id);
    else this.open(id);
  }

  activate(id: string) {
    const L = this.value;
    const at = locate(L, id);
    if (!at) return;
    // already showing (and in front): nothing to render
    if (at.kind === 'dock' ? at.stack.active === id && !L[at.zone].collapsed : at.win.active === id && at.index === L.floating.length - 1) return;
    const M = clone(L);
    const p = locate(M, id)!;
    if (p.kind === 'dock') {
      p.stack.active = id;
      M[p.zone].collapsed = false;
    } else {
      p.win.active = id;
      // to the front
      M.floating.splice(p.index, 1);
      M.floating.push(p.win);
    }
    this.layout.set(M);
  }

  /**
   * Put a panel at a position among a group's tabs: a drag reorders within
   * its group; "+ Add view" brings a panel into another group.
   */
  move(id: string, t: TabTarget) {
    const before = this.value;
    const p = locate(before, id);
    if (p && (p.kind === 'dock' ? p.stack.id : p.win.id) === t.stack) {
      const M = clone(before);
      const g = locate(M, id)!;
      const list = g.kind === 'dock' ? g.stack.panels : g.win.panels;
      const from = list.indexOf(id);
      list.splice(from, 1);
      list.splice(Math.min(t.index > from ? t.index - 1 : t.index, list.length), 0, id);
      if (g.kind === 'dock') g.stack.active = id;
      else g.win.active = id;
      this.layout.set(M);
      return;
    }
    this.layout.set(attachTab(detach(before, id), id, t));
  }

  /**
   * Move a panel to a region's slot ("Move to left sidebar", "Move to
   * bottom of left sidebar"): as the last tab of that slot's group, which is
   * made when the slot is empty. The bottom panel has only its top slot.
   */
  dock(id: string, zone: Zone, slot: Slot = 'top') {
    const L = this.value;
    const at = locate(L, id);
    const s = MAX_STACKS[zone] > 1 ? slot : 'top';
    if (at?.kind === 'dock' && at.zone === zone && slotAt(at.index) === s) {
      this.activate(id);
      return;
    }
    const rest = detach(L, id);
    const c = rest[zone];
    // the group now in that slot, if there is one (a bottom slot exists only below a top one)
    const g = s === 'top' ? c.stacks[0] : c.stacks[1];
    this.layout.set(dockAt(rest, id, g ? { zone, slot: s, stack: g.id, index: g.panels.length } : defaultOrigin(id, zone, s)));
  }

  /**
   * Undock a panel into a floating window of its own (remembering where it
   * was, for Dock back) at `rect`, or where it last floated. A panel that
   * already floats stays as it is.
   */
  undock(id: string, rect: FloatRect) {
    const L = this.value;
    const at = locate(L, id);
    if (at?.kind === 'float') return;
    const home = originOf(L, id) ?? this.memory[id]?.home ?? defaultOrigin(id);
    this.layout.set(floatAt(at ? detach(L, id) : L, id, L.rects?.[id] ?? rect, home));
  }

  /** Return a floating panel to the slot and tab it came from (its window closes when it was the last tab). */
  dockBack(id: string) {
    const L = this.value;
    const at = locate(L, id);
    if (at?.kind !== 'float') return;
    const home = at.win.home?.[id] ?? defaultOrigin(id);
    const M = detach(L, id);
    M.rects = { ...M.rects, [id]: rectOf(at.win) };
    this.layout.set(dockAt(M, id, home));
  }

  /** Dock back every panel of a floating window (its ↙ button, a double click on its header). */
  dockBackWindow(win: string) {
    const f = this.value.floating.find((x) => x.id === win);
    if (!f) return;
    for (const id of f.panels) this.dockBack(id);
    this.activate(f.active);
  }

  setSize(zone: Zone, size: number) {
    const [lo, hi] = SIZE_LIMITS[zone];
    const M = clone(this.value);
    M[zone].size = Math.round(Math.max(lo, Math.min(hi, size)));
    this.layout.set(M);
  }

  setCollapsed(zone: Zone, collapsed: boolean) {
    const M = clone(this.value);
    M[zone].collapsed = collapsed;
    this.layout.set(M);
  }

  /** Move a sidebar's divider between its top and bottom slots. */
  resizeSplit(zone: Zone, i: number, weights: [number, number]) {
    const M = clone(this.value);
    const c = M[zone];
    if (!c.stacks[i] || !c.stacks[i + 1]) return;
    c.stacks[i].weight = weights[0];
    c.stacks[i + 1].weight = weights[1];
    this.layout.set(M);
  }

  /** Move or resize a floating window; its panels remember the rectangle for the next time they are undocked. */
  setFloat(win: string, r: Partial<FloatRect>) {
    const M = clone(this.value);
    const f = M.floating.find((x) => x.id === win);
    if (!f) return;
    Object.assign(f, r);
    M.rects = { ...M.rects };
    for (const p of f.panels) M.rects[p] = rectOf(f);
    this.layout.set(M);
  }

  raise(win: string) {
    const L = this.value;
    const i = L.floating.findIndex((f) => f.id === win);
    if (i < 0 || i === L.floating.length - 1) return;
    const M = clone(L);
    const [f] = M.floating.splice(i, 1);
    M.floating.push(f);
    this.layout.set(M);
  }

  // ------------------------------------------------------------------ undo

  private undoStack: UndoEntry[] = [];
  private depth = 0;
  private changeSeq = 0;
  /** the last change made with a label (the app shows it as a toast with Undo) */
  readonly changes = new Signal<LayoutChange | null>(null);

  /**
   * Make a layout change that Undo can take back (Ctrl Z, or the toast's
   * Undo). With a label it is announced on `changes`; without one (a drag,
   * a fold) it is only recorded. A change made inside another counts as part
   * of it. Returns whether the layout changed.
   */
  change(label: string | null, fn: () => void): boolean {
    if (this.depth) {
      fn();
      return false;
    }
    const before = this.value;
    const ws = this.current.value;
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
    if (this.value === before || this.current.value !== ws || JSON.stringify(this.value) === JSON.stringify(before)) return false;
    const n = ++this.changeSeq;
    this.undoStack.push({ ws, before, n });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    if (label) this.changes.set({ label, n });
    return true;
  }

  /** Is there a change in the active workspace to undo? */
  canUndo() {
    return this.undoStack.some((e) => e.ws === this.current.value);
  }

  /**
   * Take back the last layout change made in the active workspace, or (given
   * a change's `n`, from its toast) that change and every one made after it.
   * Returns false when there is nothing to undo.
   */
  undo(n?: number): boolean {
    const ws = this.current.value;
    const mine = this.undoStack.filter((e) => e.ws === ws);
    const i = n === undefined ? mine.length - 1 : mine.findIndex((e) => e.n === n);
    if (i < 0) return false;
    const target = mine[i];
    const dropped = new Set(mine.slice(i));
    this.undoStack = this.undoStack.filter((e) => !dropped.has(e));
    this.layout.set(target.before);
    return true;
  }

  /** Replace the layout, keeping open tool windows it does not mention and dropping panels it names that do not exist. */
  apply(next: Layout, available: (id: string) => boolean) {
    const M = normalise(next);
    const now = new Set(openPanels(this.value));
    // a carried panel is open in the next layout only if it is open now
    const keep = (id: string) => available(id) && (!CARRIED_PANELS.has(id) || now.has(id));
    for (const z of ZONES) {
      for (const s of M[z].stacks) {
        s.panels = s.panels.filter(keep);
        if (!s.panels.includes(s.active)) s.active = s.panels[0] ?? '';
      }
      M[z].stacks = M[z].stacks.filter((s) => s.panels.length);
    }
    M.floating = M.floating.filter((f) => (f.panels = f.panels.filter(keep)).length);
    const inNext = new Set(openPanels(M));
    let out = M;
    // a feature's window is open because its feature is on, whichever workspace shows it (and a carried panel goes along)
    for (const id of now) if (!inNext.has(id) && available(id) && (!DOCK_PANELS.has(id) || CARRIED_PANELS.has(id))) out = dockAt(out, id, defaultOrigin(id));
    this.layout.set(out);
  }

  /**
   * Make a workspace the active one: the layout being left stays with its
   * workspace, and the one entered comes back as it was left (its starting
   * layout the first time). Returns false for an unknown id.
   */
  switchTo(id: string, available: (id: string) => boolean): boolean {
    if (!this.has(id)) return false;
    if (id === this.current.value) return true;
    this.live[this.current.value] = this.value;
    const next = this.layoutOf(id);
    // the active id first, so the layout below saves into the workspace entered
    this.current.set(id);
    this.apply(next, available);
    return true;
  }

  /** The workspace `step` tabs away from `from` (the active one), wrapping round (Ctrl PgUp / PgDn). */
  neighbour(step: number, from = this.current.value): string {
    const ids = this.list().map((w) => w.id);
    const i = ids.indexOf(from);
    return ids[(((i + step) % ids.length) + ids.length) % ids.length];
  }

  /** Kept for scripts and tests: switch to a built-in workspace. */
  preset(id: PresetId, available: (id: string) => boolean) {
    this.switchTo(id, available);
  }

  /**
   * Put a workspace's layout back to where it started: a built-in one to its
   * preset, a user one to the layout it was saved or duplicated with.
   */
  reset(id: string, available: (id: string) => boolean) {
    if (!this.has(id)) return;
    if (id === this.current.value) this.apply(this.base(id), available);
    else {
      delete this.live[id];
      this.persist();
    }
  }

  /**
   * A new user workspace holding a copy of another's live layout and task
   * context (a unique name is made up when none is given), placed after the
   * others. Switching to it is the caller's: the app's switch also applies
   * the context. Returns its id.
   */
  duplicate(id: string, name?: string): string {
    const from = this.info(id) ?? this.info(this.current.value)!;
    const n = this.uniqueName(name?.trim() || `${from.name} copy`);
    const entry: SavedWorkspace = { id: uid('w'), name: n, layout: clone(this.layoutOf(from.id)), ...(from.context ? { context: { ...from.context } } : {}) };
    this.saved.set([...this.saved.value, entry]);
    return entry.id;
  }

  /**
   * Save the active layout under a name: a user workspace of the same name is
   * replaced, otherwise a new one is made. It becomes the active one; returns its id.
   */
  saveAs(name: string): string {
    const n = name.trim() || 'Workspace';
    const same = this.saved.value.find((w) => w.name.toLowerCase() === n.toLowerCase());
    const id = same?.id ?? uid('w');
    const context = this.info(this.current.value)?.context;
    const entry: SavedWorkspace = { id, name: n, layout: clone(this.value), ...(context ? { context: { ...context } } : {}) };
    this.saved.set(same ? this.saved.value.map((w) => (w.id === id ? entry : w)) : [...this.saved.value, entry]);
    // the same layout, so nothing to apply: it simply carries on as that workspace
    this.live[id] = this.value;
    this.current.set(id);
    return id;
  }

  /** A name no workspace uses yet: "Petrophysics copy", then "Petrophysics copy 2"… */
  uniqueName(name: string): string {
    const taken = new Set(this.list().map((w) => w.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let i = 2;
    while (taken.has(`${name} ${i}`.toLowerCase())) i++;
    return `${name} ${i}`;
  }

  /** Rename a user workspace (built-in ones keep their names). */
  rename(id: string, name: string) {
    const n = name.trim();
    if (!n || isPreset(id)) return;
    this.saved.set(this.saved.value.map((w) => (w.id === id ? { ...w, name: n } : w)));
  }

  /** Delete a user workspace (built-in ones stay); deleting the active one goes back to Walkthrough. */
  remove(id: string, available: (id: string) => boolean = () => true) {
    if (isPreset(id) || !this.saved.value.some((w) => w.id === id)) return;
    if (this.current.value === id) this.switchTo(PRESETS[0].id, available);
    this.saved.set(this.saved.value.filter((w) => w.id !== id));
    delete this.live[id];
    this.persist();
  }

  /** Left / right column as a whole: expanded, or folded to its icon strip. */
  toggleZone(zone: Zone) {
    if (!this.value[zone].stacks.length) return false;
    this.setCollapsed(zone, !this.value[zone].collapsed);
    return true;
  }
}
