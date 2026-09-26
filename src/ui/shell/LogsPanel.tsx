import { Button } from '@tecton/react/components/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Popover, PopoverHeader, PopoverTitle, PopoverTrigger } from '@tecton/react/components/popover';
import { Skeleton } from '@tecton/react/components/skeleton';
import { LogCurveIcon } from '@tecton/react/icons';
import { MinusIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import type { LogTracks } from '../logTracks';
import { ProvBadge } from '../prov';
import { useRev, useSignal } from '../signal';
import { TrackEditor } from './TrackEditor';

/**
 * The log panel's header controls: provenance key, track editor and depth
 * window. The track editor is a popover on its button rather than a panel of
 * its own: it only changes how these tracks draw, and they stay in view
 * beside it while it is open.
 */
export function LogsActions({ app }: { app: App }) {
  const logs = app.logs;
  const win = useSignal(logs.windowSize);
  const editing = useSignal(app.tracksOpen);
  return (
    <>
      <span className="mr-1 flex items-center gap-0.5">
        <ProvBadge prov="measured" short />
        <ProvBadge prov="calculated" short />
        <ProvBadge prov="interpreted" short />
      </span>
      <PopoverTrigger isOpen={editing} onOpenChange={(o) => app.tracksOpen.set(o)}>
        <IconButton label="Add, remove and edit tracks" size="icon-xs" variant={editing ? 'secondary' : 'ghost'}>
          <SlidersHorizontalIcon />
        </IconButton>
        <Popover placement="bottom end" className="w-96">
          <PopoverHeader>
            <PopoverTitle>Log tracks</PopoverTitle>
          </PopoverHeader>
          <div className="flex max-h-[70vh] min-h-0 flex-col">
            <TrackEditor app={app} />
          </div>
        </Popover>
      </PopoverTrigger>
      <IconButton label="Zoom out" size="icon-xs" onPress={() => logs.zoom(1.6)}>
        <MinusIcon />
      </IconButton>
      <span className="type-value w-11 text-center text-[0.75rem]!">{win} m</span>
      <IconButton label="Zoom in" size="icon-xs" onPress={() => logs.zoom(1 / 1.6)}>
        <PlusIcon />
      </IconButton>
    </>
  );
}

/** Conventional log display synchronised with the 3D cursor. */
export function LogsBody({ app }: { app: App }) {
  const logs = app.logs;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    logs.attach(canvas.current);
    return () => logs.attach(null);
  }, [logs]);
  const loading = useSignal(app.loadingWell);
  useRev(app.wellRev);
  const w = app.engine?.activeWell;
  return (
    <div className="relative min-h-0 flex-1">
      {loading && <LogsSkeleton name={loading} />}
      {!loading && w && !w.logs && <NoLogs app={app} name={w.name} />}
      {/* the canvas keeps its own size (grown in steps while the panel resizes); this box clips it to the panel */}
      <div className="absolute inset-0 overflow-hidden">
        <canvas ref={canvas} aria-label="Log tracks: click to travel, scroll to move, Ctrl + scroll to zoom" className="absolute top-0 left-0 block cursor-crosshair" />
      </div>
      <LogReadout logs={logs} />
    </div>
  );
}

/** The open well has no logs (a trajectory, or a live well before its first readings): say so, and offer the import. */
function NoLogs({ app, name }: { app: App; name: string }) {
  return (
    <Empty className="absolute inset-2 z-10 w-auto border bg-panel">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LogCurveIcon />
        </EmptyMedia>
        <EmptyTitle>{name} has no logs</EmptyTitle>
        <EmptyDescription>Import LAS, CSV or XLSX logs for it, or open a well that has them.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onPress={() => app.dataOpen.set(true)}>
          Import logs…
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Placeholder track columns while a well's logs load. */
function LogsSkeleton({ name }: { name: string }) {
  return (
    <div role="status" aria-label={`Loading ${name} logs`} className="absolute inset-0 z-10 flex flex-col gap-2 bg-panel p-2">
      <div className="flex gap-1.5">
        {[0.7, 1, 1, 0.8, 1, 1].map((f, i) => (
          <div key={i} className="flex flex-col gap-1" style={{ flex: `${f} 1 0` }}>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 gap-1.5">
        {[0.7, 1, 1, 0.8, 1, 1].map((f, i) => (
          <Skeleton key={i} className="h-full" style={{ flex: `${f} 1 0`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <span className="type-caption absolute inset-x-0 top-1/2 text-center">Loading {name} logs …</span>
    </div>
  );
}

const TONE = { m: 'text-azure-560', c: 'text-saffron-560', i: 'text-violet-560' };

/** Values of every curve at the depth under the pointer. */
function LogReadout({ logs }: { logs: LogTracks }) {
  const r = useSignal(logs.readout);
  if (!r) return null;
  const left = r.x + 200 > r.w;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 flex w-44 flex-col gap-1 rounded-md bg-popover px-2.5 py-2 font-mono text-[0.75rem] text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: left ? r.x - 188 : r.x + 16, top: Math.max(4, Math.min(r.y + 14, r.h - 260)) }}
    >
      <span className="text-foreground">{r.title}</span>
      <span className="truncate font-sans text-muted-foreground">{r.zone}</span>
      {r.groups.map((g, i) => (
        <dl key={i} className="grid grid-cols-[auto_1fr] gap-x-2">
          {g.map((row) => (
            <div key={row.k} className="contents">
              <dt className="text-muted-foreground">{row.k}</dt>
              <dd className={`text-right ${TONE[row.tone]}`}>{row.v}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}
