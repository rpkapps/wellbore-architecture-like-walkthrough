import { z } from 'zod';
import { COLORMAPS, type ColormapName } from '../data/colormap';
import { DEFAULT_PARAMS, type PetroParams } from '../data/petro';
import { FORMATION_BY_ID, MODEL_HORIZONS } from '../data/stratigraphy';
import { FEATURES, type FeatureId } from '../features/registry';
import type { App } from '../ui/app';
import type { ConnectionState } from '../connect/hub';
import { REPLAY_OFFSETS } from '../connect/offsets';
import { ACCENTS, prefs, setAllOverlays, setPrefs, type Accent, type Density, type Theme } from '../ui/prefs';
import { exportCsv } from '../ui/shell/InterpretationPanel';
import { toolWindows } from '../ui/toolWindow';
import { withTransition } from '../ui/transition';
import { PRESETS, type PresetId } from '../ui/workspace/layout';
import { describeLocation } from '../ui/workspace/where';
import { defineAction, type Action, type AnyAction } from './registry';

/*
 * The app's actions. Each wraps a call the UI already makes, so a command
 * from the palette, a key, a button or (later) an assistant does exactly the
 * same thing. Inputs are objects (tool calls always send one); enumerations
 * list their values so a model can pick without guessing.
 */

const PROPERTY_MODES = ['resistivity', 'hydrocarbon', 'lithology', 'rop'] as const;
const MODE_LABEL: Record<(typeof PROPERTY_MODES)[number], string> = { resistivity: 'Resistivity', hydrocarbon: 'Hydrocarbons', lithology: 'Lithology', rop: 'Drilling speed (ROP)' };
const BUILTIN_PANELS = { scene: 'Scene', interpretation: 'Interpretation', features: 'Features', logs: 'Well logs', sources: 'Live data', live: 'Live charts' } as const;
const FEATURE_IDS = FEATURES.map((f) => f.id) as [FeatureId, ...FeatureId[]];
const FORMATIONS = MODEL_HORIZONS as unknown as [string, ...string[]];
const formationName = (id: string) => FORMATION_BY_ID.get(id)?.name ?? id;
const NUMERIC_PARAMS = (Object.keys(DEFAULT_PARAMS) as (keyof PetroParams)[]).filter((k) => typeof DEFAULT_PARAMS[k] === 'number') as [string, ...string[]];

/**
 * The features that bring a tool window, by its panel id: its title, and words
 * people search for it by. Listed as panels even while the feature is off.
 */
const FEATURE_WINDOWS: Partial<Record<FeatureId, { title: string; keywords: string[] }>> = {
  geosteer: { title: 'Geosteering', keywords: ['distance to boundary', 'dtb', 'target', 'landing'] },
  section: { title: 'Section along the well', keywords: ['cross-section', 'profile'] },
  correlation: { title: 'Well correlation', keywords: ['tops', 'flatten', 'side by side'] },
  crossplot: { title: 'Crossplot', keywords: ['porosity', 'density', 'neutron', 'rhob', 'nphi', 'pickett', 'buckles', 'scatter'] },
  mapview: { title: 'Map', keywords: ['plan view', 'top view'] },
  simulation: { title: 'Reservoir simulation', keywords: ['eclipse', 'pressure', 'saturation', 'grid'] },
  views: { title: 'Saved views', keywords: ['bookmarks', 'presentation', 'camera'] },
};

type PanelPlace = { id: string; title: string; location: string; about?: string; keywords?: string[] };

/**
 * Every panel there is, with where it is now in words ("Left column · tab 2",
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

/** Every panel that can be shown now: the built-in ones and the open features' tool windows. */
function panelIds(): Record<string, string> {
  const out: Record<string, string> = { ...BUILTIN_PANELS };
  for (const w of toolWindows.value) out[w.opts.id] = w.opts.title;
  return out;
}

export function appActions(): AnyAction<App>[] {
  const A = <S extends z.ZodType = z.ZodUndefined>(a: Action<S, App>) => defineAction<App, S>(a);
  return [
    // ------------------------------------------------------------------ reading
    A({
      id: 'app.state',
      title: 'What the app is showing',
      description: 'The active well, the camera position along it, the colouring, open panels and features on. Read this before acting.',
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
        if (mode === 'rop' && !app.optionalModes.value.has('rop')) throw new Error('Turn on the “Drilling speed (ROP) mode” feature first.');
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
      run: (app, d) => app.setDisplay(d),
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
      run: (app, { formation, visible, opacity }) => app.setLayer(formation, { visible, opacity }),
    }),
    A({
      id: 'scene.isolate',
      title: 'Isolate formation',
      description: 'Fades every other formation to a ghost so one stands alone; without a formation, shows them all again.',
      category: 'Scene',
      where: 'Scene › Layers › formation ⋯',
      input: z.object({ formation: z.enum(FORMATIONS).nullable() }),
      choices: (app) => [
        ...(app.engine.geology.isolatedId ? [{ label: 'Show all formations', input: { formation: null } }] : []),
        ...MODEL_HORIZONS.map((id) => ({ label: formationName(id), input: { formation: id }, current: app.engine.geology.isolatedId === id })),
      ],
      run: (app, { formation }) => app.isolate(formation),
    }),
    A({
      id: 'scene.inspect',
      title: 'Show formation details',
      description: 'Opens the details card of a formation (age, lithology, depths, pay in the active well).',
      category: 'Scene',
      where: 'Scene › Layers › formation ⋯',
      input: z.object({ formation: z.enum(FORMATIONS) }),
      choices: () => MODEL_HORIZONS.map((id) => ({ label: formationName(id), input: { formation: id } })),
      run: (app, { formation }) => app.inspectFormation(formation),
    }),

    // ------------------------------------------------------------------ panels & workspace
    A({
      id: 'panels.show',
      title: 'Show panel',
      description: 'Opens a panel (or brings it to the front) where it was last docked.',
      category: 'Panels',
      where: 'Top bar › Window',
      input: z.object({ panel: z.string().meta({ description: 'Panel id, from the choices' }) }),
      choices: (app) => Object.entries(panelIds()).map(([panel, label]) => ({ label, input: { panel }, current: app.workspace.isShown(panel) })),
      run: (app, { panel }) => {
        const tool = toolWindows.value.find((w) => w.opts.id === panel);
        if (tool) tool.show();
        else if (panel in BUILTIN_PANELS) withTransition(() => app.workspace.open(panel));
        else throw new Error(`No panel "${panel}" (is its feature on?).`);
      },
    }),
    A({
      id: 'panels.reveal',
      title: 'Go to panel',
      description: 'Says where a panel is (its column and tab, floating, or hidden) and brings it into view: unfolds its column, brings its tab to the front, and turns its feature on if needed.',
      category: 'Panels',
      where: 'Top bar › Window',
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
        if (feature) app.flags.set(panel as FeatureId, true);
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
      id: 'panels.hide_all',
      title: 'Hide / show all panels',
      description: 'Clears every panel off the 3D view, or brings them back.',
      category: 'Panels',
      where: 'Top bar › Window',
      shortcut: 'Tab',
      run: (app) => withTransition(() => app.workspace.hidden.set(!app.workspace.hidden.value)),
    }),
    A({
      id: 'panels.overlays',
      title: 'Overlays',
      description: 'Collapses the cards over the 3D view (colour key, chapter card) to one-line chips, or expands them.',
      category: 'Panels',
      where: 'Personalise › Overlays',
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
      description: 'Arranges the panels for a task, or as a saved workspace.',
      category: 'Workspace',
      where: 'Top bar › Workspace',
      input: z.object({ id: z.string().meta({ description: 'A built-in layout (walkthrough, petrophysics, geosteering) or a saved workspace id' }) }),
      choices: (app) => [
        ...PRESETS.map((p) => ({ label: p.label, input: { id: p.id }, current: app.workspace.current.value === p.id })),
        ...app.workspace.saved.value.map((w) => ({ label: w.name, input: { id: w.id }, current: app.workspace.current.value === w.id })),
      ],
      run: (app, { id }) => {
        const has = (p: string) => p in panelIds();
        if (PRESETS.some((p) => p.id === id)) withTransition(() => app.workspace.preset(id as PresetId, has));
        else if (app.workspace.saved.value.some((w) => w.id === id)) withTransition(() => app.workspace.load(id, has));
        else throw new Error(`No workspace "${id}".`);
      },
    }),
    A({
      id: 'workspace.save',
      title: 'Save workspace as',
      description: 'Saves the current panel layout under a name (a name in use is replaced).',
      category: 'Workspace',
      where: 'Top bar › Workspace',
      input: z.object({ name: z.string().min(1).max(60) }),
      prompt: { label: 'Workspace name', placeholder: 'e.g. Logs review', parse: (t) => (t.trim() ? { name: t.trim() } : null) },
      run: (app, { name }) => ({ id: app.workspace.saveAs(name) }),
    }),
    A({
      id: 'workspace.delete',
      title: 'Delete saved workspace',
      description: 'Removes one of your saved workspaces.',
      category: 'Workspace',
      where: 'Top bar › Workspace',
      needsApproval: true,
      input: z.object({ id: z.string() }),
      choices: (app) => app.workspace.saved.value.map((w) => ({ label: w.name, input: { id: w.id } })),
      run: (app, { id }) => app.workspace.remove(id),
    }),

    // ------------------------------------------------------------------ features
    A({
      id: 'features.set',
      title: 'Feature',
      description: 'Turns an optional feature (geosteering, cross-section, crossplots, simulation…) on or off.',
      category: 'Features',
      where: 'Features',
      input: z.object({ feature: z.enum(FEATURE_IDS), on: z.boolean() }),
      choices: (app) => FEATURES.map((f) => ({ label: `${app.flags.on(f.id) ? 'Turn off' : 'Turn on'} ${f.name}`, input: { feature: f.id, on: !app.flags.on(f.id) }, keywords: [f.group], description: f.desc })),
      run: (app, { feature, on }) => app.flags.set(feature, on),
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
        'Changes a petrophysical parameter of the active well (Vsh from GR, porosity, Archie / Simandoux saturation, net pay cut-offs) and re-interprets. Keys: grClean, grShale, rhoMa, rhoFl, a, m, n, rw, rwTemp, rsh, cutVsh, cutPhi, cutSw.',
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
        (app.engine.activeWell.params as unknown as Record<string, number>)[key] = value;
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
      where: 'Top bar › Data',
      keywords: ['upload', 'las', 'csv', 'xlsx'],
      run: (app) => app.dataOpen.set(true),
    }),
    A({
      id: 'data.production',
      title: 'Production data',
      description: 'Opens the monthly production sheet of the field.',
      category: 'Data',
      where: 'Top bar › Production',
      run: (app) => app.productionOpen.set(true),
    }),

    // ------------------------------------------------------------------ live data
    A({
      id: 'data.sources',
      title: 'Live data',
      description: 'Shows the live and streamed data connections: their state, rate and messages.',
      category: 'Data',
      where: 'Top bar › Live data',
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
      where: 'Top bar › Live data',
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
      where: 'Personalise',
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
      where: 'Personalise',
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
      where: 'Personalise',
      input: z.object({ accent: z.enum(ACCENTS.map((a) => a.id) as [Accent, ...Accent[]]) }),
      choices: () => ACCENTS.map((a) => ({ label: a.label, input: { accent: a.id }, current: prefs.value.accent === a.id })),
      run: (_app, { accent }) => setPrefs({ accent }),
    }),
    A({
      id: 'prefs.open',
      title: 'Personalise…',
      description: 'Opens the personalisation dialog (theme, density, accent, panel glass, labels, motion).',
      category: 'Preferences',
      where: 'Top bar › Personalise',
      run: (app) => app.personaliseOpen.set(true),
    }),
    A({
      id: 'help.open',
      title: 'Controls and data notes',
      description: 'Opens the help: keys, mouse controls and where the data comes from.',
      category: 'Help',
      where: 'Top bar › Help',
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
  ];
}
