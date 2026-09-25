import { Panel, PanelActions, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { MinusIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { App } from '../app';
import { openWindows, ToolWindow } from '../toolWindow';
import { IconButton } from '../icon-button';
import type { LogTracks } from '../logTracks';
import { ProvBadge } from '../prov';
import { useSignal } from '../signal';
import { TrackEditor } from './TrackEditor';

const editors = new WeakMap<App, ToolWindow>();

/** The track editor opens as a tab in the dock under the 3D view, so the tracks redraw beside it as they change. */
function trackEditor(app: App): ToolWindow {
  let p = editors.get(app);
  if (!p) {
    p = new ToolWindow({ id: 'log-tracks', title: 'Log tracks', body: () => <TrackEditor app={app} /> });
    editors.set(app, p);
  }
  return p;
}

/** Conventional log display synchronised with the 3D cursor. */
export function LogsPanel({ app }: { app: App }) {
  const logs = app.logs;
  const win = useSignal(logs.windowSize);
  const canvas = useRef<HTMLCanvasElement>(null);
  const editor = trackEditor(app);
  const editing = useSignal(openWindows).includes(editor);
  useEffect(() => {
    logs.attach(canvas.current);
    return () => logs.attach(null);
  }, [logs]);
  return (
    <Panel variant="flat" size="sm" aria-label="Well logs" className="h-full rounded-none">
      <PanelHeader>
        <PanelTitle className="flex-initial">Well logs</PanelTitle>
        <ProvBadge prov="measured" short />
        <ProvBadge prov="calculated" short />
        <ProvBadge prov="interpreted" short />
        <PanelActions>
          <IconButton label="Add, remove and edit tracks" size="icon-xs" variant={editing ? 'secondary' : 'ghost'} onPress={() => editor.toggle()}>
            <SlidersHorizontalIcon />
          </IconButton>
          <IconButton label="Zoom out" size="icon-xs" onPress={() => logs.zoom(1.6)}>
            <MinusIcon />
          </IconButton>
          <span className="w-12 text-center font-mono text-xs text-muted-foreground tabular-nums">{win} m</span>
          <IconButton label="Zoom in" size="icon-xs" onPress={() => logs.zoom(1 / 1.6)}>
            <PlusIcon />
          </IconButton>
        </PanelActions>
      </PanelHeader>
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvas} aria-label="Log tracks: click to travel, scroll to move, Ctrl + scroll to zoom" className="absolute inset-0 block size-full cursor-crosshair" />
        <LogReadout logs={logs} />
      </div>
    </Panel>
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
      className="pointer-events-none absolute z-10 flex w-44 flex-col gap-1 rounded-md bg-popover px-2.5 py-2 font-mono text-[10.5px] text-popover-foreground shadow-md ring-1 ring-foreground/10"
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
