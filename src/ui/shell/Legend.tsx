import { Panel, PanelActions, PanelContent, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import type { ReactNode } from 'react';
import { colormap, RES_RANGE, toCss } from '../../data/colormap';
import { ropByZone, ROP_RANGE } from '../../data/drilling';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { App } from '../app';
import { Note } from '../controls';
import { ProvBadge, type Provenance } from '../prov';
import { useRev } from '../signal';

const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Colour key for the active property mode. */
export function Legend({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const m = app.engine.mode;
  const w = app.engine.activeWell;
  if (m === 'resistivity') {
    const stops = Array.from({ length: 24 }, (_, i) => `${toCss(colormap(app.colormapName, i / 23))} ${((i / 23) * 100).toFixed(1)}%`).join(',');
    const lmin = Math.log10(RES_RANGE.min);
    const lmax = Math.log10(RES_RANGE.max);
    return (
      <Frame title="Resistivity · Ω·m" prov="measured">
        <Ramp stops={stops} ticks={[0.2, 1, 10, 100, 1000].map((v) => [v, (Math.log10(v) - lmin) / (lmax - lmin)])} />
        <Note>
          Log scale {RES_RANGE.min}–{RES_RANGE.max} Ω·m. Borehole wall shows the shallow reading; the halo grades outward to the deep reading (RT). Radial scale ×{app.engine.radialScale}; investigation depth schematic.
        </Note>
      </Frame>
    );
  }
  if (m === 'rop') {
    const stops = Array.from({ length: 16 }, (_, i) => {
      const t = i / 15;
      const c = t < 0.33 ? mix([0.13, 0.04, 0.32], [0.72, 0.16, 0.42], t / 0.33) : t < 0.66 ? mix([0.72, 0.16, 0.42], [0.98, 0.55, 0.2], (t - 0.33) / 0.33) : mix([0.98, 0.55, 0.2], [0.99, 0.95, 0.62], (t - 0.66) / 0.34);
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
      <Frame title="ROP · m/h" prov="measured">
        <Ramp stops={stops} ticks={[1, 3, 10, 30, 100].map((v) => [v, Math.log10(v) / Math.log10(ROP_RANGE.max)])} />
        {zones.length ? (
          <>
            <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
              {[...byF].map(([id, a]) => (
                <li key={id} className="contents">
                  <Swatch color={FORMATION_BY_ID.get(id)?.color ?? '#666'} />
                  <span className="truncate">{a.name.replace(/ \(.*\)| –.*/, '')}</span>
                  <span className="text-right font-mono">{(a.f / a.h).toFixed(0)} m/h</span>
                  <span className="text-right font-mono text-muted-foreground">{a.h.toFixed(0)} h</span>
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
    return (
      <Frame title="Pore fluids" prov="calculated">
        <Swatches
          items={[
            ['linear-gradient(90deg,#8a520e,#e0932a)', 'Oil-filled pore space (So)'],
            ['linear-gradient(90deg,#1b4d7a,#3f86c4)', 'Water-filled pore space (Sw)'],
            ['#5b4a35', 'Oil-stained borehole wall'],
            ['#ffc35a', 'Net pay boundaries'],
          ]}
        />
        <Note>
          {p.satModel === 'archie' ? 'Archie' : 'Simandoux'} Sw from measured RT & RHOB · a {p.a}, m {p.m}, n {p.n}, Rw {p.rw} Ω·m @ {p.rwTemp} °C. Pore size tracks φ; drawn only where density and resistivity logs exist.
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
    <Frame title="Formations" prov="interpreted">
      <Swatches items={items} />
    </Frame>
  );
}

function Frame({ title, prov, children }: { title: string; prov: Provenance; children: ReactNode }) {
  return (
    <Panel variant="elevated" size="sm" className="w-64 max-w-full shrink-0">
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
        <PanelActions className="mr-0">
          <ProvBadge prov={prov} />
        </PanelActions>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-2">{children}</PanelContent>
    </Panel>
  );
}

function Ramp({ stops, ticks }: { stops: string; ticks: [number, number][] }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg,${stops})` }} />
      <div className="relative h-3 font-mono text-[10px] text-muted-foreground">
        {ticks.map(([v, f]) => (
          <span key={v} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${f * 100}%` }}>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
}

function Swatches({ items }: { items: [string, string][] }) {
  return (
    <ul className="grid grid-cols-1 gap-1 text-xs">
      {items.map(([c, l]) => (
        <li key={l} className="flex items-center gap-2">
          <Swatch color={c} />
          <span className="truncate">{l}</span>
        </li>
      ))}
    </ul>
  );
}
