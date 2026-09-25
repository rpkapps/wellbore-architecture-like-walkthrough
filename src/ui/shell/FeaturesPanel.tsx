import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@tecton/react/components/input-group';
import { Switch } from '@tecton/react/components/switch';
import { LogCurveIcon, TrajectoryIcon } from '@tecton/react/icons';
import {
  BookmarkIcon,
  BoxesIcon,
  CameraIcon,
  ChartScatterIcon,
  ChevronDownIcon,
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
import type { Key } from 'react-aria-components';
import { FEATURES, type FeatureGroup, type FeatureId, type FeatureModule } from '../../features/registry';
import type { App } from '../app';
import { IconButton, Tip } from '../icon-button';
import { ProvBadge } from '../prov';
import { PanelAccordion, PanelSection } from '../section';
import { Rev, useRev, useSignal } from '../signal';
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
 * Every optional feature: a search, a switch per group and per feature, and
 * while a feature is on, its settings (folded until asked for) and a button
 * that brings up its panel.
 */
export function FeaturesPanel({ app }: { app: App }) {
  const [, setTick] = useState(0);
  useEffect(() => app.flags.onAny(() => setTick((t) => t + 1)), [app]);
  const flags = app.flags;
  const low = app.engine.quality === 'low';
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<Key>>(() => new Set(GROUPS));
  const q = query.trim().toLowerCase();
  const match = (id: FeatureId) => {
    if (!q) return true;
    const f = FEATURES.find((x) => x.id === id)!;
    return `${f.name} ${f.desc} ${f.group}`.toLowerCase().includes(q);
  };
  const on = FEATURES.filter((f) => flags.on(f.id)).length;
  const groups = GROUPS.map((g) => ({ g, list: FEATURES.filter((f) => f.group === g && match(f.id)) })).filter((x) => x.list.length);
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1.5 px-3 pt-2 pb-2">
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
        <div className="-mr-1 flex items-center gap-1">
          <span className="type-caption flex-1">
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
      {/* while searching, every group with a match is open */}
      <PanelAccordion expandedKeys={q ? new Set(groups.map((x) => x.g)) : open} onExpandedChange={(k) => !q && setOpen(k)}>
        {groups.map(({ g, list }) => {
          const n = list.filter((f) => flags.on(f.id)).length;
          const all = n === list.length;
          return (
            <PanelSection
              key={g}
              id={g}
              title={g}
              aside={
                <span className="type-unit ml-auto pr-12 normal-case tracking-normal">
                  {n}/{list.length}
                </span>
              }
              control={
                <Switch
                  aria-label={`${all ? 'Turn off' : 'Turn on'} every ${g} feature`}
                  isSelected={all}
                  onChange={() => list.forEach((f) => flags.set(f.id, !all))}
                  className={n > 0 && !all ? 'opacity-70' : undefined}
                />
              }
            >
              {open.has(g) || q ? (
                <div className="-mx-1 flex flex-col">
                  {list.map((f) => (
                    <FeatureRow key={f.id} app={app} id={f.id} />
                  ))}
                </div>
              ) : null}
            </PanelSection>
          );
        })}
      </PanelAccordion>
    </div>
  );
}

function FeatureRow({ app, id }: { app: App; id: FeatureId }) {
  const f = FEATURES.find((x) => x.id === id)!;
  const on = app.flags.on(id);
  const m = app.modules.get(id);
  const tools = useSignal(toolWindows);
  const tool = useMemo(() => tools.find((t) => t.opts.id === id), [tools, id]);
  const [showSettings, setShowSettings] = useState(false);
  const sid = `feature-${id}`;
  return (
    <div className={`flex flex-col rounded-md px-1 py-1.5 ${on ? '' : 'opacity-80'}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3.5 ${on ? 'bg-ui-accent/15 text-ui-accent' : 'bg-muted text-fg-3'}`}>
          {ICONS[id]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={sid} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.857rem] leading-5 font-medium text-fg-1">
            {f.name}
            {f.prov && <ProvBadge prov={f.prov} />}
            {f.gpu && (
              <Badge variant="outline" title="Uses extra GPU time">
                GPU
              </Badge>
            )}
          </label>
          <p className="type-caption line-clamp-2" title={f.desc}>
            {f.desc}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {on && tool && (
            <IconButton label={`Show the ${tool.opts.title} panel`} size="icon-xs" onPress={() => tool.show()}>
              <PanelTopOpenIcon />
            </IconButton>
          )}
          {on && m?.settings && (
            <Tip label={showSettings ? 'Hide settings' : 'Settings'}>
              <Button variant="ghost" size="icon-xs" aria-label={`${f.name} settings`} aria-expanded={showSettings} onPress={() => setShowSettings((v) => !v)}>
                <ChevronDownIcon className={`transition-transform ${showSettings ? 'rotate-180' : ''}`} />
              </Button>
            </Tip>
          )}
          <Switch id={sid} isSelected={on} onChange={(v) => app.flags.set(id, v)} className="ml-1" />
        </div>
      </div>
      {on && m?.settings && showSettings && <Settings m={m} />}
    </div>
  );
}

function Settings({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <div className="mt-2 ml-7 flex flex-col gap-1.5 border-l border-border-subtle pl-2.5">{m.settings!()}</div>;
}
