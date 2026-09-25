import { z } from 'zod';

/**
 * What is selected: one object of the scene, whichever view it was picked in
 * (the 3D view, the Scene tree, an action). The selection drives the
 * Properties panel, the details card and the right-click menus, whose items
 * are the actions that apply to its kind (`appliesTo` in actions/registry.ts).
 *
 * It is plain, serialisable data, so an assistant can read it (`app.state`)
 * and set it (`selection.set`) like anything else.
 *
 * - `well`: a wellbore. `id` is a well id of the field, or the name of a
 *   context wellbore (trajectory only). A clicked point on the active well
 *   carries `md`; a part of it (casing string, cement sheath, fracture) `part`.
 * - `formation`: a unit of the structural model; `id` is the formation id.
 *   `point` is where it was clicked in 3D, for the read-outs at that place.
 * - `pick`: a formation top in a well; `id` is the formation id, `md` the top.
 * - `contact`: a fluid contact; `id` is the feature that draws it (`owc`).
 * - `overlay`: a scene layer (`casing`, `labels`, `sea`…) or an optional
 *   overlay feature (`curtain`, `uncertainty`…); `id` is the layer or feature id.
 * - `interval`: a depth range on a well (`top`–`base` MD), e.g. a net pay interval.
 *
 * Anything that exists only in one well (a point, a part, a pick, an
 * interval) names that well in `well`; it is cleared when another well opens.
 */
export const SELECTION_KINDS = ['well', 'formation', 'pick', 'contact', 'overlay', 'interval'] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

export interface Selection {
  kind: SelectionKind;
  id: string;
  /** the well a pick, an interval, a point or a part belongs to */
  well?: string;
  /** a depth along the well (a clicked point, a pick's top), m MD */
  md?: number;
  /** an interval's top and base, m MD */
  top?: number;
  base?: number;
  /** a part of the well, by its index in the well's casing strings or fractures */
  part?: { type: 'casing' | 'cement' | 'fracture'; index: number };
  /** where it was clicked, in scene coordinates */
  point?: { x: number; y: number; z: number };
}

/** The selection as a Zod schema: the input of `selection.set`, checked like any tool input. */
export const SelectionSchema = z.object({
  kind: z.enum(SELECTION_KINDS),
  id: z.string().min(1).meta({ description: 'Formation id, well id, layer or feature id (see app.state)' }),
  well: z.string().optional(),
  md: z.number().optional(),
  top: z.number().optional(),
  base: z.number().optional(),
  part: z.object({ type: z.enum(['casing', 'cement', 'fracture']), index: z.number().int().min(0) }).optional(),
  point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
});

/** Do two selections name the same object (and the same place on it)? */
export function sameSelection(a: Selection | null | undefined, b: Selection | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.well === b.well &&
    a.md === b.md &&
    a.top === b.top &&
    a.base === b.base &&
    a.part?.type === b.part?.type &&
    a.part?.index === b.part?.index &&
    a.point?.x === b.point?.x &&
    a.point?.y === b.point?.y &&
    a.point?.z === b.point?.z
  );
}

/**
 * The default input an action gets for a selection: the selection's id under
 * a key named after its kind, e.g. `{ formation: 'hugin' }` or
 * `{ well: '15_9-F-11_B' }`. An action whose input is shaped differently
 * maps the selection itself (`onSelection` in actions/registry.ts).
 */
export function selectionInput(sel: Selection): Record<string, unknown> {
  return { [sel.kind]: sel.id };
}

/** The formation a selection is about (a formation, or the formation a pick is the top of). */
export function formationOf(sel: Selection | null | undefined): string | null {
  return sel && (sel.kind === 'formation' || sel.kind === 'pick') ? sel.id : null;
}

/** The depth a selection points at along its well (a point, a pick, the middle of an interval). */
export function depthOf(sel: Selection | null | undefined): number | null {
  if (!sel) return null;
  if (sel.md !== undefined) return sel.md;
  if (sel.top !== undefined && sel.base !== undefined) return (sel.top + sel.base) / 2;
  return null;
}
