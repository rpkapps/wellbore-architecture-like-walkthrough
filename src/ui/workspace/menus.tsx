import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { AppWindowIcon, LayoutDashboardIcon } from 'lucide-react';
import { FEATURES, type FeatureId } from '../../features/registry';
import type { App } from '../app';
import { useSignal } from '../signal';
import { openWindows } from '../toolWindow';
import { withTransition } from '../transition';
import { PRESETS, type PresetId } from './layout';
import type { PanelDef } from './panels';

const isFeature = (id: string): id is FeatureId => FEATURES.some((f) => f.id === id);

/** Window menu: every panel, ticked when it is open; choosing one shows or closes it. */
export function WindowMenu({ app, panels }: { app: App; panels: Map<string, PanelDef> }) {
  const ws = app.workspace;
  useSignal(ws.layout);
  useSignal(openWindows);
  const list = [...panels.values()];
  const open = list.filter((p) => ws.isOpen(p.id)).map((p) => p.id);
  const toggle = (id: string) => {
    const p = panels.get(id);
    if (!p) return;
    if (!p.tool) {
      ws.isShown(id) ? ws.close(id) : ws.open(id);
      return;
    }
    // a feature's window: turning it on shows it; an open one closes through the feature
    if (isFeature(id) && !app.flags.on(id)) app.flags.set(id, true);
    else if (p.tool.visible) p.tool.close();
    else p.tool.show();
  };
  return (
    <DropdownMenuTrigger>
      <Button variant="ghost" size="sm">
        <AppWindowIcon data-icon="inline-start" />
        Window
      </Button>
      <DropdownMenu placement="bottom end" className="min-w-56">
        <DropdownMenuGroup
          selectionMode="multiple"
          selectedKeys={open}
          onSelectionChange={(keys) => {
            if (keys === 'all') return;
            const next = new Set([...keys].map(String));
            for (const p of list) if (next.has(p.id) !== open.includes(p.id)) toggle(p.id);
          }}
        >
          <DropdownMenuLabel>Panels</DropdownMenuLabel>
          {list.map((p) => (
            <DropdownMenuItem key={p.id} id={p.id} textValue={p.title}>
              {p.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem id="hide" onAction={() => withTransition(() => ws.hidden.set(!ws.hidden.value))}>
          {ws.hidden.value ? 'Show panels' : 'Hide panels'}
          <DropdownMenuShortcut>Tab</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

/** Workspace menu: layouts for a task, and your own saved one. */
export function WorkspaceMenu({ app, panels }: { app: App; panels: Map<string, PanelDef> }) {
  const ws = app.workspace;
  const custom = useSignal(ws.custom);
  const available = (id: string) => panels.has(id);
  return (
    <DropdownMenuTrigger>
      <Button variant="ghost" size="sm">
        <LayoutDashboardIcon data-icon="inline-start" />
        Workspace
      </Button>
      <DropdownMenu placement="bottom end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Layouts</DropdownMenuLabel>
          {PRESETS.map((p) => (
            <DropdownMenuItem key={p.id} id={p.id} onAction={() => withTransition(() => ws.preset(p.id as PresetId, available))}>
              {p.label}
            </DropdownMenuItem>
          ))}
          {custom && (
            <DropdownMenuItem id="custom" onAction={() => withTransition(() => ws.apply(custom, available))}>
              My workspace
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem id="save" onAction={() => (ws.saveCustom(), app.toast('Saved as “My workspace”.'))}>
          Save current as My workspace
        </DropdownMenuItem>
        <DropdownMenuItem id="reset" onAction={() => withTransition(() => ws.preset('walkthrough', available))}>
          Reset to default
        </DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
