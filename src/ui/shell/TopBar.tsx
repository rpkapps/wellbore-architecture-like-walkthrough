import { Button } from '@tecton/react/components/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Separator } from '@tecton/react/components/separator';
import { AppShellBrand, AppShellHeader, useMinWidth } from '@tecton/react/tecton/app-shell';
import { Overflow, OverflowDivider, OverflowItem, OverflowLabel, OverflowSpacer } from '@tecton/react/tecton/overflow';
import { WellIcon } from '@tecton/react/icons';
import { ListMinusIcon, ListPlusIcon, MaximizeIcon, SearchIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import type { App } from '../app';
import { useFlags } from '../flags';
import { IconButton } from '../icon-button';
import { Logo } from '../logo';
import { useNameDialog, WorkspaceSubmenu, WorkspaceTabs } from '../workspace/menus';
import { Signal, useRev, useSignal } from '../signal';
import { DataDialog } from './DataDialog';
import { ConnectDialog } from './ConnectDialog';
import { HelpDialog } from './HelpDialog';
import { PersonaliseDialog } from './PersonaliseDialog';
import { CommandPalette } from './CommandPalette';
import { Kbd } from '@tecton/react/components/kbd';
import { ProductionSheet } from './ProductionSheet';

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
 * Brand, well selector and one row holding the rest: the workspace tabs,
 * search and full screen (panels, data, settings and help are on the rail at the left of
 * the stage, see `workspace/Rail.tsx`; navigation and the view tools on the
 * viewport toolbar; colour-by on the colour key). As the window
 * narrows, labels collapse to icons, then controls move into the More menu
 * at the end, least used first, down to the well, search and More on a phone.
 */
export function TopBar({ app }: { app: App }) {
  const ready = useSignal(app.ready);
  return (
    <AppShellHeader className="gap-2 px-2 sm:px-3">
      <AppShellBrand className="shrink-0">
        <span className="flex">
          <Logo />
        </span>
        <span className="hidden lg:inline">BoreWalk</span>
      </AppShellBrand>
      {ready && <Controls app={app} />}
    </AppShellHeader>
  );
}

/**
 * The row itself subscribes to nothing: every control that shows state
 * subscribes to just that state, so a layout change, a view change or a
 * dialog opening re-renders one button, not the whole row with its tooltips.
 */
const Controls = memo(function Controls({ app }: { app: App }) {
  const fullscreen = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  const palette = isMac ? '⌘K' : 'Ctrl K';
  return (
    <>
      <Divider />
      <WellSelect app={app} />
      <Divider />
      <Overflow role="group" aria-label="Workspaces and commands" className="min-w-0 flex-1 flex-nowrap justify-end gap-1">
        <WorkspaceItem app={app} />
        <OverflowSpacer />
        {/* panels, data, settings and help are on the rail at the left of the stage; navigation and
            the view tools on the viewport toolbar; colour-by on the colour key */}
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

/** The well picker's footer entry: it shows or hides the further Volve wells (the `extraWells` feature). */
const MORE_WELLS = '__more-wells';
const EXTRA_WELLS = ['extraWells'] as const;

/**
 * The active wellbore. Its footer entry, "Show more Volve wells" (or "Show
 * fewer wells"), adds the further public Volve wellbores with logs to the list
 * and to the 3D view.
 */
function WellSelect({ app }: { app: App }) {
  useRev(app.wellRev);
  const [more] = useFlags(app.flags, EXTRA_WELLS);
  const e = app.engine;
  const extra = app.field.wells.filter((w) => w.extra).length;
  return (
    <Select
      aria-label="Active wellbore"
      selectedKey={e.activeWell.id}
      onSelectionChange={(k: Key | null) => {
        if (k === MORE_WELLS) app.flags.set('extraWells', !more);
        else if (k !== null && k !== e.activeWell.id) app.selectWell(String(k));
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
        <SelectGroup aria-label="Wellbores">
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
        </SelectGroup>
        {extra > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup aria-label="More wells">
              <SelectItem id={MORE_WELLS} textValue={more ? 'Show fewer wells' : 'Show more Volve wells'}>
                <span className="flex items-center gap-2 text-fg-2">
                  {more ? <ListMinusIcon className="size-4" /> : <ListPlusIcon className="size-4" />}
                  {more ? 'Show fewer wells' : `Show ${extra} more Volve wells`}
                </span>
              </SelectItem>
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
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
