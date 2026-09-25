import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tecton/react/components/tabs';
import type { App, SidebarTab } from '../app';
import { useSignal } from '../signal';
import { FeaturesPanel } from './FeaturesPanel';
import { InterpretationPanel } from './InterpretationPanel';
import { ScenePanel } from './ScenePanel';

/** The left sidebar: scene layers and display, the live petrophysical interpretation, and the optional features. */
export function Sidebar({ app }: { app: App }) {
  const tab = useSignal(app.sidebar);
  return (
    <Tabs selectedKey={tab} onSelectionChange={(k) => app.showSidebar(String(k) as SidebarTab)} className="h-full min-h-0 gap-0">
      <div className="shrink-0 border-b border-border-subtle p-1.5">
        <TabsList aria-label="Sidebar" className="h-8 w-full p-0.5">
          <TabsTrigger id="scene">Scene</TabsTrigger>
          <TabsTrigger id="interpretation">Interpretation</TabsTrigger>
          <TabsTrigger id="features">Features</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent id="scene" className="min-h-0 overflow-y-auto">
        <ScenePanel app={app} />
      </TabsContent>
      <TabsContent id="interpretation" className="min-h-0 overflow-y-auto">
        <InterpretationPanel app={app} />
      </TabsContent>
      <TabsContent id="features" className="min-h-0 overflow-y-auto">
        <FeaturesPanel app={app} />
      </TabsContent>
    </Tabs>
  );
}
