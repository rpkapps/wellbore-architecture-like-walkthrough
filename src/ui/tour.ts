import type { FieldModel, Well } from '../data/dataset';
import { findCurve } from '../data/las';
import { payIntervals } from '../data/petro';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { Trajectory } from '../data/trajectory';
import type { GuidedView } from '../scene/cameraRig';
import type { PropertyMode } from '../scene/wellbore';

export interface Fact {
  k: string;
  v: string;
  prov: 'measured' | 'calculated' | 'interpreted' | 'reconstructed';
}

export interface Chapter {
  md: number;
  title: string;
  text: string;
  view: GuidedView;
  mode?: PropertyMode;
  facts: Fact[];
}

function stat(well: Well, key: string, a: number, b: number, agg: 'median' | 'mean' | 'geo' = 'median'): number {
  const logs = well.logs;
  if (!logs) return NaN;
  const c = findCurve(logs, key);
  if (!c) return NaN;
  const v: number[] = [];
  for (let i = 0; i < logs.depth.length; i++) {
    const d = logs.depth[i];
    if (d < a || d > b) continue;
    const x = c.values[i];
    if (Number.isFinite(x)) v.push(x);
  }
  if (!v.length) return NaN;
  if (agg === 'mean') return v.reduce((s, x) => s + x, 0) / v.length;
  if (agg === 'geo') return Math.exp(v.reduce((s, x) => s + Math.log(Math.max(x, 1e-4)), 0) / v.length);
  v.sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
}

const f1 = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function buildChapters(well: Well, field: FieldModel): Chapter[] {
  const ch: Chapter[] = [];
  const traj = well.trajectory;
  const at = (md: number) => traj.at(Math.min(md, traj.mdEnd));
  const posFacts = (md: number): Fact[] => {
    const p = at(md);
    return [
      { k: 'MD', v: `${f1(md)} m`, prov: 'measured' },
      { k: 'TVDSS', v: `${f1(p.tvd - field.meta.datumElevation)} m`, prov: traj.status === 'reconstructed' ? 'reconstructed' : 'measured' },
      { k: 'Inclination', v: `${f1(p.inc, 1)}°`, prov: traj.status === 'reconstructed' ? 'reconstructed' : 'measured' },
    ];
  };
  const zone = (id: string, nth = 0) => well.zones.filter((z) => z.formationId === id)[nth];
  const seabed = well.zones.find((z) => z.formationId === 'sea');

  ch.push({
    md: 0,
    title: `${field.meta.facility.split('(')[0].trim()} · drill floor`,
    text: `${well.name} is drilled from the drill floor ${field.meta.datumElevation} m above sea level in block ${field.meta.block}, ${field.meta.country}. All depths are measured from this datum (MD) and projected vertically (TVD / TVDSS).`,
    view: 'chase',
    mode: 'resistivity',
    facts: [
      { k: 'Datum', v: `DF +${field.meta.datumElevation} m`, prov: 'measured' },
      { k: 'Water depth', v: `${field.meta.waterDepth} m`, prov: 'measured' },
      { k: 'TD', v: `${f1(well.tdMD)} m MD`, prov: 'measured' },
    ],
  });
  if (seabed) {
    const cond = well.casing[0];
    ch.push({
      md: seabed.baseMD + 5,
      title: 'Seabed & conductor',
      text: `The well leaves the ${field.meta.waterDepth} m water column and enters soft Nordland Group clays. ${cond ? `A ${cond.name} is set to ${f1(cond.shoeMD)} m MD (inferred from the 36" bit-size log).` : ''}`,
      view: 'chase',
      facts: posFacts(seabed.baseMD + 5),
    });
  }
  const uts = zone('utsira');
  if (uts) {
    const rt = stat(well, 'RT', uts.topMD, uts.baseMD, 'geo');
    ch.push({
      md: uts.topMD + 20,
      title: 'Utsira Fm. — saline aquifer',
      text: `A highly porous, water-bearing sand. Low deep resistivity (${f1(rt, 2)} Ω·m) is the signature of formation brine — the same unit stores CO₂ at nearby Sleipner.`,
      view: 'tunnel',
      mode: 'resistivity',
      facts: [...posFacts(uts.topMD + 20).slice(0, 2), { k: 'RT (geo-mean)', v: `${f1(rt, 2)} Ω·m`, prov: 'measured' }],
    });
  }
  const c20 = well.casing.find((c) => c.od === 20);
  if (c20)
    ch.push({
      md: c20.shoeMD - 10,
      title: '20" casing shoe',
      text: `The surface casing isolates the shallow aquifers and unconsolidated overburden. Below the shoe the hole narrows to 17½".`,
      view: 'chase',
      facts: posFacts(c20.shoeMD),
    });
  if (well.kickoffMD) {
    const p = at(well.kickoffMD + 60);
    ch.push({
      md: well.kickoffMD,
      title: 'Sidetrack point — kick-off',
      text: `${well.name} leaves the ${well.sister ? `15/9-${well.sister.replace('F-', 'F-')}` : 'parent'} wellbore just below the 13⅜" shoe and starts building angle (${f1(p.inc, 0)}° by ${f1(well.kickoffMD + 60)} m MD).`,
      view: 'orbit',
      facts: posFacts(well.kickoffMD),
    });
  }
  const eko = zone('ekofisk');
  if (eko)
    ch.push({
      md: eko.topMD + 30,
      title: 'Shetland Gp. chalk',
      text: 'Pelagic chalk of the Ekofisk and Hod formations. Fracture planes shown here are schematic — the public Volve package contains no borehole-image log — but illustrate the naturally fractured character of North Sea chalk.',
      view: 'chase',
      mode: 'resistivity',
      facts: [...posFacts(eko.topMD + 30), { k: 'Section', v: Trajectory.sectionType(at(eko.topMD + 30).inc), prov: 'reconstructed' }],
    });
  const dr = zone('draupne');
  if (dr) {
    const gr = stat(well, 'GR', dr.topMD, dr.baseMD, 'mean');
    ch.push({
      md: dr.topMD + Math.min(10, (dr.baseMD - dr.topMD) / 2),
      title: 'Draupne Fm. — source rock & seal',
      text: `Organic-rich Upper Jurassic shale: the kitchen that generated Volve's oil and the top seal above the reservoir. Mean gamma ray ${f1(gr)} API.`,
      view: 'tunnel',
      facts: [...posFacts(dr.topMD).slice(0, 2), { k: 'GR mean', v: `${f1(gr)} API`, prov: 'measured' }],
    });
  }
  const hugins = well.zones.filter((z) => z.formationId === 'hugin');
  if (hugins[0]) {
    const h0 = hugins[0];
    const p = at(h0.topMD);
    const rt = stat(well, 'RT', h0.topMD, h0.baseMD, 'geo');
    ch.push({
      md: h0.topMD + 8,
      title: 'Landing in the Hugin reservoir',
      text: `Entering the Middle Jurassic Hugin sandstone at ${f1(p.inc, 1)}° inclination. Resistivity jumps to ${f1(rt, 1)} Ω·m (geo-mean) as oil replaces conductive brine in the pore space.`,
      view: 'chase',
      mode: 'resistivity',
      facts: [...posFacts(h0.topMD), { k: 'RT', v: `${f1(rt, 1)} Ω·m`, prov: 'measured' }],
    });
  }
  // best pay interval
  if (well.petro && well.logs) {
    const ints = payIntervals(well.logs.depth, well.petro.pay, 1.0);
    let best: { top: number; base: number; hc: number; phi: number; sw: number } | null = null;
    for (const iv of ints) {
      let hc = 0, phi = 0, sw = 0, n = 0;
      const d = well.logs.depth;
      for (let i = 1; i < d.length; i++) {
        if (d[i] < iv.top || d[i] > iv.base) continue;
        const ph = well.petro.phie.values[i];
        const s = well.petro.sw.values[i];
        if (!Number.isFinite(ph) || !Number.isFinite(s)) continue;
        hc += ph * (1 - s) * (d[i] - d[i - 1]);
        phi += ph;
        sw += s;
        n++;
      }
      if (n && (!best || hc > best.hc)) best = { ...iv, hc, phi: phi / n, sw: sw / n };
    }
    if (best) {
      ch.push({
        md: (best.top + best.base) / 2,
        title: 'Best continuous pay',
        text: `Along-hole ${f1(best.base - best.top)} m of net pay (${f1(best.top)}–${f1(best.base)} m MD). Oil-filled pore space is rendered from the calculated saturation: amber = oil, blue = formation water.`,
        view: 'chase',
        mode: 'hydrocarbon',
        facts: [
          { k: 'PHIE avg', v: `${f1(best.phi * 100, 1)} %`, prov: 'calculated' },
          { k: 'Sw avg', v: `${f1(best.sw * 100, 0)} %`, prov: 'calculated' },
          { k: 'HC column', v: `${f1(best.hc, 2)} m`, prov: 'calculated' },
        ],
      });
    }
  }
  if (hugins.length > 1) {
    const exitZone = well.zones.find((z) => z.topMD >= hugins[0].baseMD - 0.1 && z.formationId !== 'hugin');
    const f = exitZone ? FORMATION_BY_ID.get(exitZone.formationId) : undefined;
    const re = hugins[1];
    ch.push({
      md: re.topMD - 15,
      title: 'Reservoir exit & re-entry',
      text: `The near-horizontal lateral undulates through a thin, faulted reservoir: it exits into the ${f?.name ?? 'surrounding shales'} and re-enters the Hugin ${hugins.length - 1} time${hugins.length > 2 ? 's' : ''}, each crossing picked by Equinor geologists.`,
      view: 'orbit',
      mode: 'hydrocarbon',
      facts: [...posFacts(re.topMD).slice(0, 2), { k: 'Hugin entries', v: String(hugins.length), prov: 'interpreted' }],
    });
  }
  ch.push({
    md: well.tdMD - 2,
    title: 'Total depth',
    text: `TD at ${f1(well.tdMD)} m MD, ${f1(at(well.tdMD).tvd - field.meta.datumElevation)} m below sea level — ${f1(Math.hypot(at(well.tdMD).ns, at(well.tdMD).ew))} m horizontally from the platform.`,
    view: 'orbit',
    facts: posFacts(well.tdMD),
  });
  return ch.sort((a, b) => a.md - b.md);
}
