import { LogCurveIcon, TrajectoryIcon } from '@tecton/react/icons';
import {
  ActivityIcon,
  BookmarkIcon,
  BoxesIcon,
  ChartScatterIcon,
  ColumnsIcon,
  FlaskConicalIcon,
  LayersIcon,
  MapIcon,
  PanelTopIcon,
  RadioTowerIcon,
  RulerIcon,
  ScissorsIcon,
  SlidersHorizontalIcon,
  SquareMousePointerIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { App } from '../app';
import { ProvBadge } from '../prov';
import { useRev, useSignal } from '../signal';
import { toolWindows, type ToolWindow } from '../toolWindow';
import { FeaturesPanel } from '../shell/FeaturesPanel';
import { InterpretationPanel } from '../shell/InterpretationPanel';
import { LogsActions, LogsBody } from '../shell/LogsPanel';
import { ScenePanel } from '../shell/ScenePanel';
import { PropertiesPanel } from '../shell/PropertiesPanel';
import { LiveActions, LiveBody } from '../shell/LivePanel';
import { SourcesActions, SourcesBody } from '../shell/SourcesPanel';

/** What the workspace needs to show a panel: its tab, its header controls and its content. */
export interface PanelDef {
  id: string;
  title: string;
  icon: ReactNode;
  /** controls at the end of the group header while this panel is the active tab */
  actions?: () => ReactNode;
  body: () => ReactNode;
  /** a feature's tool window (closing it goes through the feature) */
  tool?: ToolWindow;
}

const TOOL_ICONS: Record<string, ReactNode> = {
  geosteer: <TrajectoryIcon />,
  crossplot: <ChartScatterIcon />,
  correlation: <ColumnsIcon />,
  section: <ScissorsIcon />,
  mapview: <MapIcon />,
  simulation: <BoxesIcon />,
  views: <BookmarkIcon />,
  'log-tracks': <SlidersHorizontalIcon />,
  measure: <RulerIcon />,
};

/** Scrolling content of the built-in panels. */
function Scroll({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>;
}

export function builtinPanels(app: App): PanelDef[] {
  return [
    {
      id: 'scene',
      title: 'Scene',
      icon: <LayersIcon />,
      body: () => (
        <Scroll>
          <ScenePanel app={app} />
        </Scroll>
      ),
    },
    {
      id: 'properties',
      title: 'Properties',
      icon: <SquareMousePointerIcon />,
      body: () => (
        <Scroll>
          <PropertiesPanel app={app} />
        </Scroll>
      ),
    },
    {
      id: 'interpretation',
      title: 'Interpretation',
      icon: <FlaskConicalIcon />,
      body: () => (
        <Scroll>
          <InterpretationPanel app={app} />
        </Scroll>
      ),
    },
    {
      id: 'features',
      title: 'Features',
      icon: <SlidersHorizontalIcon />,
      body: () => (
        <Scroll>
          <FeaturesPanel app={app} />
        </Scroll>
      ),
    },
    { id: 'logs', title: 'Well logs', icon: <LogCurveIcon />, actions: () => <LogsActions app={app} />, body: () => <LogsBody app={app} /> },
    { id: 'sources', title: 'Live data', icon: <RadioTowerIcon />, actions: () => <SourcesActions app={app} />, body: () => <SourcesBody app={app} /> },
    { id: 'live', title: 'Live charts', icon: <ActivityIcon />, actions: () => <LiveActions app={app} />, body: () => <LiveBody app={app} /> },
  ];
}

function toolPanel(w: ToolWindow): PanelDef {
  return { id: w.opts.id, title: w.opts.title, icon: TOOL_ICONS[w.opts.id] ?? <PanelTopIcon />, tool: w, body: () => <ToolBody win={w} /> };
}

/** Every panel the workspace can show right now: the built-in ones and the feature tool windows. */
export function usePanels(app: App): Map<string, PanelDef> {
  const tools = useSignal(toolWindows);
  // each definition keeps its identity, so opening a tool does not re-render the other panels
  const builtins = useMemo(() => builtinPanels(app), [app]);
  return useMemo(() => {
    const m = new Map<string, PanelDef>();
    for (const p of builtins) m.set(p.id, p);
    for (const w of tools) m.set(w.opts.id, toolDefs.get(w) ?? toolDefs.set(w, toolPanel(w)).get(w)!);
    return m;
  }, [builtins, tools]);
}

const toolDefs = new WeakMap<ToolWindow, PanelDef>();

/** A tool window's content: its provenance and own controls on a row, then its body (its canvases observe their own size). */
function ToolBody({ win }: { win: ToolWindow }) {
  useRev(win.rev);
  return (
    <>
      {(win.opts.badge || win.opts.header) && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-2 py-1">
          {win.opts.badge && <ProvBadge prov={win.opts.badge} />}
          {win.opts.header?.()}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">{win.opts.body()}</div>
    </>
  );
}
