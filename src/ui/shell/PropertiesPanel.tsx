import { Button } from '@tecton/react/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@tecton/react/components/input-group';
import { Separator } from '@tecton/react/components/separator';
import { ColorSwatch } from '@tecton/react/tecton/color-swatch';
import { CheckIcon, MoreVerticalIcon, MousePointerClickIcon, PinIcon, PinOffIcon, SearchIcon, XIcon } from 'lucide-react';
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FEATURE_BY_ID, type FeatureId, type FeatureModule } from '../../features/registry';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { App, SceneDisplay, WellboreDisplay } from '../app';
import { SliderField, SwitchField } from '../controls';
import { IconButton } from '../icon-button';
import type { InspectorRow, InspectorView } from '../inspect';
import { ProvBadge } from '../prov';
import { PanelAccordion, PanelSection } from '../section';
import { sameSelection, type Selection } from '../selection';
import { Rev, useRev, useSignal } from '../signal';
import { SelectionActionsButton } from './SelectionMenu';

/**
 * Properties: the selected object's details and settings, in a fixed place
 * (Figma, Blender, ParaView). It follows the selection made in the 3D view,
 * the Scene tree or by an action, unless pinned to one object (to compare it
 * with others as they are selected). The floating details card stands in for
 * it while this panel is closed.
 */
export function PropertiesPanel({ app }: { app: App }) {
  const selection = useSignal(app.selection);
  const pinned = useSignal(app.pinned);
  const sel = pinned ?? selection;
  if (!sel) return <NothingSelected />;
  return <Properties app={app} sel={sel} pinned={!!pinned} following={pinned && selection && !sameSelection(pinned, selection) ? selection : null} />;
}

function NothingSelected({ gone }: { gone?: boolean }) {
  return (
    <Empty className="m-3 w-auto min-h-40 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>{gone ? 'No longer in the scene' : 'Nothing selected'}</EmptyTitle>
        <EmptyDescription>Select a formation, well or pick in the 3D view or the Scene tree.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The panel for one object: header, filter, settings, details and quick actions. */
function Properties({ app, sel, pinned, following }: { app: App; sel: Selection; pinned: boolean; following: Selection | null }) {
  // the read-outs follow the well and its interpretation
  const rev = useRev(app.wellRev);
  const v = useMemo(() => app.inspectorFor(sel), [app, sel, rev]);
  const [query, setQuery] = useState('');
  if (!v) return <NothingSelected gone />;
  const settings = settingsFor(app, sel);
  const q = query.trim().toLowerCase();
  const rows = q ? filterRows(v.rows, q) : v.rows;
  const actions = (v.actions ?? []).filter((a) => !a.setting || !settings);
  return (
    <div className="flex flex-col">
      <Header app={app} sel={sel} v={v} pinned={pinned} />
      {following && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1">
          <span className="type-caption min-w-0 flex-1 truncate">Pinned. Selected: {app.inspectorFor(following)?.title ?? following.id}</span>
          <Button variant="ghost" size="xs" onPress={() => app.pinned.set(null)}>
            Show it
          </Button>
        </div>
      )}
      {v.rows.length > 6 && (
        <div className="px-3 pb-2">
          <InputGroup className="h-7">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput aria-label="Filter the details" placeholder="Filter the details" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
            {query && (
              <InputGroupAddon align="inline-end">
                <IconButton label="Clear the filter" size="icon-xs" onPress={() => setQuery('')}>
                  <XIcon />
                </IconButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {actions.map((a) => (
            <QuickAction key={a.label} app={app} label={a.label} primary={a.primary} pressed={a.pressed} onPress={a.onPress} />
          ))}
        </div>
      )}
      <PanelAccordion defaultExpandedKeys={['settings', 'details', 'about']}>
        {settings && (
          <PanelSection id="settings" title="Settings">
            {settings}
          </PanelSection>
        )}
        {v.rows.length > 0 && (
          <PanelSection id="details" title="Details">
            {rows.length ? <Rows rows={rows} /> : <p className="type-caption">No detail matches “{query}”.</p>}
          </PanelSection>
        )}
        {v.desc && (
          <PanelSection id="about" title="About">
            <div className="type-caption leading-relaxed">{v.desc}</div>
          </PanelSection>
        )}
      </PanelAccordion>
    </div>
  );
}

/** Colour, name, what it is and where it comes from; the pin and the object's actions (the same as its right-click menu). */
function Header({ app, sel, v, pinned }: { app: App; sel: Selection; v: InspectorView; pinned: boolean }) {
  const formation = sel.kind === 'formation' ? FORMATION_BY_ID.get(sel.id) : undefined;
  return (
    <div className="flex flex-col gap-1 px-3 pt-2.5 pb-2">
      <div className="flex min-w-0 items-center gap-2">
        {formation ? (
          <ColorSwatch color={v.color} size="sm" shape="rounded" aria-label={`${formation.name} colour: click to change`} onChange={(hex) => app.setFormationColor(sel.id, hex)} />
        ) : (
          <ColorSwatch color={v.color} size="sm" shape="rounded" aria-label="Colour" />
        )}
        <h3 className="type-title min-w-0 flex-1 truncate" title={v.title}>
          {v.title}
        </h3>
        <IconButton
          label={pinned ? 'Unpin: follow the selection' : 'Pin: keep showing this'}
          size="icon-xs"
          variant={pinned ? 'secondary' : 'ghost'}
          aria-pressed={pinned}
          onPress={() => app.pinned.set(pinned ? null : sel)}
        >
          {pinned ? <PinOffIcon /> : <PinIcon />}
        </IconButton>
        <SelectionActionsButton app={app} selection={sel} label={`${v.title} actions`}>
          <Button variant="ghost" size="icon-xs" aria-label={`${v.title} actions`}>
            <MoreVerticalIcon />
          </Button>
        </SelectionActionsButton>
      </div>
      <p className="type-caption">{v.sub}</p>
      {v.badge && (
        <ProvBadge prov={v.badge.prov} className="self-start">
          {v.badge.text}
        </ProvBadge>
      )}
    </div>
  );
}

/** A quick action of the read-out (travel here, open this well); a toggle shows the scene's state. */
function QuickAction({ app, label, primary, pressed, onPress }: { app: App; label: string; primary?: boolean; pressed?: () => boolean; onPress: () => void }) {
  useRev(app.sceneRev);
  const on = pressed?.();
  return (
    <Button size="xs" variant={primary ? 'default' : on ? 'secondary' : 'outline'} aria-pressed={pressed ? on : undefined} onPress={onPress}>
      {on && <CheckIcon data-icon="inline-start" />}
      {label}
    </Button>
  );
}

/** Rows whose name or value contains the text, under the headings they belong to. */
function filterRows(rows: InspectorRow[], q: string): InspectorRow[] {
  const out: InspectorRow[] = [];
  let heading: InspectorRow | null = null;
  for (const r of rows) {
    if (r === 'sep') continue;
    if (!Array.isArray(r)) {
      heading = r;
      continue;
    }
    if (!`${r[0]} ${r[1]}`.toLowerCase().includes(q)) continue;
    if (heading) out.push(heading);
    heading = null;
    out.push(r);
  }
  return out;
}

/** The read-outs: name, value and provenance on a row; names and values wrap rather than hide behind an ellipsis. */
function Rows({ rows }: { rows: InspectorRow[] }) {
  return (
    <dl className="grid grid-cols-[minmax(5.5rem,1fr)_minmax(0,auto)_auto] items-baseline gap-x-3 gap-y-1">
      {rows.map((r, i) => {
        if (r === 'sep') return <Separator key={i} emphasis="subtle" className="col-span-3 my-1" />;
        if (!Array.isArray(r))
          return (
            <dt key={i} className="type-section col-span-3 pt-1.5">
              {r.h}
            </dt>
          );
        const [k, val, prov] = r;
        return (
          <Fragment key={i}>
            <dt className="type-label leading-snug">{k}</dt>
            <dd className="type-value text-right leading-snug [overflow-wrap:anywhere]">{val}</dd>
            <dd className="flex justify-end self-center">{prov ? <ProvBadge prov={prov} short /> : null}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

// ------------------------------------------------------------------ settings

const DISPLAY_KEYS = new Set<keyof SceneDisplay>(['labels', 'otherWells', 'sea', 'contours']);
const WELLBORE_KEYS = new Set<keyof WellboreDisplay>(['casing', 'fractures', 'markers']);
const noRev = new Rev();

/** The settings an object has (null when it has none): the same controls as its tree row and the Features panel. */
function settingsFor(app: App, sel: Selection): ReactNode | null {
  if (sel.kind === 'formation' && FORMATION_BY_ID.has(sel.id)) return <FormationSettings app={app} id={sel.id} />;
  if (sel.kind === 'overlay' || sel.kind === 'contact') {
    if (DISPLAY_KEYS.has(sel.id as keyof SceneDisplay)) return <DisplayLayerSettings app={app} k={sel.id as keyof SceneDisplay} />;
    if (WELLBORE_KEYS.has(sel.id as keyof WellboreDisplay)) return <WellboreLayerSettings app={app} k={sel.id as keyof WellboreDisplay} />;
    if (FEATURE_BY_ID.has(sel.id as FeatureId)) return <FeatureSettings app={app} id={sel.id as FeatureId} />;
  }
  return null;
}

/** A formation's visibility, opacity and isolation (what its tree row's eye, scrub chip and menu set). */
const FormationSettings = memo(function FormationSettings({ app, id }: { app: App; id: string }) {
  useRev(app.sceneRev);
  const geo = app.engine.geology;
  const st = geo.state.get(id);
  if (!st) return null;
  const isolated = geo.isolatedId === id;
  return (
    <div className="flex flex-col gap-1">
      <SwitchField label="Visible" isSelected={st.visible} onChange={(v) => app.setLayer(id, { visible: v })} />
      <SliderField label="Opacity" value={Math.round(st.opacity * 100)} minValue={0} maxValue={100} step={5} format={(v) => `${v}%`} onChange={(v) => app.setLayer(id, { opacity: v / 100 })} />
      <SwitchField label="Isolate (ghost the others)" isSelected={isolated} onChange={(v) => app.isolate(v ? id : null)} />
    </div>
  );
});

function DisplayLayerSettings({ app, k }: { app: App; k: keyof SceneDisplay }) {
  useRev(app.sceneRev);
  return <SwitchField label="Visible" isSelected={app.display[k]} onChange={(v) => app.setDisplay({ [k]: v })} />;
}

function WellboreLayerSettings({ app, k }: { app: App; k: keyof WellboreDisplay }) {
  useRev(app.sceneRev);
  return <SwitchField label="Visible" isSelected={!!app.wellbore[k]} onChange={(v) => app.setWellboreDisplay({ [k]: v })} />;
}

/** An overlay feature: its switch, and while it is on, its own settings (`FeatureModule.settings`). */
function FeatureSettings({ app, id }: { app: App; id: FeatureId }) {
  const [on, setOn] = useState(() => app.flags.on(id));
  useEffect(() => app.flags.watch(id, setOn), [app, id]);
  const m = app.modules.get(id);
  return (
    <div className="flex flex-col gap-1.5">
      <SwitchField label="On" isSelected={on} onChange={(v) => app.flags.set(id, v)} />
      {on && m?.settings && <ModuleSettings m={m} />}
    </div>
  );
}

function ModuleSettings({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <div className="flex flex-col gap-1.5">{m.settings!()}</div>;
}
