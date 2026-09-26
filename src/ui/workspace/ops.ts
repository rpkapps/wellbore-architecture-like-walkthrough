import { Signal } from '../signal';
import { locate, slotAt, type FloatRect, type Slot, type TabTarget, type Workspace, type Zone } from './layout';
import type { PanelDef } from './panels';

/**
 * Panel operations the rail, the group menus and the actions share. A
 * feature's tool window opens and closes through its feature (the workspace
 * follows the window, see `useToolSync`), so these never put a closed tool
 * window into the layout by hand.
 *
 * The ones made from a menu or button (move, undock, dock back, reset
 * location, close) go through `Workspace.change`, so the app announces them
 * with a toast that offers Undo, and Ctrl Z takes them back.
 */

/** Enough of a panel to open or close it (a `PanelDef`, or one built from a tool window); the title names it in the toast. */
export type PanelRef = Pick<PanelDef, 'id' | 'tool' | 'open' | 'onReveal'> & { title?: string };

/**
 * Where a panel's menus (and the palette) can put it: a sidebar's top slot
 * (`left`, `right`), a sidebar's bottom slot, the bottom panel, a floating
 * window (Undock), back where it was docked (Dock back), or its default place.
 */
export type Placement = 'left' | 'left-bottom' | 'right' | 'right-bottom' | 'bottom' | 'float' | 'dock' | 'default';

export const PLACEMENTS: Placement[] = ['dock', 'left', 'left-bottom', 'right', 'right-bottom', 'bottom', 'float', 'default'];

/** Where a panel floats when nothing better is known (no remembered window, no docked size to keep). */
export const FLOAT_RECT: FloatRect = { x: 120, y: 80, w: 380, h: 340 };

/**
 * Set by the frame: the rectangle a panel's window takes when it is first
 * undocked: its docked group's size, nudged in from the edge, inside the stage.
 */
export const undockRect: { of: ((id: string) => FloatRect | null) | null } = { of: null };

/**
 * The group maximised to fill the stage (`Ctrl Space`, or a double click on a
 * tab). Frame state only: it is not part of the layout, so it is never saved
 * and a layout change cannot restore it.
 */
export const maximised = new Signal<string | null>(null);

/** Is the panel in the layout (a tool window: also shown by its feature)? */
export function isOpen(ws: Workspace, p: PanelRef) {
  return ws.isOpen(p.id) && (!p.tool || p.tool.visible);
}

/** Put a closed panel into the layout where it was last (a tool window through its feature). */
export function ensureOpen(ws: Workspace, p: PanelRef) {
  if (isOpen(ws, p)) return;
  if (p.tool) {
    (p.open ?? (() => p.tool!.show()))();
    // (the workspace has normally followed the window already)
    if (p.tool.visible && !ws.isOpen(p.id)) ws.open(p.id);
  } else ws.open(p.id);
}

/** Open the panel if it is closed, then bring it to the front: its tab, its column unfolded, its window raised. */
export function reveal(ws: Workspace, p: PanelRef) {
  if (ws.hidden.value) ws.hidden.set(false);
  p.onReveal?.();
  ensureOpen(ws, p);
  ws.activate(p.id);
}

const name = (p: PanelRef) => p.title ?? p.id;

/**
 * Close a panel (a feature's window turns its feature off). From a tab or a
 * menu the toast offers Undo; the rail's toggle (`announce` false) closes
 * quietly, though Ctrl Z still takes it back.
 */
export function closePanel(ws: Workspace, p: PanelRef, announce = true) {
  ws.change(announce ? `${name(p)} closed` : null, () => {
    if (p.tool) p.tool.close();
    else ws.close(p.id);
  });
}

/** Open a panel as a tab of one group ("+ Add view"). */
export function openIn(ws: Workspace, p: PanelRef, group: string) {
  const L = ws.value;
  const g = [...L.left.stacks, ...L.right.stacks, ...L.bottom.stacks, ...L.floating].find((s) => s.id === group);
  const t: TabTarget = { stack: group, index: g ? g.panels.length : 999 };
  if (p.tool) {
    ensureOpen(ws, p);
    ws.move(p.id, t);
  } else ws.open(p.id, t);
}

const ZONE_NAME: Record<Zone, string> = { left: 'left sidebar', right: 'right sidebar', bottom: 'bottom panel' };

type DockPlacement = Exclude<Placement, 'float' | 'dock' | 'default'>;

/** A placement as a region and slot. */
function target(where: DockPlacement): { zone: Zone; slot: Slot } {
  return where === 'left-bottom' ? { zone: 'left', slot: 'bottom' } : where === 'right-bottom' ? { zone: 'right', slot: 'bottom' } : { zone: where, slot: 'top' };
}

/** A panel's region and slot, when it is docked. */
function slotOf(ws: Workspace, id: string): { zone: Zone; slot: Slot } | null {
  const at = locate(ws.value, id);
  return at?.kind === 'dock' ? { zone: at.zone, slot: slotAt(at.index) } : null;
}

/**
 * A placement's menu label for a panel where it is now; within its own
 * sidebar the slots read as top and bottom ("Move to bottom of left sidebar").
 */
export function placementLabel(ws: Workspace, id: string, where: Placement): string {
  if (where === 'float') return 'Undock';
  if (where === 'dock') return 'Dock back';
  if (where === 'default') return 'Reset location';
  const t = target(where);
  if (t.slot === 'bottom') return `Move to bottom of ${ZONE_NAME[t.zone]}`;
  if (t.zone !== 'bottom' && slotOf(ws, id)?.zone === t.zone) return `Move to top of ${ZONE_NAME[t.zone]}`;
  return `Move to ${ZONE_NAME[t.zone]}`;
}

/**
 * The placements that would move the panel from where it is now. The menus
 * (`menu`) keep the list short: the other slot of its own sidebar and the
 * other regions; the palette lists every slot. A closed panel can go anywhere
 * (it opens first). Reset location is left out: the menus show it apart.
 */
export function placements(ws: Workspace, id: string, menu = false): Placement[] {
  const at = locate(ws.value, id);
  const here = slotOf(ws, id);
  const out: Placement[] = [];
  if (at?.kind === 'float') out.push('dock');
  for (const p of ['left', 'left-bottom', 'right', 'right-bottom', 'bottom'] as const) {
    const t = target(p);
    if (here && here.zone === t.zone && here.slot === t.slot) continue;
    // menus offer a bottom slot only within the panel's own sidebar
    if (menu && t.slot === 'bottom' && here?.zone !== t.zone) continue;
    out.push(p);
  }
  if (at?.kind !== 'float') out.push('float');
  return out;
}

/** What a placement did, for its toast. */
function placedLabel(p: PanelRef, where: Placement): string {
  if (where === 'float') return `${name(p)} undocked`;
  if (where === 'dock') return `${name(p)} docked back`;
  if (where === 'default') return `${name(p)} back in its default place`;
  const t = target(where);
  return `${name(p)} moved to the ${t.slot === 'bottom' ? `bottom of the ${ZONE_NAME[t.zone]}` : ZONE_NAME[t.zone]}`;
}

/** Move, undock, dock back or reset a panel (opening it first when it is closed), announced with Undo. */
export function place(ws: Workspace, p: PanelRef, where: Placement) {
  ws.change(placedLabel(p, where), () => {
    ensureOpen(ws, p);
    const at = locate(ws.value, p.id);
    if (where === 'float') {
      if (at?.kind !== 'float') ws.undock(p.id, undockRect.of?.(p.id) ?? FLOAT_RECT);
      return;
    }
    if (where === 'dock') {
      if (at?.kind === 'float') ws.dockBack(p.id);
      return;
    }
    const t = where === 'default' ? ws.defaultPlace(p.id) : target(where);
    ws.dock(p.id, t.zone, t.slot);
  });
}

/** Dock back a whole floating window (its ↙ button, a double click on its header), announced with Undo. */
export function dockBackWindow(ws: Workspace, win: string, title: string) {
  ws.change(`${title} docked back`, () => ws.dockBackWindow(win));
}

/** Is the panel docked in its default place (so Reset location has nothing to do)? */
export function atDefault(ws: Workspace, id: string) {
  const here = slotOf(ws, id);
  const d = ws.defaultPlace(id);
  return !!here && here.zone === d.zone && here.slot === d.slot;
}

/** The group a panel is in, if it is open. */
export function groupOf(ws: Workspace, id: string): string | null {
  const at = locate(ws.value, id);
  return at ? (at.kind === 'dock' ? at.stack.id : at.win.id) : null;
}

/** Maximise a group, or restore it when it already is. */
export function toggleMaximised(group: string | null) {
  maximised.set(group && maximised.value !== group ? group : null);
}
