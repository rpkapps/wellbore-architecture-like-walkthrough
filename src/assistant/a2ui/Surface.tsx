/*
 * `A2UISurface`: every surface of one UIPart, each in a quiet frame. The
 * messages are re-applied on each change (cheap: a surface is tens of
 * components), but a surface whose content did not change keeps its state
 * object, so its memoised view — and its charts — do not re-render while a
 * later surface streams in.
 */
import { memo, useCallback, useMemo, useRef } from 'react';
import { Skeleton } from '@tecton/react/components/skeleton';
import { TriangleAlert } from 'lucide-react';
import type { UIEventPart } from '../core/types';
import type { A2UISurfaceProps } from './index';
import { applyMessages, surfaceKey } from './processor';
import { SurfaceView } from './Renderer';
import type { SurfaceState } from './types';
import { validateMessages } from './validate';

const EMPTY_DATASETS = {};

function Issues({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-foreground">
        <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
        {errors.length === 1 ? '1 problem in this interface' : `${errors.length} problems in this interface`}
      </summary>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 font-mono text-[11px] leading-snug break-words">
        {errors.slice(0, 12).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </details>
  );
}

/** Renders the A2UI messages of one UIPart: all its surfaces, in creation order. */
export const A2UISurface = memo(function A2UISurface({ messages, datasets, onAction, streaming = false }: A2UISurfaceProps) {
  const cache = useRef(new Map<string, { key: string; surface: SurfaceState }>());
  const surfaces = useMemo(() => {
    const fresh = applyMessages(null, messages, { streaming });
    const next = new Map<string, { key: string; surface: SurfaceState }>();
    const out = fresh.map((s) => {
      const key = surfaceKey(s);
      const prev = cache.current.get(s.id);
      const keep = prev && prev.key === key ? prev.surface : s;
      next.set(s.id, { key, surface: keep });
      return keep;
    });
    cache.current = next;
    return out;
  }, [messages, streaming]);

  const errors = useMemo(() => (streaming ? [] : validateMessages(messages, { datasets })), [messages, datasets, streaming]);

  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const dispatch = useCallback((event: Omit<UIEventPart, 'type'>) => actionRef.current(event), []);

  const visible = surfaces.filter((s) => s.rootId);
  if (!visible.length) {
    if (streaming)
      return (
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-card p-4" aria-busy="true" aria-label="Building interface">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    return errors.length ? (
      <div className="rounded-xl border border-dashed border-border p-3">
        <Issues errors={errors} />
      </div>
    ) : null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-a2ui="">
      {visible.map((s) => (
        // a surface whose root is a Card already has a frame
        <div
          key={s.id}
          data-surface-id={s.id}
          className={s.components[s.rootId!]?.component === 'Card' ? 'min-w-0' : 'min-w-0 rounded-xl border border-border-subtle bg-card p-4 text-card-foreground'}
        >
          <SurfaceView surface={s} datasets={datasets ?? EMPTY_DATASETS} streaming={streaming} onAction={dispatch} />
        </div>
      ))}
      <Issues errors={errors} />
    </div>
  );
});
