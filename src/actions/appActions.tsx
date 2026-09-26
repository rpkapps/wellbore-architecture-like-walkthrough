import { LogCurveIcon, TrajectoryIcon } from '@tecton/react/icons';
import { ChartScatterIcon, ColumnsIcon, FocusIcon, FoldVerticalIcon, NavigationIcon, RadarIcon, ScissorsIcon, TargetIcon } from 'lucide-react';
import { z } from 'zod';
import { COLORMAPS, type ColormapName } from '../data/colormap';
import { DEFAULT_PARAMS, PARAM_RANGES, paramProblem, type NumericParam, type PetroParams } from '../data/petro';
import { FORMATION_BY_ID, MODEL_HORIZONS } from '../data/stratigraphy';
import { FEATURES, graphicsQuality, labelOf, setGraphicsQuality, type FeatureDef, type FeatureId, type GraphicsQuality } from '../features/registry';
import { CorrelationFeature } from '../features/correlation';
import type { CrossplotFeature } from '../features/crossplot';
import type { GeosteerFeature } from '../features/geosteer';
import type { SectionFeature } from '../features/section';
import type { App } from '../ui/app';
import type { ConnectionState } from '../connect/hub';
import { REPLAY_OFFSETS } from '../connect/offsets';
import { ACCENTS, prefs, setAllOverlays, setPrefs, type Accent, type Density, type Theme } from '../ui/prefs';
import { exportCsv } from '../ui/shell/InterpretationPanel';
import { toolWindows } from '../ui/toolWindow';
import { withTransition } from '../ui/transition';
import { openPanels, PRESETS } from '../ui/workspace/layout';
import { atDefault, groupOf, maximised, place, placementLabel, placements, PLACEMENTS, toggleMaximised, type PanelRef, type Placement } from '../ui/workspace/ops';
import { showTool } from '../ui/workspace/panels';
import { describeLocation } from '../ui/workspace/where';
import { depthOf, formationOf, SELECTION_KINDS, SelectionSchema, type Selection } from '../ui/selection';
import { assistantActions } from '../assistant-host/actions';
import { defineAction, type Action, type AnyAction } from './registry';

/*
 * The app's actions. Each wraps a call the UI already makes, so a command
 * from the palette, a key, a button or (later) an assistant does exactly the
 * same thing. Inputs are objects (tool calls always send one); enumerations
 * list their values so a model can pick without guessing.
 *
 * An action that acts on a selected object names its kinds in `appliesTo`;
 * the right-click menus and Properties list it with the object filled in. Its
 * input then takes the object's id under the kind's name (`{ formation }`,
 * `{ well }`), or `onSelection` maps the selection to the input it has.
 */

const PROPERTY_MODES = ['resistivity', 'hydrocarbon', 'lithology', 'rop'] as const;
const MODE_LABEL: Record<(typeof PROPERTY_MODES)[number], string> = { resistivity: 'Resistivity', hydrocarbon: 'Hydrocarbons', lithology: 'Lithology', rop: 'Drilling speed (ROP)' };
const BUILTIN_PANELS = { scene: 'Scene', properties: 'Properties', interpretation: 'Interpretation', logs: 'Well logs', sources: 'Live data', live: 'Live charts', assistant: 'Assistant' } as const;
const FEATURE_IDS = FEATURES.map((f) => f.id) as [FeatureId, ...FeatureId[]];
const FORMATIONS = MODEL_HORIZONS as unknown as [string, ...string[]];
const formationName = (id: string) => FORMATION_BY_ID.get(id)?.name ?? id;
/** Scene-tree layers that are display options: their keys in `view.display` and `scene.wellbore_layers`. */
const DISPLAY_LAYERS = ['labels', 'otherWells', 'sea', 'contours'] as const;
const WELLBORE_LAYERS = ['casing', 'fractures', 'markers'] as const;
const isFeature = (id: string): id is FeatureId => FEATURE_IDS.includes(id as FeatureId);
const NUMERIC_PARAMS = (Object.keys(DEFAULT_PARAMS) as (keyof PetroParams)[]).filter((k) => typeof DEFAULT_PARAMS[k] === 'number') as [string, ...string[]];

/**
 * The features that bring a tool window, by its panel id: its title, and words
 * people search for it by. Listed as panels even while the feature is off.
 */
const FEATURE_WINDOWS: Partial<Record<FeatureId, { title: string; keywords: string[] }>> = {
  geosteer: { title: 'Geosteering', keywords: ['distance to boundary', 'dtb', 'target', 'landing'] },
  section: { title: 'Section along the well', keywords: ['cross-section', 'profile'] },
  correlation: { title: 'Well correlation', keywords: ['tops', 'flatten', 'side by side'] },
  cylinder: { title: 'Anti-collision · travelling cylinder', keywords: ['anti-collision', 'collision', 'separation factor', 'close approach', 'offset wells', 'tc', 'polar'] },
  crossplot: { title: 'Crossplot', keywords: ['porosity', 'density', 'neutron', 'rhob', 'nphi', 'pickett', 'buckles', 'scatter'] },
  mapview: { title: 'Map', keywords: ['plan view', 'top view'] },
  simulation: { title: 'Reservoir simulation', keywords: ['eclipse', 'pressure', 'saturation', 'grid'] },
  views: { title: 'Saved views', keywords: ['bookmarks', 'presentation', 'camera'] },
};

/** How each home names a feature in the palette. */
const HOME_WORD: Record<FeatureDef['home'], string> = { view: 'view', overlay: 'overlay', colour: 'colour by', wells: 'wells', graphics: 'graphics', tool: 'tool' };

/** A `features.set` choice, in the words of the feature's home: "Show Log curtain", "Open Crossplot", "Show more Volve wells". */
function featureChoice(f: FeatureDef, on: boolean): string {
  switch (f.home) {
    case 'overlay':
      return `${on ? 'Hide' : 'Show'} ${labelOf(f.id)}`;
    case 'view':
      return `${on ? 'Close' : 'Open'} ${FEATURE_WINDOWS[f.id]?.title ?? f.name}`;
    case 'wells':
      return on ? 'Show fewer wells' : 'Show more Volve wells';
    case 'graphics':
      return `${on ? 'Turn off' : 'Turn on'} ${labelOf(f.id)} (graphics)`;
    default:
      return `${on ? 'Turn off' : 'Turn on'} ${f.name}`;
  }
}

type PanelPlace = { id: string; title: string; location: string; about?: string; keywords?: string[] };

/**
 * Every panel there is, with where it is now in words ("Left sidebar · top · tab 2",
 * "Hidden"), including the windows of features that are off: the palette's
 * "where is it?" answer, and what `panels.reveal` can bring into view.
 */
function panelPlaces(app: App): PanelPlace[] {
  const L = app.workspace.layout.value;
  const all = app.workspace.hidden.value;
  const out: PanelPlace[] = Object.entries(panelIds()).map(([id, title]) => {
    const where = describeLocation(L, id);
    return { id, title, location: all && where !== 'Hidden' ? `${where} · all panels hidden (Tab)` : where };
  });
  for (const [id, w] of Object.entries(FEATURE_WINDOWS) as [FeatureId, { title: string; keywords: string[] }][]) {
    const about = FEATURES.find((f) => f.id === id)?.desc;
    const off = !app.flags.on(id);
    const p = out.find((x) => x.id === id);
    if (p) Object.assign(p, { about, keywords: w.keywords, location: off ? 'Hidden · feature off' : p.location });
    else out.push({ id, title: w.title, about, keywords: w.keywords, location: 'Hidden · feature off' });
  }
  return out;
}

/** A panel to open or move: a feature's tool window (opened through its feature) or a built-in panel. */
function panelRef(app: App, panel: string): PanelRef {
  const tool = toolWindows.value.find((w) => w.opts.id === panel);
  if (tool) return { id: panel, title: tool.opts.title, tool, open: () => showTool(app, tool) };
  if (panel in BUILTIN_PANELS) return { id: panel, title: BUILTIN_PANELS[panel as keyof typeof BUILTIN_PANELS] };
  throw new Error(`No panel "${panel}".`);
}

/**
 * Undo the last layout change (or, given its `n`, the change a toast reports
 * and those after it). A feature's window follows its feature, so a window the
 * restored layout shows turns its feature back on, and one it no longer shows
 * closes. Returns false when there was nothing to undo.
 */
export function undoLayout(app: App, n?: number): boolean {
  const ws = app.workspace;
  let ok = false;
  withTransition(() => {
    ok = ws.undo(n);
    if (!ok) return;
    const open = new Set(openPanels(ws.value));
    for (const w of toolWindows.value) {
      const id = w.opts.id;
      if (open.has(id) && !w.visible) showTool(app, w);
      else if (!open.has(id) && w.visible) w.close();
    }
  });
  return ok;
}

/** Every panel that can be shown now: the built-in ones and the open features' tool windows. */
function panelIds(): Record<string, string> {
  const out: Record<string, string> = { ...BUILTIN_PANELS };
  for (const w of toolWindows.value) out[w.opts.id] = w.opts.title;
  return out;
}

/**
 * Bring a feature's window into view, set up: its feature turns on (which
 * opens the window) or the open window comes to the front, with every panel
 * shown again if they were hidden (Tab).
 */
function openView(app: App, id: FeatureId) {
  const tool = toolWindows.value.find((w) => w.opts.id === id);
  withTransition(() => {
    if (app.workspace.hidden.value) app.workspace.hidden.set(false);
    if (tool && app.flags.on(id)) tool.show();
  });
  if (!app.flags.on(id)) app.flags.set(id, true);
}

/** Bring a built-in panel into view (its tab to the front, its column unfolded). */
function openPanel(app: App, id: string) {
  withTransition(() => {
    if (app.workspace.hidden.value) app.workspace.hidden.set(false);
    app.workspace.open(id);
  });
}

/** A well of the field (logs, survey) by id: the views work on these, not on context wellbores (a path only). */
const fieldWell = (app: App, id: string) => app.selectableWells().find((w) => w.id === id);

/** Make a well the open one, flying out to it as "Open well" does; resolves once its data is in. */
async function openWell(app: App, id: string) {
  if (!fieldWell(app, id)) throw new Error(`No well "${id}".`);
  if (app.engine.activeWell.id !== id) await app.loadWellAsync(id, true);
}

/** The formation a selection is about, when the open well crosses it (a view of that zone has samples). */
const zoneInOpenWell = (app: App, sel: Selection) => {
  const id = formationOf(sel);
  return id && app.engine.activeWell.zones.some((z) => z.formationId === id) ? id : null;
};

export function appActions(): AnyAction<App>[] {
  const A = <S extends z.ZodType = z.ZodUndefined>(a: Action<S, App>) => defineAction<App, S>(a);
  return [
    // ------------------------------------------------------------------ reading
    A({
      id: 'app.state',
      title: 'What the app is showing',
      description: 'The active well, the camera position along it, the colouring, the selected object, open panels and features on. Read this before acting.',
      category: 'View',
      hidden: true,
      run: (app) => {
        const e = app.engine;
        const p = app.pose.value;
        return {
          well: { id: e.activeWell.id, name: e.activeWell.name, tdMd: Math.round(e.rig.mdMax) },
          position: { md: Math.round(p.md * 10) / 10, tvdss: Math.round(p.tvdss * 10) / 10, inclination: Math.round(p.inc * 10) / 10, formation: p.zone },
          navigation: e.rig.mode === 'guided' ? { mode: 'guided', view: e.rig.guidedView, playing: e.rig.playing } : { mode: 'explore', view: e.rig.exploreView },
          colourBy: e.mode,
          colormap: app.colormapName,
          isolatedFormation: e.geology.isolatedId,
          // what is selected (the Properties panel and the right-click menu follow it); actions with `appliesTo` act on it
          selection: app.selection.value ? { ...app.selection.value, name: app.inspector.value?.title } : null,
          // depth intervals a view has marked (the crossplot's brushed samples); the timeline shows them
          marking: app.marking.value,
          panels: Object.keys(panelIds()).filter((id) => app.workspace.isShown(id)),
          featuresOn: FEATURES.filter((f) => app.flags.on(f.id)).map((f) => f.id),
          workspace: app.workspace.current.value,
          theme: prefs.value.theme,
        };
      },
    }),

    // ------------------------------------------------------------------ navigate
    A({
      id: 'nav.play_pause',
      title: 'Play / pause the walk along the well',
      description: 'Starts or stops travelling down the active well in guided mode.',
      category: 'Navigate',
      where: 'Timeline › Play',
      shortcut: 'Space',
      keywords: ['walk', 'animate', 'travel'],
      run: (app) => (app.togglePlay(), { playing: app.engine.rig.playing }),
    }),
    A({
      id: 'nav.set_mode',
      title: 'Navigation',
      description: 'Guided follows the well path (tunnel, chase or orbit camera); Explore frees the camera to orbit or fly.',
      category: 'Navigate',
      where: 'View toolbar › Guided / Explore',
      input: z.object({ mode: z.enum(['guided', 'explore']) }),
      choices: (app) => [
        { label: 'Guided', input: { mode: 'guided' }, current: app.engine.rig.mode === 'guided' },
        { label: 'Explore', input: { mode: 'explore' }, current: app.engine.rig.mode === 'explore' },
      ],
      run: (app, { mode }) => app.setNav(mode),
    }),
    A({
      id: 'nav.guided_view',
      title: 'Guided camera',
      description: 'Where the camera sits in guided mode: inside the hole, chasing the bit, or orbiting it.',
      category: 'Navigate',
      where: '3D view › Camera',
      input: z.object({ view: z.enum(['tunnel', 'chase', 'orbit']) }),
      choices: (app) =>
        (
          [
            ['tunnel', 'Inside the hole', '1'],
            ['chase', 'Chase', '2'],
            ['orbit', 'Orbit', '3'],
          ] as const
        ).map(([view, label]) => ({ label, input: { view }, current: app.engine.rig.mode === 'guided' && app.engine.rig.guidedView === view })),
      run: (app, { view }) => {
        if (app.engine.rig.mode !== 'guided') app.setNav('guided');
        app.setGuidedView(view);
      },
    }),
    A({
      id: 'nav.explore_view',
      title: 'Explore camera',
      description: 'How the free camera moves in Explore mode: fly (WASD + drag) or orbit around a point.',
      category: 'Navigate',
      input: z.object({ view: z.enum(['fly', 'orbit']) }),
      choices: (app) =>
        (
          [
            ['fly', 'Fly'],
            ['orbit', 'Orbit'],
          ] as const
        ).map(([view, label]) => ({ label, input: { view }, current: app.engine.rig.mode === 'explore' && app.engine.rig.exploreView === view })),
      run: (app, { view }) => {
        if (app.engine.rig.mode !== 'explore') app.setNav('explore');
        app.setExploreView(view);
      },
    }),
    A({
      id: 'nav.go_to_depth',
      title: 'Go to depth',
      description: 'Travels the camera to a measured depth (MD, metres) along the active well.',
      category: 'Navigate',
      where: 'Timeline',
      icon: <NavigationIcon />,
      keywords: ['md', 'jump', 'travel'],
      input: z.object({ md: z.number().min(0).meta({ description: 'Measured depth along the active well, in metres' }) }),
      prompt: {
        label: 'Measured depth (m)',
        placeholder: 'e.g. 3200',
        parse: (t) => {
          const v = parseFloat(t.replace(/[, ]/g, ''));
          return Number.isFinite(v) ? { md: v } : null;
        },
      },
      appliesTo: ['well', 'pick', 'interval'],
      onSelection: (sel, app) => {
        const md = depthOf(sel);
        return md !== null && sel.well === app.engine.activeWell.id ? { input: { md: sel.kind === 'pick' ? md + 1 : md }, label: sel.kind === 'pick' ? 'Travel to top' : 'Travel here' } : null;
      },
      run: (app, { md }) => {
        const max = app.engine.rig.mdMax;
        const to = Math.min(md, max);
        app.travelTo(to);
        return { md: to, clamped: to !== md };
      },
    }),
    A({
      id: 'nav.chapter',
      title: 'Go to chapter',
      description: 'Jumps to a chapter of the guided story along the well (casing points, reservoir entry, TD…).',
      category: 'Navigate',
      where: 'Timeline › Chapters',
      shortcut: 'N / P',
      input: z.object({ index: z.number().int().min(0) }),
      choices: (app) => app.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, input: { index: i }, current: app.chapter.value?.index === i })),
      run: (app, { index }) => app.goChapter(index),
    }),
    A({
      id: 'nav.tour',
      title: 'Start the auto tour',
      description: 'Plays every chapter in turn; any interaction pauses it.',
      category: 'Navigate',
      where: 'Story card › Auto tour',
      run: (app) => app.startTour(),
    }),
    A({
      id: 'nav.overview',
      title: 'Field overview',
      description: 'Flies the camera out to the whole Volve field.',
      category: 'Navigate',
      where: 'View toolbar › Field overview',
      keywords: ['home', 'reset camera', 'zoom out'],
      run: (app) => app.overview(),
    }),
    A({
      id: 'nav.select_well',
      title: 'Open well',
      description: 'Makes another wellbore the active one (its logs, trajectory and interpretation).',
      category: 'Navigate',
      where: 'Top bar › Well',
      keywords: ['wellbore', 'switch'],
      input: z.object({ id: z.string().meta({ description: 'Well id, from the choices' }) }),
      choices: (app) => app.selectableWells().map((w) => ({ label: w.name, input: { id: w.id }, current: w.id === app.engine.activeWell.id })),
      appliesTo: ['well'],
      // its input predates the convention: `{ id }`; the open well has nothing to open
      onSelection: (sel, app) => (sel.id !== app.engine.activeWell.id && app.selectableWells().some((w) => w.id === sel.id) ? { input: { id: sel.id }, label: 'Open well' } : null),
      run: (app, { id }) => {
        if (!app.selectableWells().some((w) => w.id === id)) throw new Error(`No well "${id}".`);
        app.selectWell(id);
      },
    }),

    // ------------------------------------------------------------------ view
    A({
      id: 'view.color_by',
      title: 'Colour the wellbore by',
      description: 'The property painted on the borehole wall and halo: resistivity, hydrocarbons (pore fluids), lithology, or drilling speed.',
      category: 'View',
      where: 'Colour key › Colour by',
      shortcut: 'V',
      input: z.object({ mode: z.enum(PROPERTY_MODES) }),
      choices: (app) =>
        PROPERTY_MODES.filter((m) => m !== 'rop' || app.optionalModes.value.has('rop')).map((mode) => ({ label: MODE_LABEL[mode], input: { mode }, current: app.engine.mode === mode })),
      run: (app, { mode }) => {
        if (mode === 'rop' && !app.optionalModes.value.has('rop')) throw new Error(app.flags.on('rop') ? 'The active well has no ROP log.' : 'The ROP colouring is off: turn the “rop” feature on first.');
        app.setProperty(mode);
      },
    }),
    A({
      id: 'view.colormap',
      title: 'Resistivity colours',
      description: 'The colour map for resistivity in 3D and in the log tracks.',
      category: 'View',
      where: 'Scene › Display',
      input: z.object({ map: z.enum(COLORMAPS.map((c) => c.id) as [ColormapName, ...ColormapName[]]) }),
      choices: (app) => COLORMAPS.map((c) => ({ label: c.label, input: { map: c.id }, current: app.colormapName === c.id })),
      run: (app, { map }) => app.setColormap(map),
    }),
    A({
      id: 'view.display',
      title: 'Scene layers',
      description: 'Shows or hides labels, the other Volve wellbores, the sea and platform, structural contours, and the glow effect.',
      category: 'Scene',
      where: 'Scene › Layers',
      input: z.object({ labels: z.boolean().optional(), otherWells: z.boolean().optional(), sea: z.boolean().optional(), contours: z.boolean().optional(), postFx: z.boolean().optional() }),
      choices: (app) =>
        (
          [
            ['labels', 'labels'],
            ['otherWells', 'other wellbores'],
            ['sea', 'sea and platform'],
            ['contours', 'structural contours'],
          ] as const
        ).map(([k, l]) => ({ label: `${app.display[k] ? 'Hide' : 'Show'} ${l}`, input: { [k]: !app.display[k] } })),
      appliesTo: ['overlay'],
      onSelection: (sel, app) => {
        const k = DISPLAY_LAYERS.find((x) => x === sel.id);
        return k ? { input: { [k]: !app.display[k] }, label: app.display[k] ? 'Hide' : 'Show' } : null;
      },
      run: (app, d) => app.setDisplay(d),
    }),
    A({
      id: 'scene.wellbore_layers',
      title: 'Near-well geometry',
      description: 'Shows or hides the casing and cement, the natural fractures, and the formation tops and depth marks along the active well.',
      category: 'Scene',
      input: z.object({ casing: z.boolean().optional(), fractures: z.boolean().optional(), markers: z.boolean().optional() }),
      choices: (app) =>
        (
          [
            ['casing', 'casing and cement'],
            ['fractures', 'natural fractures'],
            ['markers', 'tops and depth marks'],
          ] as const
        ).map(([k, l]) => ({ label: `${app.wellbore[k] ? 'Hide' : 'Show'} ${l}`, input: { [k]: !app.wellbore[k] } })),
      appliesTo: ['overlay'],
      onSelection: (sel, app) => {
        const k = WELLBORE_LAYERS.find((x) => x === sel.id);
        return k ? { input: { [k]: !app.wellbore[k] }, label: app.wellbore[k] ? 'Hide' : 'Show' } : null;
      },
      run: (app, d) => app.setWellboreDisplay(d),
    }),

    // ------------------------------------------------------------------ scene
    A({
      id: 'scene.layer_preset',
      title: 'Layer preset',
      description: 'Sets every formation’s visibility and opacity at once.',
      category: 'Scene',
      where: 'Scene › Layers › Presets',
      input: z.object({ preset: z.enum(['default', 'solid', 'reservoir', 'pay']) }),
      choices: () =>
        (
          [
            ['default', 'Glass overburden'],
            ['solid', 'Solid'],
            ['reservoir', 'Reservoir focus'],
            ['pay', 'Isolate pay'],
          ] as const
        ).map(([preset, label]) => ({ label, input: { preset } })),
      run: (app, { preset }) => app.preset(preset),
    }),
    A({
      id: 'scene.formation',
      title: 'Formation visibility and opacity',
      description: 'Shows, hides or sets the opacity (0–1) of one formation of the structural model.',
      category: 'Scene',
      where: 'Scene › Layers',
      input: z.object({ formation: z.enum(FORMATIONS), visible: z.boolean().optional(), opacity: z.number().min(0).max(1).optional() }),
      appliesTo: ['formation'],
      onSelection: (sel, app) => {
        const visible = app.engine.geology.state.get(sel.id)?.visible;
        return visible === undefined ? null : { input: { formation: sel.id, visible: !visible }, label: visible ? 'Hide' : 'Show' };
      },
      run: (app, { formation, visible, opacity }) =>
        app.setLayer(formation, { ...(visible !== undefined ? { visible } : {}), ...(opacity !== undefined ? { opacity } : {}) }),
    }),
    A({
      id: 'scene.isolate',
      title: 'Isolate formation',
      description: 'Fades every other formation to a ghost so one stands alone; without a formation, shows them all again.',
      category: 'Scene',
      where: 'Scene › Layers › formation ⋯',
      icon: <FocusIcon />,
      input: z.object({ formation: z.enum(FORMATIONS).nullable() }),
      choices: (app) => [
        ...(app.engine.geology.isolatedId ? [{ label: 'Show all formations', input: { formation: null } }] : []),
        ...MODEL_HORIZONS.map((id) => ({ label: formationName(id), input: { formation: id }, current: app.engine.geology.isolatedId === id })),
      ],
      appliesTo: ['formation', 'pick'],
      // a toggle on the selected formation: pressed again, every formation comes back
      onSelection: (sel, app) => {
        const id = formationOf(sel)!;
        const on = app.engine.geology.isolatedId === id;
        return { input: { formation: on ? null : id }, label: 'Isolate', checked: on };
      },
      run: (app, { formation }) => app.isolate(formation),
    }),
    A({
      id: 'scene.inspect',
      title: 'Show formation details',
      description: 'Selects a formation, so Properties (or the details card) shows it: age, lithology, depths, pay in the active well.',
      category: 'Scene',
      where: 'Scene › Layers › formation ⋯',
      input: z.object({ formation: z.enum(FORMATIONS) }),
      choices: () => MODEL_HORIZONS.map((id) => ({ label: formationName(id), input: { formation: id } })),
      // from a formation top in a well to the formation itself
      appliesTo: ['pick'],
      onSelection: (sel) => ({ input: { formation: sel.id }, label: `Select ${formationName(sel.id)}` }),
      run: (app, { formation }) => app.inspectFormation(formation),
    }),
    A({
      id: 'selection.set',
      title: 'Select',
      description:
        'Selects an object, as a click in the 3D view or the Scene tree does: a well (id), a formation (id), a formation top in the active well (pick: formation id and md), an overlay or scene layer (feature or layer id), a contact, or a depth interval (top, base). Properties and the right-click menu follow it; null clears it.',
      category: 'Scene',
      hidden: true,
      input: z.object({ selection: SelectionSchema.nullable(), show: z.boolean().optional().meta({ description: 'Also bring up the Properties panel' }) }),
      run: (app, { selection, show }) => {
        // what exists in one well belongs to the active one
        const sel = selection && (selection.kind === 'pick' || selection.kind === 'interval' || selection.md !== undefined || selection.part) ? { well: app.engine.activeWell.id, ...selection } : selection;
        if (sel && !app.inspectorFor(sel)) throw new Error(`Nothing to select as ${sel.kind} "${sel.id}".`);
        app.select(sel);
        if (show) withTransition(() => app.workspace.open('properties'));
        return { selection: app.selection.value, name: app.inspector.value?.title ?? null };
      },
    }),

    A({
      id: 'selection.clear',
      title: 'Clear selection',
      description: 'Deselects the selected object (Properties then shows the scene settings).',
      category: 'Scene',
      shortcut: 'Esc',
      enabled: (app) => app.selection.value !== null,
      run: (app) => app.select(null),
    }),

    // ------------------------------------------------------------------ views set up for an object (the task bar's steps)
    A({
      id: 'views.logs',
      title: 'Show logs',
      description: 'Brings up the Well logs panel for a well (opening it first), or at the depth of a formation top or an interval of the open well.',
      category: 'Panels',
      where: 'Task bar',
      icon: <LogCurveIcon />,
      keywords: ['well logs', 'tracks', 'curves'],
      input: z.object({ well: z.string().optional(), md: z.number().min(0).optional().meta({ description: 'A depth of the open well to centre the tracks on, m MD' }) }),
      appliesTo: ['well', 'pick', 'interval'],
      onSelection: (sel, app) => {
        if (sel.kind === 'well') {
          const w = fieldWell(app, sel.id);
          return w && (w.logs || w.lasFile) ? { input: { well: sel.id }, label: 'Show logs' } : null;
        }
        const md = depthOf(sel);
        return md !== null && sel.well === app.engine.activeWell.id ? { input: { md }, label: 'Show in logs' } : null;
      },
      run: async (app, { well, md }) => {
        if (well) await openWell(app, well);
        openPanel(app, 'logs');
        if (md !== undefined) app.logs.setCursor(Math.min(md, app.engine.rig.mdMax));
      },
    }),
    A({
      id: 'views.correlate',
      title: 'Correlate with the other wells',
      description: "Opens the well correlation (every logged well's tracks side by side) with this well among them.",
      category: 'Panels',
      where: 'Task bar',
      icon: <ColumnsIcon />,
      keywords: ['correlation', 'side by side', 'tops'],
      input: z.object({ well: z.string() }),
      appliesTo: ['well'],
      onSelection: (sel, app) => {
        const w = fieldWell(app, sel.id);
        return w && (w.logs || w.lasFile) ? { label: 'Correlate' } : null;
      },
      run: (app, { well }) => {
        if (!fieldWell(app, well)) throw new Error(`No well "${well}".`);
        app.feature<CorrelationFeature>('correlation')?.include(well);
        openView(app, 'correlation');
      },
    }),
    A({
      id: 'views.section',
      title: 'Section along the well',
      description: 'Opens the vertical section that follows a well path (opening the well first), with the formations it crosses.',
      category: 'Panels',
      where: 'Task bar',
      icon: <ScissorsIcon />,
      keywords: ['cross-section', 'profile', 'curtain'],
      input: z.object({ well: z.string() }),
      appliesTo: ['well'],
      onSelection: (sel, app) => (fieldWell(app, sel.id) ? { label: 'Section along the well' } : null),
      run: async (app, { well }) => {
        await openWell(app, well);
        // a section pinned to another well comes back to this one
        app.feature<SectionFeature>('section')?.pinTo(null);
        openView(app, 'section');
      },
    }),
    A({
      id: 'views.geosteer',
      title: 'Geosteer this well',
      description: 'Opens geosteering for a well (opening it first): where it runs relative to the top and base of the target formation.',
      category: 'Panels',
      where: 'Task bar',
      icon: <TrajectoryIcon />,
      keywords: ['geosteering', 'distance to boundary', 'landing'],
      input: z.object({ well: z.string() }),
      appliesTo: ['well'],
      onSelection: (sel, app) => (fieldWell(app, sel.id) ? { label: 'Geosteer' } : null),
      run: async (app, { well }) => {
        await openWell(app, well);
        openView(app, 'geosteer');
      },
    }),
    A({
      id: 'views.cylinder',
      title: 'Travelling cylinder around the well',
      description:
        'Opens the anti-collision travelling cylinder for a well (opening it first): the other wellbores around it at the depth cursor, looking down the hole, coloured by separation factor.',
      category: 'Panels',
      where: 'Task bar',
      icon: <RadarIcon />,
      keywords: ['anti-collision', 'collision', 'separation factor', 'close approach', 'offset wells', 'polar'],
      input: z.object({ well: z.string().optional().meta({ description: 'The well to look down (default: the open one)' }) }),
      appliesTo: ['well', 'overlay'],
      onSelection: (sel, app) => {
        if (sel.kind === 'overlay') return sel.id === 'anticollision' ? { input: {}, label: 'Travelling cylinder' } : null;
        return fieldWell(app, sel.id) ? { label: 'Travelling cylinder' } : null;
      },
      run: async (app, { well }) => {
        if (well) await openWell(app, well);
        openView(app, 'cylinder');
      },
    }),
    A({
      id: 'views.crossplot_zone',
      title: 'Crossplot this zone',
      description: "Opens the crossplot of the open well limited to one formation's samples.",
      category: 'Panels',
      where: 'Task bar',
      icon: <ChartScatterIcon />,
      keywords: ['crossplot', 'porosity', 'pickett', 'density neutron', 'zone'],
      input: z.object({ formation: z.enum(FORMATIONS) }),
      appliesTo: ['formation', 'pick'],
      onSelection: (sel, app) => {
        const id = zoneInOpenWell(app, sel);
        return id && app.engine.activeWell.logs ? { input: { formation: id }, label: 'Crossplot this zone' } : null;
      },
      run: (app, { formation }) => {
        const x = app.feature<CrossplotFeature>('crossplot');
        if (!x?.showZone(formation)) throw new Error(`${app.engine.activeWell.name} does not cross the ${formationName(formation)}.`);
        openView(app, 'crossplot');
      },
    }),
    A({
      id: 'views.flatten_correlation',
      title: 'Flatten the correlation on this top',
      description: "Opens the well correlation flattened on a formation's top, so the wells line up on it.",
      category: 'Panels',
      where: 'Task bar',
      icon: <FoldVerticalIcon />,
      keywords: ['flatten', 'datum', 'correlation', 'top'],
      input: z.object({ formation: z.enum(FORMATIONS) }),
      appliesTo: ['formation', 'pick'],
      onSelection: (sel) => (CorrelationFeature.canFlatten(formationOf(sel)!) ? { input: { formation: formationOf(sel)! }, label: 'Flatten correlation on this top' } : null),
      run: (app, { formation }) => {
        if (!CorrelationFeature.canFlatten(formation)) throw new Error(`The correlation cannot flatten on the ${formationName(formation)}.`);
        app.feature<CorrelationFeature>('correlation')?.flattenOn(formation);
        openView(app, 'correlation');
      },
    }),
    A({
      id: 'views.geosteer_target',
      title: 'Set as geosteering target',
      description: 'Makes a formation the geosteering target (its top and base become the boundaries the well is measured against) and opens geosteering.',
      category: 'Panels',
      where: 'Task bar',
      icon: <TargetIcon />,
      keywords: ['geosteering', 'target', 'boundary', 'landing'],
      input: z.object({ formation: z.enum(FORMATIONS) }),
      appliesTo: ['formation', 'pick'],
      onSelection: (sel, app) => {
        const id = formationOf(sel)!;
        const g = app.feature<GeosteerFeature>('geosteer');
        return g?.targets.some((t) => t.id === id) ? { input: { formation: id }, label: 'Set as geosteering target' } : null;
      },
      run: (app, { formation }) => {
        const g = app.feature<GeosteerFeature>('geosteer');
        if (!g?.targets.some((t) => t.id === formation)) throw new Error(`The ${formationName(formation)} cannot be a geosteering target.`);
        g.setTarget(formation);
        openView(app, 'geosteer');
      },
    }),

    // ------------------------------------------------------------------ panels & workspace
    A({
      id: 'panels.show',
      title: 'Show panel',
      description: 'Opens a panel (or brings it to the front) where it was last docked.',
      category: 'Panels',
      where: 'Rail',
      input: z.object({ panel: z.string().meta({ description: 'Panel id, from the choices' }) }),
      choices: (app) => Object.entries(panelIds()).map(([panel, label]) => ({ label, input: { panel }, current: app.workspace.isShown(panel) })),
      run: (app, { panel }) => {
        const tool = toolWindows.value.find((w) => w.opts.id === panel);
        // a feature's window turns its feature on, as the rail does
        if (tool) showTool(app, tool);
        else if (panel in BUILTIN_PANELS) withTransition(() => app.workspace.open(panel));
        else throw new Error(`No panel "${panel}" (is its feature on?).`);
      },
    }),
    A({
      id: 'panels.reveal',
      title: 'Go to panel',
      description: 'Says where a panel is (its sidebar or the bottom panel, slot and tab, floating, or hidden) and brings it into view: unfolds its sidebar, brings its tab to the front, and turns its feature on if needed.',
      category: 'Panels',
      where: 'Rail',
      keywords: ['where', 'find', 'locate', 'reveal', 'panel', 'window', 'tab'],
      input: z.object({ panel: z.string().meta({ description: 'Panel id, from the choices' }) }),
      choices: (app) =>
        panelPlaces(app).map(({ id, title, location, about, keywords = [] }) => ({
          label: title,
          input: { panel: id },
          detail: location,
          description: about,
          keywords: ['panel', 'window', ...keywords],
          current: app.workspace.isShown(id),
        })),
      run: (app, { panel }) => {
        const place = panelPlaces(app).find((p) => p.id === panel);
        if (!place) throw new Error(`No panel "${panel}".`);
        const tool = toolWindows.value.find((w) => w.opts.id === panel);
        // a feature that is off: turning it on opens its window (as the Window menu does)
        const feature = panel in FEATURE_WINDOWS && !app.flags.on(panel as FeatureId);
        withTransition(() => {
          if (app.workspace.hidden.value) app.workspace.hidden.set(false);
          if (feature) return;
          if (tool) tool.show();
          else if (panel in BUILTIN_PANELS) app.workspace.open(panel);
        });
        if (feature) {
          if (tool) showTool(app, tool);
          else app.flags.set(panel as FeatureId, true);
        }
        return { panel, was: place.location, now: describeLocation(app.workspace.layout.value, panel) };
      },
    }),
    A({
      id: 'panels.close',
      title: 'Close panel',
      description: 'Closes a panel.',
      category: 'Panels',
      where: 'Panel tab › ×',
      input: z.object({ panel: z.string() }),
      choices: (app) =>
        Object.entries(panelIds())
          .filter(([id]) => app.workspace.isOpen(id))
          .map(([panel, label]) => ({ label, input: { panel } })),
      run: (app, { panel }) => {
        const tool = toolWindows.value.find((w) => w.opts.id === panel);
        if (tool) tool.close();
        else withTransition(() => app.workspace.close(panel));
      },
    }),
    A({
      id: 'selection.properties',
      title: 'Show properties',
      description: 'Brings up the Properties panel: the details and settings of the selected object.',
      category: 'Panels',
      keywords: ['inspector', 'details', 'settings', 'selection'],
      // without a selection it shows the current one (the palette); from a menu, the object the menu is for
      input: z.object({ selection: SelectionSchema.optional() }).optional(),
      appliesTo: [...SELECTION_KINDS],
      onSelection: (sel) => ({ input: { selection: sel }, label: 'Properties' }),
      run: (app, input) => {
        if (input?.selection) app.select(input.selection);
        withTransition(() => app.workspace.open('properties'));
      },
    }),
    A({
      id: 'panels.place',
      title: 'Move panel',
      description:
        'Moves a panel to the top or bottom of the left or right sidebar or to the bottom panel, undocks it into a floating window, docks a floating one back where it came from, or resets it to where the workspace puts it (opening it first if it is closed). The toast that follows offers Undo.',
      category: 'Panels',
      where: 'Panel menu ⋯ · rail right-click',
      keywords: ['dock', 'undock', 'float', 'sidebar', 'split'],
      input: z.object({ panel: z.string(), to: z.enum(PLACEMENTS as [Placement, ...Placement[]]) }),
      choices: (app) =>
        Object.entries(panelIds())
          .filter(([id]) => app.workspace.isOpen(id))
          .flatMap(([panel, label]) =>
            [...placements(app.workspace, panel), ...(atDefault(app.workspace, panel) ? [] : (['default'] as const))].map((to) => ({
              label: `${label}: ${placementLabel(app.workspace, panel, to).toLowerCase()}`,
              input: { panel, to },
            })),
          ),
      run: (app, { panel, to }) => {
        withTransition(() => place(app.workspace, panelRef(app, panel), to));
        return { panel, now: describeLocation(app.workspace.layout.value, panel) };
      },
    }),
    A({
      id: 'panels.undo_layout',
      title: 'Undo layout change',
      description: 'Takes back the last change to the panel layout: a move, undock, dock back, close or reset location (the toast after each offers the same), or a resize or reorder.',
      category: 'Panels',
      shortcut: 'Ctrl Z',
      keywords: ['undo', 'layout', 'panel', 'dock', 'revert'],
      // a toast's Undo names its change: that one (and any made after it) is taken back
      input: z.object({ change: z.number().int().optional().meta({ description: 'The change a toast reported; the last one when left out' }) }).optional(),
      run: (app, input) => {
        if (!undoLayout(app, input?.change)) throw new Error('No layout change to undo.');
        // (in place of the change's own toast, so its Undo is not pressed twice)
        app.toast('Layout change undone.', 'info', { id: 'layout-change' });
        return { layout: 'restored' };
      },
    }),
    A({
      id: 'panels.maximise',
      title: 'Maximise panel',
      description: 'Fills the space beside the rail and above the timeline with the group of tabs a panel is in, or restores it.',
      category: 'Panels',
      shortcut: 'Ctrl Space',
      input: z.object({ panel: z.string() }),
      choices: (app) =>
        Object.entries(panelIds())
          .filter(([id]) => app.workspace.isOpen(id))
          .map(([panel, label]) => ({ label, input: { panel }, current: maximised.value !== null && maximised.value === groupOf(app.workspace, panel) })),
      run: (app, { panel }) => {
        const g = groupOf(app.workspace, panel);
        if (!g) throw new Error(`"${panel}" is not open.`);
        withTransition(() => {
          if (app.workspace.hidden.value) app.workspace.hidden.set(false);
          toggleMaximised(g);
        });
      },
    }),
    A({
      id: 'panels.hide_all',
      title: 'Hide / show all panels',
      description: 'Clears every panel off the 3D view, or brings them back.',
      category: 'Panels',
      where: 'Rail',
      shortcut: 'Tab',
      run: (app) => withTransition(() => app.workspace.hidden.set(!app.workspace.hidden.value), { grow: false }),
    }),
    A({
      id: 'panels.overlays',
      title: 'Overlays',
      description: 'Collapses the cards over the 3D view (colour key, chapter card) to one-line chips, or expands them.',
      category: 'Panels',
      where: 'Settings › Overlays',
      input: z.object({ collapsed: z.boolean() }),
      choices: () => [
        { label: 'Collapse all', input: { collapsed: true } },
        { label: 'Expand all', input: { collapsed: false } },
      ],
      run: (_app, { collapsed }) => setAllOverlays(collapsed),
    }),
    A({
      id: 'workspace.apply',
      title: 'Workspace',
      description:
        'Switches to a workspace tab. Each keeps its own panel layout as you left it, and can set up its task: Petrophysics colours the well by hydrocarbons, Geosteering follows the bit in guided mode.',
      category: 'Workspace',
      where: 'Top bar › Workspace tabs',
      input: z.object({ id: z.string().meta({ description: 'A built-in workspace (walkthrough, petrophysics, geosteering) or the id of one of yours' }) }),
      choices: (app) => app.workspace.list().map((w) => ({ label: w.name, input: { id: w.id }, current: app.workspace.current.value === w.id })),
      run: (app, { id }) => {
        if (!app.switchWorkspace(id)) throw new Error(`No workspace "${id}".`);
      },
    }),
    A({
      id: 'workspace.next',
      title: 'Next workspace',
      description: 'Switches to the workspace tab to the right (wrapping round).',
      category: 'Workspace',
      shortcut: 'Ctrl PgDn',
      run: (app) => {
        const id = app.workspace.neighbour(1, app.targetWorkspace);
        app.switchWorkspace(id);
        return { workspace: id };
      },
    }),
    A({
      id: 'workspace.previous',
      title: 'Previous workspace',
      description: 'Switches to the workspace tab to the left (wrapping round).',
      category: 'Workspace',
      shortcut: 'Ctrl PgUp',
      run: (app) => {
        const id = app.workspace.neighbour(-1, app.targetWorkspace);
        app.switchWorkspace(id);
        return { workspace: id };
      },
    }),
    A({
      id: 'workspace.reset',
      title: 'Reset workspace',
      description: "Puts a workspace's panel layout back to where it started: a built-in one to its preset, one of yours to the layout it was saved or duplicated with.",
      category: 'Workspace',
      keywords: ['layout', 'default', 'restore'],
      input: z.object({ id: z.string() }),
      choices: (app) => app.workspace.list().map((w) => ({ label: w.name, input: { id: w.id }, current: app.workspace.current.value === w.id })),
      run: (app, { id }) => {
        if (!app.workspace.has(id)) throw new Error(`No workspace "${id}".`);
        app.resetWorkspace(id);
      },
    }),
    A({
      id: 'workspace.save',
      title: 'Save workspace as',
      description: 'Saves the current panel layout as a new workspace tab and switches to it (a name in use by one of yours replaces it).',
      category: 'Workspace',
      where: 'Top bar › Workspace tabs',
      input: z.object({ name: z.string().min(1).max(60) }),
      prompt: { label: 'Workspace name', placeholder: 'e.g. Logs review', parse: (t) => (t.trim() ? { name: t.trim() } : null) },
      run: (app, { name }) => ({ id: app.workspace.saveAs(name) }),
    }),
    A({
      id: 'workspace.duplicate',
      title: 'Duplicate workspace',
      description: 'Copies a workspace (its layout as it is now and its task context) into a new tab of yours, and switches to it.',
      category: 'Workspace',
      input: z.object({ id: z.string(), name: z.string().min(1).max(60).optional() }),
      choices: (app) => app.workspace.list().map((w) => ({ label: w.name, input: { id: w.id }, current: app.workspace.current.value === w.id })),
      run: (app, { id, name }) => {
        if (!app.workspace.has(id)) throw new Error(`No workspace "${id}".`);
        const copy = app.workspace.duplicate(id, name);
        app.switchWorkspace(copy);
        return { id: copy, name: app.workspace.info(copy)?.name };
      },
    }),
    A({
      id: 'workspace.rename',
      title: 'Rename workspace',
      description: 'Renames one of your workspaces (the active one when no id is given). Built-in workspaces keep their names.',
      category: 'Workspace',
      input: z.object({ id: z.string().optional(), name: z.string().min(1).max(60) }),
      enabled: (app) => app.workspace.saved.value.length > 0,
      prompt: { label: 'New name for the active workspace', placeholder: 'e.g. Logs review', parse: (t) => (t.trim() ? { name: t.trim() } : null) },
      run: (app, { id = app.workspace.current.value, name }) => {
        if (!app.workspace.saved.value.some((w) => w.id === id)) throw new Error('Built-in workspaces keep their names: duplicate one to make your own.');
        app.workspace.rename(id, name);
      },
    }),
    A({
      id: 'workspace.delete',
      title: 'Delete workspace',
      description: 'Removes one of your workspace tabs (built-in ones stay). Deleting the active one goes back to Walkthrough.',
      category: 'Workspace',
      where: 'Top bar › Workspace tabs',
      needsApproval: true,
      input: z.object({ id: z.string() }),
      enabled: (app) => app.workspace.saved.value.length > 0,
      choices: (app) => app.workspace.saved.value.map((w) => ({ label: w.name, input: { id: w.id } })),
      run: (app, { id }) => {
        if (!app.workspace.saved.value.some((w) => w.id === id)) throw new Error(`No workspace of yours with id "${id}".`);
        if (app.workspace.current.value === id) app.switchWorkspace(PRESETS[0].id);
        // after the switch has run (it waits for the next frame), so the tab leaves once its layout has
        withTransition(() => app.workspace.remove(id, app.hasPanel));
      },
    }),

    // ------------------------------------------------------------------ features
    A({
      id: 'features.set',
      title: 'Feature',
      description:
        'Turns an optional feature on or off: an overlay in 3D (log curtain, oil–water contact, uncertainty cones, geosteering band), a view (cross-section, correlation, crossplots, travelling cylinder, map, simulation: on opens its window), a graphics effect, the further Volve wells, the ROP colouring or a toolbar tool.',
      category: 'Features',
      where: 'Scene › Overlays · Rail › Views · Settings › Graphics · Well picker',
      input: z.object({ feature: z.enum(FEATURE_IDS), on: z.boolean() }),
      choices: (app) => FEATURES.map((f) => ({ label: featureChoice(f, app.flags.on(f.id)), input: { feature: f.id, on: !app.flags.on(f.id) }, keywords: [f.group, f.name, HOME_WORD[f.home]], description: f.desc })),
      // an overlay or a contact drawn by a feature: switching the feature shows or hides it
      appliesTo: ['overlay', 'contact'],
      onSelection: (sel, app) => (isFeature(sel.id) ? { input: { feature: sel.id, on: !app.flags.on(sel.id) }, label: app.flags.on(sel.id) ? 'Hide' : 'Show' } : null),
      run: (app, { feature, on }) => {
        // opening a view shows its window even when the feature does not open it by itself (nothing loaded yet)
        const tool = on && FEATURES.find((f) => f.id === feature)?.home === 'view' ? toolWindows.value.find((w) => w.opts.id === feature) : undefined;
        if (tool) withTransition(() => showTool(app, tool));
        else app.flags.set(feature, on);
      },
    }),
    A({
      id: 'features.all',
      title: 'Every optional feature',
      description: 'Turns every optional feature (overlays, views, graphics effects, the further Volve wells, tools) on or off at once.',
      category: 'Features',
      keywords: ['all on', 'all off', 'features'],
      input: z.object({ on: z.boolean() }),
      choices: () => [
        { label: 'All on', input: { on: true } },
        { label: 'All off', input: { on: false } },
      ],
      run: (app, { on }) => FEATURES.forEach((f) => app.flags.set(f.id, on)),
    }),
    A({
      id: 'features.reset',
      title: 'Reset optional features to defaults',
      description: 'Puts every optional feature back as it starts: the overlays, views, graphics quality, wells and tools.',
      category: 'Features',
      keywords: ['defaults', 'features', 'restore'],
      run: (app) => app.flags.resetDefaults(app.engine.quality === 'low'),
    }),
    A({
      id: 'graphics.quality',
      title: 'Graphics quality',
      description: 'Low, Medium or High: sets the GPU-heavy effects (photo textures, shadows and ambient occlusion, inside-the-hole effects, sea surface detail) at once. Low suits integrated GPUs, remote desktops and VMs.',
      category: 'Preferences',
      where: 'Settings › Graphics',
      keywords: ['performance', 'slow', 'gpu', 'textures', 'shadows'],
      input: z.object({ quality: z.enum(['low', 'medium', 'high']) }),
      choices: (app) => {
        const q = graphicsQuality((id) => app.flags.on(id));
        return (['low', 'medium', 'high'] as GraphicsQuality[]).map((quality) => ({ label: quality[0].toUpperCase() + quality.slice(1), input: { quality }, current: q === quality }));
      },
      run: (app, { quality }) => setGraphicsQuality(app.flags, quality),
    }),
    A({
      id: 'tools.run',
      title: 'Tool',
      description: 'Runs a command of an enabled feature (measure, snapshot, crossplot type…).',
      category: 'Features',
      where: 'View toolbar',
      input: z.object({ tool: z.string(), item: z.string().optional() }),
      choices: (app) =>
        app.tools.value.flatMap((t) =>
          t.menu
            ? t.menu.map((m) => ({ label: `${t.label}: ${m.label}`, input: { tool: t.id, item: m.id }, current: m.isSelected?.() }))
            : [{ label: t.label, input: { tool: t.id }, current: t.isActive?.() }],
        ),
      run: (app, { tool, item }) => {
        const t = app.tools.value.find((x) => x.id === tool);
        if (!t) throw new Error(`No tool "${tool}".`);
        const m = item ? t.menu?.find((x) => x.id === item) : undefined;
        if (item && !m) throw new Error(`No item "${item}" in ${t.label}.`);
        (m?.onAction ?? t.onAction)?.();
      },
    }),

    // ------------------------------------------------------------------ interpretation
    A({
      id: 'interp.set_parameter',
      title: 'Set interpretation parameter',
      description:
        `Changes a petrophysical parameter of the active well (Vsh from GR, porosity, Archie / Simandoux saturation, net pay cut-offs) and re-interprets. Allowed ranges: ${Object.entries(PARAM_RANGES)
          .map(([k, [lo, hi]]) => `${k} ${lo}–${hi}`)
          .join(', ')}; grClean stays below grShale.`,
      category: 'Interpretation',
      where: 'Interpretation',
      input: z.object({ key: z.enum(NUMERIC_PARAMS), value: z.number() }),
      prompt: {
        label: 'Parameter and value',
        placeholder: 'e.g. rw 0.05',
        parse: (t) => {
          const m = /^\s*([a-z]+)\s*[= ]\s*(-?[\d.]+)\s*$/i.exec(t);
          const key = m && NUMERIC_PARAMS.find((k) => k.toLowerCase() === m[1].toLowerCase());
          return key ? { key, value: parseFloat(m![2]) } : null;
        },
      },
      enabled: (app) => !!app.engine.activeWell.petro?.available,
      run: (app, { key, value }) => {
        const params = app.engine.activeWell.params;
        const problem = paramProblem(params, key as NumericParam, value);
        if (problem) throw new Error(problem);
        (params as unknown as Record<string, number>)[key] = value;
        app.reinterpret();
        return { key, value };
      },
    }),
    A({
      id: 'interp.export',
      title: 'Export interpreted curves (CSV)',
      description: 'Downloads Vsh, porosity, saturation and the pay flag of the active well as CSV.',
      category: 'Interpretation',
      where: 'Interpretation › Export curves',
      enabled: (app) => !!app.engine.activeWell.petro,
      run: (app) => exportCsv(app),
    }),

    // ------------------------------------------------------------------ data & dialogs
    A({
      id: 'data.import',
      title: 'Import data',
      description: 'Opens the import dialog for LAS, CSV and XLSX files.',
      category: 'Data',
      where: 'Rail › Data',
      keywords: ['upload', 'las', 'csv', 'xlsx'],
      run: (app) => app.dataOpen.set(true),
    }),
    A({
      id: 'data.production',
      title: 'Production data',
      description: 'Opens the monthly production sheet of the field.',
      category: 'Data',
      where: 'Rail › Data › Production',
      run: (app) => app.productionOpen.set(true),
    }),

    // ------------------------------------------------------------------ live data
    A({
      id: 'data.sources',
      title: 'Live data',
      description: 'Shows the live and streamed data connections: their state, rate and messages.',
      category: 'Data',
      where: 'Rail › Data › Live sources',
      keywords: ['stream', 'realtime', 'real-time', 'connections', 'sources', 'kafka', 'witsml'],
      run: (app) => app.openSources(),
    }),
    A({
      id: 'data.add_source',
      title: 'Connect a data source',
      description: 'Opens the connect dialog: files, URLs, REST polling, server-sent events, WebSocket, MQTT, or the relay (Kafka, WITSML, ETP, OSDU, TCP).',
      category: 'Data',
      where: 'Live data › Connect',
      keywords: ['connect', 'stream', 'kafka', 'mqtt', 'websocket', 'witsml', 'etp', 'osdu', 'api', 'realtime'],
      run: (app) => app.connectRequest.set({}),
    }),
    A({
      id: 'data.live_charts',
      title: 'Live charts',
      description: 'Shows the strip charts of readings arriving by time (drilling parameters, sensors).',
      category: 'Data',
      where: 'Rail › Data › Live sources',
      keywords: ['strip chart', 'realtime', 'drilling parameters', 'trend'],
      run: (app) => app.openLive(),
    }),
    A({
      id: 'data.replay',
      title: 'Replay a well live',
      description: 'Drills a Volve well again as a live feed (rig readings, MWD sensors behind the bit, surveys every stand), faster than real time. Creates a new well that grows as it is drilled.',
      category: 'Data',
      where: 'Data › Replay a well live',
      keywords: ['simulate', 'demo', 'drilling', 'realtime', 'stream'],
      input: z.object({
        well: z.string().optional().describe('Well id or name (default: the main well)'),
        speed: z.number().min(1).max(3600).default(60).describe('Simulated seconds per real second'),
        fromMd: z.number().min(0).optional().describe('Start drilling at this MD, metres (default: 600 m above TD)'),
      }),
      choices: (app) =>
        app.field.wells.filter((w) => w.lasFile && !w.extra).flatMap((w) => [60, 600].map((speed) => ({ label: `${w.name} · ${speed}× real time`, input: { well: w.id, speed }, keywords: [w.name] }))),
      run: (app, { well, speed, fromMd }) => {
        const w = well ? app.field.wells.find((x) => x.id === well || x.name === well) : app.field.primary;
        if (!w?.lasFile) throw new Error(`${w?.name ?? well} has no logs to replay.`);
        const start = fromMd ?? Math.max(300, Math.round(w.tdMD - 600));
        const id = app.hub.connect(
          {
            name: `Replay ${w.name}`,
            transport: { id: 'replay', options: { well: w.id, speed, fromMd: start } },
            steps: [
              { id: 'map', options: {} },
              { id: 'units', options: {} },
              { id: 'time-to-depth', options: { step: 0.1524, offsets: REPLAY_OFFSETS } },
            ],
          },
          undefined,
          { focus: true },
        );
        app.openSources(id);
        return { connection: id, well: `${w.name} · live`, fromMd: start, speed };
      },
    }),
    A({
      id: 'data.connect',
      title: 'Connect a source (with settings)',
      description:
        'Starts a connection from a full description: transport (id + options), format (codec id or "auto" + options), steps (transform ids + options), and where rows without a well go. Call data.plugins first for the ids and option schemas.',
      category: 'Data',
      hidden: true,
      input: z.object({
        name: z.string().min(1),
        transport: z.object({ id: z.string(), options: z.record(z.string(), z.unknown()).default({}) }),
        format: z.object({ id: z.string().default('auto'), options: z.record(z.string(), z.unknown()).default({}) }).optional(),
        steps: z.array(z.object({ id: z.string(), options: z.record(z.string(), z.unknown()).default({}) })).default([]),
        target: z.object({ mode: z.enum(['auto', 'active', 'well', 'new']), well: z.string().default('') }).optional(),
      }),
      run: (app, input) => {
        if (input.transport.id === 'file') throw new Error('Files are chosen by the person: open the connect dialog instead.');
        return { connection: app.hub.connect(input) };
      },
    }),
    A({
      id: 'data.plugins',
      title: 'Connector plugins',
      description: 'Every transport, format (codec) and step (transform) available, with the JSON Schema of its options.',
      category: 'Data',
      hidden: true,
      run: async (app) => (await app.hub.describe()).plugins,
    }),
    A({
      id: 'data.list',
      title: 'Live connections',
      description: 'Each connection: name, state, format, values received, rate, and the wells it writes to.',
      category: 'Data',
      hidden: true,
      run: (app) =>
        app.hub.connections.value.map((c) => ({
          id: c.id,
          name: c.config.name,
          transport: c.config.transport.id,
          status: c.paused ? 'paused' : c.status,
          detail: c.detail,
          format: c.codec,
          values: c.stats?.samples ?? 0,
          valuesPerSecond: c.rate[c.rate.length - 1] ?? 0,
          wells: c.wells.map((id) => app.field.wells.find((w) => w.id === id)?.name ?? id),
          lastMessages: c.log.slice(-5).map((l) => `${l.level}: ${l.text}`),
        })),
    }),
    ...(
      [
        [
          'pause',
          'Pause a connection',
          'Holds a connection’s data (what arrives meanwhile is kept and delivered on resume).',
          (c: ConnectionState) => c.status !== 'stopped' && !c.paused,
          (app: App, id: string) => app.hub.pause(id, true),
        ],
        [
          'resume',
          'Resume a connection',
          'Resumes a paused connection, or starts a stopped one.',
          (c: ConnectionState) => c.paused || c.status === 'stopped' || c.status === 'error',
          (app: App, id: string) => (app.hub.get(id)?.paused ? app.hub.pause(id, false) : app.hub.resume(id)),
        ],
        ['stop', 'Stop a connection', 'Disconnects; the data already received stays.', (c: ConnectionState) => c.status !== 'stopped', (app: App, id: string) => app.hub.stop(id)],
        ['remove', 'Remove a connection', 'Disconnects and forgets the connection (the data already received stays in its wells).', () => true, (app: App, id: string) => app.hub.remove(id)],
      ] as const
    ).map(([verb, title, description, when, act]) =>
      A({
        id: `data.${verb}`,
        title,
        description,
        category: 'Data',
        where: 'Live data › connection ⋯',
        needsApproval: verb === 'remove',
        input: z.object({ id: z.string().describe('Connection id (see data.list)') }),
        enabled: (app) => app.hub.connections.value.some(when),
        choices: (app) => app.hub.connections.value.filter(when).map((c) => ({ label: c.config.name, input: { id: c.id } })),
        run: (app, { id }) => {
          if (!app.hub.get(id)) throw new Error(`No connection "${id}".`);
          act(app, id);
          return { id, status: app.hub.get(id)?.status ?? 'removed' };
        },
      }),
    ),
    A({
      id: 'data.follow_bit',
      title: 'Follow the bit',
      description: 'While a well is being drilled, keep the view and the log tracks at the bottom of the hole.',
      category: 'Data',
      where: 'Live data › Follow the bit',
      input: z.object({ on: z.boolean() }),
      choices: (app) => [
        { label: 'On', input: { on: true }, current: app.hub.followBit.value },
        { label: 'Off', input: { on: false }, current: !app.hub.followBit.value },
      ],
      run: (app, { on }) => app.hub.followBit.set(on),
    }),

    // ------------------------------------------------------------------ preferences
    A({
      id: 'prefs.theme',
      title: 'Theme',
      description: 'Dark, light, or follow the system setting.',
      category: 'Preferences',
      where: 'Settings',
      keywords: ['dark mode', 'light mode', 'appearance'],
      input: z.object({ theme: z.enum(['dark', 'light', 'system']) }),
      choices: () => (['dark', 'light', 'system'] as Theme[]).map((theme) => ({ label: theme[0].toUpperCase() + theme.slice(1), input: { theme }, current: prefs.value.theme === theme })),
      run: (_app, { theme }) => setPrefs({ theme }),
    }),
    A({
      id: 'prefs.density',
      title: 'Density',
      description: 'The size of text and controls.',
      category: 'Preferences',
      where: 'Settings',
      input: z.object({ density: z.enum(['compact', 'default', 'comfortable']) }),
      choices: () =>
        (['compact', 'default', 'comfortable'] as Density[]).map((density) => ({ label: density[0].toUpperCase() + density.slice(1), input: { density }, current: prefs.value.density === density })),
      run: (_app, { density }) => setPrefs({ density }),
    }),
    A({
      id: 'prefs.accent',
      title: 'Accent colour',
      description: 'The colour of the cursor, playhead and selections.',
      category: 'Preferences',
      where: 'Settings',
      input: z.object({ accent: z.enum(ACCENTS.map((a) => a.id) as [Accent, ...Accent[]]) }),
      choices: () => ACCENTS.map((a) => ({ label: a.label, input: { accent: a.id }, current: prefs.value.accent === a.id })),
      run: (_app, { accent }) => setPrefs({ accent }),
    }),
    A({
      id: 'prefs.task_bar',
      title: 'Task bar for the selection',
      description: 'Shows or hides the small bar of likely next steps that appears next to the selected object in the 3D view.',
      category: 'Preferences',
      where: 'Settings › 3D view',
      keywords: ['contextual', 'next step', 'selection', 'toolbar'],
      input: z.object({ on: z.boolean() }),
      choices: () => [
        { label: 'Show', input: { on: true }, current: prefs.value.taskBar },
        { label: 'Hide', input: { on: false }, current: !prefs.value.taskBar },
      ],
      run: (_app, { on }) => setPrefs({ taskBar: on }),
    }),
    A({
      id: 'prefs.open',
      title: 'Settings…',
      description: 'Opens Settings: theme, density, accent, panel glass, labels, graphics quality, motion.',
      keywords: ['personalise', 'preferences', 'graphics', 'quality'],
      category: 'Preferences',
      where: 'Rail › Settings',
      run: (app) => app.personaliseOpen.set(true),
    }),
    A({
      id: 'logs.tracks',
      title: 'Edit log tracks',
      description: 'Opens the track editor of the Well logs panel: show, hide, reorder and add tracks, and set their scales and colours.',
      category: 'Panels',
      where: 'Well logs › Tracks',
      keywords: ['tracks', 'curves', 'scales', 'log layout', 'template'],
      run: (app) => {
        withTransition(() => app.workspace.open('logs'));
        app.tracksOpen.set(true);
      },
    }),
    A({
      id: 'help.open',
      title: 'Controls and data notes',
      description: 'Opens the help: keys, mouse controls and where the data comes from.',
      category: 'Help',
      where: 'Rail › Help',
      keywords: ['help', 'shortcuts', 'keys', 'keyboard', 'mouse', 'controls', 'sources', 'licence'],
      shortcut: '?',
      run: (app) => app.helpOpen.set(true),
    }),
    A({
      id: 'app.fullscreen',
      title: 'Full screen',
      description: 'Enters or leaves full screen.',
      category: 'View',
      where: 'Top bar › Full screen',
      run: () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()),
    }),

    // ------------------------------------------------------------------ assistant
    ...assistantActions(),
  ];
}
