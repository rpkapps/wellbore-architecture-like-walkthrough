import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Separator } from '@tecton/react/components/separator';
import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { OilRigOffshoreIcon, TrajectoryIcon } from '@tecton/react/icons';
import { Panel } from '@tecton/react/tecton/panel';
import { CircleDotIcon, EllipsisIcon, OrbitIcon, PlaneIcon } from 'lucide-react';
import { memo, useSyncExternalStore, type ReactNode } from 'react';
import type { GuidedView, NavMode } from '../../scene/cameraRig';
import type { App, ToolEntry } from '../app';
import { IconButton } from '../icon-button';
import { Signal, useSignal } from '../signal';
import { SURFACE } from './overlay';

const NAV: [NavMode, string, string][] = [
  ['guided', 'Guided', 'Guided: the camera follows the well path'],
  ['explore', 'Explore', 'Explore: a free camera over the field'],
];

const GUIDED: [GuidedView, string, ReactNode][] = [
  ['tunnel', 'Inside the hole (1)', <CircleDotIcon />],
  ['chase', 'Chase the bit (2)', <TrajectoryIcon />],
  ['orbit', 'Orbit the bit (3)', <OrbitIcon />],
];

const EXPLORE: ['fly' | 'orbit', string, ReactNode][] = [
  ['fly', 'Fly (WASD + drag)', <PlaneIcon />],
  ['orbit', 'Orbit', <OrbitIcon />],
];

const idle = new Signal<unknown>(0);

/**
 * The viewport toolbar, floating at the bottom centre of the 3D view: how you
 * move (Guided | Explore), the camera for that mode, then the view tools the
 * features add (measure, saved views, snapshot) and the field overview. What
 * acts on the view sits on the view (Figma's canvas toolbar), so the top bar
 * keeps to the application. Where the free area is narrow, the tools fold
 * into a ⋯ menu; the navigation and the cameras always stay.
 */
export const ViewToolbar = memo(function ViewToolbar({ app }: { app: App }) {
  return (
    <Panel variant="elevated" size="sm" aria-label="View toolbar" className={`w-fit max-w-full ${SURFACE}`}>
      <div role="group" aria-label="View" className="flex items-center gap-1 p-1">
        <Nav app={app} />
        <Rule />
        <Cameras app={app} />
        <Rule />
        {/* the tools in the row where there is room, behind ⋯ where there is not */}
        <div className="hidden items-center gap-0.5 @md:flex">
          <Tools app={app} />
          <IconButton label="Field overview" placement="top" onPress={() => app.overview()}>
            <OilRigOffshoreIcon />
          </IconButton>
        </div>
        <div className="flex @md:hidden">
          <ToolsMenu app={app} />
        </div>
      </div>
    </Panel>
  );
});

function Rule() {
  return <Separator orientation="vertical" className="mx-0.5 h-5 aria-[orientation=vertical]:self-center" />;
}

/** Of the view, only the navigation mode and the camera matter here (a slider on the view bumps viewRev per step). */
function useCamera(app: App) {
  const key = useSyncExternalStore(app.viewRev.subscribe, () => {
    const rig = app.engine.rig;
    return `${rig.mode}:${rig.mode === 'guided' ? rig.guidedView : rig.exploreView}`;
  });
  const [mode, view] = key.split(':') as [NavMode, string];
  return { mode, view };
}

/** Guided | Explore: a segmented choice, labelled because it changes how everything else behaves. */
function Nav({ app }: { app: App }) {
  const { mode } = useCamera(app);
  return (
    <ToggleGroup
      aria-label="Navigation"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[mode]}
      onSelectionChange={(k) => {
        const v = k.size ? String([...k][0]) : null;
        if (v && v !== mode) void app.actions.run('nav.set_mode', { mode: v });
      }}
    >
      {NAV.map(([id, label, tip]) => (
        <TooltipTrigger key={id} delay={400}>
          <ToggleGroupItem id={id} className="px-2.5 text-xs">
            {label}
          </ToggleGroupItem>
          <Tooltip placement="top">{tip}</Tooltip>
        </TooltipTrigger>
      ))}
    </ToggleGroup>
  );
}

/** The cameras of the current navigation mode. */
function Cameras({ app }: { app: App }) {
  const { mode, view } = useCamera(app);
  const guided = mode === 'guided';
  const views = guided ? GUIDED : EXPLORE;
  return (
    <ToggleGroup
      aria-label="Camera"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[view]}
      onSelectionChange={(k) => {
        const v = k.size ? String([...k][0]) : null;
        if (!v) return;
        if (guided) void app.actions.run('nav.guided_view', { view: v });
        else void app.actions.run('nav.explore_view', { view: v });
      }}
    >
      {views.map(([id, label, icon]) => (
        <TooltipTrigger key={id} delay={400}>
          <ToggleGroupItem id={id} aria-label={label}>
            {icon}
          </ToggleGroupItem>
          <Tooltip placement="top">{label}</Tooltip>
        </TooltipTrigger>
      ))}
    </ToggleGroup>
  );
}

/** The commands features add (`app.addTool`), as buttons. */
function Tools({ app }: { app: App }) {
  const tools = useSignal(app.tools);
  return tools.map((t) => <Tool key={t.id} t={t} />);
}

/** A feature's command: a toggle or action button, or a menu of choices. */
function Tool({ t }: { t: ToolEntry }) {
  useSignal(t.watch ?? idle);
  if (!t.menu) {
    const on = t.isActive?.();
    return (
      <IconButton label={t.label} placement="top" variant={on ? 'secondary' : 'ghost'} aria-pressed={t.isActive ? !!on : undefined} onPress={t.onAction}>
        {t.icon}
      </IconButton>
    );
  }
  return (
    <DropdownMenuTrigger>
      <IconButton label={t.label} placement="top">
        {t.icon}
      </IconButton>
      <DropdownMenu placement="top" className="w-max min-w-56">
        <ToolItems t={t} />
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

/** A menu tool's entries: its actions, then its switches (ticked while on). */
function ToolItems({ t }: { t: ToolEntry }) {
  const menu = t.menu ?? [];
  const actions = menu.filter((m) => !m.isSelected);
  const toggles = menu.filter((m) => m.isSelected);
  return (
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
}

/** The narrow form: every tool and the field overview behind one ⋯ button. */
function ToolsMenu({ app }: { app: App }) {
  const tools = useSignal(app.tools);
  return (
    <DropdownMenuTrigger>
      <IconButton label="View tools" placement="top">
        <EllipsisIcon />
      </IconButton>
      <DropdownMenu placement="top" className="w-max min-w-52">
        <DropdownMenuGroup>
          {tools.map((t) =>
            t.menu ? (
              <DropdownMenuSub key={t.id}>
                <DropdownMenuSubTrigger id={t.id} textValue={t.label}>
                  {t.icon}
                  {t.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-max min-w-56">
                  <ToolItems t={t} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem key={t.id} id={t.id} textValue={t.label} onAction={t.onAction}>
                {t.icon}
                {t.label}
                {t.isActive?.() && <span className="ml-auto pl-3 text-muted-foreground">on</span>}
              </DropdownMenuItem>
            ),
          )}
          <DropdownMenuItem id="overview" textValue="Field overview" onAction={() => app.overview()}>
            <OilRigOffshoreIcon />
            Field overview
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
