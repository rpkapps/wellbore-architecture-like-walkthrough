import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@tecton/react/components/input-group';
import { LogCurveIcon, TrajectoryIcon } from '@tecton/react/icons';
import {
  BookmarkIcon,
  BoxesIcon,
  CameraIcon,
  ChartScatterIcon,
  ColumnsIcon,
  CrosshairIcon,
  DropletsIcon,
  GaugeIcon,
  MapIcon,
  MountainIcon,
  PanelTopOpenIcon,
  RotateCcwIcon,
  RulerIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  SunIcon,
  WavesIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FEATURES, type FeatureGroup, type FeatureId, type FeatureModule } from '../../features/registry';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { ProvBadge } from '../prov';
import { Rev, useRev, useSignal } from '../signal';
import { SwitchGroup, SwitchRow } from '../switchGroup';
import { toolWindows } from '../toolWindow';

const GROUPS: FeatureGroup[] = [...new Set(FEATURES.map((f) => f.group))];
const noRev = new Rev();

/** A glyph per feature, so the list can be scanned by shape as well as name. */
const ICONS: Record<FeatureId, ReactNode> = {
  geosteer: <TrajectoryIcon />,
  curtain: <LogCurveIcon />,
  section: <ScissorsIcon />,
  correlation: <ColumnsIcon />,
  crossplot: <ChartScatterIcon />,
  owc: <DropletsIcon />,
  rop: <GaugeIcon />,
  uncertainty: <CrosshairIcon />,
  extraWells: <WrenchIcon />,
  simulation: <BoxesIcon />,
  mapview: <MapIcon />,
  textures: <MountainIcon />,
  shadows: <SunIcon />,
  tunnelFx: <SparklesIcon />,
  seaFx: <WavesIcon />,
  measure: <RulerIcon />,
  views: <BookmarkIcon />,
  snapshot: <CameraIcon />,
};

/**
 * Every optional feature: a search, then one `SwitchGroup` per group (how
 * many are on, and an "All on / All off" action) with a row per feature. While a
 * feature is on, its row offers its settings (folded until asked for) and a
 * button that brings up its panel.
 */
export function FeaturesPanel({ app }: { app: App }) {
  const [, setTick] = useState(0);
  useEffect(() => app.flags.onAny(() => setTick((t) => t + 1)), [app]);
  const flags = app.flags;
  const low = app.engine.quality === 'low';
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<FeatureGroup>>(() => new Set());
  const q = query.trim().toLowerCase();
  const match = (id: FeatureId) => {
    if (!q) return true;
    const f = FEATURES.find((x) => x.id === id)!;
    return `${f.name} ${f.desc} ${f.group}`.toLowerCase().includes(q);
  };
  const on = FEATURES.filter((f) => flags.on(f.id)).length;
  const groups = GROUPS.map((g) => ({
    g,
    list: FEATURES.filter((f) => f.group === g && match(f.id)),
  })).filter((x) => x.list.length);
  const tools = useSignal(toolWindows);
  const hasPanel = (id: FeatureId) => tools.some((t) => t.opts.id === id);
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 px-3 pt-2.5 pb-2">
        <InputGroup className="h-7">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput aria-label="Find a feature" placeholder="Find a feature" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query && (
            <InputGroupAddon align="inline-end">
              <IconButton label="Clear the search" size="icon-xs" onPress={() => setQuery('')}>
                <XIcon />
              </IconButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {/* the reset button ends on the switch column */}
        <div className="flex h-6 items-center gap-0.5">
          <span className="type-caption flex-1 truncate">
            <span className="type-value text-fg-1!">{on}</span> of {FEATURES.length} on
          </span>
          <Button variant="ghost" size="xs" onPress={() => FEATURES.forEach((f) => flags.set(f.id, true))}>
            All on
          </Button>
          <Button variant="ghost" size="xs" onPress={() => FEATURES.forEach((f) => flags.set(f.id, false))}>
            All off
          </Button>
          <IconButton label="Reset to defaults" size="icon-xs" onPress={() => flags.resetDefaults(low)}>
            <RotateCcwIcon />
          </IconButton>
        </div>
      </div>
      {groups.length === 0 && <p className="type-caption px-3 pb-3">No feature matches “{query}”.</p>}
      {groups.map(({ g, list }) => {
        // a slot for "show the panel" and one for the settings chevron, when any feature of the group has them
        const panelSlot = list.some((f) => hasPanel(f.id));
        const slots = +panelSlot + +list.some((f) => app.modules.get(f.id)?.settings);
        return (
          <SwitchGroup
            key={g}
            title={g}
            noun="features"
            on={list.filter((f) => flags.on(f.id)).length}
            total={list.length}
            onAll={(v) => list.forEach((f) => flags.set(f.id, v))}
            // while searching, every group with a match is open
            isExpanded={!!q || !closed.has(g)}
            onExpandedChange={(v) => !q && setClosed((c) => (v ? new Set([...c].filter((x) => x !== g)) : new Set(c).add(g)))}
            actionSlots={slots}
            className="last:border-b"
          >
            {list.map((f) => (
              <FeatureRow key={f.id} app={app} id={f.id} panelSlot={panelSlot} />
            ))}
          </SwitchGroup>
        );
      })}
    </div>
  );
}

function FeatureRow({ app, id, panelSlot }: { app: App; id: FeatureId; panelSlot: boolean }) {
  const f = FEATURES.find((x) => x.id === id)!;
  const on = app.flags.on(id);
  const m = app.modules.get(id);
  const tools = useSignal(toolWindows);
  const tool = useMemo(() => tools.find((t) => t.opts.id === id), [tools, id]);
  return (
    <SwitchRow
      icon={ICONS[id]}
      name={f.name}
      description={f.desc}
      badges={
        <>
          {f.prov && <ProvBadge prov={f.prov} short />}
          {f.gpu && (
            <Badge variant="outline" title="Uses extra GPU time" className="h-4! rounded-sm! px-1! text-[0.68rem]! leading-none font-semibold! tracking-wide">
              GPU
            </Badge>
          )}
        </>
      }
      actions={
        panelSlot
          ? [
              on && tool ? (
                <IconButton key="panel" label={`Show the ${tool.opts.title} panel`} size="icon-xs" onPress={() => tool.show()}>
                  <PanelTopOpenIcon />
                </IconButton>
              ) : null,
            ]
          : []
      }
      isSelected={on}
      onChange={(v) => app.flags.set(id, v)}
      settings={on && m?.settings ? () => <Settings m={m} /> : undefined}
    />
  );
}

/** A feature's own settings; they re-render when the feature bumps its revision. */
function Settings({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <>{m.settings!()}</>;
}
