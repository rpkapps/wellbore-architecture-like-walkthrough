import { Button } from '@tecton/react/components/button';
import { ContextMenu, ContextMenuItem, ContextMenuTrigger } from '@tecton/react/components/context-menu';
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@tecton/react/components/dropdown-menu';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Input } from '@tecton/react/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Tabs } from '@tecton/react/components/tabs';
import { CopyIcon, EllipsisIcon, LayoutDashboardIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { Pressable, type Key } from 'react-aria-components';
import { IconButton } from '../icon-button';
import type { App } from '../app';
import { useSignal } from '../signal';
import { Tab, TabStrip } from '../tabs';

/** One thing that can be done to a workspace; the tab's right-click menu, its ⋯ menu and the More menu all list the same ones. */
export interface WorkspaceCommand {
  id: string;
  label: string;
  icon: ReactNode;
  destructive?: boolean;
  run: () => void;
}

/** What the name dialog is for: a new workspace copied from `from`, or renaming `id`. */
export type NameRequest = { kind: 'new'; from: string } | { kind: 'rename'; id: string };

/**
 * What can be done to one workspace: reset its layout, duplicate it, and,
 * for the user's own, rename or delete it. Each runs through its action, so
 * the tab menus, the palette and an assistant do the same thing.
 */
export function workspaceCommands(app: App, id: string, ask: (r: NameRequest) => void): WorkspaceCommand[] {
  const w = app.workspace.info(id);
  if (!w) return [];
  const run = (action: string, input: object, done?: (result: unknown) => void) =>
    void app.actions.run(action, input).then((r) => (r.ok ? done?.(r.result) : app.toast(r.error, 'error')));
  const out: WorkspaceCommand[] = [
    { id: 'ws-reset', label: `Reset “${w.name}”`, icon: <RotateCcwIcon />, run: () => run('workspace.reset', { id }) },
    {
      id: 'ws-duplicate',
      label: 'Duplicate',
      icon: <CopyIcon />,
      run: () => run('workspace.duplicate', { id }, (r) => app.toast(`Duplicated as “${(r as { name?: string }).name}”.`)),
    },
  ];
  if (!w.builtin)
    out.push(
      { id: 'ws-rename', label: 'Rename…', icon: <PencilIcon />, run: () => ask({ kind: 'rename', id }) },
      { id: 'ws-delete', label: 'Delete', icon: <Trash2Icon />, destructive: true, run: () => run('workspace.delete', { id }, () => app.toast(`Deleted “${w.name}”.`)) },
    );
  return out;
}

/** The ⋯ menu's and the More menu's entries: the active workspace's commands, then a new one. */
function ActiveCommands({ app, current, ask }: { app: App; current: string; ask: (r: NameRequest) => void }) {
  return (
    <>
      <DropdownMenuGroup>
        {workspaceCommands(app, current, ask).map((c) => (
          <DropdownMenuItem key={c.id} id={c.id} textValue={c.label} variant={c.destructive ? 'destructive' : 'default'} onAction={c.run}>
            {c.icon}
            {c.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem id="ws-new" textValue="New workspace" onAction={() => ask({ kind: 'new', from: current })}>
        <PlusIcon />
        New workspace…
      </DropdownMenuItem>
    </>
  );
}

const switchTo = (app: App, k: Key | null) => {
  if (k !== null) void app.actions.run('workspace.apply', { id: String(k) });
};

/**
 * The workspace tabs, right after the well: one per workspace, the active
 * one selected. Right-click a tab for its commands; the ⋯ button holds the
 * active one's, and + starts a new workspace from the active one. `compact`
 * swaps the tabs for a select when the window is narrow.
 */
export function WorkspaceTabs({ app, ask, compact }: { app: App; ask: (r: NameRequest) => void; compact?: boolean }) {
  // the list changes with the user's workspaces; re-render on that and on the active one only
  useSignal(app.workspace.saved);
  const current = useSignal(app.workspace.current);
  const list = app.workspace.list();
  const active = list.find((w) => w.id === current);
  const [menu, setMenu] = useState<TabMenuTarget | null>(null);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {compact ? (
        <Select aria-label="Workspace" selectedKey={current} onSelectionChange={(k: Key | null) => switchTo(app, k)} className="w-36 shrink-0">
          <SelectTrigger size="sm">
            <LayoutDashboardIcon />
            <SelectValue className="min-w-0">{({ selectedText }) => <span className="truncate">{selectedText}</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-max min-w-(--trigger-width)">
            {list.map((w) => (
              <SelectItem key={w.id} id={w.id} textValue={w.name}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Tabs selectedKey={current} onSelectionChange={(k) => switchTo(app, k)} className="shrink-0">
          <TabStrip aria-label="Workspaces">
            {list.map((w) => (
              <Tab
                key={w.id}
                id={w.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id: w.id, rect: e.currentTarget.getBoundingClientRect() });
                }}
              >
                {w.name}
              </Tab>
            ))}
          </TabStrip>
        </Tabs>
      )}
      <TabMenu app={app} ask={ask} target={compact ? null : menu} onClose={() => setMenu(null)} />
      <DropdownMenuTrigger>
        <IconButton label={`“${active?.name ?? 'Workspace'}” options`} size="icon-xs">
          <EllipsisIcon />
        </IconButton>
        <DropdownMenu placement="bottom start" className="w-max min-w-48">
          <ActiveCommands app={app} current={current} ask={ask} />
        </DropdownMenu>
      </DropdownMenuTrigger>
      <IconButton label="New workspace" size="icon-xs" onPress={() => ask({ kind: 'new', from: current })}>
        <PlusIcon />
      </IconButton>
    </div>
  );
}

interface TabMenuTarget {
  id: string;
  rect: DOMRect;
}

/**
 * A tab's right-click menu. Tabs are items of their tab list's collection,
 * which a menu trigger around each one would break, so there is one menu for
 * the strip: the right-clicked tab opens it, anchored by a hit-less box laid
 * over that tab, so it drops down from the tab like its own menu.
 */
function TabMenu({ app, ask, target, onClose }: { app: App; ask: (r: NameRequest) => void; target: TabMenuTarget | null; onClose: () => void }) {
  const r = target?.rect;
  const name = target ? app.workspace.info(target.id)?.name : undefined;
  return (
    <ContextMenuTrigger isOpen={!!target} onOpenChange={(o) => !o && onClose()}>
      <Pressable>
        <span
          role="button"
          tabIndex={-1}
          aria-label={name ? `Menu of “${name}”` : 'Workspace menu'}
          className="pointer-events-none fixed"
          style={r ? { left: r.left, top: r.top, width: r.width, height: r.height } : { left: 0, top: 0 }}
        />
      </Pressable>
      <ContextMenu placement="bottom start" className="w-max min-w-48">
        {target &&
          workspaceCommands(app, target.id, ask).map((c) => (
            <ContextMenuItem key={c.id} id={c.id} textValue={c.label} variant={c.destructive ? 'destructive' : 'default'} onAction={c.run}>
              {c.icon}
              {c.label}
            </ContextMenuItem>
          ))}
      </ContextMenu>
    </ContextMenuTrigger>
  );
}

/** The workspace tabs in the More menu: a submenu with the active one ticked, then its commands. */
export function WorkspaceSubmenu({ app, ask }: { app: App; ask: (r: NameRequest) => void }) {
  useSignal(app.workspace.saved);
  const current = useSignal(app.workspace.current);
  const list = app.workspace.list();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger id="workspace" textValue="Workspace">
        <LayoutDashboardIcon />
        Workspace
        <span className="ml-auto pl-3 text-muted-foreground">{list.find((w) => w.id === current)?.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <DropdownMenuGroup
          selectionMode="single"
          selectedKeys={[current]}
          onSelectionChange={(keys) => switchTo(app, keys === 'all' ? null : ([...keys][0] ?? null))}
        >
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {list.map((w) => (
            <DropdownMenuItem key={w.id} id={w.id} textValue={w.name}>
              {w.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ActiveCommands app={app} current={current} ask={ask} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The dialog that names a new workspace or renames one. `dialog` must be
 * mounted outside any menu, so it outlives the menu that opened it.
 */
export function useNameDialog(app: App): { ask: (r: NameRequest) => void; dialog: ReactNode } {
  const [req, setReq] = useState<{ r: NameRequest; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  const ask = useCallback((r: NameRequest) => {
    setReq((p) => ({ r, n: (p?.n ?? 0) + 1 }));
    setOpen(true);
  }, []);
  // keyed per request, so the name starts afresh each time
  const dialog = req && <NameDialog key={req.n} app={app} req={req.r} isOpen={open} onOpenChange={setOpen} />;
  return { ask, dialog };
}

/** Name a new workspace (a copy of the active one) or rename one of yours. Names are unique. */
function NameDialog({ app, req, isOpen, onOpenChange }: { app: App; req: NameRequest; isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = app.workspace;
  const renaming = req.kind === 'rename';
  const source = ws.info(renaming ? req.id : req.from);
  const suggestion = renaming ? (source?.name ?? '') : ws.uniqueName(`${source?.name ?? 'Workspace'} copy`);
  const [name, setName] = useState(renaming ? suggestion : '');
  // once submitted, the name is taken by the new workspace: no clash to show while the dialog closes
  const [done, setDone] = useState(false);
  const id = useId();
  const n = name.trim();
  const clash = n && !done ? ws.list().find((w) => w.name.toLowerCase() === n.toLowerCase() && !(renaming && w.id === req.id)) : undefined;
  const submit = () => {
    if (clash || done) return;
    setDone(true);
    if (req.kind === 'rename') {
      if (n) void app.actions.run('workspace.rename', { id: req.id, name: n });
    } else {
      const named = n || suggestion;
      void app.actions.run('workspace.duplicate', { id: req.from, name: named }).then((r) => r.ok && app.toast(`New workspace “${named}”. Layout changes save into it as you go.`));
    }
    onOpenChange(false);
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{renaming ? 'Rename workspace' : 'New workspace'}</DialogTitle>
        <DialogDescription>
          {renaming
            ? 'The name on its tab.'
            : `Starts as a copy of “${source?.name}”: its panels as they are now${source?.context ? ' and what it sets up' : ''}. Saved in this browser.`}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={id} className="type-label">
          Name
        </label>
        <Input id={id} autoFocus value={name} placeholder={suggestion} aria-invalid={!!clash || undefined} onChange={(e) => setName(e.target.value)} />
        {clash && <p className="type-caption text-destructive">“{clash.name}” is already a workspace.</p>}
      </form>
      <DialogFooter>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button isDisabled={!!clash || (renaming && !n)} onPress={submit}>
          {renaming ? 'Rename' : 'Create'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
