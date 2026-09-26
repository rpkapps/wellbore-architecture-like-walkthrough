import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { ColorSwatch } from '@tecton/react/tecton/color-swatch';
import { TreeView, TreeViewAction, TreeViewItem, TreeViewItemContent, TreeViewVisibilityToggle } from '@tecton/react/tecton/tree-view';
import { LayersIcon } from 'lucide-react';
import { memo, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import { FORMATION_BY_ID, MODEL_HORIZONS } from '../../data/stratigraphy';
import { featuresAt, labelOf, type FeatureId } from '../../features/registry';
import type { App, LayerPreset, SceneDisplay, WellboreDisplay } from '../app';
import { SliderField, SwitchField } from '../controls';
import { useFlags } from '../flags';
import { ProvBadge } from '../prov';
import { PanelAccordion, PanelSection } from '../section';
import { ScrubChip } from '../scrub';
import type { Selection } from '../selection';
import { useRev, useSignal, useSignalPart } from '../signal';
import { SelectionActionsButton } from './SelectionMenu';
import { SectionBoxEditor } from '../viz/SectionBoxEditor';
import { ColormapPicker } from '../viz/ColormapPicker';
import { Tip } from '../icon-button';

/** Folder rows: they open and close, and are never the selection. */
const FOLDERS = ['formations', 'wells', 'wellbore', 'overlays', 'scene'];
/** Layer rows that are scene options, selected as overlays (their Properties is a visibility switch and a note). */
const LAYERS = new Set(['casing', 'fractures', 'markers', 'labels', 'otherWells', 'sea', 'contours']);
/**
 * The Overlays folder: optional features drawn in 3D (log curtain, oil–water
 * contact, uncertainty cones, the geosteering band). The eye switches the
 * feature, so a hidden overlay computes nothing; selected, its settings show
 * in Properties (`FeatureModule.settings`).
 */
const OVERLAYS: FeatureId[] = featuresAt('overlay').map((f) => f.id);
const OVERLAY_SET = new Set<string>(OVERLAYS);

/** The selection a tree row stands for (its key: a formation id, `well:<id>`, a layer or an overlay feature id). */
function selectionOfKey(key: string): Selection | null {
  if (FORMATION_BY_ID.has(key)) return { kind: 'formation', id: key };
  if (key.startsWith('well:')) return { kind: 'well', id: key.slice(5) };
  if (LAYERS.has(key) || OVERLAY_SET.has(key)) return { kind: 'overlay', id: key };
  return null;
}

/** The row a selection highlights (a point on a well highlights the well, the contact plane its overlay). */
function keyOfSelection(sel: Selection | null): string | null {
  if (!sel) return null;
  if (sel.kind === 'formation') return sel.id;
  if (sel.kind === 'well') return `well:${sel.id}`;
  if (sel.kind === 'overlay' && LAYERS.has(sel.id)) return sel.id;
  if ((sel.kind === 'overlay' || sel.kind === 'contact') && OVERLAY_SET.has(sel.id)) return sel.id;
  return null;
}

/** Right click on a row: select it and open its menu of actions. */
function rowMenu(app: App, e: MouseEvent) {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-sel-key]');
  const sel = row?.dataset.selKey ? selectionOfKey(row.dataset.selKey) : null;
  if (!sel) return;
  e.preventDefault();
  app.openContextMenu(sel, e.clientX, e.clientY);
}

const PRESETS: [LayerPreset, string][] = [
  ['default', 'Glass overburden'],
  ['solid', 'Solid'],
  ['reservoir', 'Reservoir focus'],
  ['pay', 'Isolate pay'],
];

/**
 * Layers of the scene as a tree, then the section box, near-well and display
 * settings. A click on a row selects it (Properties shows it), a double click
 * opens a well or brings up Properties, a right click opens its actions.
 */
export function ScenePanel({ app }: { app: App }) {
  return (
    // tree rows are React Aria tree items, which take no context-menu trigger of their own: one handler finds the row
    <div className="flex flex-col" onContextMenu={(e) => rowMenu(app, e)}>
      <Layers app={app} />
      <PanelAccordion defaultExpandedKeys={['box']}>
        <PanelSection id="box" title="Section box">
          <SectionBoxControls app={app} />
        </PanelSection>
        <PanelSection id="wellbore" title="Near-well geometry">
          <WellboreControls app={app} />
        </PanelSection>
        <PanelSection id="display" title="Display">
          <DisplayControls app={app} />
        </PanelSection>
      </PanelAccordion>
    </div>
  );
}

function Layers({ app }: { app: App }) {
  useRev(app.sceneRev);
  const selected = keyOfSelection(useSignal(app.selection));
  // the wells folder follows which well is open
  const activeWell = useSignalPart(app.wellRev, () => app.engine.activeWell.id);
  const overlays = useFlags(app.flags, OVERLAYS);
  const geo = app.engine.geology;
  const wb = app.wellbore;
  const d = app.display;
  const toggle = (label: string, visible: boolean, onChange: (v: boolean) => void) => (
    <Tip label={visible ? 'Hide' : 'Show'}>
      <TreeViewVisibilityToggle aria-label={`${visible ? 'Hide' : 'Show'} ${label}`} isVisible={visible} onChange={onChange} />
    </Tip>
  );
  // a folder's eye: shows everything in it when anything is hidden, otherwise hides it all
  const groupToggle = (what: string, states: boolean[], set: (v: boolean) => void) => {
    const all = states.every(Boolean);
    const some = states.some(Boolean);
    return (
      <Tip label={all ? 'Hide all' : 'Show all'}>
        <TreeViewVisibilityToggle aria-label={`${all ? 'Hide' : 'Show'} ${what}`} isVisible={all} onChange={() => set(!all)} className={some && !all ? 'text-fg-2' : undefined} />
      </Tip>
    );
  };
  const leaf = (id: string, label: string, visible: boolean, onChange: (v: boolean) => void, suffix?: ReactNode) => (
    <TreeViewItem key={id} id={id} textValue={label} isHidden={!visible} data-sel-key={id}>
      <TreeViewItemContent suffix={suffix} endAdornment={toggle(label, visible, onChange)}>
        {label}
      </TreeViewItemContent>
    </TreeViewItem>
  );
  return (
    <TreeView
      aria-label="Scene layers"
      defaultExpandedKeys={['formations', 'overlays']}
      className="p-1"
      selectionMode="single"
      selectionBehavior="replace"
      selectedKeys={selected ? [selected] : []}
      disabledKeys={FOLDERS}
      disabledBehavior="selection"
      onSelectionChange={(keys) => {
        if (keys === 'all') return;
        const k = [...keys][0];
        if (k === undefined) return app.select(null);
        const sel = selectionOfKey(String(k));
        if (sel) app.select(sel);
      }}
      onAction={(key: Key) => {
        const sel = selectionOfKey(String(key));
        if (!sel) return;
        // a double click (or Enter) opens a well, and brings up the Properties of anything else
        if (sel.kind === 'well' && sel.id !== activeWell && app.selectableWells().some((w) => w.id === sel.id)) void app.actions.run('nav.select_well', { id: sel.id });
        else void app.actions.run('selection.properties', { selection: sel });
      }}
    >
      <TreeViewItem id="formations" textValue="Formations">
        <TreeViewItemContent
          kind="folder"
          suffix={<ProvBadge prov="interpreted">Picks model</ProvBadge>}
          endAdornment={
            <>
              {groupToggle(
                'every formation',
                MODEL_HORIZONS.map((id) => geo.state.get(id)!.visible),
                (v) => MODEL_HORIZONS.forEach((id) => app.setLayer(id, { visible: v })),
              )}
              <PresetMenu app={app} />
            </>
          }
        >
          Formations
        </TreeViewItemContent>
        {MODEL_HORIZONS.map((id) => {
          const f = FORMATION_BY_ID.get(id)!;
          const st = geo.state.get(id)!;
          return (
            <TreeViewItem
              key={id}
              id={id}
              textValue={f.name}
              isHidden={!st.visible}
              data-sel-key={id}
              onHoverStart={() => (geo.setHighlight(id), app.engine.requestRender())}
              onHoverEnd={() => (geo.setHighlight(null), app.engine.requestRender())}
            >
              <FormationRow app={app} id={id} visible={st.visible} opacity={st.opacity} color={f.color} />
            </TreeViewItem>
          );
        })}
      </TreeViewItem>
      <TreeViewItem id="wells" textValue="Wells">
        <TreeViewItemContent kind="folder">Wells</TreeViewItemContent>
        {app.selectableWells().map((w) => (
          <TreeViewItem key={w.id} id={`well:${w.id}`} textValue={w.name} data-sel-key={`well:${w.id}`}>
            <WellRow app={app} id={w.id} name={w.name} active={w.id === activeWell} />
          </TreeViewItem>
        ))}
      </TreeViewItem>
      <TreeViewItem id="wellbore" textValue="Wellbore">
        <TreeViewItemContent
          kind="folder"
          endAdornment={groupToggle('the near-well geometry', [wb.casing, wb.fractures, wb.markers], (v) => app.setWellboreDisplay({ casing: v, fractures: v, markers: v }))}
        >
          Wellbore
        </TreeViewItemContent>
        {leaf('casing', 'Casing & cement', wb.casing, (v) => app.setWellboreDisplay({ casing: v }))}
        {leaf('fractures', 'Natural fractures', wb.fractures, (v) => app.setWellboreDisplay({ fractures: v }), <ProvBadge prov="schematic" />)}
        {leaf('markers', 'Tops & depth marks', wb.markers, (v) => app.setWellboreDisplay({ markers: v }))}
      </TreeViewItem>
      <TreeViewItem id="overlays" textValue="Overlays">
        <TreeViewItemContent kind="folder" endAdornment={groupToggle('every overlay', overlays, (v) => OVERLAYS.forEach((id) => app.flags.set(id, v)))}>
          Overlays
        </TreeViewItemContent>
        {OVERLAYS.map((id, i) => leaf(id, labelOf(id), overlays[i], (v) => app.flags.set(id, v)))}
      </TreeViewItem>
      <TreeViewItem id="scene" textValue="Scene">
        <TreeViewItemContent
          kind="folder"
          endAdornment={groupToggle('the scene layers', [d.labels, d.otherWells, d.sea, d.contours], (v) => app.setDisplay({ labels: v, otherWells: v, sea: v, contours: v }))}
        >
          Scene
        </TreeViewItemContent>
        {leaf('labels', 'Labels', d.labels, (v) => app.setDisplay({ labels: v }))}
        {leaf('otherWells', 'Other Volve wellbores', d.otherWells, (v) => app.setDisplay({ otherWells: v }))}
        {leaf('sea', 'Sea, water column & platform', d.sea, (v) => app.setDisplay({ sea: v }))}
        {leaf('contours', 'Structural contours (25 m)', d.contours, (v) => app.setDisplay({ contours: v }))}
      </TreeViewItem>
    </TreeView>
  );
}

/** A wellbore of the field: the open one is marked; its actions open it or show its properties. */
const WellRow = memo(function WellRow({ app, id, name, active }: { app: App; id: string; name: string; active: boolean }) {
  return (
    <TreeViewItemContent
      suffix={active ? <Badge variant="outline">open</Badge> : undefined}
      endAdornment={
        <SelectionActionsButton app={app} selection={{ kind: 'well', id }} label={`${name} actions`}>
          <TreeViewAction aria-label={`${name} actions`} />
        </SelectionActionsButton>
      }
    >
      {name}
    </TreeViewItemContent>
  );
});

/**
 * A formation's row. Memoised on what it shows, so scrubbing one layer's
 * opacity (a scene change every frame) renders that row, not the whole tree.
 */
const FormationRow = memo(function FormationRow({ app, id, visible, opacity, color }: { app: App; id: string; visible: boolean; opacity: number; color: string }) {
  const f = FORMATION_BY_ID.get(id)!;
  return (
    <TreeViewItemContent
      icon={
        <span className="flex" title="Change colour" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <ColorSwatch color={color} size="xs" shape="square" aria-label={`${f.name} colour: click to change`} onChange={(hex) => app.setFormationColor(id, hex)} />
        </span>
      }
      suffix={
        <span className="flex items-center gap-1.5">
          {f.reservoir && <span title="Reservoir" aria-label="Reservoir" role="img" className="size-1.5 rounded-full bg-saffron-560 shadow-[0_0_6px_var(--tecton-palette-saffron-560)]" />}
          <ScrubChip label={`${f.name} opacity`} value={Math.round(opacity * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => app.setLayer(id, { opacity: v / 100 })} />
        </span>
      }
      endAdornment={
        <>
          <Tip label={visible ? 'Hide' : 'Show'}>
            <TreeViewVisibilityToggle aria-label={`${visible ? 'Hide' : 'Show'} ${f.name}`} isVisible={visible} onChange={(v) => app.setLayer(id, { visible: v })} />
          </Tip>
          {/* the same actions as the row's right-click menu */}
          <SelectionActionsButton app={app} selection={{ kind: 'formation', id }} label={`${f.name} actions`}>
            <TreeViewAction aria-label={`${f.name} actions`} />
          </SelectionActionsButton>
        </>
      }
    >
      {f.name}
    </TreeViewItemContent>
  );
});

function PresetMenu({ app }: { app: App }) {
  return (
    <DropdownMenuTrigger>
      <Tip label="Layer presets">
        <TreeViewAction aria-label="Layer presets">
          <LayersIcon />
        </TreeViewAction>
      </Tip>
      <DropdownMenu placement="bottom end" className="w-max min-w-44" onAction={(k) => app.preset(k as LayerPreset)}>
        <DropdownMenuLabel>Presets</DropdownMenuLabel>
        {PRESETS.map(([id, label]) => (
          <DropdownMenuItem key={id} id={id}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

function SectionBoxControls({ app }: { app: App }) {
  const fb = app.engine.geology.fullBox;
  return (
    <div className="flex flex-col gap-2">
      <div className="-ml-2 flex flex-wrap gap-0.5">
        <Button variant="ghost" size="xs" onPress={() => app.setBox({ ...fb }, true)}>
          Full
        </Button>
        <Button variant="ghost" size="xs" onPress={() => app.sectionAlongWell()}>
          Cut at well
        </Button>
        <Button variant="ghost" size="xs" onPress={() => app.setBox({ stripTo: 2750 }, true)}>
          Reservoir window
        </Button>
      </div>
      <SectionBoxEditor app={app} />
    </div>
  );
}

function WellboreControls({ app }: { app: App }) {
  useRev(app.sceneRev, app.viewRev);
  const d: WellboreDisplay = app.wellbore;
  return (
    <div className="flex flex-col gap-1">
      <SliderField label="Radial exaggeration" value={app.engine.radialScale} minValue={1} maxValue={60} step={1} format={(v) => `×${v}`} onChange={(v) => app.setRadialScale(v)} />
      <SliderField
        label="Casing transparency"
        value={d.casingOpacity}
        minValue={0}
        maxValue={1}
        step={0.01}
        format={(v) => `${Math.round((1 - v) * 100)}%`}
        onChange={(v) => app.setWellboreDisplay({ casingOpacity: v })}
      />
      <SliderField
        label="Borehole wall opacity"
        value={d.wallOpacity}
        minValue={0.05}
        maxValue={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => app.setWellboreDisplay({ wallOpacity: v })}
      />
      <SliderField
        label="Halo / fluid intensity"
        value={d.shellOpacity}
        minValue={0}
        maxValue={2}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => app.setWellboreDisplay({ shellOpacity: v })}
      />
    </div>
  );
}

function DisplayControls({ app }: { app: App }) {
  useRev(app.sceneRev, app.viewRev);
  const [textures, setTextures] = useState(() => app.flags.on('textures'));
  // mirrors Settings › Graphics › Textures so it can be flipped right next to the view
  useEffect(() => app.flags.watch('textures', setTextures), [app]);
  const s: SceneDisplay = app.display;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-7 items-center gap-3">
        <span className="type-label shrink-0">Resistivity colours</span>
        <div className="min-w-0 flex-1">
          <ColormapPicker app={app} size="sm" />
        </div>
      </div>
      <SwitchField label="Glow & colour grade" isSelected={s.postFx} onChange={(v) => app.setDisplay({ postFx: v })} />
      <SwitchField label="Realistic textures" isSelected={textures} onChange={(v) => app.flags.set('textures', v)} />
    </div>
  );
}
