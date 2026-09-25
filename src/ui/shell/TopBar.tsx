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
import { AppShellAction, AppShellActions, AppShellBrand, AppShellHeader, AppShellNav, useMinWidth } from '@tecton/react/tecton/app-shell';
import { OverflowDivider, OverflowItem, OverflowLabel, Toolbar } from '@tecton/react/tecton/overflow';
import { LogCurveIcon, OilRigOffshoreIcon, WellIcon } from '@tecton/react/icons';
import { ChartColumnIcon, CircleHelpIcon, FlaskConicalIcon, MaximizeIcon, PaletteIcon, PanelLeftIcon, RadioTowerIcon, SearchIcon, SlidersHorizontalIcon, UploadIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import type { NavMode } from '../../scene/cameraRig';
import type { PropertyMode } from '../../scene/wellbore';
import type { App, ToolEntry } from '../app';
import { IconButton } from '../icon-button';
import { Logo } from '../logo';
import { WindowMenu, WorkspaceMenu } from '../workspace/menus';
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

/** Full-height divider between header groups. */
function Divider() {
  return <Separator orientation="vertical" emphasis="subtle" />;
}

/**
 * Brand, well selector, the navigation and colouring tabs, and a toolbar of
 * commands that folds into a More menu as the window narrows.
 */
export function TopBar({ app, panels, brand = true }: { app: App; panels: Map<string, PanelDef>; brand?: boolean }) {
  const ready = useSignal(app.ready);
  return (
    <AppShellHeader className="gap-2">
      <AppShellBrand>
        {/* mounts as the loader leaves, so the loader's logo flies here */}
        {brand ? (
          <span className="brand-logo flex">
            <Logo />
          </span>
        ) : (
          <span className="size-6" />
        )}
        <span className="hidden sm:inline">BoreWalk</span>
      </AppShellBrand>
      {ready && <Controls app={app} panels={panels} />}
    </AppShellHeader>
  );
}

function Controls({ app, panels }: { app: App; panels: Map<string, PanelDef> }) {
  useRev(app.viewRev, app.wellRev);
  const optional = useSignal(app.optionalModes);
  const tools = useSignal(app.tools);
  const L = useSignal(app.workspace.layout);
  const ws = app.workspace;
  const production = useSignal(app.productionOpen);
  const data = useSignal(app.dataOpen);
  const help = useSignal(app.helpOpen);
  const personalise = useSignal(app.personaliseOpen);
  const roomy = useMinWidth(1360);
  const e = app.engine;
  const props = PROPERTIES.filter((p) => p.id !== 'rop' || optional.has('rop'));
  const tab = (t: 'interpretation' | 'features') => ws.isShown(t);
  const leftOpen = L.left.stacks.length > 0 && !L.left.collapsed;
  const fullscreen = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  return (
    <>
      <Divider />
      <Select
        aria-label="Active wellbore"
        selectedKey={e.activeWell.id}
        onSelectionChange={(k: Key | null) => {
          if (k !== null && k !== e.activeWell.id) app.selectWell(String(k));
        }}
        className="w-40 shrink-0 md:w-48"
      >
        <SelectTrigger size="sm">
          <WellIcon />
          <SelectValue />
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
      <Divider />
      <AppShellNav className="gap-2">
        <Tabs selectedKey={e.rig.mode} onSelectionChange={(k) => app.setNav(String(k) as NavMode)} className="shrink-0">
          <TabStrip aria-label="Navigation">
            <Tab id="guided">Guided</Tab>
            <Tab id="explore">Explore</Tab>
          </TabStrip>
        </Tabs>
        <Divider />
        {roomy ? (
          <Tabs selectedKey={e.mode} onSelectionChange={(k) => app.setProperty(String(k) as PropertyMode)} className="shrink-0">
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
          <Select aria-label="Colour the wellbore by" selectedKey={e.mode} onSelectionChange={(k: Key | null) => k !== null && app.setProperty(String(k) as PropertyMode)} className="w-36 shrink-0">
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
        <Divider />
        <Toolbar aria-label="Commands" className="min-w-0 flex-1 justify-end">
          <OverflowItem id="interpretation" priority={6} label="Interpretation" icon={<FlaskConicalIcon />} onAction={() => app.showSidebar('interpretation', true)}>
            <Button variant={tab('interpretation') ? 'secondary' : 'ghost'} size="sm">
              <FlaskConicalIcon data-icon="inline-start" />
              <OverflowLabel>Interpretation</OverflowLabel>
            </Button>
          </OverflowItem>
          <OverflowItem id="features" priority={5} label="Features" icon={<SlidersHorizontalIcon />} onAction={() => app.showSidebar('features', true)}>
            <Button variant={tab('features') ? 'secondary' : 'ghost'} size="sm">
              <SlidersHorizontalIcon data-icon="inline-start" />
              <OverflowLabel>Features</OverflowLabel>
            </Button>
          </OverflowItem>
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
          {tools.length > 0 && <OverflowDivider />}
          {tools.map((t) => (
            <Tool key={t.id} t={t} />
          ))}
          <OverflowDivider />
          <IconItem id="overview" priority={3} label="Field overview" icon={<OilRigOffshoreIcon />} onAction={() => app.overview()} />
          <IconItem id="personalise" priority={1} label="Personalise" icon={<PaletteIcon />} onAction={() => app.personaliseOpen.set(true)} />
          <IconItem id="help" priority={1} label="Controls & data notes" icon={<CircleHelpIcon />} onAction={() => app.helpOpen.set(true)} />
          <IconItem id="fullscreen" priority={0} label="Fullscreen" icon={<MaximizeIcon />} onAction={fullscreen} />
        </Toolbar>
      </AppShellNav>
      <Divider />
      <AppShellActions className="ml-0 gap-0.5">
        <Button variant="ghost" size="sm" aria-label="Command palette" onPress={() => app.paletteOpen.set(true)} className="gap-1.5 text-fg-2">
          <SearchIcon data-icon="inline-start" />
          <Kbd className="h-4 px-1 text-[0.68rem]">{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </Button>
        <WindowMenu app={app} panels={panels} />
        <WorkspaceMenu app={app} panels={panels} />
        <AppShellAction label="Left column: fold to icons / expand" variant={leftOpen ? 'secondary' : 'ghost'} onPress={() => app.togglePanel('left')}>
          <PanelLeftIcon />
        </AppShellAction>
        <AppShellAction label="Well logs" variant={ws.isShown('logs') ? 'secondary' : 'ghost'} onPress={() => app.togglePanel('right')}>
          <LogCurveIcon />
        </AppShellAction>
      </AppShellActions>
      <ProductionSheet app={app} isOpen={production} onOpenChange={(o) => app.productionOpen.set(o)} />
      <DataDialog app={app} isOpen={data} onOpenChange={(o) => app.dataOpen.set(o)} />
      <HelpDialog app={app} isOpen={help} onOpenChange={(o) => app.helpOpen.set(o)} />
      <PersonaliseDialog app={app} isOpen={personalise} onOpenChange={(o) => app.personaliseOpen.set(o)} />
      <CommandPalette app={app} />
      <ConnectDialog app={app} />
    </>
  );
}

/** An icon-only command; its label is the tooltip and the More-menu entry. */
function IconItem({ id, priority, label, icon, onAction, isActive }: { id: string; priority: number; label: string; icon: ReactNode; onAction?: () => void; isActive?: boolean }) {
  return (
    // the overflow item's own tooltip only shows for collapsed labels, so the button brings its own
    <OverflowItem id={id} priority={priority} label={label} icon={icon} onAction={onAction} labelBehavior="keep">
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
  const list = useSignal(app.hub.connections);
  const live = list.filter((c) => (c.status === 'live' || c.status === 'connecting' || c.status === 'reconnecting') && !c.paused).length;
  const label = live ? `Live data (${live} streaming)` : 'Live data';
  return (
    <OverflowItem id="live" priority={4} label={label} icon={<RadioTowerIcon />} onAction={() => app.openSources()}>
      <Button variant={app.workspace.isShown('sources') ? 'secondary' : 'ghost'} size="sm" aria-label={label}>
        <span className="relative flex" data-icon="inline-start">
          <RadioTowerIcon className="size-4" />
          {live > 0 && <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full bg-success ring-2 ring-background" />}
        </span>
        <OverflowLabel>Live</OverflowLabel>
      </Button>
    </OverflowItem>
  );
}
