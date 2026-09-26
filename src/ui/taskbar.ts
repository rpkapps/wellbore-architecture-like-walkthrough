import type { SelectionKind } from './selection';

/**
 * What the contextual task bar offers for each kind of selected object: the
 * likely next steps, in order, by action id, with the short label the bar
 * shows (the right-click menu keeps the action's own, longer label). Each of
 * these opens a view already set up for the object: its logs, a correlation
 * flattened on its top, a crossplot of its zone. The rest of the object's
 * actions stay one click away behind the bar's ⋯.
 */
export const TASKBAR_PLAN: Record<SelectionKind, { id: string; short: string }[]> = {
  well: [
    { id: 'views.logs', short: 'Show logs' },
    { id: 'views.correlate', short: 'Correlate' },
    { id: 'views.section', short: 'Section along well' },
    { id: 'views.geosteer', short: 'Geosteer' },
    { id: 'views.cylinder', short: 'Travelling cylinder' },
  ],
  formation: [
    { id: 'scene.isolate', short: 'Isolate' },
    { id: 'views.crossplot_zone', short: 'Crossplot zone' },
    { id: 'views.flatten_correlation', short: 'Flatten on top' },
    { id: 'views.geosteer_target', short: 'Geosteer target' },
  ],
  pick: [
    { id: 'nav.go_to_depth', short: 'Fly to' },
    { id: 'views.logs', short: 'Show in logs' },
    { id: 'views.flatten_correlation', short: 'Flatten on top' },
    { id: 'views.crossplot_zone', short: 'Crossplot zone' },
  ],
  interval: [
    { id: 'nav.go_to_depth', short: 'Fly to' },
    { id: 'views.logs', short: 'Show in logs' },
  ],
  contact: [],
  overlay: [{ id: 'views.cylinder', short: 'Travelling cylinder' }],
};

/** The most buttons the bar shows before the ⋯ menu. */
export const TASKBAR_MAX = 4;

/** Actions never promoted to a button when the plan leaves room: they are the bar itself, or its ⋯. */
const NOT_PROMOTED = new Set(['selection.properties']);

/** An action ready to run on the selection, as `ActionRegistry.actionsFor` lists them (only what curating needs). */
export interface CuratedInput {
  action: { id: string; category: string };
  label: string;
  checked?: boolean;
}

/**
 * Splits the actions of a selected object into the task bar's buttons and the
 * rest (its ⋯ menu), keeping the registry's order for the rest. The buttons
 * are the plan's actions that apply to this object, with their short labels;
 * a kind the plan says little about (a contact, a scene layer, a context
 * well) gets its first few other actions instead, so the bar is never just a
 * lone ⋯.
 */
export function curate<E extends CuratedInput>(kind: SelectionKind, entries: E[], max = TASKBAR_MAX): { primary: { entry: E; label: string }[]; rest: E[] } {
  const byId = new Map(entries.map((e) => [e.action.id, e]));
  const primary: { entry: E; label: string }[] = [];
  for (const p of TASKBAR_PLAN[kind]) {
    const e = byId.get(p.id);
    if (e && primary.length < max && !primary.some((q) => q.entry === e)) primary.push({ entry: e, label: p.short });
  }
  if (primary.length < 2)
    for (const e of entries) {
      if (primary.length >= Math.min(3, max)) break;
      if (NOT_PROMOTED.has(e.action.id) || primary.some((q) => q.entry === e)) continue;
      primary.push({ entry: e, label: e.label });
    }
  const taken = new Set(primary.map((q) => q.entry));
  return { primary, rest: entries.filter((e) => !taken.has(e)) };
}

/** A rectangle in window pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the bar goes for an anchor on screen: centred over it with a gap, so
 * it never covers the object; below it when there is no room above; kept
 * inside the free area. Null when the anchor is outside the free area (the
 * bar then docks above the viewport toolbar).
 */
export function placeNear(anchor: { x: number; y: number }, bar: { w: number; h: number }, free: Box, gap = 26, margin = 8): { left: number; top: number } | null {
  if (anchor.x < free.left + margin || anchor.x > free.right - margin || anchor.y < free.top + margin || anchor.y > free.bottom - margin) return null;
  const left = Math.max(free.left + margin, Math.min(free.right - margin - bar.w, anchor.x - bar.w / 2));
  let top = anchor.y - gap - bar.h;
  if (top < free.top + margin) top = anchor.y + gap;
  // no room below either (a short view): the dock is the better place
  if (top + bar.h > free.bottom - margin) return null;
  return { left, top };
}
