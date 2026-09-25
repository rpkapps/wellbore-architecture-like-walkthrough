import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { ColorSwatch } from '@tecton/react/tecton/color-swatch';
import { TreeView, TreeViewAction, TreeViewItem, TreeViewItemContent, TreeViewVisibilityToggle } from '@tecton/react/tecton/tree-view';
import { LayersIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import { COLORMAPS } from '../../data/colormap';
import { FORMATION_BY_ID, MODEL_HORIZONS } from '../../data/stratigraphy';
import type { App, LayerPreset, SceneDisplay, WellboreDisplay } from '../app';
import { SelectField, SliderField, SwitchField } from '../controls';
import { ProvBadge } from '../prov';
import { PanelAccordion, PanelSection } from '../section';
import { useRev } from '../signal';
import { SectionBoxEditor } from '../viz/SectionBoxEditor';

const OPACITY = [1, 0.75, 0.5, 0.25, 0.1];
const PRESETS: [LayerPreset, string][] = [
  ['default', 'Glass overburden'],
  ['solid', 'Solid'],
  ['reservoir', 'Reservoir focus'],
  ['pay', 'Isolate pay'],
];

/** Layers of the scene as a tree, then the section box, near-well and display settings. */
export function ScenePanel({ app }: { app: App }) {
  return (
    <div className="flex flex-col">
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
  const geo = app.engine.geology;
  const wb = app.wellbore;
  const d = app.display;
  const toggle = (label: string, visible: boolean, onChange: (v: boolean) => void) => (
    <TreeViewVisibilityToggle aria-label={`${visible ? 'Hide' : 'Show'} ${label}`} isVisible={visible} onChange={onChange} />
  );
  const leaf = (id: string, label: string, visible: boolean, onChange: (v: boolean) => void, suffix?: ReactNode) => (
    <TreeViewItem id={id} textValue={label} isHidden={!visible}>
      <TreeViewItemContent suffix={suffix} endAdornment={toggle(label, visible, onChange)}>
        {label}
      </TreeViewItemContent>
    </TreeViewItem>
  );
  return (
    <TreeView
      aria-label="Scene layers"
      defaultExpandedKeys={['formations']}
      className="p-1"
      onAction={(key: Key) => {
        if (FORMATION_BY_ID.has(String(key))) app.inspectFormation(String(key));
      }}
    >
      <TreeViewItem id="formations" textValue="Formations">
        <TreeViewItemContent kind="folder" suffix={<ProvBadge prov="interpreted">Picks model</ProvBadge>} endAdornment={<PresetMenu app={app} />}>
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
              onHoverStart={() => (geo.setHighlight(id), app.engine.requestRender())}
              onHoverEnd={() => (geo.setHighlight(null), app.engine.requestRender())}
            >
              <TreeViewItemContent
                icon={<ColorSwatch color={f.color} size="xs" shape="square" aria-label={`${f.name} colour`} />}
                suffix={f.reservoir ? <Badge variant="warning">Reservoir</Badge> : <span className="font-mono text-xs text-muted-foreground">{Math.round(st.opacity * 100)}%</span>}
                endAdornment={
                  <>
                    {toggle(f.name, st.visible, (v) => app.setLayer(id, { visible: v }))}
                    <LayerMenu app={app} id={id} name={f.name} opacity={st.opacity} />
                  </>
                }
              >
                {f.name}
              </TreeViewItemContent>
            </TreeViewItem>
          );
        })}
      </TreeViewItem>
      <TreeViewItem id="wellbore" textValue="Wellbore">
        <TreeViewItemContent kind="folder">Wellbore</TreeViewItemContent>
        {leaf('casing', 'Casing & cement', wb.casing, (v) => app.setWellboreDisplay({ casing: v }))}
        {leaf('fractures', 'Natural fractures', wb.fractures, (v) => app.setWellboreDisplay({ fractures: v }), <ProvBadge prov="schematic" />)}
        {leaf('markers', 'Tops & depth marks', wb.markers, (v) => app.setWellboreDisplay({ markers: v }))}
      </TreeViewItem>
      <TreeViewItem id="scene" textValue="Scene">
        <TreeViewItemContent kind="folder">Scene</TreeViewItemContent>
        {leaf('labels', 'Labels', d.labels, (v) => app.setDisplay({ labels: v }))}
        {leaf('otherWells', 'Other Volve wellbores', d.otherWells, (v) => app.setDisplay({ otherWells: v }))}
        {leaf('sea', 'Sea, water column & platform', d.sea, (v) => app.setDisplay({ sea: v }))}
        {leaf('contours', 'Structural contours (25 m)', d.contours, (v) => app.setDisplay({ contours: v }))}
      </TreeViewItem>
    </TreeView>
  );
}

function PresetMenu({ app }: { app: App }) {
  return (
    <DropdownMenuTrigger>
      <TreeViewAction aria-label="Layer presets">
        <LayersIcon />
      </TreeViewAction>
      <DropdownMenu placement="bottom end" className="min-w-44" onAction={(k) => app.preset(k as LayerPreset)}>
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

function LayerMenu({ app, id, name, opacity }: { app: App; id: string; name: string; opacity: number }) {
  const isolated = app.engine.geology.isolatedId === id;
  const nearest = OPACITY.reduce((a, b) => (Math.abs(b - opacity) < Math.abs(a - opacity) ? b : a));
  return (
    <DropdownMenuTrigger>
      <TreeViewAction aria-label={`${name} actions`} />
      <DropdownMenu placement="bottom end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onAction={() => app.inspectFormation(id)}>Details</DropdownMenuItem>
          <DropdownMenuItem onAction={() => app.isolate(isolated ? null : id)}>{isolated ? 'Clear isolation' : 'Isolate'}</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup selectionMode="single" selectedKeys={[String(nearest)]} onSelectionChange={(k) => k !== 'all' && k.size && app.setLayer(id, { opacity: +String([...k][0]) })}>
          <DropdownMenuLabel>Opacity</DropdownMenuLabel>
          {OPACITY.map((o) => (
            <DropdownMenuItem key={o} id={String(o)}>{`${Math.round(o * 100)}%`}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
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
  // mirrors Features → Realistic textures so it can be flipped right next to the view
  useEffect(() => app.flags.watch('textures', setTextures), [app]);
  const s: SceneDisplay = app.display;
  return (
    <div className="flex flex-col gap-1">
      <SelectField
        label="Resistivity colours"
        value={app.colormapName}
        onChange={(v) => app.setColormap(v as typeof app.colormapName)}
        options={COLORMAPS.map((c) => ({ id: c.id, label: c.label }))}
      />
      <SwitchField label="Glow & colour grade" isSelected={s.postFx} onChange={(v) => app.setDisplay({ postFx: v })} />
      <SwitchField label="Realistic textures" isSelected={textures} onChange={(v) => app.flags.set('textures', v)} />
    </div>
  );
}
