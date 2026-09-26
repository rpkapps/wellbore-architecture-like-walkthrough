import { DrillBitIcon, HorizonIcon, LogCurveIcon, OilRigOffshoreIcon, RockFormationsIcon, StrataIcon, TrajectoryIcon, WellIcon, WellPickIcon } from '@tecton/react/icons';
import {
  ActivityIcon,
  BoxesIcon,
  ChartAreaIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ChartScatterIcon,
  ColumnsIcon,
  DropletsIcon,
  EyeIcon,
  FlaskConicalIcon,
  GaugeIcon,
  HighlighterIcon,
  InfoIcon,
  LayersIcon,
  MapIcon,
  MousePointerClickIcon,
  NavigationIcon,
  RadarIcon,
  RulerIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  TableIcon,
  TargetIcon,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

/*
 * The icons the assistant's chips and suggestions name: a fixed set (a lookup
 * of every lucide icon by name would pull the whole library into the chunk),
 * lucide's general glyphs and Tecton's oil and gas ones.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  // domain (Tecton)
  well: WellIcon,
  'well-pick': WellPickIcon,
  pick: WellPickIcon,
  strata: StrataIcon,
  formation: StrataIcon,
  'log-curve': LogCurveIcon,
  logs: LogCurveIcon,
  trajectory: TrajectoryIcon,
  'drill-bit': DrillBitIcon,
  horizon: HorizonIcon,
  rock: RockFormationsIcon,
  platform: OilRigOffshoreIcon,
  // general (lucide)
  activity: ActivityIcon,
  boxes: BoxesIcon,
  'chart-area': ChartAreaIcon,
  'chart-column': ChartColumnIcon,
  'chart-line': ChartLineIcon,
  chart: ChartLineIcon,
  'chart-scatter': ChartScatterIcon,
  columns: ColumnsIcon,
  droplets: DropletsIcon,
  eye: EyeIcon,
  flask: FlaskConicalIcon,
  gauge: GaugeIcon,
  highlighter: HighlighterIcon,
  info: InfoIcon,
  layers: LayersIcon,
  map: MapIcon,
  selection: MousePointerClickIcon,
  navigation: NavigationIcon,
  radar: RadarIcon,
  ruler: RulerIcon,
  scissors: ScissorsIcon,
  search: SearchIcon,
  sparkles: SparklesIcon,
  table: TableIcon,
  target: TargetIcon,
};

/** "ChartLineIcon", "chart_line", "chart-line" → "chart-line". */
const key = (name: string) =>
  name
    .replace(/Icon$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();

/** An icon by name (kebab-case, or a lucide / Tecton component name), or nothing for a name it does not know. */
export function renderIcon(name: string): ReactNode {
  const I = ICONS[key(name)];
  return I ? <I /> : null;
}
