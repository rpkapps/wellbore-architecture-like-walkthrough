import { ContextMenu, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@tecton/react/components/context-menu';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { ArrowDownLeftIcon, ArrowUpRightIcon, ChartColumnIcon, ChevronsLeftRightIcon, CircleHelpIcon, DatabaseIcon, EyeIcon, EyeOffIcon, LayoutGridIcon, RadioTowerIcon, RotateCcwIcon, SettingsIcon, UploadIcon, XIcon } from 'lucide-react';
import { memo, useMemo, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { App } from '../app';
import { IconButton, Tip } from '../icon-button';
import { SURFACE } from '../shell/overlay';
import { useSignal, type Signal } from '../signal';
import { animate, withTransition } from '../transition';
import type { Flyout } from './Frame';
import { locate, type Layout, type Workspace } from './layout';
import { atDefault, closePanel, groupOf, maximised, place, placementLabel, placements, reveal, type Placement } from './ops';
import { RAIL_ENTRIES, viewGroups, type PanelDef } from './panels';

/**
 * The panel rail (VS Code's activity bar, Petrel's Windows pane): one
 * labelled list of every panel, down the far left of the stage. Its own
 * entries are the everyday panels; Views lists every analysis window by
 * workflow phase, Data the ways to bring data in, and settings and help sit at
 * the bottom. A dot shows the state of each panel: filled while it shows,
 * hollow while it is open but hidden (a tab behind another, a folded column,
 * or every panel hidden with Tab).
 *
 * Every entry subscribes to just its own panel's state, so a layout change
 * re-renders the entries whose dot changes, not the rail.
 */
export const Rail = memo(function Rail({
  ws,
  panels,
  x,
  y,
  w,
  h,
  flyout,
  setFlyout,
  extra,
  footer,
}: {
  ws: Workspace;
  panels: Map<string, PanelDef>;
  x: number;
  y: number;
  w: number;
  h: number;
  /** the folded column's panel shown as a flyout */
  flyout: Flyout | null;
  setFlyout: (f: Flyout | null) => void;
  extra?: ReactNode;
  footer?: ReactNode;
}) {
  const own = RAIL_ENTRIES.filter((e) => panels.has(e.id));
  // a folded left column merges into the rail: panels in it that have no entry of their own get one while it is folded
  const folded = useSignalPart(ws.layout, (L) => (L.left.collapsed ? L.left.stacks.flatMap((s) => s.panels).filter((id) => !own.some((e) => e.id === id) && panels.has(id)) : []).join(' '));
  const leftFolded = useSignalPart(ws.layout, (L) => L.left.collapsed && L.left.stacks.length > 0);
  const entry = (d: PanelDef, short: string) => <PanelEntry key={d.id} ws={ws} def={d} short={short} peek={flyout?.panel === d.id} setFlyout={setFlyout} />;
  return (
    <nav
      aria-label="Panels"
      data-rail
      className={`absolute z-10 flex flex-col items-stretch gap-0.5 overflow-x-hidden overflow-y-auto p-1 ${SURFACE}`}
      style={{ left: x, top: y, width: w, height: h }}
    >
      {leftFolded && (
        <div className="flex justify-center">
          <IconButton label="Expand the left column" size="icon-sm" placement="right" onPress={() => withTransition(() => ws.setCollapsed('left', false))}>
            <ChevronsLeftRightIcon />
          </IconButton>
        </div>
      )}
      {own.map((e) => entry(panels.get(e.id)!, e.short))}
      {folded &&
        folded.split(' ').map((id) => {
          const d = panels.get(id);
          return d ? entry(d, d.title) : null;
        })}
      <div aria-hidden className="mx-2 my-1 h-px shrink-0 bg-border-subtle" />
      <ViewsEntry ws={ws} panels={panels} />
      {extra}
      <div className="min-h-2 flex-1" />
      {footer}
      <HideToggle ws={ws} />
    </nav>
  );
});

/**
 * Subscribes to one part of a signal: the caller renders again only when that
 * part changes, not on every change of the signal (a layout change per drop).
 */
function useSignalPart<T, R extends string | number | boolean | null>(s: Signal<T>, part: (v: T) => R): R {
  return useSyncExternalStore(s.subscribe, () => part(s.value));
}

type State = 'shown' | 'open' | 'closed';

/** A panel's state for its dot: showing, open but hidden, or closed. */
function stateOf(L: Layout, id: string): State {
  const p = locate(L, id);
  if (!p) return 'closed';
  if (p.kind === 'float') return p.win.active === id ? 'shown' : 'open';
  return p.stack.active === id && !L[p.zone].collapsed ? 'shown' : 'open';
}

/**
 * A rail entry: the icon with its dot and a short label under it. A tooltip
 * gives the full name when the label is shortened.
 */
function RailButton({
  short,
  title,
  icon,
  state,
  menu = false,
  badge,
  ...props
}: { short: string; title: string; icon: ReactNode; state: State; badge?: ReactNode; /** opens a menu: the dot alone shows state */ menu?: boolean } & Omit<ComponentProps<typeof AriaButton>, 'children' | 'className'> & {
    'data-rail-panel'?: boolean;
  }) {
  const button = (
    <AriaButton
      aria-label={title}
      {...props}
      className={`relative flex w-full shrink-0 cursor-default flex-col items-center gap-0.5 rounded-md px-0.5 pt-1.5 pb-1 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0 ${
        state === 'shown' && !menu ? 'bg-ghost-active text-fg-1' : 'text-fg-2 hover:bg-ghost-hover hover:text-fg-1 data-pressed:bg-ghost-active'
      }`}
    >
      <span className="relative flex">
        {icon}
        {state !== 'closed' && (
          <span aria-hidden className={`absolute -top-0.5 -right-2 size-1.5 rounded-full ${state === 'shown' ? 'bg-ui-accent' : 'border border-fg-3'}`} />
        )}
        {badge}
      </span>
      <span className="max-w-full truncate text-[0.68rem] leading-3.5 font-medium">{short}</span>
    </AriaButton>
  );
  return short === title ? (
    button
  ) : (
    <Tip label={title} placement="right">
      {button}
    </Tip>
  );
}

/**
 * What a click on a panel's entry does:
 * - closed: it opens where it was last (a feature's window turns its feature on);
 * - open behind another tab or window: it comes to the front;
 * - in a folded column: it shows as a flyout beside the rail or strip (click
 *   again to close it), or, when it is all the column holds, the column unfolds;
 * - showing: it closes (it reopens in the same place), except when it is all
 *   its column holds, which folds instead, keeping the column's place and size.
 */
function press(ws: Workspace, d: PanelDef, peek: boolean, setFlyout: (f: Flyout | null) => void) {
  const L = ws.value;
  const at = locate(L, d.id);
  // a maximised group other than this panel's is restored first
  if (maximised.value && maximised.value !== groupOf(ws, d.id)) maximised.set(null);
  // a flyout open for another panel closes (the rail does not count as outside it)
  if (!at || ws.hidden.value || at.kind !== 'dock' || !L[at.zone].collapsed) setFlyout(null);
  if (!at || ws.hidden.value) {
    withTransition(() => reveal(ws, d));
    return;
  }
  if (at.kind === 'dock' && L[at.zone].collapsed) {
    const col = L[at.zone];
    if (col.stacks.length === 1 && col.stacks[0].panels.length === 1) withTransition(() => reveal(ws, d));
    else {
      if (!peek) d.onReveal?.();
      animate(() => setFlyout(peek ? null : { zone: at.zone, stack: at.stack.id, panel: d.id }));
    }
    return;
  }
  if (at.kind === 'float') {
    if (at.win.active !== d.id) withTransition(() => reveal(ws, d));
    else if (at.index !== L.floating.length - 1) ws.raise(at.win.id);
    else withTransition(() => closePanel(ws, d, false));
    return;
  }
  if (at.stack.active !== d.id) withTransition(() => reveal(ws, d));
  else if (L[at.zone].stacks.length === 1 && at.stack.panels.length === 1) withTransition(() => ws.setCollapsed(at.zone, true));
  else withTransition(() => closePanel(ws, d, false));
}

/** A panel's entry; right click (or long press, Shift F10) moves it. */
function PanelEntry({ ws, def, short, peek, setFlyout }: { ws: Workspace; def: PanelDef; short: string; peek: boolean; setFlyout: (f: Flyout | null) => void }) {
  const layout = useSignalPart(ws.layout, (L) => stateOf(L, def.id));
  const hidden = useSignal(ws.hidden);
  const state: State = peek ? 'shown' : hidden && layout !== 'closed' ? 'open' : layout;
  return (
    <ContextMenuTrigger>
      <RailButton data-rail-panel short={short} title={def.title} icon={def.icon} state={state} aria-pressed={state === 'shown'} onPress={() => press(ws, def, peek, setFlyout)} />
      <ContextMenu
        className="w-max min-w-44"
        onAction={(k) => {
          if (peek) setFlyout(null);
          withTransition(() => (k === 'close' ? closePanel(ws, def) : place(ws, def, String(k) as Placement)));
        }}
      >
        <PlaceItems ws={ws} id={def.id} />
      </ContextMenu>
    </ContextMenuTrigger>
  );
}

/**
 * Where a panel can go from where it is (the same list as its ⋯ menu: the
 * other slot of its sidebar, the other regions, undock or dock back); read as
 * the menu opens.
 */
function PlaceItems({ ws, id }: { ws: Workspace; id: string }) {
  const at = locate(ws.value, id);
  return (
    <>
      <ContextMenuGroup>
        {placements(ws, id, true).map((p) => (
          <ContextMenuItem key={p} id={p} textValue={placementLabel(ws, id, p)}>
            {p === 'float' ? <ArrowUpRightIcon /> : p === 'dock' ? <ArrowDownLeftIcon /> : null}
            {placementLabel(ws, id, p)}
          </ContextMenuItem>
        ))}
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuItem id="default" isDisabled={!!at && atDefault(ws, id)}>
        <RotateCcwIcon />
        Reset location
      </ContextMenuItem>
      <ContextMenuItem id="close" isDisabled={!at}>
        <XIcon />
        Close
      </ContextMenuItem>
    </>
  );
}

/** Views: every analysis and tool window, by workflow phase; ticked while open, and choosing one shows it (or closes it while it shows). */
function ViewsEntry({ ws, panels }: { ws: Workspace; panels: Map<string, PanelDef> }) {
  const groups = useMemo(() => viewGroups(panels), [panels]);
  const ids = useMemo(() => groups.flatMap((g) => g.panels.map((d) => d.id)), [groups]);
  // the dot: filled when any view shows, hollow when one is open behind something
  const state = useSignalPart(ws.layout, (L): State => {
    let s: State = 'closed';
    for (const id of ids) {
      const v = stateOf(L, id);
      if (v === 'shown') return 'shown';
      if (v === 'open') s = 'open';
    }
    return s;
  });
  const hidden = useSignal(ws.hidden);
  return (
    <DropdownMenuTrigger>
      <RailButton menu short="Views" title="Views" icon={<LayoutGridIcon />} state={hidden && state === 'shown' ? 'open' : state} />
      <DropdownMenu placement="right top" className="w-max min-w-56" shouldCloseOnSelect>
        <ViewsItems ws={ws} groups={groups} />
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

function ViewsItems({ ws, groups }: { ws: Workspace; groups: ReturnType<typeof viewGroups> }) {
  useSignal(ws.layout);
  const choose = (d: PanelDef) => {
    if (ws.isShown(d.id) && !ws.hidden.value) withTransition(() => closePanel(ws, d, false));
    else withTransition(() => reveal(ws, d));
  };
  return (
    <>
      {groups.map((g) => (
        <DropdownMenuGroup key={g.phase} selectionMode="multiple" selectedKeys={g.panels.filter((d) => ws.isOpen(d.id)).map((d) => d.id)}>
          <DropdownMenuLabel>{g.phase}</DropdownMenuLabel>
          {g.panels.map((d) => (
            <DropdownMenuItem key={d.id} id={d.id} textValue={d.title} onAction={() => choose(d)}>
              {d.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

/** Tab's hide-every-panel, as a toggle at the foot of the rail. */
function HideToggle({ ws }: { ws: Workspace }) {
  const hidden = useSignal(ws.hidden);
  return (
    <div className="flex justify-center pt-0.5">
      <IconButton label={hidden ? 'Show panels (Tab)' : 'Hide panels (Tab)'} size="icon-sm" placement="right" aria-pressed={hidden} variant={hidden ? 'secondary' : 'ghost'} onPress={() => withTransition(() => ws.hidden.set(!ws.hidden.value))}>
        {hidden ? <EyeIcon /> : <EyeOffIcon />}
      </IconButton>
    </div>
  );
}

/** Data: import files, the production sheet and the live sources. A dot pulses while any source streams. */
export function DataEntry({ app }: { app: App }) {
  const live = useSignalPart(app.hub.connections, (list) => list.filter((c) => (c.status === 'live' || c.status === 'connecting' || c.status === 'reconnecting') && !c.paused).length);
  return (
    <DropdownMenuTrigger>
      <RailButton
        menu
        short="Data"
        title={live ? `Data (${live} live source${live > 1 ? 's' : ''} streaming)` : 'Data'}
        icon={<DatabaseIcon />}
        state="closed"
        badge={live > 0 && <span aria-hidden className="absolute -right-1 -bottom-0.5 size-1.5 animate-pulse rounded-full bg-success ring-2 ring-background" />}
      />
      <DropdownMenu placement="right top" className="w-max min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Data</DropdownMenuLabel>
          <DropdownMenuItem id="import" onAction={() => app.dataOpen.set(true)}>
            <UploadIcon />
            Import data…
          </DropdownMenuItem>
          <DropdownMenuItem id="production" onAction={() => app.productionOpen.set(true)}>
            <ChartColumnIcon />
            Production
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem id="sources" onAction={() => app.openSources()}>
          <RadioTowerIcon />
          {live ? `Live sources (${live} streaming)` : 'Live sources'}
        </DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

/** Settings (the Personalise dialog) and help, at the foot of the rail. */
export function RailFooter({ app }: { app: App }) {
  return (
    <>
      <RailButton short="Settings" title="Settings" icon={<SettingsIcon />} state="closed" onPress={() => app.personaliseOpen.set(true)} />
      <RailButton short="Help" title="Controls & data notes" icon={<CircleHelpIcon />} state="closed" onPress={() => app.helpOpen.set(true)} />
    </>
  );
}
