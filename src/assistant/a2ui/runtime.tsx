/*
 * What a rendered component can reach: its surface's data model (with the
 * person's edits), the thread's datasets, the action dispatcher and a way to
 * render a child by id. Catalog components read it through these hooks and
 * never import the renderer, so the catalog and the renderer stay apart.
 */
import { createContext, useContext, useMemo, useState, type ComponentType } from 'react';
import type { Dataset } from '../core/types';
import { resolveRows, type RowSource } from './data';
import { resolveText, resolveValue, isBinding, type EvalContext } from './functions';
import { getAt, resolvePath } from './pointer';
import type { A2UIComponent, SurfaceState } from './types';

/** What every catalog component receives. */
export interface NodeProps {
  node: A2UIComponent;
  /** the template item's absolute path (`/` outside templates) */
  scope: string;
  /** the ids from the root down to this node (cycle guard) */
  trail: readonly string[];
}

/** A reference to a child for `runtime.Node`. */
export interface NodeRef {
  id: string;
  scope: string;
  trail: readonly string[];
}

export interface SurfaceRuntime {
  surface: SurfaceState;
  /** the data model as the person sees it (the agent's, plus their edits) */
  model: unknown;
  /** writes a value at an absolute pointer (two-way binding) */
  setValue: (path: string, value: unknown) => void;
  datasets: Record<string, Dataset>;
  streaming: boolean;
  /** a Button's action: sends the event (or runs the local function) */
  dispatch: (node: A2UIComponent, scope: string, label: string) => void;
  /** buttons are briefly disabled after a press, while the agent answers */
  locked: boolean;
  /** the id (and scope) of the last pressed button */
  pressedKey: string | null;
  /** renders a child component by id */
  Node: ComponentType<NodeRef>;
  /** rendered inside the expanded dialog: charts take more height */
  expanded?: boolean;
}

export const RuntimeContext = createContext<SurfaceRuntime | null>(null);

/** The surface runtime (throws outside a surface: a programming error). */
export function useRuntime(): SurfaceRuntime {
  const rt = useContext(RuntimeContext);
  if (!rt) throw new Error('A2UI component rendered outside a surface');
  return rt;
}

/** The evaluation context for a node's scope. */
export function useEval(scope: string): EvalContext {
  const { model } = useRuntime();
  return useMemo(() => ({ model, scope }), [model, scope]);
}

/** A dynamic prop resolved to text. */
export function useText(v: unknown, scope: string): string {
  const ctx = useEval(scope);
  return v === undefined ? '' : resolveText(v, ctx);
}

/** A dynamic prop resolved to its value. */
export function useValue(v: unknown, scope: string): unknown {
  const ctx = useEval(scope);
  return resolveValue(v, ctx);
}

/**
 * A two-way bound value: a `{path}` binding reads and writes the surface's
 * data model; a literal starts local state the input then owns.
 */
export function useBound<T>(v: unknown, scope: string, fallback: T, coerce: (x: unknown) => T): [T, (next: T) => void] {
  const rt = useRuntime();
  const ctx = useEval(scope);
  const [local, setLocal] = useState<T>(() => {
    const init = v === undefined ? undefined : resolveValue(v, ctx);
    return init === undefined ? fallback : coerce(init);
  });
  if (isBinding(v)) {
    const abs = resolvePath(v.path, scope);
    const cur = getAt(rt.model, abs);
    return [cur === undefined ? fallback : coerce(cur), (next: T) => rt.setValue(abs, next)];
  }
  return [local, setLocal];
}

/** The rows a data component shows, memoised on their source. */
export function useRows(props: Record<string, unknown>, scope: string): RowSource {
  const { datasets, model } = useRuntime();
  const pathValue = typeof props.path === 'string' && props.dataset === undefined && props.rows === undefined ? getAt(model, resolvePath(props.path, scope)) : undefined;
  const ds = typeof props.dataset === 'string' ? datasets[props.dataset] : undefined;
  return useMemo(() => {
    if (typeof props.dataset === 'string') return resolveRows({ dataset: props.dataset }, ds ? { [props.dataset]: ds } : {}, null);
    return resolveRows({ rows: props.rows !== undefined ? props.rows : pathValue }, {}, null);
  }, [ds, props.dataset, props.rows, pathValue]);
}
