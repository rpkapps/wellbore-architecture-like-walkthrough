import type { ContextItem, Json } from '../assistant/core/types';
import type { Selection, SelectionKind } from '../ui/selection';
import type { App } from '../ui/app';
import { inspectorRows } from './tools';
import { round } from './wells';

/*
 * What the composer attaches to a message: the selected object (with every
 * read-out Properties shows) and the depth intervals a view has marked.
 *
 * The open well and the camera depth are not a chip: the snapshot sends them
 * with every step anyway, and a chip that changed as the camera moved would
 * re-render the composer while flying and sit on every message as noise.
 */

const KIND_WORD: Record<SelectionKind, string> = { well: 'well', formation: 'formation', pick: 'formation top', contact: 'fluid contact', overlay: 'scene layer', interval: 'depth interval' };
/** Icon names `renderIcon` knows, per kind of selection. */
export const KIND_ICON: Record<SelectionKind, string> = { well: 'well', formation: 'strata', pick: 'well-pick', contact: 'droplets', overlay: 'layers', interval: 'ruler' };

/** A stable id for a selection: a chip the person removed stays removed while the same object is selected. */
export function selectionId(s: Selection): string {
  const parts = [`selection:${s.kind}:${s.id}`];
  if (s.well && s.well !== s.id) parts.push(`@${s.well}`);
  if (s.md !== undefined) parts.push(`:${round(s.md, 1)}`);
  if (s.top !== undefined || s.base !== undefined) parts.push(`:${round(s.top, 1)}-${round(s.base, 1)}`);
  if (s.part) parts.push(`:${s.part.type}${s.part.index}`);
  return parts.join('');
}

/** The selection as plain data, without its scene coordinates (meaningless to a reader). */
function plain(s: Selection): Json {
  const { point: _p, ...rest } = s;
  void _p;
  return rest as unknown as Json;
}

/** The context chips of the next message. */
export function contextItems(app: App): ContextItem[] {
  const out: ContextItem[] = [];
  const sel = app.selection.value;
  const v = app.inspector.value;
  if (sel && v) {
    out.push({
      id: selectionId(sel),
      label: v.title,
      description: `Selected ${KIND_WORD[sel.kind]}${v.sub ? ` · ${v.sub}` : ''}`,
      icon: KIND_ICON[sel.kind],
      data: { selected: KIND_WORD[sel.kind], selection: plain(sel), name: v.title, subtitle: v.sub, details: inspectorRows(v.rows) },
    });
  }
  const m = app.marking.value;
  if (m?.intervals.length) {
    const n = m.intervals.length;
    const thick = m.intervals.reduce((s, [a, b]) => s + (b - a), 0);
    const wellName = app.field.wells.find((w) => w.id === m.well)?.name ?? m.well;
    out.push({
      id: `marking:${m.well}:${n}:${round(m.intervals[0][0], 1)}:${round(m.intervals[n - 1][1], 1)}`,
      label: `${n} marked interval${n === 1 ? '' : 's'}`,
      description: `Marked by ${m.source} in ${wellName}`,
      icon: 'highlighter',
      data: {
        marking: { well: m.well, source: m.source, intervals: n, totalMdM: round(thick, 1), fromMd: round(m.intervals[0][0], 1), toMd: round(m.intervals[n - 1][1], 1) },
        // the first ones in full; data tools can read the rest by depth
        firstIntervals: m.intervals.slice(0, 40).map(([a, b]) => [round(a, 1), round(b, 1)]) as Json,
      },
    });
  }
  return out;
}

/**
 * Calls `onChange` when the context may have changed: the selection, its
 * details (which follow the well's data) and the marking. Several changes in
 * one task are reported once.
 */
export function subscribeContext(app: App, onChange: () => void): () => void {
  let queued = false;
  let closed = false;
  const ping = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!closed) onChange();
    });
  };
  const offs = [app.selection.subscribe(ping), app.inspector.subscribe(ping), app.marking.subscribe(ping)];
  return () => {
    closed = true;
    offs.forEach((f) => f());
  };
}
