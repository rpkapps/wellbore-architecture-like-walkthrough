import type { ReactNode } from 'react';
import type { InspectorRow } from '../ui/inspect';
import type { Rev } from '../ui/signal';

/**
 * Optional 3D / analysis features. A flag per feature is the internal switch
 * (the choice is remembered per browser; `?features=none` or
 * `?features=geosteer,curtain` in the URL overrides it), but there is no
 * panel of switches: each feature is found and used where it belongs, its
 * `home` (a view opens from the rail's Views menu, an overlay has an eye in
 * the Scene tree's Overlays folder, and so on).
 */
export type FeatureId =
  | 'geosteer'
  | 'curtain'
  | 'section'
  | 'correlation'
  | 'crossplot'
  | 'owc'
  | 'rop'
  | 'uncertainty'
  | 'anticollision'
  | 'extraWells'
  | 'simulation'
  | 'mapview'
  | 'textures'
  | 'shadows'
  | 'tunnelFx'
  | 'seaFx'
  | 'measure'
  | 'views'
  | 'snapshot';

export type FeatureGroup = 'Geoscience' | 'Drilling & survey' | 'Reservoir model' | 'Visual quality' | 'Tools';

/**
 * Where a feature is found and used:
 * - `view`: a window, opened from Views (rail, "+ Add view", palette); opening
 *   it turns the feature on, closing its window turns it off again, so it
 *   stops computing;
 * - `overlay`: something drawn in 3D, shown or hidden by its eye in
 *   Scene › Overlays, with its settings in Properties;
 * - `colour`: a colour-by mode, offered in the colour key when the well has the data;
 * - `wells`: the well picker's "Show more Volve wells";
 * - `graphics`: Settings › Graphics (the Quality preset and its switches);
 * - `tool`: a viewport toolbar command, always there (it costs nothing until used).
 */
export type FeatureHome = 'view' | 'overlay' | 'colour' | 'wells' | 'graphics' | 'tool';

export interface FeatureDef {
  id: FeatureId;
  name: string;
  group: FeatureGroup;
  desc: string;
  /** provenance chip shown next to the name */
  prov?: 'measured' | 'calculated' | 'interpreted' | 'reconstructed' | 'schematic' | 'user';
  default: boolean;
  /** GPU-heavy features are off in the low-quality mode (?q=low) */
  gpu?: boolean;
  home: FeatureHome;
  /** its name where it lives, when that differs from `name` (the Overlays row, the Graphics switch) */
  label?: string;
  /** how to read what it draws: Properties shows it when the overlay is clicked in 3D or selected in the tree */
  read?: string;
}

export const FEATURES: FeatureDef[] = [
  {
    id: 'geosteer',
    home: 'overlay',
    label: 'Geosteering band',
    name: 'Geosteering view',
    group: 'Geoscience',
    prov: 'calculated',
    default: true,
    desc: 'Vertical distance from the well to the top and base of the target formation at every depth: status band and drop-lines along the well in 3D, plus a distance-to-boundary strip.',
    read: 'The band rides on top of the well: green where the well is inside the target formation, amber above its top, red below its base. The drop-lines join the well to the top and base surfaces; the shorter the line, the closer the boundary.',
  },
  {
    id: 'curtain',
    home: 'overlay',
    name: 'Log curtain',
    group: 'Geoscience',
    prov: 'measured',
    default: true,
    desc: 'A ribbon hanging off the trajectory with a log drawn as a filled curve, so logs can be read in 3D from the field view.',
    read: 'The filled curve reaches further from the well, and its colour changes, as the log value rises. Choose the log in its settings.',
  },
  {
    id: 'section',
    home: 'view',
    name: 'Cross-section along the well',
    group: 'Geoscience',
    prov: 'interpreted',
    default: false,
    desc: '2D vertical section that follows the well path: formations from the picks model, the trajectory, casing shoes, tops and a log along the path. Click it to travel.',
  },
  {
    id: 'correlation',
    home: 'view',
    name: 'Well correlation',
    group: 'Geoscience',
    prov: 'measured',
    default: false,
    desc: 'Log tracks of every logged well side by side, flattened on a formation top, with the formation intervals and the same tops joined between neighbouring wells. Click a track to travel there.',
  },
  {
    id: 'crossplot',
    home: 'view',
    name: 'Crossplots linked to 3D',
    group: 'Geoscience',
    prov: 'calculated',
    default: false,
    desc: 'Density–neutron, Pickett and Buckles plots of the active well, with the matrix line, iso-Sw and bulk-volume-water lines from the interpretation parameters. Drag a box to mark those samples along the well in 3D.',
  },
  {
    id: 'owc',
    home: 'overlay',
    name: 'Oil–water contact',
    group: 'Geoscience',
    prov: 'calculated',
    default: true,
    desc: 'Contact depth found from the calculated water saturation in the clean Hugin sands of every logged well, drawn as a labelled plane with its uncertainty band.',
    read: 'The flat plane is the estimated depth where oil gives way to water; the discs on the wells are the depth found in each well, and the band is its uncertainty.',
  },
  {
    id: 'rop',
    home: 'colour',
    name: 'Drilling speed (ROP) mode',
    group: 'Drilling & survey',
    prov: 'measured',
    default: true,
    desc: 'Adds a fourth colouring mode: rate of penetration from the LAS files, with average speed and drilling time per formation.',
  },
  {
    id: 'uncertainty',
    home: 'overlay',
    label: 'Uncertainty cones',
    name: 'Survey uncertainty cones',
    group: 'Drilling & survey',
    prov: 'calculated',
    default: false,
    desc: 'Position-uncertainty ellipses that widen with depth (simplified MWD error model), with a larger allowance where the path is reconstructed from picks.',
    read: 'Each ellipse is where the well could be at that depth, at the chosen confidence. They widen with depth as the survey errors add up; wider where the path is reconstructed from picks.',
  },
  {
    id: 'anticollision',
    home: 'overlay',
    label: 'Anti-collision',
    name: 'Well anti-collision',
    group: 'Drilling & survey',
    prov: 'calculated',
    default: false,
    desc: 'How close the active well comes to every other wellbore: a separation factor (centre-to-centre distance over the summed uncertainty-ellipse radii, simplified MWD model) every 10 m from the seabed, with the close approaches drawn in 3D and the offset wells listed by risk. Hole shared with a parent or sidetrack above the kick-off is not counted.',
    read: 'A line joins the active well to the nearest point of each well it passes closely: red where the separation factor is under 1 (the uncertainty ellipses overlap, collision risk), amber under the caution threshold. The same colours mark those stretches along the active well; each label names the other well, the centre-to-centre distance and the separation factor.',
  },
  {
    id: 'extraWells',
    home: 'wells',
    name: 'More Volve wells',
    group: 'Drilling & survey',
    prov: 'measured',
    default: false,
    desc: 'Adds further public Volve wellbores with full log suites to the well selector.',
  },
  {
    id: 'simulation',
    home: 'view',
    name: 'Reservoir simulation',
    group: 'Reservoir model',
    prov: 'calculated',
    default: false,
    desc: 'Eclipse grid and restart results (saturation, pressure) on a time slider synced to production. Needs the Volve simulation files — import them in Data.',
  },
  {
    id: 'mapview',
    home: 'view',
    name: 'Map view',
    group: 'Reservoir model',
    prov: 'interpreted',
    default: false,
    desc: 'Plan view: structure map of a horizon with contours, all well paths and where they meet it, the camera, the oil–water contact line and production bubbles on a date slider.',
  },
  {
    id: 'textures',
    home: 'graphics',
    name: 'Realistic textures',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'CC0 photo-scanned PBR textures (Poly Haven) for every rock type, the seabed, the borehole wall, casing steel and cement. Switches live between the photo look and the procedural look.',
  },
  {
    id: 'shadows',
    home: 'graphics',
    name: 'Shadows & ambient occlusion',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Sun shadows on the platform, seabed and block, plus screen-space ambient occlusion in creases and around the casing.',
  },
  {
    id: 'tunnelFx',
    home: 'graphics',
    name: 'Inside-the-hole atmosphere',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Lens depth-of-field and drifting drilling-fluid particles in the Inside view.',
  },
  {
    id: 'seaFx',
    home: 'graphics',
    name: 'Sea surface & seabed detail',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Reflective multi-scale waves with sun glint, and a sand-ripple seabed where the water meets the Nordland clays.',
  },
  {
    id: 'measure',
    home: 'tool',
    name: 'Measure tool',
    group: 'Tools',
    default: true,
    desc: 'Click two points to get the 3D distance, horizontal and vertical offsets, azimuth and — on a well — the MD difference. Shortcut M.',
  },
  {
    id: 'views',
    home: 'tool',
    name: 'Saved views & presentation',
    group: 'Tools',
    default: true,
    desc: 'Bookmark camera, view mode and layers with a caption, then play them back as a full-screen captioned presentation.',
  },
  {
    id: 'snapshot',
    home: 'tool',
    name: 'High-resolution snapshot',
    group: 'Tools',
    default: true,
    desc: 'Export a 2× or 4K PNG of the 3D view with labels, legend, north arrow and data provenance composited in.',
  },
];

export const FEATURE_BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** The features that live in one place, in registry order. */
export const featuresAt = (home: FeatureHome): FeatureDef[] => FEATURES.filter((f) => f.home === home);

/** A feature's name where it lives (the Overlays row, the Graphics switch). */
export const labelOf = (id: FeatureId): string => {
  const f = FEATURE_BY_ID.get(id)!;
  return f.label ?? f.name;
};

/**
 * Features with no switch of their own anywhere (the toolbar commands and the
 * ROP colouring, which shows whenever the well has the data): a stored "off"
 * from the old Features panel is not restored, since nothing in the interface
 * could turn them back on. The URL and the palette can still switch them.
 */
const NO_SWITCH = new Set<FeatureHome>(['tool', 'colour']);

/**
 * Closing a view's window turns its feature off, so it stops computing. A
 * feature that also draws in 3D (the geosteering band) keeps drawing: closing
 * its window only hides the window, and its eye in Scene › Overlays turns it off.
 */
export function closesWithWindow(id: FeatureId): boolean {
  return FEATURE_BY_ID.get(id)?.home === 'view';
}

/** What a feature's window does as it is closed (`ToolWindowOptions.onClose`): see `closesWithWindow`. */
export function windowClosed(flags: Pick<FeatureFlags, 'set'>, id: FeatureId, hide: () => void) {
  if (closesWithWindow(id)) flags.set(id, false);
  else hide();
}

/** Settings › Graphics › Quality: a preset of the four GPU-heavy switches, or "custom" when they match none. */
export type GraphicsQuality = 'low' | 'medium' | 'high';
export type GraphicsId = 'textures' | 'shadows' | 'tunnelFx' | 'seaFx';
export const GRAPHICS_IDS: GraphicsId[] = ['textures', 'shadows', 'tunnelFx', 'seaFx'];

/**
 * - Low: all four off, as the low-quality mode (`?q=low`) starts;
 * - Medium: the cheap-for-their-look ones on (photo textures are a texture
 *   fetch, the sea a single surface), the per-frame costly ones off (shadow
 *   maps with ambient occlusion, depth of field with particles);
 * - High: all on, the default.
 */
export const GRAPHICS_PRESETS: Record<GraphicsQuality, Record<GraphicsId, boolean>> = {
  low: { textures: false, shadows: false, tunnelFx: false, seaFx: false },
  medium: { textures: true, shadows: false, tunnelFx: false, seaFx: true },
  high: { textures: true, shadows: true, tunnelFx: true, seaFx: true },
};

/** The preset the switches match, or 'custom'. */
export function graphicsQuality(on: (id: GraphicsId) => boolean): GraphicsQuality | 'custom' {
  for (const q of ['low', 'medium', 'high'] as GraphicsQuality[]) if (GRAPHICS_IDS.every((id) => GRAPHICS_PRESETS[q][id] === on(id))) return q;
  return 'custom';
}

/** Set the four graphics switches to a preset. */
export function setGraphicsQuality(flags: Pick<FeatureFlags, 'set'>, q: GraphicsQuality) {
  for (const id of GRAPHICS_IDS) flags.set(id, GRAPHICS_PRESETS[q][id]);
}

const KEY = 'vwt.features.v1';

type Listener = (on: boolean) => void;

export class FeatureFlags {
  private state = new Map<FeatureId, boolean>();
  private listeners = new Map<FeatureId, Set<Listener>>();
  private anyListeners = new Set<(id: FeatureId, on: boolean) => void>();

  constructor(lowQuality = false, search = typeof location !== 'undefined' ? location.search : '') {
    let saved: Record<string, boolean> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
    } catch {
      saved = {};
    }
    for (const f of FEATURES) {
      const def = f.default && !(lowQuality && f.gpu);
      this.state.set(f.id, NO_SWITCH.has(f.home) && def ? true : (saved[f.id] ?? def));
    }
    const m = /[?&]features=([^&]*)/.exec(search);
    if (m) {
      const list = decodeURIComponent(m[1]).split(',').map((s) => s.trim());
      const all = list.includes('all');
      for (const f of FEATURES) this.state.set(f.id, all || list.includes(f.id));
    }
  }

  on(id: FeatureId): boolean {
    return this.state.get(id) ?? false;
  }

  set(id: FeatureId, on: boolean) {
    if (this.on(id) === on) return;
    this.state.set(id, on);
    this.save();
    for (const l of this.listeners.get(id) ?? []) l(on);
    for (const l of this.anyListeners) l(id, on);
  }

  toggle(id: FeatureId) {
    this.set(id, !this.on(id));
  }

  /** Subscribe to one feature; called immediately with the current state. */
  watch(id: FeatureId, fn: Listener): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(fn);
    fn(this.on(id));
    return () => this.listeners.get(id)?.delete(fn);
  }

  onAny(fn: (id: FeatureId, on: boolean) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  resetDefaults(lowQuality = false) {
    for (const f of FEATURES) this.set(f.id, f.default && !(lowQuality && f.gpu));
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(this.state)));
    } catch {
      /* private mode: keep in memory only */
    }
  }
}

/** A feature implementation. `enable` / `disable` may be called many times. */
export interface FeatureModule {
  readonly id: FeatureId;
  enable(): void;
  disable(): void;
  /** active well changed or its data was refreshed */
  onWell?(): void;
  /** per-frame update while enabled */
  frame?(dt: number): void;
  /** optional settings, shown in Properties while the feature (an overlay) is selected and on */
  settings?(): ReactNode;
  /** bump to re-render the settings */
  readonly rev?: Rev;
  /** what it shows at a point clicked on it in 3D (scene coordinates): rows for Properties */
  identify?(point: { x: number; y: number; z: number }): InspectorRow[];
}
