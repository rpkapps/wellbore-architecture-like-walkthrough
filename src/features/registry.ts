/**
 * Optional 3D / analysis features. Every feature can be switched on and off
 * independently from the Features panel; the choice is remembered per browser.
 * `?features=none` or `?features=geosteer,curtain` in the URL overrides it.
 */
export type FeatureId =
  | 'geosteer'
  | 'curtain'
  | 'section'
  | 'owc'
  | 'rop'
  | 'uncertainty'
  | 'extraWells'
  | 'simulation'
  | 'shadows'
  | 'tunnelFx'
  | 'seaFx'
  | 'measure'
  | 'views'
  | 'snapshot';

export type FeatureGroup = 'Geoscience' | 'Drilling & survey' | 'Reservoir model' | 'Visual quality' | 'Tools';

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
}

export const FEATURES: FeatureDef[] = [
  {
    id: 'geosteer',
    name: 'Geosteering view',
    group: 'Geoscience',
    prov: 'calculated',
    default: true,
    desc: 'Vertical distance from the well to the top and base of the target formation at every depth: status band and drop-lines along the well in 3D, plus a distance-to-boundary strip.',
  },
  {
    id: 'curtain',
    name: 'Log curtain',
    group: 'Geoscience',
    prov: 'measured',
    default: true,
    desc: 'A ribbon hanging off the trajectory with a log drawn as a filled curve, so logs can be read in 3D from the field view.',
  },
  {
    id: 'section',
    name: 'Cross-section along the well',
    group: 'Geoscience',
    prov: 'interpreted',
    default: false,
    desc: '2D vertical section that follows the well path: formations from the picks model, the trajectory, casing shoes, tops and a log along the path. Click it to travel.',
  },
  {
    id: 'owc',
    name: 'Oil–water contact',
    group: 'Geoscience',
    prov: 'calculated',
    default: true,
    desc: 'Contact depth found from the calculated water saturation in the clean Hugin sands of every logged well, drawn as a labelled plane with its uncertainty band.',
  },
  {
    id: 'rop',
    name: 'Drilling speed (ROP) mode',
    group: 'Drilling & survey',
    prov: 'measured',
    default: true,
    desc: 'Adds a fourth colouring mode: rate of penetration from the LAS files, with average speed and drilling time per formation.',
  },
  {
    id: 'uncertainty',
    name: 'Survey uncertainty cones',
    group: 'Drilling & survey',
    prov: 'calculated',
    default: false,
    desc: 'Position-uncertainty ellipses that widen with depth (simplified MWD error model), with a larger allowance where the path is reconstructed from picks.',
  },
  {
    id: 'extraWells',
    name: 'More Volve wells',
    group: 'Drilling & survey',
    prov: 'measured',
    default: false,
    desc: 'Adds further public Volve wellbores with full log suites to the well selector.',
  },
  {
    id: 'simulation',
    name: 'Reservoir simulation',
    group: 'Reservoir model',
    prov: 'calculated',
    default: false,
    desc: 'Eclipse grid and restart results (saturation, pressure) on a time slider synced to production. Needs the Volve simulation files — import them in Data.',
  },
  {
    id: 'shadows',
    name: 'Shadows & ambient occlusion',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Sun shadows on the platform, seabed and block, plus screen-space ambient occlusion in creases and around the casing.',
  },
  {
    id: 'tunnelFx',
    name: 'Inside-the-hole atmosphere',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Lens depth-of-field and drifting drilling-fluid particles in the Inside view.',
  },
  {
    id: 'seaFx',
    name: 'Sea surface & seabed detail',
    group: 'Visual quality',
    default: true,
    gpu: true,
    desc: 'Reflective multi-scale waves with sun glint, and a sand-ripple seabed where the water meets the Nordland clays.',
  },
  {
    id: 'measure',
    name: 'Measure tool',
    group: 'Tools',
    default: true,
    desc: 'Click two points to get the 3D distance, horizontal and vertical offsets, azimuth and — on a well — the MD difference. Shortcut M.',
  },
  {
    id: 'views',
    name: 'Saved views & presentation',
    group: 'Tools',
    default: true,
    desc: 'Bookmark camera, view mode and layers with a caption, then play them back as a full-screen captioned presentation.',
  },
  {
    id: 'snapshot',
    name: 'High-resolution snapshot',
    group: 'Tools',
    default: true,
    desc: 'Export a 2× or 4K PNG of the 3D view with labels, legend, north arrow and data provenance composited in.',
  },
];

export const FEATURE_BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

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
    for (const f of FEATURES) this.state.set(f.id, saved[f.id] ?? (f.default && !(lowQuality && f.gpu)));
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

  onAny(fn: (id: FeatureId, on: boolean) => void) {
    this.anyListeners.add(fn);
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
  /** optional settings UI shown under the switch in the Features panel */
  settings?(): HTMLElement | null;
}
