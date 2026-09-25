import { Canvas, CanvasSurface } from '@tecton/react/tecton/canvas';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Engine } from '../../scene/engine';
import type { App } from '../app';
import { useSignal, useSignalPart } from '../signal';
import { activeWindow, openWindows, toolWindows } from '../toolWindow';
import { WorkspaceFrame } from '../workspace/Frame';
import { openPanels } from '../workspace/layout';
import { usePanels } from '../workspace/panels';
import { DataEntry, RailFooter } from '../workspace/Rail';
import { HudPrompts } from './Hud';
import { InspectorCard } from './Inspector';
import { Legend } from './Legend';
import { trackEditor } from './LogsPanel';
import { Narrative } from './Narrative';
import { SelectionContextMenu } from './SelectionMenu';
import { Morph } from './overlay';
import { Timeline } from './Timeline';
import { TopBar } from './TopBar';
import { ViewToolbar } from './ViewControls';

const BUILTIN = new Set(['scene', 'properties', 'interpretation', 'features', 'logs']);
const TIMELINE_H = 64;

/**
 * The application: the top bar, then the workspace, where the 3D view fills
 * the stage and the panels, the overlays and the timeline float over it.
 */
export const Workspace = memo(function Workspace({ app, brand = true }: { app: App; brand?: boolean }) {
  const ready = useSignal(app.ready);
  const presenting = useSignal(app.presentation) !== null;
  const panels = usePanels(app);
  useToolSync(app);
  const chrome = ready && !presenting;
  // the app's own rail entries: Data after Views, settings and help at the foot
  const rail = useMemo(() => ({ extra: <DataEntry app={app} />, footer: <RailFooter app={app} /> }), [app]);
  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      {!presenting && <TopBar app={app} brand={brand} />}
      <WorkspaceFrame
        ws={app.workspace}
        panels={panels}
        chromeless={!chrome}
        rail={rail}
        viewport={<Viewport app={app} />}
        overlay={ready && <Overlays app={app} />}
        timeline={chrome && <Timeline app={app} />}
        timelineHeight={chrome ? TIMELINE_H : 0}
        onFree={(f) => app.engine?.setInsets(f.left, f.right, f.bottom)}
      />
      {ready && <SelectionContextMenu app={app} />}
    </div>
  );
});

/**
 * Feature tool windows open and close through their features; the workspace
 * follows: a window that opens takes its last place (or the bottom column),
 * one that closes leaves the layout, and one brought to the front is
 * activated in its group.
 */
function useToolSync(app: App) {
  useEffect(() => {
    const ws = app.workspace;
    trackEditor(app);
    const sync = () => {
      const visible = new Set(openWindows.value.map((w) => w.opts.id));
      const known = new Set(toolWindows.value.map((w) => w.opts.id));
      for (const id of known) {
        if (visible.has(id) && !ws.isOpen(id)) ws.open(id);
        if (!visible.has(id) && ws.isOpen(id)) ws.close(id);
      }
      // a saved layout can name windows of features that no longer exist
      for (const id of openPanels(ws.value)) if (!BUILTIN.has(id) && !known.has(id)) ws.close(id);
    };
    const focus = () => {
      const a = activeWindow.value;
      if (a && ws.isOpen(a)) ws.activate(a);
    };
    const offs = [openWindows.subscribe(sync), toolWindows.subscribe(sync), activeWindow.subscribe(focus)];
    // features create their windows as the first well loads
    const offReady = app.ready.subscribe(sync);
    if (app.ready.value) sync();
    return () => {
      offs.forEach((f) => f());
      offReady();
    };
  }, [app]);
}

/** The 3D view: the engine draws into this surface, which always fills the stage. */
function Viewport({ app }: { app: App }) {
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!app.engine && surface.current) app.mount(new Engine(surface.current, app.field));
  }, [app]);
  return (
    <Canvas className="h-full bg-background">
      <CanvasSurface ref={surface} />
    </Canvas>
  );
}

/**
 * The widgets over the 3D view, inside the area the panels leave free: only
 * what belongs to the view. The colour key (or the inspector, while something
 * is inspected) at the top right; at the bottom centre the toolbar, with a
 * tool's prompt above it and the chapter card above that, over its marker.
 * Where the camera is lives in the timeline.
 */
function Overlays({ app }: { app: App }) {
  const presentation = useSignal(app.presentation);
  // the details card stands in for Properties while that panel is not showing
  const properties = useSignalPart(app.workspace.layout, () => app.workspace.isShown('properties'));
  const hidden = useSignal(app.workspace.hidden);
  const inspecting = useSignal(app.inspector) !== null && !(properties && !hidden);
  // the same elements every time: opening the inspector re-renders these wrappers, not the widgets
  const legend = useMemo(() => <Legend app={app} />, [app]);
  const inspector = useMemo(() => <InspectorCard app={app} />, [app]);
  const narrative = useMemo(() => <Narrative app={app} />, [app]);
  const toolbar = useMemo(() => <ViewToolbar app={app} />, [app]);
  const prompts = useMemo(() => <HudPrompts app={app} />, [app]);
  if (presentation !== null)
    return (
      <div className="absolute inset-x-0 bottom-8 flex justify-center px-4">
        <div className="pointer-events-auto w-full max-w-3xl">{presentation}</div>
      </div>
    );
  return (
    <>
      <div className="absolute top-2 right-2 bottom-14 flex max-w-[calc(100%-1rem)] flex-col items-end @2xl:max-w-[calc(50%-1rem)]">
        <div className="pointer-events-auto flex min-h-0 flex-col">
          <Morph anchor="tr">{inspecting ? inspector : legend}</Morph>
        </div>
      </div>
      <div className="absolute inset-x-2 bottom-2 flex flex-col items-center gap-2">
        {narrative}
        {prompts}
        {/* positioned, so it paints over the chapter card's line */}
        <div className="pointer-events-auto relative max-w-full">{toolbar}</div>
      </div>
    </>
  );
}
