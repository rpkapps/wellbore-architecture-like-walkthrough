import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Panel, PanelActions, PanelContent, PanelHeader } from '@tecton/react/tecton/panel';
import type { ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import { colormap, toCss } from '../../data/colormap';
import { ropByZone, ROP_RANGE } from '../../data/drilling';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { PropertyMode } from '../../scene/wellbore';
import type { App } from '../app';
import { Note } from '../controls';
import { ProvBadge, type Provenance } from '../prov';
import { useRev, useSignal } from '../signal';
import { ColormapPicker } from '../viz/ColormapPicker';
import { CollapseButton, OverlayChip, SURFACE, useCollapsed } from './overlay';

const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** What the wellbore can be coloured by, each with the dot that marks it. */
export const PROPERTIES: { id: PropertyMode; label: string; dot: string }[] = [
  { id: 'resistivity', label: 'Resistivity', dot: '#7fe3ff' },
  { id: 'hydrocarbon', label: 'Hydrocarbons', dot: '#ffb547' },
  { id: 'lithology', label: 'Lithology', dot: '#a28e67' },
  { id: 'rop', label: 'ROP', dot: '#f28a3c' },
];

/**
 * Colour key for the active property mode, and the control that chooses it:
 * its title is the "Colour by" menu, so the key and the choice it explains
 * sit together (V still cycles the property).
 */
export function Legend({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const m = app.engine.mode;
  const w = app.engine.activeWell;
  if (m === 'resistivity') {
    const stops = Array.from({ length: 24 }, (_, i) => `${toCss(colormap(app.colormapName, i / 23))} ${((i / 23) * 100).toFixed(1)}%`).join(',');
    return (
      <Frame app={app} unit="Ω·m" prov="measured" compact={<MiniRamp stops={stops} lo="0.2" hi="1000" />}>
        {/* the ramp itself opens the colour maps */}
        <ColormapPicker app={app} />
        <Note>Log scale · wall = shallow reading, halo → deep (RT) · radial ×{app.engine.radialScale}</Note>
      </Frame>
    );
  }
  if (m === 'rop') {
    const stops = Array.from({ length: 16 }, (_, i) => {
      const t = i / 15;
      const c =
        t < 0.33
          ? mix([0.13, 0.04, 0.32], [0.72, 0.16, 0.42], t / 0.33)
          : t < 0.66
            ? mix([0.72, 0.16, 0.42], [0.98, 0.55, 0.2], (t - 0.33) / 0.33)
            : mix([0.98, 0.55, 0.2], [0.99, 0.95, 0.62], (t - 0.66) / 0.34);
      return `${toCss(c)} ${(t * 100).toFixed(1)}%`;
    }).join(',');
    const zones = w.logs ? ropByZone(w.logs, w.zones) : [];
    const byF = new Map<string, { name: string; h: number; f: number }>();
    for (const z of zones) {
      const a = byF.get(z.formationId) ?? { name: z.name, h: 0, f: 0 };
      a.h += z.hours;
      a.f += z.footage;
      byF.set(z.formationId, a);
    }
    const tot = [...byF.values()].reduce((s, a) => s + a.h, 0);
    return (
      <Frame app={app} unit="m/h" prov="measured" compact={<MiniRamp stops={stops} lo="1" hi="100" />}>
        <Ramp stops={stops} ticks={[1, 3, 10, 30, 100].map((v) => [v, Math.log10(v) / Math.log10(ROP_RANGE.max)])} />
        {zones.length ? (
          <>
            <ul className="type-label grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1">
              {[...byF].map(([id, a]) => (
                <li key={id} className="contents">
                  <Swatch color={FORMATION_BY_ID.get(id)?.color ?? '#666'} />
                  <span className="truncate">{a.name.replace(/ \(.*\)| –.*/, '')}</span>
                  <span className="type-value text-right">{(a.f / a.h).toFixed(0)} m/h</span>
                  <span className="type-unit text-right">{a.h.toFixed(0)} h</span>
                </li>
              ))}
            </ul>
            <Note>On-bottom drilling time Σ ΔMD / ROP ≈ {tot.toFixed(0)} h for the logged footage (connections, trips and casing runs excluded). Averages are footage-weighted.</Note>
          </>
        ) : (
          <Note>No ROP curve in this well’s logs.</Note>
        )}
      </Frame>
    );
  }
  if (m === 'hydrocarbon') {
    const p = w.params;
    const fluids: [string, string][] = [
      ['linear-gradient(90deg,#8a520e,#e0932a)', 'Oil-filled pore space (So)'],
      ['linear-gradient(90deg,#1b4d7a,#3f86c4)', 'Water-filled pore space (Sw)'],
      ['#5b4a35', 'Oil-stained borehole wall'],
      ['#ffc35a', 'Net pay boundaries'],
    ];
    return (
      <Frame app={app} unit="pore fluids" prov="calculated" compact={<Dots items={fluids} />}>
        <Swatches items={fluids} />
        <Note>
          {p.satModel === 'archie' ? 'Archie' : 'Simandoux'} Sw · a {p.a}, m {p.m}, n {p.n}, Rw {p.rw} Ω·m @ {p.rwTemp} °C
        </Note>
      </Frame>
    );
  }
  const seen = new Set<string>();
  const items: [string, string][] = [];
  for (const z of w.zones) {
    const f = FORMATION_BY_ID.get(z.formationId);
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    items.push([f.color, f.name]);
  }
  return (
    <Frame app={app} unit="formations" prov="interpreted" compact={<Dots items={items} />}>
      <Swatches items={items} />
    </Frame>
  );
}

/**
 * The key's card, headed by the colour-by menu; collapsed, the menu and a
 * one-line ramp or row of swatches. Where the 3D view is too narrow for the
 * card it shrinks to the menu alone, so the choice stays in reach.
 */
function Frame({ app, unit, prov, compact, children }: { app: App; unit: string; prov: Provenance; compact: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useCollapsed('legend');
  if (collapsed)
    return (
      <OverlayChip name="colour key" onExpand={() => setCollapsed(false)}>
        <ColourBy app={app} />
        {compact}
      </OverlayChip>
    );
  // where the 3D view is narrow only the menu shows: the card shrinks to it
  return (
    <Panel variant="elevated" size="sm" className={`w-fit max-w-full shrink-0 @md:w-64 ${SURFACE}`}>
      <PanelHeader className="gap-1">
        <ColourBy app={app} />
        <span className="type-unit hidden min-w-0 truncate @md:inline">{unit}</span>
        <PanelActions className="mr-0 hidden gap-1 @md:flex">
          <ProvBadge prov={prov} short />
          <CollapseButton collapsed={false} name="colour key" onChange={setCollapsed} />
        </PanelActions>
      </PanelHeader>
      <PanelContent className="hidden flex-col gap-2 @md:flex">{children}</PanelContent>
    </Panel>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />;
}

/** "● Resistivity ▾": the property the wellbore is coloured by, as a menu (the same action as V and the command palette). */
function ColourBy({ app }: { app: App }) {
  const optional = useSignal(app.optionalModes);
  const mode = app.engine.mode;
  const props = PROPERTIES.filter((p) => p.id !== 'rop' || optional.has('rop') || mode === 'rop');
  return (
    <Select
      aria-label="Colour the wellbore by (V cycles)"
      selectedKey={mode}
      onSelectionChange={(k: Key | null) => {
        if (k !== null && k !== mode) void app.actions.run('view.color_by', { mode: String(k) });
      }}
      className="shrink-0"
    >
      <SelectTrigger size="sm" variant="text" className="-ml-1">
        <SelectValue className="type-title min-w-max" />
      </SelectTrigger>
      <SelectContent className="w-max min-w-(--trigger-width)">
        {props.map((p) => (
          <SelectItem key={p.id} id={p.id} textValue={p.label}>
            {/* the item's own row does not centre its children vertically */}
            <span className="flex items-center gap-2">
              <Dot color={p.dot} />
              {p.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Ramp({ stops, ticks }: { stops: string; ticks: [number, number][] }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg,${stops})` }} />
      <div className="type-unit relative h-3">
        {ticks.map(([v, f]) => (
          <span key={v} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${f * 100}%` }}>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function MiniRamp({ stops, lo, hi }: { stops: string; lo: string; hi: string }) {
  return (
    <span className="type-unit flex items-center gap-1">
      {lo}
      <span aria-hidden className="h-1.5 w-20 rounded-full" style={{ background: `linear-gradient(90deg,${stops})` }} />
      {hi}
    </span>
  );
}

/** A row of colour dots, each named by its tooltip. */
function Dots({ items }: { items: [string, string][] }) {
  return (
    <span className="flex max-w-40 flex-wrap items-center gap-1">
      {items.map(([c, l]) => (
        <span key={l} title={l} aria-label={l} role="img" className="size-2.5 rounded-full ring-1 ring-foreground/10" style={{ background: c }} />
      ))}
    </span>
  );
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
}

function Swatches({ items }: { items: [string, string][] }) {
  return (
    <ul className="type-label grid grid-cols-1 gap-1">
      {items.map(([c, l]) => (
        <li key={l} className="flex items-center gap-2">
          <Swatch color={c} />
          <span className="truncate">{l}</span>
        </li>
      ))}
    </ul>
  );
}
