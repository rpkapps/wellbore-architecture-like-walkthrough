import { Signal } from '../signal';
import { defaultZone, locate, type DropTarget, type Workspace, type Zone } from './layout';
import type { PanelDef } from './panels';

/**
 * Panel operations the rail, the group menus and the actions share. A
 * feature's tool window opens and closes through its feature (the workspace
 * follows the window, see `useToolSync`), so these never put a closed tool
 * window into the layout by hand.
 */

/** Enough of a panel to open or close it (a `PanelDef`, or one built from a tool window). */
export type PanelRef = Pick<PanelDef, 'id' | 'tool' | 'open' | 'onReveal'>;

/** Where the panel's context menu can put it: a column, floating, or back where it opens by default. */
export type Placement = Zone | 'float' | 'default';

/** Where a panel floats when it is sent to float from a menu. */
export const FLOAT_RECT = { x: 120, y: 80, w: 380, h: 340 };

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

/** Close a panel (a feature's window turns its feature off). */
export function closePanel(ws: Workspace, p: PanelRef) {
  if (p.tool) p.tool.close();
  else ws.close(p.id);
}

/** Open a panel as a tab of one group ("+ Add view"). */
export function openIn(ws: Workspace, p: PanelRef, group: string) {
  const L = ws.value;
  const g = [...L.left.stacks, ...L.right.stacks, ...L.bottom.stacks, ...L.floating].find((s) => s.id === group);
  const t: DropTarget = { kind: 'tab', stack: group, index: g ? g.panels.length : 999 };
  if (p.tool) {
    ensureOpen(ws, p);
    ws.move(p.id, t);
  } else ws.open(p.id, t);
}

/** Dock, float or reset a panel (opening it first when it is closed). */
export function place(ws: Workspace, p: PanelRef, where: Placement) {
  ensureOpen(ws, p);
  const at = locate(ws.value, p.id);
  if (where === 'float') {
    if (at?.kind !== 'float') ws.float(p.id, FLOAT_RECT);
    return;
  }
  const zone = where === 'default' ? defaultZone(p.id) : where;
  if (at?.kind === 'dock' && at.zone === zone) {
    ws.activate(p.id);
    return;
  }
  // back to its default column: as a tab of that column's first group, as a panel opens there
  const first = ws.value[zone].stacks[0];
  if (where === 'default' && first) ws.move(p.id, { kind: 'tab', stack: first.id, index: first.panels.length });
  else ws.dock(p.id, zone);
}

/** Is the panel docked in its default column (so Reset location has nothing to do)? */
export function atDefault(ws: Workspace, id: string) {
  const at = locate(ws.value, id);
  return at?.kind === 'dock' && at.zone === defaultZone(id);
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
