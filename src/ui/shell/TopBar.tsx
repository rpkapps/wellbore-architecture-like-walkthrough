import { Button } from '@tecton/react/components/button';
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@tecton/react/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Separator } from '@tecton/react/components/separator';
import { Tabs } from '@tecton/react/components/tabs';
import { Tab, TabStrip } from '../tabs';
import { AppShellBrand, AppShellHeader, useMinWidth } from '@tecton/react/tecton/app-shell';
import { Overflow, OverflowDivider, OverflowItem, OverflowLabel, OverflowSpacer } from '@tecton/react/tecton/overflow';
import { LogCurveIcon, OilRigOffshoreIcon, WellIcon } from '@tecton/react/icons';
import {
  AppWindowIcon,
  ChartColumnIcon,
  CircleHelpIcon,
  CompassIcon,
  FlaskConicalIcon,
  MaximizeIcon,
  PaintBucketIcon,
  PaletteIcon,
  PanelLeftIcon,
  RadioTowerIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UploadIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useSyncExternalStore, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import type { NavMode } from '../../scene/cameraRig';
import type { PropertyMode } from '../../scene/wellbore';
import type { App, ToolEntry } from '../app';
import { IconButton, Tip } from '../icon-button';
import { Logo } from '../logo';
import { useNameDialog, useWindowMenu, WorkspaceSubmenu, WorkspaceTabs } from '../workspace/menus';
import type { PanelDef } from '../workspace/panels';
import { Signal, useRev, useSignal } from '../signal';
import { DataDialog } from './DataDialog';
import { ConnectDialog } from './ConnectDialog';
import { HelpDialog } from './HelpDialog';
import { PersonaliseDialog } from './PersonaliseDialog';
import { CommandPalette } from './CommandPalette';
import { Kbd } from '@tecton/react/components/kbd';
import { ProductionSheet } from './ProductionSheet';

const PROPERTIES: { id: PropertyMode; label: string; dot: string }[] = [
  { id: 'resistivity', label: 'Resistivity', dot: '#7fe3ff' },
  { id: 'hydrocarbon', label: 'Hydrocarbons', dot: '#ffb547' },
  { id: 'lithology', label: 'Lithology', dot: '#a28e67' },
  { id: 'rop', label: 'ROP', dot: '#f28a3c' },
];

const idle = new Signal<unknown>(0);

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Divider between the brand, the well and the row. Every divider in the header
 * is the same short rule with the same space either side: the header's gap
 * here, the row's smaller gap plus a margin in `GroupDivider`.
 */
function Divider() {
  return <Separator orientation="vertical" className="h-4 aria-[orientation=vertical]:self-center" />;
}

/** Divider between groups in the row; it leaves with the items around it. */
function GroupDivider() {
  return <OverflowDivider className="mx-1" />;
}

/**
 * Brand, well selector and one row holding everything else: navigation,
 * colouring, commands, and the window and panel controls. As the window
 * narrows, labels collapse to icons, then controls move into the More menu
 * at the end, least used first, down to the well, search and More on a phone.
 */
export function TopBar({ app, panels, brand = true }: { app: App; panels: Map<string, PanelDef>; brand?: boolean }) {
  const ready = useSignal(app.ready);
  return (
    <AppShellHeader className="gap-2 px-2 sm:px-3">
      <AppShellBrand className="shrink-0">
        {/* mounts as the loader leaves, so the loader's logo flies here */}
        {brand ? (
          <span className="brand-logo flex">
            <Logo />
          </span>
        ) : (
          <span className="size-6" />
        )}
        <span className="hidden lg:inline">BoreWalk</span>
      </AppShellBrand>
      {ready && <Controls app={app} panels={panels} />}
    </AppShellHeader>
  );
}

/**
 * Subscribes to one part of a signal (a flag, a count): the caller renders
 * again only when that part changes, not on every change of the signal.
 */
function useSignalPart<T, R extends string | number | boolean | null>(s: Signal<T>, part: (v: T) => R): R {
  return useSyncExternalStore(s.subscribe, () => part(s.value));
}

/** Is the panel open and showing? Re-renders the caller only when that flips, not on every layout change. */
function useShown(app: App, id: string) {
  return useSignalPart(app.workspace.layout, () => app.workspace.isShown(id));
}

/**
 * The row itself subscribes to nothing: every control that shows state
 * subscribes to just that state, so a layout change, a view change or a
 * dialog opening re-renders one button, not the whole row with its tooltips.
 */
const Controls = memo(function Controls({ app, panels }: { app: App; panels: Map<string, PanelDef> }) {
  const fullscreen = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  const palette = isMac ? '⌘K' : 'Ctrl K';
  return (
    <>
      <Divider />
      <WellSelect app={app} />
      <Divider />
      <Overflow role="group" aria-label="View and commands" className="min-w-0 flex-1 flex-nowrap justify-end gap-1">
        <WorkspaceItem app={app} />
        <GroupDivider />
        <NavItem app={app} />
        <GroupDivider />
        <ColourItem app={app} />
        {/* the spacer comes first, so the divider stays beside the commands, not before the gap */}
        <OverflowSpacer />
        <GroupDivider />
        <PanelItem app={app} id="interpretation" priority={6} label="Interpretation" Icon={FlaskConicalIcon} />
        <PanelItem app={app} id="features" priority={5} label="Features" Icon={SlidersHorizontalIcon} />
        <OverflowItem id="production" priority={4} label="Production" icon={<ChartColumnIcon />} onAction={() => app.productionOpen.set(true)}>
          <Button variant="ghost" size="sm">
            <ChartColumnIcon data-icon="inline-start" />
            <OverflowLabel>Production</OverflowLabel>
          </Button>
        </OverflowItem>
        <OverflowItem id="data" priority={4} label="Data" icon={<UploadIcon />} onAction={() => app.dataOpen.set(true)}>
          <Button variant="ghost" size="sm">
            <UploadIcon data-icon="inline-start" />
            <OverflowLabel>Data</OverflowLabel>
          </Button>
        </OverflowItem>
        <LiveItem app={app} />
        <Tools app={app} />
        <GroupDivider />
        <IconItem id="overview" priority={3} label="Field overview" icon={<OilRigOffshoreIcon />} onAction={() => app.overview()} />
        <IconItem id="personalise" priority={1} label="Personalise" icon={<PaletteIcon />} onAction={() => app.personaliseOpen.set(true)} />
        <IconItem id="help" priority={1} label="Controls & data notes" icon={<CircleHelpIcon />} onAction={() => app.helpOpen.set(true)} />
        <IconItem id="fullscreen" priority={0} label="Fullscreen" icon={<MaximizeIcon />} onAction={fullscreen} />
        <GroupDivider />
        <OverflowItem id="palette" priority={10} label="Command palette" icon={<SearchIcon />} shortcut={palette} onAction={() => app.paletteOpen.set(true)}>
          <Button variant="ghost" size="sm" aria-label="Command palette" className="gap-1.5 text-fg-2">
            <SearchIcon data-icon="inline-start" />
            <OverflowLabel>
              <Kbd className="h-4 px-1 text-[0.68rem]">{palette}</Kbd>
            </OverflowLabel>
          </Button>
        </OverflowItem>
        <WindowMenu app={app} panels={panels} />
        <LeftToggle app={app} />
        <LogsToggle app={app} />
      </Overflow>
      <Opens s={app.productionOpen}>{(isOpen, onOpenChange) => <ProductionSheet app={app} isOpen={isOpen} onOpenChange={onOpenChange} />}</Opens>
      <Opens s={app.dataOpen}>{(isOpen, onOpenChange) => <DataDialog app={app} isOpen={isOpen} onOpenChange={onOpenChange} />}</Opens>
      <Opens s={app.helpOpen}>{(isOpen, onOpenChange) => <HelpDialog app={app} isOpen={isOpen} onOpenChange={onOpenChange} />}</Opens>
      <Opens s={app.personaliseOpen}>{(isOpen, onOpenChange) => <PersonaliseDialog app={app} isOpen={isOpen} onOpenChange={onOpenChange} />}</Opens>
      <CommandPalette app={app} />
      <ConnectDialog app={app} />
    </>
  );
});

/** A dialog opened by a signal; only it renders when the signal flips. */
function Opens({ s, children }: { s: Signal<boolean>; children: (isOpen: boolean, onOpenChange: (o: boolean) => void) => ReactNode }) {
  return children(useSignal(s), s.set.bind(s));
}

function WellSelect({ app }: { app: App }) {
  useRev(app.wellRev);
  const e = app.engine;
  return (
    <Select
      aria-label="Active wellbore"
      selectedKey={e.activeWell.id}
      onSelectionChange={(k: Key | null) => {
        if (k !== null && k !== e.activeWell.id) app.selectWell(String(k));
      }}
      // shrinks before anything leaves the row, down to a readable name
      className="w-48 min-w-28 shrink"
    >
      <SelectTrigger size="sm" className="w-full min-w-0">
        <WellIcon />
        {/* the name alone, so a long one ends in an ellipsis */}
        <SelectValue className="min-w-0">{({ selectedText }) => <span className="truncate">{selectedText}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent className="w-max min-w-64">
        {app.selectableWells().map((w) => (
          <SelectItem key={w.id} id={w.id} textValue={w.name}>
            {w.name}
            {w.liveSource ? (
              <span className="text-success">live</span>
            ) : w.userAdded ? (
              <span className="text-muted-foreground">uploaded</span>
            ) : (
              !w.lasFile && <span className="text-muted-foreground">survey + production</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NavItem({ app }: { app: App }) {
  useRev(app.viewRev);
  const mode = app.engine.rig.mode;
  return (
    <OverflowItem
      id="nav"
      priority={9}
      labelBehavior="keep"
      tooltip={false}
      overflow={<ChoiceMenu id="nav" label="Navigation" icon={<CompassIcon />} value={mode} choices={NAV} onChange={(k) => app.setNav(k as NavMode)} />}
    >
      <Tabs selectedKey={mode} onSelectionChange={(k) => app.setNav(String(k) as NavMode)} className="shrink-0">
        <TabStrip aria-label="Navigation">
          {NAV.map((n) => (
            <Tab key={n.id} id={n.id}>
              {n.label}
            </Tab>
          ))}
        </TabStrip>
      </Tabs>
    </OverflowItem>
  );
}

function ColourItem({ app }: { app: App }) {
  useRev(app.viewRev);
  const optional = useSignal(app.optionalModes);
  const roomy = useMinWidth(1360);
  const mode = app.engine.mode;
  const props = PROPERTIES.filter((p) => p.id !== 'rop' || optional.has('rop'));
  return (
    <OverflowItem
      id="colour"
      priority={8}
      labelBehavior="keep"
      tooltip={false}
      overflow={
        <ChoiceMenu
          id="colour"
          label="Colour by"
          icon={<PaintBucketIcon />}
          value={mode}
          choices={props.map((p) => ({ id: p.id, label: p.label, icon: <Dot color={p.dot} /> }))}
          onChange={(k) => app.setProperty(k as PropertyMode)}
        />
      }
    >
      {roomy ? (
        <Tabs selectedKey={mode} onSelectionChange={(k) => app.setProperty(String(k) as PropertyMode)} className="shrink-0">
          <TabStrip aria-label="Colour the wellbore by">
            {props.map((p) => (
              <Tab key={p.id} id={p.id}>
                <Dot color={p.dot} />
                {p.label}
              </Tab>
            ))}
          </TabStrip>
        </Tabs>
      ) : (
        <Select aria-label="Colour the wellbore by" selectedKey={mode} onSelectionChange={(k: Key | null) => k !== null && app.setProperty(String(k) as PropertyMode)} className="w-36 shrink-0">
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-max min-w-(--trigger-width)">
            {props.map((p) => (
              <SelectItem key={p.id} id={p.id} textValue={p.label}>
                {/* the item's own row does not centre its children vertically */}
                <span className="flex items-center gap-2">
                  <Dot color={p.dot} />
                  {p.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </OverflowItem>
  );
}

/** A panel's button (Interpretation, Features): highlighted while the panel shows. */
function PanelItem({ app, id, priority, label, Icon }: { app: App; id: 'interpretation' | 'features'; priority: number; label: string; Icon: LucideIcon }) {
  const shown = useShown(app, id);
  return (
    <OverflowItem id={id} priority={priority} label={label} icon={<Icon />} onAction={() => app.showSidebar(id, true)}>
      <Button variant={shown ? 'secondary' : 'ghost'} size="sm">
        <Icon data-icon="inline-start" />
        <OverflowLabel>{label}</OverflowLabel>
      </Button>
    </OverflowItem>
  );
}

function Tools({ app }: { app: App }) {
  const tools = useSignal(app.tools);
  return (
    <>
      {tools.length > 0 && <GroupDivider />}
      {tools.map((t) => (
        <Tool key={t.id} t={t} />
      ))}
    </>
  );
}

function WindowMenu({ app, panels }: { app: App; panels: Map<string, PanelDef> }) {
  const items = useWindowMenu(app, panels);
  return <MenuItem id="window" priority={5} label="Window" icon={<AppWindowIcon />} items={items} className="min-w-56" />;
}

/**
 * The workspace tabs, first in the row so they sit by the well: tabs while
 * there is room, a select when the window narrows, then a submenu of the
 * More menu. The name dialog lives here, outside both, so it outlives the
 * menu that opened it.
 */
function WorkspaceItem({ app }: { app: App }) {
  const names = useNameDialog(app);
  const roomy = useMinWidth(1180);
  return (
    <>
      <OverflowItem id="workspace" priority={9} labelBehavior="keep" tooltip={false} overflow={<WorkspaceSubmenu app={app} ask={names.ask} />}>
        <WorkspaceTabs app={app} ask={names.ask} compact={!roomy} />
      </OverflowItem>
      {names.dialog}
    </>
  );
}

function LeftToggle({ app }: { app: App }) {
  const open = useSignalPart(app.workspace.layout, (L) => L.left.stacks.length > 0 && !L.left.collapsed);
  return (
    <IconItem
      id="left"
      priority={7}
      label="Left column: fold to icons / expand"
      menuLabel={open ? 'Fold the left column' : 'Expand the left column'}
      icon={<PanelLeftIcon />}
      onAction={() => app.togglePanel('left')}
      isActive={open}
    />
  );
}

function LogsToggle({ app }: { app: App }) {
  const open = useShown(app, 'logs');
  return <IconItem id="logs" priority={7} label="Well logs" menuLabel={open ? 'Hide well logs' : 'Show well logs'} icon={<LogCurveIcon />} onAction={() => app.togglePanel('right')} isActive={open} />;
}

const NAV: { id: NavMode; label: string }[] = [
  { id: 'guided', label: 'Guided' },
  { id: 'explore', label: 'Explore' },
];

/** The More-menu form of a set of tabs: a submenu with the current choice ticked. */
function ChoiceMenu({
  id,
  label,
  icon,
  value,
  choices,
  onChange,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  value: string;
  choices: { id: string; label: string; icon?: ReactNode }[];
  onChange: (id: string) => void;
}) {
  const current = choices.find((c) => c.id === value);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger id={id} textValue={label}>
        {icon}
        {label}
        {current && <span className="ml-auto pl-3 text-muted-foreground">{current.label}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuGroup
          selectionMode="single"
          selectedKeys={[value]}
          onSelectionChange={(keys) => {
            const k = keys === 'all' ? undefined : [...keys][0];
            if (k !== undefined && String(k) !== value) onChange(String(k));
          }}
        >
          {choices.map((c) => (
            <DropdownMenuItem key={c.id} id={c.id} textValue={c.label}>
              <span className="flex items-center gap-2">
                {c.icon}
                {c.label}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A labelled menu button (Window); in the More menu it becomes a submenu. */
function MenuItem({ id, priority, label, icon, items, className }: { id: string; priority: number; label: string; icon: ReactNode; items: ReactNode; className?: string }) {
  return (
    <OverflowItem
      id={id}
      priority={priority}
      label={label}
      icon={icon}
      // the item's own tooltip would wrap the menu trigger, which is not focusable; the button brings its own
      tooltip={false}
      overflow={
        <DropdownMenuSub>
          <DropdownMenuSubTrigger id={id} textValue={label}>
            {icon}
            {label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={className}>{items}</DropdownMenuSubContent>
        </DropdownMenuSub>
      }
    >
      <DropdownMenuTrigger>
        <Tip label={label} placement="bottom">
          <Button variant="ghost" size="sm" aria-label={label}>
            {icon}
            <OverflowLabel>{label}</OverflowLabel>
          </Button>
        </Tip>
        <DropdownMenu placement="bottom end" className={`w-max ${className ?? ''}`}>
          {items}
        </DropdownMenu>
      </DropdownMenuTrigger>
    </OverflowItem>
  );
}

/** An icon-only command; its label is the tooltip and the More-menu entry. */
function IconItem({
  id,
  priority,
  label,
  menuLabel = label,
  icon,
  onAction,
  isActive,
}: {
  id: string;
  priority: number;
  label: string;
  /** the More-menu entry, when it should say more than the tooltip (the state a toggle will change to) */
  menuLabel?: string;
  icon: ReactNode;
  onAction?: () => void;
  isActive?: boolean;
}) {
  return (
    // the overflow item's own tooltip only shows for collapsed labels, so the button brings its own
    <OverflowItem id={id} priority={priority} label={menuLabel} icon={icon} onAction={onAction} labelBehavior="keep">
      <IconButton label={label} variant={isActive ? 'secondary' : 'ghost'} size="icon-sm" aria-pressed={isActive}>
        {icon}
      </IconButton>
    </OverflowItem>
  );
}

/** A feature's command: a toggle or action button, or a menu of choices. */
function Tool({ t }: { t: ToolEntry }) {
  useSignal(t.watch ?? idle);
  if (!t.menu) return <IconItem id={t.id} priority={2} label={t.label} icon={t.icon} onAction={t.onAction} isActive={t.isActive?.()} />;
  const actions = t.menu.filter((m) => !m.isSelected);
  const toggles = t.menu.filter((m) => m.isSelected);
  const contents = (
    <>
      <DropdownMenuGroup>
        {actions.map((m) => (
          <DropdownMenuItem key={m.id} id={m.id} onAction={m.onAction}>
            {m.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {toggles.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup selectionMode="multiple" selectedKeys={toggles.filter((m) => m.isSelected!()).map((m) => m.id)}>
            {toggles.map((m) => (
              <DropdownMenuItem key={m.id} id={m.id} onAction={m.onAction}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </>
      )}
    </>
  );
  return (
    <OverflowItem
      id={t.id}
      priority={2}
      label={t.label}
      icon={t.icon}
      labelBehavior="keep"
      tooltip={false}
      overflow={
        <DropdownMenuSub>
          <DropdownMenuSubTrigger id={t.id}>
            {t.icon}
            {t.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>{contents}</DropdownMenuSubContent>
        </DropdownMenuSub>
      }
    >
      <DropdownMenuTrigger>
        <IconButton label={t.label}>{t.icon}</IconButton>
        <DropdownMenu placement="bottom end" className="w-max min-w-56">
          {contents}
        </DropdownMenu>
      </DropdownMenuTrigger>
    </OverflowItem>
  );
}

/** Live data: a pulsing dot while any source is streaming. */
function LiveItem({ app }: { app: App }) {
  // connections change with every stats report: only the count of streaming ones matters here
  const live = useSignalPart(app.hub.connections, (list) => list.filter((c) => (c.status === 'live' || c.status === 'connecting' || c.status === 'reconnecting') && !c.paused).length);
  const shown = useShown(app, 'sources');
  const label = live ? `Live data (${live} streaming)` : 'Live data';
  return (
    <OverflowItem id="live" priority={4} label={label} icon={<RadioTowerIcon />} onAction={() => app.openSources()}>
      <Button variant={shown ? 'secondary' : 'ghost'} size="sm" aria-label={label}>
        <span className="relative flex" data-icon="inline-start">
          <RadioTowerIcon className="size-4" />
          {live > 0 && <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full bg-success ring-2 ring-background" />}
        </span>
        <OverflowLabel>Live</OverflowLabel>
      </Button>
    </OverflowItem>
  );
}
