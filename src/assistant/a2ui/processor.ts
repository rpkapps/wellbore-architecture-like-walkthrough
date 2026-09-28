/*
 * The framework-free half of the renderer: applies a stream of A2UI messages
 * to surface states (an adjacency list of components plus a data model per
 * surface). It never throws on bad input — a model's stream is partial while
 * it arrives and occasionally wrong once it has — it skips what it cannot use,
 * and `validateMessages` (validate.ts) says what was wrong.
 */
import { COMPONENTS, isComplete, refsOf } from './catalog/schema';
import { normalizeMessages } from './normalize';
import { removeAt, setAt } from './pointer';
import { DATA_CATALOG_ID, type A2UIComponent, type SurfaceState } from './types';

export { validateMessages } from './validate';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface ApplyOptions {
  /**
   * The stream may still be arriving: the last component of the last
   * `updateComponents` is marked pending, and a component whose type is not
   * (yet) known or that lacks required props is left out instead of shown
   * as unsupported.
   */
  streaming?: boolean;
}

function newSurface(id: string, catalogId: string): SurfaceState {
  return { id, catalogId, sendDataModel: false, components: {}, rootId: null, dataModel: {}, pending: [], revision: 0 };
}

/**
 * Applies `messages` on top of `state` (the surfaces of earlier messages, or
 * nothing) and returns the live surfaces in creation order. Inputs are never
 * mutated. Accepts v0.9/v0.9.1 messages, v0.8 ones, JSON strings, arrays and
 * `{messages: [...]}` wrappers.
 */
export function applyMessages(state: readonly SurfaceState[] | null | undefined, messages: unknown, opts: ApplyOptions = {}): SurfaceState[] {
  const surfaces = new Map<string, SurfaceState>();
  /** surfaces this call has already copied (so it mutates only its own copies) */
  const owned = new Set<string>();
  /** the v0.8 root a `beginRendering` named */
  const legacyRoot = new Map<string, string>();
  for (const s of state ?? []) surfaces.set(s.id, s);

  const own = (id: string): SurfaceState => {
    const s = surfaces.get(id)!;
    if (owned.has(id)) return s;
    const copy = { ...s, components: { ...s.components }, pending: [] as string[], revision: s.revision + 1 };
    surfaces.set(id, copy);
    owned.add(id);
    return copy;
  };
  const ensure = (id: string): SurfaceState => {
    if (!surfaces.has(id)) {
      surfaces.set(id, newSurface(id, DATA_CATALOG_ID));
      owned.add(id);
    }
    return own(id);
  };

  const list = normalizeMessages(messages);
  const lastIndex = list.length - 1;
  list.forEach((raw, index) => {
    if (!isRec(raw)) return;
    if (isRec(raw.createSurface)) {
      const cs = raw.createSurface;
      if (typeof cs.surfaceId !== 'string' || !cs.surfaceId) return;
      const s = ensure(cs.surfaceId);
      if (typeof cs.catalogId === 'string' && cs.catalogId) s.catalogId = cs.catalogId;
      if (isRec(cs.theme)) s.theme = cs.theme;
      if (typeof cs.sendDataModel === 'boolean') s.sendDataModel = cs.sendDataModel;
      if (typeof cs.root === 'string' && cs.root) legacyRoot.set(s.id, cs.root);
      return;
    }
    if (isRec(raw.updateComponents)) {
      const uc = raw.updateComponents;
      const components = uc.components;
      if (typeof uc.surfaceId !== 'string' || !uc.surfaceId || !Array.isArray(components)) return;
      const s = ensure(uc.surfaceId);
      const streamingTail = opts.streaming && index === lastIndex;
      components.forEach((c, ci) => {
        if (!isRec(c) || typeof c.id !== 'string' || !c.id || typeof c.component !== 'string' || !c.component) return;
        const tail = streamingTail && ci === components.length - 1;
        // a half-streamed type name ("Cha") or a component still missing required props
        if (opts.streaming && (!COMPONENTS[c.component] ? tail : !isComplete(c))) return;
        s.components[c.id] = c as A2UIComponent;
        if (tail) s.pending.push(c.id);
      });
      return;
    }
    if (isRec(raw.updateDataModel)) {
      const um = raw.updateDataModel;
      if (typeof um.surfaceId !== 'string' || !um.surfaceId) return;
      const s = ensure(um.surfaceId);
      const path = typeof um.path === 'string' && um.path ? um.path : '/';
      if (!('value' in um) || um.value === undefined) {
        // while streaming, a missing value is more likely not-yet-arrived than a removal
        if (!(opts.streaming && index === lastIndex)) s.dataModel = removeAt(s.dataModel, path);
      } else s.dataModel = path === '/' ? um.value : setAt(s.dataModel, path, um.value);
      return;
    }
    if (isRec(raw.deleteSurface)) {
      const id = raw.deleteSurface.surfaceId;
      if (typeof id === 'string') {
        surfaces.delete(id);
        owned.delete(id);
      }
    }
  });

  for (const id of owned) {
    const s = surfaces.get(id);
    if (s) s.rootId = resolveRoot(s, legacyRoot.get(id) ?? s.rootId, !!opts.streaming);
  }
  return [...surfaces.values()];
}

/**
 * The spec's root rule: the component with id `root`. A v0.8 surface names
 * its root in `beginRendering`. Once the stream is complete and no `root`
 * exists, the first component nothing refers to stands in (the validator
 * still reports the missing root).
 */
export function resolveRoot(s: SurfaceState, preferred: string | null, streaming: boolean): string | null {
  if (preferred && s.components[preferred]) return preferred;
  if (s.components.root) return 'root';
  return streaming ? null : fallbackRoot(s);
}

function fallbackRoot(s: SurfaceState): string | null {
  const referenced = new Set<string>();
  for (const c of Object.values(s.components)) for (const r of refsOf(c)) referenced.add(r.id);
  return Object.keys(s.components).find((id) => !referenced.has(id)) ?? null;
}

/** A cheap structural key of a surface, so a view can keep the previous state object when nothing changed. */
export function surfaceKey(s: SurfaceState): string {
  try {
    return JSON.stringify([s.catalogId, s.rootId, s.pending, s.components, s.dataModel]);
  } catch {
    return String(Math.random());
  }
}
