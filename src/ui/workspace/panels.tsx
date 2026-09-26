import { Popover, PopoverHeader, PopoverTitle, PopoverTrigger } from '@tecton/react/components/popover';
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
  Settings2Icon,
  SquareMousePointerIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { FEATURE_BY_ID, FEATURES, type FeatureId, type FeatureModule } from '../../features/registry';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { ProvBadge } from '../prov';
import { LinkChip } from './LinkChip';
import { Rev, useRev, useSignal } from '../signal';
import { toolWindows, type ToolWindow } from '../toolWindow';
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
  /** shows a tool window that is not open: turns its feature on first, as the Window menu did */
  open?: () => void;
  /** called when the rail or a menu brings the panel to the front (Interpretation switches to the Hydrocarbons colouring) */
  onReveal?: () => void;
}

/** A workflow phase: the Views menu on the rail (and "+ Add view") lists the analysis windows under these. */
export type ViewPhase = 'Explore' | 'Interpret' | 'Steer' | 'Model' | 'Monitor' | 'Present' | 'Other';

/**
 * Panels with an entry of their own on the rail, top to bottom, with the short
 * label shown under the icon. A panel that does not exist (a feature, or a
 * panel another build leaves out) is skipped; every other panel is listed in
 * the rail's Views menu.
 */
export const RAIL_ENTRIES: { id: string; short: string }[] = [
  { id: 'scene', short: 'Scene' },
  { id: 'properties', short: 'Props.' },
  { id: 'interpretation', short: 'Interp.' },
  { id: 'logs', short: 'Logs' },
];

/** The analysis and tool windows by workflow phase; a panel named nowhere here or on the rail goes under Other. */
export const VIEW_PHASES: { phase: ViewPhase; ids: string[] }[] = [
  { phase: 'Explore', ids: ['mapview', 'section'] },
  { phase: 'Interpret', ids: ['correlation', 'crossplot'] },
  { phase: 'Steer', ids: ['geosteer'] },
  { phase: 'Model', ids: ['simulation'] },
  { phase: 'Monitor', ids: ['live', 'sources'] },
  { phase: 'Present', ids: ['views'] },
];

const ON_RAIL = new Set(RAIL_ENTRIES.map((e) => e.id));

/** The panels the Views menu lists, grouped by phase in order (empty phases left out). */
export function viewGroups(panels: Map<string, PanelDef>): { phase: ViewPhase; panels: PanelDef[] }[] {
  const named = new Set(VIEW_PHASES.flatMap((g) => g.ids));
  const groups = VIEW_PHASES.map((g) => ({ phase: g.phase, panels: g.ids.map((id) => panels.get(id)).filter((d): d is PanelDef => !!d) }));
  const other = [...panels.values()].filter((d) => !named.has(d.id) && !ON_RAIL.has(d.id));
  return [...groups, { phase: 'Other' as const, panels: other }].filter((g) => g.panels.length);
}

const TOOL_ICONS: Record<string, ReactNode> = {
  geosteer: <TrajectoryIcon />,
  crossplot: <ChartScatterIcon />,
  correlation: <ColumnsIcon />,
  section: <ScissorsIcon />,
  mapview: <MapIcon />,
  simulation: <BoxesIcon />,
  views: <BookmarkIcon />,
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
      onReveal: () => app.interpretationShown(),
      body: () => (
        <Scroll>
          <InterpretationPanel app={app} />
        </Scroll>
      ),
    },
    { id: 'logs', title: 'Well logs', icon: <LogCurveIcon />, actions: () => <LogsActions app={app} />, body: () => <LogsBody app={app} /> },
    { id: 'sources', title: 'Live data', icon: <RadioTowerIcon />, actions: () => <SourcesActions app={app} />, body: () => <SourcesBody app={app} /> },
    { id: 'live', title: 'Live charts', icon: <ActivityIcon />, actions: () => <LiveActions app={app} />, body: () => <LiveBody app={app} /> },
  ];
}

const isFeature = (id: string): id is FeatureId => FEATURES.some((f) => f.id === id);

/**
 * Show a tool window; a feature's window turns its feature on first (which
 * usually shows it). It is shown either way: a window its feature does not
 * open by itself (the simulation with nothing loaded) shows its empty state.
 */
export function showTool(app: App, w: ToolWindow) {
  const id = w.opts.id;
  if (isFeature(id) && !app.flags.on(id)) app.flags.set(id, true);
  w.show();
}

/**
 * The feature whose settings a window's header offers: a view's, or the
 * geosteering band's, whose window is its view. Not the toolbar tools' (their
 * window is all they have), nor the simulation's, whose window already says
 * what is loaded.
 */
function settingsOf(app: App, id: string): FeatureModule | undefined {
  const f = isFeature(id) ? FEATURE_BY_ID.get(id) : undefined;
  if (!f || (f.home !== 'view' && f.home !== 'overlay') || id === 'simulation') return undefined;
  const m = app.modules.get(f.id);
  return m?.settings ? m : undefined;
}

function toolPanel(app: App, w: ToolWindow): PanelDef {
  const m = settingsOf(app, w.opts.id);
  return {
    id: w.opts.id,
    title: w.opts.title,
    icon: TOOL_ICONS[w.opts.id] ?? <PanelTopIcon />,
    tool: w,
    open: () => showTool(app, w),
    actions: m ? () => <ViewSettings m={m} title={w.opts.title} /> : undefined,
    body: () => <ToolBody win={w} />,
  };
}

const noRev = new Rev();

/**
 * A view's own settings (well order, which wells to show, notes on how to read
 * it), behind a button in its group header: what the Features panel used to
 * unfold under the view's switch.
 */
function ViewSettings({ m, title }: { m: FeatureModule; title: string }) {
  return (
    <PopoverTrigger>
      <IconButton label={`${title} settings`} size="icon-xs">
        <Settings2Icon />
      </IconButton>
      <Popover placement="bottom end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
        </PopoverHeader>
        <ViewSettingsBody m={m} />
      </Popover>
    </PopoverTrigger>
  );
}

/** Re-renders when the feature bumps its revision. */
function ViewSettingsBody({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">{m.settings!()}</div>;
}

/** Every panel the workspace can show right now: the built-in ones and the feature tool windows. */
export function usePanels(app: App): Map<string, PanelDef> {
  const tools = useSignal(toolWindows);
  // each definition keeps its identity, so opening a tool does not re-render the other panels
  const builtins = useMemo(() => builtinPanels(app), [app]);
  return useMemo(() => {
    const m = new Map<string, PanelDef>();
    for (const p of builtins) m.set(p.id, p);
    for (const w of tools) m.set(w.opts.id, toolDefs.get(w) ?? toolDefs.set(w, toolPanel(app, w)).get(w)!);
    return m;
  }, [builtins, tools]);
}

const toolDefs = new WeakMap<ToolWindow, PanelDef>();

/** A tool window's content: its provenance, its link chip and own controls on a row, then its body (its canvases observe their own size). */
function ToolBody({ win }: { win: ToolWindow }) {
  useRev(win.rev);
  return (
    <>
      {(win.opts.badge || win.opts.header || win.opts.links) && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-2 py-1">
          {win.opts.badge && <ProvBadge prov={win.opts.badge} />}
          {/* what the view follows (the open well, the depth cursor): pressed, the switches for its links */}
          {win.opts.links && <LinkChip state={win.opts.links()} />}
          {win.opts.header?.()}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">{win.opts.body()}</div>
    </>
  );
}
