/*
 * Renders one processed surface: walks the adjacency list from the root,
 * keeps the person's edits to the data model (two-way binding) on top of
 * the agent's, and turns Button presses into actions. Each node renders
 * through an error boundary, so one bad component never blanks the surface.
 */
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Dataset, UIEventPart } from '../core/types';
import { CATALOG } from './catalog';
import { Note } from './catalog/frame';
import { isFunctionCall, openUrl, resolveValue } from './functions';
import { setAt } from './pointer';
import { RuntimeContext, useRuntime, type NodeRef, type SurfaceRuntime } from './runtime';
import type { A2UIComponent, SurfaceState } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deeper than this is a runaway tree (or a cycle the trail did not catch). */
const MAX_DEPTH = 48;
/** How long a surface's buttons stay disabled after a press. */
const LOCK_MS = 2500;

class NodeBoundary extends Component<{ type: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn(`A2UI: ${this.props.type} failed to render`, error, info.componentStack);
  }
  render() {
    return this.state.failed ? <Note>This {this.props.type} could not be shown.</Note> : this.props.children;
  }
}

/** Renders the component `id` (nothing when it has not arrived, or would recurse). */
export const NodeRenderer = memo(function NodeRenderer({ id, scope, trail }: NodeRef) {
  const rt = useRuntime();
  const node = rt.surface.components[id];
  const nextTrail = useMemo(() => [...trail, id], [trail, id]);
  if (!node || trail.includes(id) || trail.length >= MAX_DEPTH) return null;
  const C = CATALOG[node.component];
  if (!C) return rt.streaming ? null : <Note>Unsupported component “{node.component}”.</Note>;
  return (
    <NodeBoundary type={node.component}>
      <C node={node} scope={scope} trail={nextTrail} />
    </NodeBoundary>
  );
});

export interface SurfaceViewProps {
  surface: SurfaceState;
  datasets: Record<string, Dataset>;
  streaming: boolean;
  onAction: (event: Omit<UIEventPart, 'type'>) => void;
}

const ROOT_TRAIL: readonly string[] = [];

/** Resolves an action's `context` against the model (each value may be a binding or a function call). */
export function resolveActionContext(context: unknown, model: unknown, scope: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRec(context)) return out;
  for (const [k, v] of Object.entries(context)) out[k] = resolveValue(v, { model, scope });
  return out;
}

/** One surface: its data model with the person's edits, and the action dispatcher. */
export const SurfaceView = memo(function SurfaceView({ surface, datasets, streaming, onAction }: SurfaceViewProps) {
  const [edits, setEdits] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const [locked, setLocked] = useState(false);
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // the agent's model, with what the person typed on top (edits survive later agent updates)
  const model = useMemo(() => {
    let m = surface.dataModel;
    for (const [path, value] of edits) m = setAt(m, path, value);
    return m;
  }, [surface.dataModel, edits]);
  const modelRef = useRef(model);
  modelRef.current = model;

  const setValue = useCallback((path: string, value: unknown) => {
    setEdits((prev) => {
      const next = new Map(prev);
      next.delete(path);
      next.set(path, value);
      return next;
    });
  }, []);

  const dispatch = useCallback(
    (node: A2UIComponent, scope: string, label: string) => {
      const action = node.action;
      if (!isRec(action)) return;
      if (isRec(action.functionCall) && isFunctionCall(action.functionCall)) {
        const fc = action.functionCall;
        if (fc.call === 'openUrl') openUrl(resolveValue(isRec(fc.args) ? fc.args.url : undefined, { model: modelRef.current, scope }));
        return;
      }
      const event = isRec(action.event) ? action.event : typeof action.name === 'string' ? action : null;
      if (!event || typeof event.name !== 'string') return;
      const context = resolveActionContext(event.context, modelRef.current, scope);
      if (surface.sendDataModel) context.dataModel = modelRef.current;
      onAction({ surfaceId: surface.id, name: event.name, sourceComponentId: node.id, context, label: label || event.name });
      setPressedKey(`${node.id}@${scope}`);
      setLocked(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setLocked(false), LOCK_MS);
    },
    [surface.id, surface.sendDataModel, onAction],
  );

  const runtime = useMemo<SurfaceRuntime>(
    () => ({ surface, model, setValue, datasets, streaming, dispatch, locked, pressedKey, Node: NodeRenderer }),
    [surface, model, setValue, datasets, streaming, dispatch, locked, pressedKey],
  );
  if (!surface.rootId) return null;
  return (
    <RuntimeContext.Provider value={runtime}>
      <NodeRenderer id={surface.rootId} scope="/" trail={ROOT_TRAIL} />
    </RuntimeContext.Provider>
  );
});
