import { Sheet, SheetHeader, SheetTitle } from '@tecton/react/components/sheet';
import { AppShell, AppShellAside, AppShellBody, AppShellMain, AppShellSidebar, AppShellSplit, AppShellSplitHandle, AppShellSplitPanel, useMinWidth } from '@tecton/react/tecton/app-shell';
import { Canvas, CanvasOverlay, CanvasSurface } from '@tecton/react/tecton/canvas';
import { useLayoutEffect, useRef } from 'react';
import { Engine } from '../../scene/engine';
import type { App } from '../app';
import { useSignal } from '../signal';
import { openWindows } from '../toolWindow';
import { Dock } from './Dock';
import { Hud } from './Hud';
import { InspectorCard } from './Inspector';
import { Legend } from './Legend';
import { LogsPanel } from './LogsPanel';
import { Narrative } from './Narrative';
import { Sidebar } from './Sidebar';
import { Timeline } from './Timeline';
import { TopBar } from './TopBar';

/** Below this width the sidebar and the logs open as sheets over the work area. */
export const WIDE = 1024;

/**
 * The application frame: top bar; the Scene / Interpretation / Features
 * sidebar, the 3D work area (with the tool-window dock and the timeline) and
 * the well logs, side by side with draggable dividers on a wide screen.
 */
export function Workspace({ app }: { app: App }) {
  const ready = useSignal(app.ready);
  const leftOpen = useSignal(app.leftOpen);
  const rightOpen = useSignal(app.rightOpen);
  const presenting = useSignal(app.presentation) !== null;
  const wide = useMinWidth(WIDE);
  const panels = ready && !presenting;
  return (
    <AppShell>
      {!presenting && <TopBar app={app} wide={wide} />}
      <AppShellBody className={presenting ? 'row-span-2' : undefined}>
        <AppShellSplit orientation="horizontal">
          {panels && wide && leftOpen && (
            <>
              <AppShellSplitPanel id="sidebar" defaultSize="300px" minSize="240px" maxSize="40%">
                <AppShellSidebar className="h-full w-full border-r-0">
                  <Sidebar app={app} />
                </AppShellSidebar>
              </AppShellSplitPanel>
              <AppShellSplitHandle aria-label="Resize the sidebar" />
            </>
          )}
          <AppShellSplitPanel id="work" minSize="320px">
            <AppShellMain className="flex h-full flex-col overflow-hidden">
              <Work app={app} showDock={panels} />
              {panels && <Timeline app={app} />}
            </AppShellMain>
          </AppShellSplitPanel>
          {panels && wide && rightOpen && (
            <>
              <AppShellSplitHandle aria-label="Resize the well logs" />
              <AppShellSplitPanel id="logs" defaultSize="400px" minSize="260px" maxSize="55%">
                <AppShellAside className="h-full w-full border-l-0">
                  <LogsPanel app={app} />
                </AppShellAside>
              </AppShellSplitPanel>
            </>
          )}
        </AppShellSplit>
      </AppShellBody>
      {panels && !wide && (
        <>
          <Sheet side="left" isOpen={leftOpen} onOpenChange={(o) => app.leftOpen.set(o)} showCloseButton={false} className="gap-0 data-[side=left]:sm:max-w-sm">
            <SheetHeader className="sr-only">
              <SheetTitle>Scene, interpretation and features</SheetTitle>
            </SheetHeader>
            <Sidebar app={app} />
          </Sheet>
          <Sheet side="right" isOpen={rightOpen} onOpenChange={(o) => app.rightOpen.set(o)} showCloseButton={false} className="gap-0 data-[side=right]:sm:max-w-md">
            <SheetHeader className="sr-only">
              <SheetTitle>Well logs</SheetTitle>
            </SheetHeader>
            <LogsPanel app={app} />
          </Sheet>
        </>
      )}
    </AppShell>
  );
}

/** The 3D view over the dock of tool windows, with a draggable divider between them. */
function Work({ app, showDock }: { app: App; showDock: boolean }) {
  const docked = useSignal(openWindows).length > 0 && showDock;
  return (
    <AppShellSplit orientation="vertical">
      <AppShellSplitPanel id="viewport" minSize="35%">
        <Viewport app={app} />
      </AppShellSplitPanel>
      {docked && (
        <>
          <AppShellSplitHandle aria-label="Resize the tool windows" />
          <AppShellSplitPanel id="dock" defaultSize="32%" minSize="120px" maxSize="65%">
            <Dock />
          </AppShellSplitPanel>
        </>
      )}
    </AppShellSplit>
  );
}

/** The 3D view with its overlays: position, colour key or inspector, and the tour narrative. */
function Viewport({ app }: { app: App }) {
  const ready = useSignal(app.ready);
  const presentation = useSignal(app.presentation);
  const inspecting = useSignal(app.inspector) !== null;
  const surface = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!app.engine && surface.current) app.mount(new Engine(surface.current, app.field));
  }, [app]);

  return (
    <Canvas className="@container bg-background">
      <CanvasSurface ref={surface} />
      {ready && presentation !== null && (
        <CanvasOverlay position="bottom" className="bottom-8 w-full max-w-3xl px-4">
          {presentation}
        </CanvasOverlay>
      )}
      {ready && presentation === null && (
        <>
          <CanvasOverlay position="top-left" className="max-w-[calc(50%-1rem)]">
            <Hud app={app} />
          </CanvasOverlay>
          <CanvasOverlay position="top-right" className={inspecting ? 'bottom-3 max-w-[calc(50%-1rem)]' : 'bottom-3 hidden max-w-[calc(50%-1rem)] @2xl:flex'}>
            {inspecting ? <InspectorCard app={app} /> : <Legend app={app} />}
          </CanvasOverlay>
          <CanvasOverlay position="bottom-left" className="max-w-[calc(50%-1rem)]">
            <Narrative app={app} />
          </CanvasOverlay>
        </>
      )}
    </Canvas>
  );
}
