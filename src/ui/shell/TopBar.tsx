import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Separator } from '@tecton/react/components/separator';
import { Tabs, TabsList, TabsTrigger } from '@tecton/react/components/tabs';
import { AppShellAction, AppShellActions, AppShellBrand, AppShellHeader, AppShellNav, useMinWidth } from '@tecton/react/tecton/app-shell';
import { OverflowDivider, OverflowItem, OverflowLabel, Toolbar } from '@tecton/react/tecton/overflow';
import { LogCurveIcon, OilRigOffshoreIcon, WellIcon } from '@tecton/react/icons';
import { ChartColumnIcon, CircleHelpIcon, FlaskConicalIcon, MaximizeIcon, PanelLeftIcon, SlidersHorizontalIcon, UploadIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import type { NavMode } from '../../scene/cameraRig';
import type { PropertyMode } from '../../scene/wellbore';
import type { App, ToolEntry } from '../app';
import { Logo } from '../logo';
import { Signal, useRev, useSignal } from '../signal';
import { DataDialog } from './DataDialog';
import { HelpDialog } from './HelpDialog';
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

/** Full-height divider between header groups. */
function Divider() {
  return <Separator orientation="vertical" emphasis="subtle" />;
}

/**
 * Brand, well selector, the navigation and colouring tabs, and a toolbar of
 * commands that folds into a More menu as the window narrows.
 */
export function TopBar({ app, wide }: { app: App; wide: boolean }) {
  const ready = useSignal(app.ready);
  return (
    <AppShellHeader className="gap-2">
      <AppShellBrand>
        <Logo />
        <span className="hidden sm:inline">BoreWalk</span>
      </AppShellBrand>
      {ready && <Controls app={app} wide={wide} />}
    </AppShellHeader>
  );
}

function Controls({ app, wide }: { app: App; wide: boolean }) {
  useRev(app.viewRev, app.wellRev);
  const optional = useSignal(app.optionalModes);
  const tools = useSignal(app.tools);
  const sidebar = useSignal(app.sidebar);
  const leftOpen = useSignal(app.leftOpen);
  const rightOpen = useSignal(app.rightOpen);
  const production = useSignal(app.productionOpen);
  const data = useSignal(app.dataOpen);
  const help = useSignal(app.helpOpen);
  const roomy = useMinWidth(1360);
  const e = app.engine;
  const props = PROPERTIES.filter((p) => p.id !== 'rop' || optional.has('rop'));
  const tab = (t: typeof sidebar) => leftOpen && sidebar === t;
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
        <SelectContent className="min-w-64">
          {app.selectableWells().map((w) => (
            <SelectItem key={w.id} id={w.id} textValue={w.name}>
              {w.name}
              {w.userAdded ? <span className="text-muted-foreground">uploaded</span> : !w.lasFile && <span className="text-muted-foreground">survey + production</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Divider />
      <AppShellNav className="gap-2 self-stretch">
        <Tabs selectedKey={e.rig.mode} onSelectionChange={(k) => app.setNav(String(k) as NavMode)} className="shrink-0 justify-center">
          <TabsList variant="line" aria-label="Navigation">
            <TabsTrigger id="guided">Guided</TabsTrigger>
            <TabsTrigger id="explore">Explore</TabsTrigger>
          </TabsList>
        </Tabs>
        <Divider />
        {roomy ? (
          <Tabs selectedKey={e.mode} onSelectionChange={(k) => app.setProperty(String(k) as PropertyMode)} className="shrink-0 justify-center">
            <TabsList variant="line" aria-label="Colour the wellbore by">
              {props.map((p) => (
                <TabsTrigger key={p.id} id={p.id}>
                  <Dot color={p.dot} />
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <Select
            aria-label="Colour the wellbore by"
            selectedKey={e.mode}
            onSelectionChange={(k: Key | null) => k !== null && app.setProperty(String(k) as PropertyMode)}
            className="w-36 shrink-0 self-center"
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.map((p) => (
                <SelectItem key={p.id} id={p.id} textValue={p.label}>
                  <Dot color={p.dot} />
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Divider />
        <Toolbar aria-label="Commands" className="min-w-0 flex-1 justify-end self-center">
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
          {tools.length > 0 && <OverflowDivider />}
          {tools.map((t) => (
            <Tool key={t.id} t={t} />
          ))}
          <OverflowDivider />
          <IconItem id="overview" priority={3} label="Field overview" icon={<OilRigOffshoreIcon />} onAction={() => app.overview()} />
          <IconItem id="help" priority={1} label="Controls & data notes" icon={<CircleHelpIcon />} onAction={() => app.helpOpen.set(true)} />
          <IconItem id="fullscreen" priority={0} label="Fullscreen" icon={<MaximizeIcon />} onAction={fullscreen} />
        </Toolbar>
      </AppShellNav>
      <Divider />
      <AppShellActions className="ml-0">
        <AppShellAction label={wide ? 'Sidebar' : 'Scene, interpretation & features'} variant={leftOpen ? 'secondary' : 'ghost'} onPress={() => app.togglePanel('left')}>
          <PanelLeftIcon />
        </AppShellAction>
        <AppShellAction label="Well logs" variant={rightOpen ? 'secondary' : 'ghost'} onPress={() => app.togglePanel('right')}>
          <LogCurveIcon />
        </AppShellAction>
      </AppShellActions>
      <ProductionSheet app={app} isOpen={production} onOpenChange={(o) => app.productionOpen.set(o)} />
      <DataDialog app={app} isOpen={data} onOpenChange={(o) => app.dataOpen.set(o)} />
      <HelpDialog app={app} isOpen={help} onOpenChange={(o) => app.helpOpen.set(o)} />
    </>
  );
}

/** An icon-only command; its label is the tooltip and the More-menu entry. */
function IconItem({ id, priority, label, icon, onAction, isActive }: { id: string; priority: number; label: string; icon: ReactNode; onAction?: () => void; isActive?: boolean }) {
  return (
    <OverflowItem id={id} priority={priority} label={label} icon={icon} onAction={onAction} labelBehavior="keep" tooltip>
      <Button variant={isActive ? 'secondary' : 'ghost'} size="icon-sm" aria-label={label} aria-pressed={isActive}>
        {icon}
      </Button>
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
      tooltip
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
        <Button variant="ghost" size="icon-sm" aria-label={t.label}>
          {t.icon}
        </Button>
        <DropdownMenu placement="bottom end" className="min-w-56">
          {contents}
        </DropdownMenu>
      </DropdownMenuTrigger>
    </OverflowItem>
  );
}
