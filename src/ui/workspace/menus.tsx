import { Button } from '@tecton/react/components/button';
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@tecton/react/components/dropdown-menu';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Input } from '@tecton/react/components/input';
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { IconButton } from '../icon-button';
import type { App } from '../app';
import { useSignal } from '../signal';
import { withTransition } from '../transition';
import { PRESETS, type PresetId } from './layout';
import type { PanelDef } from './panels';

/**
 * Workspace menu entries: layouts for a task, your own named ones, and saving
 * / managing them. `dialogs` holds the save and manage dialogs; mount it once,
 * outside any menu, so they outlive the menu that opened them.
 */
export function useWorkspaceMenu(app: App, panels: Map<string, PanelDef>): { items: ReactNode; dialogs: ReactNode } {
  const ws = app.workspace;
  const saved = useSignal(ws.saved);
  const current = useSignal(ws.current);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const available = (id: string) => panels.has(id);
  const mine = saved.find((w) => w.id === current);
  const tick = (on: boolean) => <CheckIcon className={on ? undefined : 'invisible'} />;
  const items = (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Layouts</DropdownMenuLabel>
        {PRESETS.map((p) => (
          <DropdownMenuItem key={p.id} id={p.id} textValue={p.label} onAction={() => withTransition(() => ws.preset(p.id as PresetId, available))}>
            {tick(current === p.id)}
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {saved.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
          {saved.map((w) => (
            <DropdownMenuItem key={w.id} id={w.id} textValue={w.name} onAction={() => withTransition(() => ws.load(w.id, available))}>
              {tick(current === w.id)}
              {w.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      )}
      <DropdownMenuSeparator />
      {mine && (
        <DropdownMenuItem id="update" textValue={`Update ${mine.name}`} onAction={() => (ws.update(mine.id), app.toast(`Saved the layout to “${mine.name}”.`))}>
          <SaveIcon />
          Update “{mine.name}”
        </DropdownMenuItem>
      )}
      <DropdownMenuItem id="save" textValue="Save as a new workspace" onAction={() => setDialog('save')}>
        <PlusIcon />
        Save as a new workspace…
      </DropdownMenuItem>
      {saved.length > 0 && (
        <DropdownMenuItem id="manage" textValue="Rename or delete workspaces" onAction={() => setDialog('manage')}>
          <PencilIcon />
          Rename or delete…
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem id="reset" onAction={() => withTransition(() => ws.preset('walkthrough', available))}>
        <RotateCcwIcon />
        Reset to default
      </DropdownMenuItem>
    </>
  );
  const dialogs = (
    <>
      <SaveDialog app={app} isOpen={dialog === 'save'} onOpenChange={(o) => setDialog(o ? 'save' : null)} />
      <ManageDialog app={app} available={available} isOpen={dialog === 'manage'} onOpenChange={(o) => setDialog(o ? 'manage' : null)} />
    </>
  );
  return { items, dialogs };
}

/** Name the current layout. A name already in use replaces that workspace. */
function SaveDialog({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = app.workspace;
  const [name, setName] = useState('');
  const id = useId();
  const clash = ws.saved.value.find((w) => w.name.toLowerCase() === name.trim().toLowerCase());
  const save = () => {
    const n = name.trim() || `Workspace ${ws.saved.value.length + 1}`;
    ws.saveAs(n);
    app.toast(`Saved as “${n}”.`);
    setName('');
    onOpenChange(false);
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Save workspace</DialogTitle>
        <DialogDescription>The panels, where they are docked and their sizes. Saved in this browser.</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label htmlFor={id} className="type-label">
          Name
        </label>
        <Input id={id} autoFocus value={name} placeholder={`Workspace ${ws.saved.value.length + 1}`} onChange={(e) => setName(e.target.value)} />
        {clash && <p className="type-caption">Replaces the saved “{clash.name}”.</p>}
      </form>
      <DialogFooter>
        <Button variant="ghost" onPress={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onPress={save}>{clash ? 'Replace' : 'Save'}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Every saved workspace: rename in place, open, or delete. */
function ManageDialog({ app, available, isOpen, onOpenChange }: { app: App; available: (id: string) => boolean; isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = app.workspace;
  const saved = useSignal(ws.saved);
  const current = useSignal(ws.current);
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Your workspaces</DialogTitle>
        <DialogDescription>Click a name to rename it. Built-in layouts cannot be changed.</DialogDescription>
      </DialogHeader>
      {saved.length === 0 ? (
        <p className="type-caption">No saved workspaces left.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {saved.map((w) => (
            <li key={w.id} className="flex items-center gap-1">
              <Input
                aria-label={`Name of ${w.name}`}
                defaultValue={w.name}
                className="h-7 flex-1"
                onBlur={(e) => ws.rename(w.id, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              />
              <Button variant={current === w.id ? 'secondary' : 'ghost'} size="xs" onPress={() => withTransition(() => ws.load(w.id, available))}>
                {current === w.id ? 'In use' : 'Open'}
              </Button>
              <IconButton label={`Delete ${w.name}`} size="icon-xs" onPress={() => (ws.remove(w.id), app.toast(`Deleted “${w.name}”.`))}>
                <Trash2Icon />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button onPress={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}
