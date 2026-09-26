import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Toggle } from '@tecton/react/components/toggle';
import { CableIcon, CrosshairIcon, EllipsisIcon, PauseIcon, PlayIcon, RadioTowerIcon, RotateCwIcon, SquareIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConnectionState } from '../../connect/hub';
import type { App } from '../app';
import { IconButton, Tip } from '../icon-button';
import { useSignal } from '../signal';

const STATE: Record<ConnectionState['status'], { label: string; dot: string; pulse?: boolean }> = {
  connecting: { label: 'Connecting', dot: 'bg-warning' },
  live: { label: 'Live', dot: 'bg-success', pulse: true },
  reconnecting: { label: 'Reconnecting', dot: 'bg-warning', pulse: true },
  idle: { label: 'Waiting for data', dot: 'bg-success' },
  done: { label: 'Finished', dot: 'bg-fg-3' },
  error: { label: 'Failed', dot: 'bg-destructive' },
  stopped: { label: 'Stopped', dot: 'bg-fg-3' },
};

export const TRANSPORT_LABEL: Record<string, string> = {
  file: 'Files',
  url: 'URL',
  poll: 'REST polling',
  sse: 'Server-sent events',
  websocket: 'WebSocket',
  mqtt: 'MQTT',
  relay: 'Relay',
  replay: 'Replay',
};

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

function ago(t: number, now: number) {
  if (!t) return 'nothing yet';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 2 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** A second-by-second clock for "3 s ago" labels. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The header of the Live data panel: follow the bit, add a source. */
export function SourcesActions({ app }: { app: App }) {
  const follow = useSignal(app.hub.followBit);
  return (
    <>
      <Tip label={follow ? 'Following the bit: the view stays at the bottom of a well being drilled' : 'Follow the bit'}>
        <Toggle size="sm" aria-label="Follow the bit" isSelected={follow} onChange={(v) => app.hub.followBit.set(v)} className="size-7 min-w-7 p-0">
          <CrosshairIcon />
        </Toggle>
      </Tip>
      {/* a cable, not a +: the group's own + (open a view) sits beside it */}
      <IconButton label="Connect a data source" onPress={() => app.connectRequest.set({})}>
        <CableIcon />
      </IconButton>
    </>
  );
}

/** Every connection: its state, how much is arriving, where it goes, and what it said. */
export function SourcesBody({ app }: { app: App }) {
  const list = useSignal(app.hub.connections);
  const focus = useSignal(app.hub.focus);
  const now = useNow();
  if (!list.length)
    return (
      <Empty className="flex-1 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RadioTowerIcon />
          </EmptyMedia>
          <EmptyTitle>No live data yet</EmptyTitle>
          <EmptyDescription>
            Stream from files, APIs, WebSockets, MQTT, or — through the relay — Kafka, WITSML, ETP and OSDU. Or watch a Volve well being drilled again, faster than real time.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          <Button size="sm" onPress={() => app.actions.run('data.replay', { speed: 60 })}>
            <PlayIcon data-icon="inline-start" />
            Replay a well live
          </Button>
          <Button size="sm" variant="outline" onPress={() => app.connectRequest.set({})}>
            <CableIcon data-icon="inline-start" />
            Connect a source
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-2" aria-label="Connections">
      {list.map((c) => (
        <Connection key={c.id} app={app} c={c} now={now} open={focus === c.id} onToggle={() => app.hub.focus.set(focus === c.id ? null : c.id)} />
      ))}
    </ul>
  );
}

function Connection({ app, c, now, open, onToggle }: { app: App; c: ConnectionState; now: number; open: boolean; onToggle: () => void }) {
  const st = STATE[c.status];
  const running = c.status !== 'stopped' && c.status !== 'done' && c.status !== 'error';
  const perSec = c.rate.length ? c.rate[c.rate.length - 1] : 0;
  const wells = c.wells.map((id) => app.field.wells.find((w) => w.id === id)).filter((w) => !!w);
  const lastErr = [...c.log].reverse().find((l) => l.level === 'error');
  return (
    <li className="rounded-md border border-border-subtle bg-card/40">
      <div className="flex min-w-0 items-center gap-2 px-2 pt-1.5">
        <span
          role="img"
          title={c.paused ? 'Paused' : `${st.label}${c.detail ? ` — ${c.detail}` : ''}`}
          aria-label={c.paused ? 'Paused' : st.label}
          className="relative flex size-2.5 shrink-0 items-center justify-center rounded-full"
        >
          {st.pulse && !c.paused && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${st.dot}`} />}
          <span className={`relative size-2 rounded-full ${c.paused ? 'bg-warning' : st.dot}`} />
        </span>
        <button type="button" onClick={onToggle} aria-expanded={open} className="type-label min-w-0 flex-1 truncate text-left text-fg-1 outline-none hover:underline focus-visible:underline">
          {c.config.name}
        </button>
        {c.codec && <Badge variant="outline">{c.codec}</Badge>}
        {running ? (
          <IconButton label={c.paused ? 'Resume' : 'Pause'} size="icon-xs" onPress={() => app.hub.pause(c.id, !c.paused)}>
            {c.paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
        ) : (
          <IconButton label={c.config.transport.id === 'file' ? 'Import again' : 'Start'} size="icon-xs" isDisabled={c.config.transport.id === 'file'} onPress={() => app.hub.resume(c.id)}>
            <PlayIcon />
          </IconButton>
        )}
        <DropdownMenuTrigger>
          <IconButton label="More" size="icon-xs">
            <EllipsisIcon />
          </IconButton>
          <DropdownMenu placement="bottom end" className="w-max min-w-44">
            <DropdownMenuItem id="edit" onAction={() => app.connectRequest.set({ edit: c.id })} isDisabled={c.config.transport.id === 'file'}>
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem id="restart" onAction={() => app.hub.update(c.id, c.config)} isDisabled={c.config.transport.id === 'file'}>
              <RotateCwIcon />
              Restart
            </DropdownMenuItem>
            <DropdownMenuItem id="stop" onAction={() => app.hub.stop(c.id)} isDisabled={!running}>
              <SquareIcon />
              Stop
            </DropdownMenuItem>
            <DropdownMenuItem id="charts" onAction={() => app.openLive(c.wells[0])} isDisabled={!c.wells.length}>
              Show live charts
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem id="remove" variant="destructive" onAction={() => app.hub.remove(c.id)}>
              Remove
            </DropdownMenuItem>
          </DropdownMenu>
        </DropdownMenuTrigger>
      </div>
      <div className="flex min-w-0 items-center gap-2 px-2 pb-1.5 pl-6.5">
        <Sparkline values={c.rate} />
        <span className="type-caption shrink-0 tabular-nums">
          {running ? `${compact(perSec)} values/s` : c.stats ? `${compact(c.stats.samples)} values` : (TRANSPORT_LABEL[c.config.transport.id] ?? c.config.transport.id)}
        </span>
        <span className="type-caption ml-auto shrink-0 tabular-nums">{c.stats ? ago(c.stats.lastAt, now) : st.label.toLowerCase()}</span>
      </div>
      {(wells.length > 0 || lastErr) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2 pl-6.5">
          {wells.map((w) => (
            <Button key={w.id} variant={w === app.engine.activeWell ? 'secondary' : 'ghost'} size="xs" onPress={() => app.selectWell(w.id)} className="h-5 px-1.5 text-[0.7rem]">
              {w.name}
            </Button>
          ))}
          {lastErr && !open && <span className="type-caption min-w-0 truncate text-destructive!">{lastErr.text}</span>}
        </div>
      )}
      {open && (
        <div className="border-t border-border-subtle px-2 py-1.5 pl-6.5">
          <dl className="type-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt>Source</dt>
            <dd className="truncate text-fg-2">{TRANSPORT_LABEL[c.config.transport.id] ?? c.config.transport.id}</dd>
            <dt>Received</dt>
            <dd className="text-fg-2 tabular-nums">{c.stats ? `${compact(c.stats.messages)} messages · ${compact(c.stats.bytes)}B · ${compact(c.stats.rows)} rows` : '—'}</dd>
            <dt>Steps</dt>
            <dd className="truncate text-fg-2">
              {c.config.steps
                .filter((s) => s.enabled)
                .map((s) => s.id)
                .join(' → ') || 'none'}
            </dd>
          </dl>
          <ul className="mt-1.5 flex max-h-32 flex-col gap-0.5 overflow-y-auto text-[0.7rem]" aria-label="Messages">
            {[...c.log].reverse().map((l, i) => (
              <li key={i} className={`flex gap-2 ${l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-warning' : 'text-fg-2'}`}>
                <span className="shrink-0 text-fg-3 tabular-nums">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="min-w-0">{l.text}</span>
              </li>
            ))}
            {!c.log.length && <li className="text-fg-3">No messages.</li>}
          </ul>
        </div>
      )}
    </li>
  );
}

/** Values per second over the last minute. */
function Sparkline({ values }: { values: number[] }) {
  const W = 72;
  const H = 14;
  if (values.length < 2) return <span className="h-3.5 w-18 shrink-0" />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 1 - (v / max) * (H - 2)).toFixed(1)}`).join(' ');
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="h-3.5 w-18 shrink-0 overflow-visible">
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill="var(--ui-accent)" fillOpacity={0.15} stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--ui-accent)" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
