import { ContextMenu, ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@tecton/react/components/context-menu';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { memo, type ReactNode } from 'react';
import { Pressable, type Key } from 'react-aria-components';
import type { SelectionEntry } from '../../actions/registry';
import type { App } from '../app';
import { Tip } from '../icon-button';
import type { Selection } from '../selection';
import { useSignal } from '../signal';

/** The menu parts a list of actions renders with: a dropdown's or a context menu's (the same React Aria menu, styled for each). */
interface MenuKit {
  Item: typeof DropdownMenuItem;
  Group: typeof DropdownMenuGroup;
  Label: typeof DropdownMenuLabel;
  Separator: typeof DropdownMenuSeparator;
}

const DROPDOWN: MenuKit = { Item: DropdownMenuItem, Group: DropdownMenuGroup, Label: DropdownMenuLabel, Separator: DropdownMenuSeparator };
const CONTEXT: MenuKit = { Item: ContextMenuItem, Group: ContextMenuGroup, Label: ContextMenuLabel, Separator: ContextMenuSeparator };

/**
 * The actions of a selected object as menu items, straight from the action
 * registry (`actionsFor`): its verbs first, then its toggles (ticked when
 * on), then the panels that show it. The palette, these menus and an
 * assistant therefore offer the same operations.
 */
function actionItems(entries: SelectionEntry<App>[], title: string | undefined, kit: MenuKit): ReactNode {
  const { Item, Group, Label, Separator } = kit;
  const panel = (e: SelectionEntry<App>) => e.action.category === 'Panels';
  const verbs = entries.filter((e) => e.checked === undefined && !panel(e));
  const toggles = entries.filter((e) => e.checked !== undefined);
  const panels = entries.filter((e) => e.checked === undefined && panel(e));
  const item = (e: SelectionEntry<App>) => (
    <Item key={e.action.id} id={e.action.id} onAction={() => void e.run()}>
      {e.label}
    </Item>
  );
  return (
    <>
      {(title || verbs.length > 0) && (
        <Group>
          {title && <Label className="max-w-64 truncate">{title}</Label>}
          {verbs.map(item)}
        </Group>
      )}
      {toggles.length > 0 && (
        <Group
          selectionMode="multiple"
          // the menu is read when it opens: it closes like any other entry rather than show a stale tick
          shouldCloseOnSelect
          selectedKeys={toggles.filter((e) => e.checked).map((e) => e.action.id)}
          onSelectionChange={(keys) => {
            // the one whose tick changed runs
            const on = keys === 'all' ? null : new Set<Key>(keys);
            const e = toggles.find((t) => (on ? on.has(t.action.id) : true) !== t.checked);
            if (e) void e.run();
          }}
        >
          {toggles.map((e) => (
            <Item key={e.action.id} id={e.action.id}>
              {e.label}
            </Item>
          ))}
        </Group>
      )}
      {panels.length > 0 && (
        <>
          {(verbs.length > 0 || toggles.length > 0) && <Separator />}
          <Group>{panels.map(item)}</Group>
        </>
      )}
      {entries.length === 0 && (
        <Group>
          <Item id="none" isDisabled>
            No actions
          </Item>
        </Group>
      )}
    </>
  );
}

/**
 * The right-click menu of whatever was right-clicked (a tree row, an object
 * in the 3D view): one menu for the whole app, opened at the pointer by
 * `app.openContextMenu`, anchored on an invisible point there.
 */
export const SelectionContextMenu = memo(function SelectionContextMenu({ app }: { app: App }) {
  const m = useSignal(app.contextMenu);
  if (!m) return null;
  // a fresh trigger for every opening: the menu is placed from where its anchor is when it mounts
  return (
    <ContextMenuTrigger key={`${m.x},${m.y}`} isOpen onOpenChange={(open) => !open && app.contextMenu.set(null)}>
      <Pressable>
        <span role="button" aria-hidden tabIndex={-1} className="pointer-events-none fixed size-px" style={{ left: m.x, top: m.y }} />
      </Pressable>
      <ContextMenu aria-label="Actions" placement="bottom start" offset={2} className="w-max max-w-80">
        {actionItems(app.actions.actionsFor(m.selection), app.inspectorFor(m.selection)?.title, CONTEXT)}
      </ContextMenu>
    </ContextMenuTrigger>
  );
});

/**
 * A ⋮ button with the same actions as the right-click menu, for an object
 * that is not (necessarily) selected: a tree row, the Properties header. The
 * items are read when the menu opens, so they show the scene as it is.
 */
export function SelectionActionsButton({ app, selection, label, children }: { app: App; selection: Selection; label: string; children: ReactNode }) {
  return (
    <DropdownMenuTrigger>
      <Tip label="Actions">{children}</Tip>
      <DropdownMenu aria-label={label} placement="bottom end" className="w-max min-w-44">
        <Deferred render={() => actionItems(app.actions.actionsFor(selection), undefined, DROPDOWN)} />
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

/** Renders its content only when it renders: inside a menu, that is when the menu opens. */
function Deferred({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}
