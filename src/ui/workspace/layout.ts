import { Signal } from '../signal';

/**
 * The panel layout of the workspace, Illustrator style: three dock columns
 * (left, right, bottom) of vertically stacked tab groups, plus free-floating
 * windows. The 3D view is never part of it: panels float over it, so moving
 * or resizing them never resizes the canvas.
 *
 * The model is plain data (persisted per browser); the Workspace class holds
 * it in a signal and applies the edits the frame's drag and drop and menus
 * make.
 */

export type Zone = 'left' | 'right' | 'bottom';
export const ZONES: Zone[] = ['left', 'right', 'bottom'];

export interface Stack {
  id: string;
  panels: string[];
  active: string;
  /** share of the column's length */
  weight: number;
}

export interface Column {
  stacks: Stack[];
  /** width (left / right) or height (bottom) in px */
  size: number;
  /** shown as a strip of icons */
  collapsed: boolean;
}

export interface FloatWin {
  id: string;
  panels: string[];
  active: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  v: 1;
  left: Column;
  right: Column;
  bottom: Column;
  /** back to front */
  floating: FloatWin[];
}

export type DropTarget =
  | { kind: 'tab'; stack: string; index: number }
  | { kind: 'split'; zone: Zone; stack: string; where: 'before' | 'after' }
  | { kind: 'zone'; zone: Zone }
  | { kind: 'float'; x: number; y: number; w: number; h: number };

export type Place = { kind: 'dock'; zone: Zone; stack: Stack; index: number } | { kind: 'float'; win: FloatWin; index: number };

/** smallest sizes of the columns; the largest is whatever the window leaves (the frame caps a drag) */
export const SIZE_LIMITS: Record<Zone, [number, number]> = { left: [220, 4000], right: [240, 4000], bottom: [120, 4000] };

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const col = (size: number, ...groups: string[][]): Column => ({ size, collapsed: false, stacks: groups.filter((g) => g.length).map((g) => ({ id: uid('s'), panels: g, active: g[0], weight: 1 })) });

export type PresetId = 'walkthrough' | 'petrophysics' | 'geosteering';

export const PRESETS: { id: PresetId; label: string; build: () => Layout }[] = [
  {
    id: 'walkthrough',
    label: 'Walkthrough',
    build: () => ({ v: 1, left: col(300, ['scene', 'interpretation', 'features'], ['properties']), right: col(400, ['logs']), bottom: col(260), floating: [] }),
  },
  {
    id: 'petrophysics',
    label: 'Petrophysics',
    build: () => ({ v: 1, left: col(320, ['interpretation'], ['scene', 'features'], ['properties']), right: col(520, ['logs']), bottom: col(280, ['crossplot']), floating: [] }),
  },
  {
    id: 'geosteering',
    label: 'Geosteering',
    build: () => ({ v: 1, left: col(280, ['scene', 'interpretation', 'features'], ['properties']), right: col(420, ['logs']), bottom: col(300, ['geosteer', 'correlation', 'section']), floating: [] }),
  },
];

/** Where a panel opens when it has no remembered place. */
export function defaultZone(id: string): Zone {
  return id === 'logs' || id === 'sources' ? 'right' : id === 'scene' || id === 'properties' || id === 'interpretation' || id === 'features' ? 'left' : 'bottom';
}

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

const clone = (L: Layout): Layout => structuredClone(L);

function detach(L: Layout, id: string): Layout {
  const M = clone(L);
  for (const zone of ZONES) {
    const c = M[zone];
    for (const s of c.stacks) {
      s.panels = s.panels.filter((p) => p !== id);
      if (s.active === id) s.active = s.panels[0] ?? '';
    }
    c.stacks = c.stacks.filter((s) => s.panels.length);
  }
  for (const f of M.floating) {
    f.panels = f.panels.filter((p) => p !== id);
    if (f.active === id) f.active = f.panels[0] ?? '';
  }
  M.floating = M.floating.filter((f) => f.panels.length);
  return M;
}

function attach(L: Layout, id: string, t: DropTarget): Layout {
  const M = clone(L);
  if (t.kind === 'tab') {
    const s = ZONES.flatMap((z) => M[z].stacks).find((x) => x.id === t.stack) ?? M.floating.find((x) => x.id === t.stack);
    if (s) {
      s.panels.splice(Math.max(0, Math.min(t.index, s.panels.length)), 0, id);
      s.active = id;
      return M;
    }
    return attach(M, id, { kind: 'zone', zone: defaultZone(id) });
  }
  if (t.kind === 'split') {
    const c = M[t.zone];
    const i = c.stacks.findIndex((x) => x.id === t.stack);
    const neighbour = c.stacks[i];
    const w = neighbour ? neighbour.weight / 2 : 1;
    if (neighbour) neighbour.weight = w;
    c.stacks.splice(i < 0 ? c.stacks.length : t.where === 'before' ? i : i + 1, 0, { id: uid('s'), panels: [id], active: id, weight: w });
    c.collapsed = false;
    return M;
  }
  if (t.kind === 'zone') {
    const c = M[t.zone];
    c.stacks.push({ id: uid('s'), panels: [id], active: id, weight: c.stacks.length ? c.stacks.reduce((a, s) => a + s.weight, 0) / c.stacks.length : 1 });
    c.collapsed = false;
    return M;
  }
  M.floating.push({ id: uid('f'), panels: [id], active: id, x: t.x, y: t.y, w: t.w, h: t.h });
  return M;
}

/** Remembered placements for closed panels, so they reopen where they were. */
export interface Memory {
  /** the group (or floating rectangle) and, for a docked panel, its column in case the group is gone */
  [panel: string]: { target: DropTarget; zone?: Zone };
}

function placeOf(L: Layout, id: string): Memory[string] | null {
  const p = locate(L, id);
  if (!p) return null;
  if (p.kind === 'dock') return { target: { kind: 'tab', stack: p.stack.id, index: p.stack.panels.indexOf(id) }, zone: p.zone };
  return { target: { kind: 'float', x: p.win.x, y: p.win.y, w: p.win.w, h: p.win.h } };
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

const KEY = 'bw.workspace.v1';
/** the single "My workspace" of earlier versions (moved into the named list) */
const CUSTOM = 'bw.workspace.custom.v1';
const SAVED = 'bw.workspaces.v2';

/** A layout the user saved under a name. */
export interface SavedWorkspace {
  id: string;
  name: string;
  layout: Layout;
}

function loadSaved(): SavedWorkspace[] {
  const list = load<SavedWorkspace[]>(SAVED);
  if (Array.isArray(list)) return list.filter((w) => w && typeof w.name === 'string' && valid(w.layout));
  const old = load<Layout>(CUSTOM);
  return valid(old) ? [{ id: uid('w'), name: 'My workspace', layout: old }] : [];
}

function valid(L: Layout | null): L is Layout {
  return !!L && L.v === 1 && ZONES.every((z) => Array.isArray(L[z]?.stacks)) && Array.isArray(L.floating);
}

export class Workspace {
  readonly layout: Signal<Layout>;
  /** Tab hides every panel for a clean view */
  readonly hidden = new Signal(false);
  /** the user's named workspaces */
  readonly saved = new Signal<SavedWorkspace[]>(loadSaved());
  /** the preset or saved workspace last applied (null once none matches) */
  readonly current = new Signal<string | null>(null);
  private memory: Memory = {};

  constructor() {
    const saved = load<Layout>(KEY);
    this.layout = new Signal(valid(saved) ? saved : PRESETS[0].build());
    this.layout.subscribe(() => save(KEY, this.layout.value));
    this.saved.subscribe(() => save(SAVED, this.saved.value));
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

  /** Open (where it was last, or in its default column) and bring to the front. */
  open(id: string, where?: DropTarget) {
    const L = this.value;
    const p = locate(L, id);
    if (p) {
      this.activate(id);
      return;
    }
    const mem = this.memory[id];
    const t = where ?? mem?.target ?? { kind: 'zone', zone: defaultZone(id) };
    // the remembered group may be gone: its column then, or the default one
    const ok = t.kind !== 'tab' || ZONES.some((z) => L[z].stacks.some((s) => s.id === t.stack)) || L.floating.some((f) => f.id === t.stack);
    const target: DropTarget = ok ? t : { kind: 'zone', zone: mem?.zone ?? defaultZone(id) };
    // a new panel for a column that has groups joins its first group as a tab
    const Z = target.kind === 'zone' ? L[target.zone] : null;
    this.layout.set(Z && Z.stacks.length ? attach(L, id, { kind: 'tab', stack: Z.stacks[0].id, index: Z.stacks[0].panels.length }) : attach(L, id, target));
    this.activate(id);
  }

  close(id: string) {
    const place = placeOf(this.value, id);
    if (place) this.memory[id] = place;
    this.layout.set(detach(this.value, id));
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

  move(id: string, t: DropTarget) {
    const before = this.value;
    const p = locate(before, id);
    // dropping the only tab of a group back onto that group changes nothing
    if (p && t.kind === 'tab' && ((p.kind === 'dock' && p.stack.id === t.stack) || (p.kind === 'float' && p.win.id === t.stack))) {
      const M = clone(before);
      const g = p.kind === 'dock' ? locate(M, id)! : locate(M, id)!;
      const list = g.kind === 'dock' ? g.stack.panels : g.win.panels;
      const from = list.indexOf(id);
      list.splice(from, 1);
      list.splice(Math.min(t.index > from ? t.index - 1 : t.index, list.length), 0, id);
      if (g.kind === 'dock') g.stack.active = id;
      else g.win.active = id;
      this.layout.set(M);
      return;
    }
    if (p && t.kind === 'split' && p.kind === 'dock' && p.stack.id === t.stack && p.stack.panels.length === 1) return;
    this.layout.set(attach(detach(before, id), id, t));
  }

  /** Float a panel's whole group at a position (panel menu "Float"). */
  float(id: string, rect: { x: number; y: number; w: number; h: number }) {
    this.move(id, { kind: 'float', ...rect });
  }

  dock(id: string, zone: Zone) {
    this.move(id, { kind: 'zone', zone });
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

  /** Move the split between two neighbouring groups of a column. */
  resizeSplit(zone: Zone, i: number, weights: [number, number]) {
    const M = clone(this.value);
    const c = M[zone];
    if (!c.stacks[i] || !c.stacks[i + 1]) return;
    c.stacks[i].weight = weights[0];
    c.stacks[i + 1].weight = weights[1];
    this.layout.set(M);
  }

  setFloat(win: string, r: Partial<Pick<FloatWin, 'x' | 'y' | 'w' | 'h'>>) {
    const M = clone(this.value);
    const f = M.floating.find((x) => x.id === win);
    if (!f) return;
    Object.assign(f, r);
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

  /** Replace the layout, keeping open panels a preset does not mention and dropping ones it names that do not exist. */
  apply(next: Layout, available: (id: string) => boolean) {
    const M = clone(next);
    for (const z of ZONES) {
      for (const s of M[z].stacks) {
        s.panels = s.panels.filter(available);
        if (!s.panels.includes(s.active)) s.active = s.panels[0] ?? '';
      }
      M[z].stacks = M[z].stacks.filter((s) => s.panels.length);
    }
    M.floating = M.floating.filter((f) => (f.panels = f.panels.filter(available)).length);
    const inNext = new Set(openPanels(M));
    let out = M;
    for (const id of openPanels(this.value))
      if (!inNext.has(id) && available(id) && !['scene', 'properties', 'interpretation', 'features', 'logs'].includes(id)) out = attach(out, id, { kind: 'zone', zone: defaultZone(id) });
    this.layout.set(out);
  }

  preset(id: PresetId, available: (id: string) => boolean) {
    this.apply(PRESETS.find((p) => p.id === id)!.build(), available);
    this.current.set(id);
  }

  /** Save the current layout under a name (replacing a workspace of the same name); returns its id. */
  saveAs(name: string): string {
    const n = name.trim() || 'Workspace';
    const same = this.saved.value.find((w) => w.name.toLowerCase() === n.toLowerCase());
    const id = same?.id ?? uid('w');
    const entry = { id, name: n, layout: clone(this.value) };
    this.saved.set(same ? this.saved.value.map((w) => (w.id === id ? entry : w)) : [...this.saved.value, entry]);
    this.current.set(id);
    return id;
  }

  /** Overwrite a saved workspace with the current layout. */
  update(id: string) {
    this.saved.set(this.saved.value.map((w) => (w.id === id ? { ...w, layout: clone(this.value) } : w)));
  }

  rename(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    this.saved.set(this.saved.value.map((w) => (w.id === id ? { ...w, name: n } : w)));
  }

  remove(id: string) {
    this.saved.set(this.saved.value.filter((w) => w.id !== id));
    if (this.current.value === id) this.current.set(null);
  }

  load(id: string, available: (id: string) => boolean) {
    const w = this.saved.value.find((x) => x.id === id);
    if (!w) return;
    this.apply(w.layout, available);
    this.current.set(id);
  }

  /** Left / right column as a whole: expanded, or folded to its icon strip. */
  toggleZone(zone: Zone) {
    if (!this.value[zone].stacks.length) return false;
    this.setCollapsed(zone, !this.value[zone].collapsed);
    return true;
  }
}
