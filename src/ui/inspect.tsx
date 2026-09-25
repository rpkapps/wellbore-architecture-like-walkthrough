import type { ReactNode } from 'react';
import type { CasingString } from '../data/dataset';
import { findCurve, sampleCurve } from '../data/las';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { horizonDip, sampleHorizon } from '../data/surfaces';
import { Trajectory } from '../data/trajectory';
import type { HorizonGrid, Zone } from '../data/types';
import type { PickResult } from '../scene/engine';
import type { Fracture } from '../scene/wellbore';
import type { App } from './app';
import { fmt } from './dom';
import type { Provenance } from './prov';

export type InspectorRow = [string, string, (Provenance | '')?] | 'sep' | { h: string };

export interface InspectorAction {
  label: string;
  primary?: boolean;
  onPress: () => void;
}

/** What the inspector card shows for a picked object. */
export interface InspectorView {
  title: string;
  sub: string;
  color: string;
  rows: InspectorRow[];
  desc?: ReactNode;
  actions?: InspectorAction[];
  badge?: { prov: Provenance; text?: string };
}

type Row = InspectorRow;

function view(title: string, sub: string, color: string, rows: Row[], desc?: ReactNode, actions: InspectorAction[] = [], badge?: InspectorView['badge']): InspectorView {
  return { title, sub, color, rows, desc, actions, badge };
}

/** Builds the inspector read-out for whatever was clicked in the scene. */
class Inspect {
  constructor(private app: App) {}

  pick(p: PickResult): InspectorView | null {
    const d = p.object.userData;
    switch (p.kind) {
      case 'wall':
        return this.wellAt(p.md ?? this.app.engine.rig.md);
      case 'casing':
        return this.casing(d.casing as CasingString);
      case 'cement':
        return this.casing(d.casing as CasingString, true);
      case 'formation':
        return this.formation(d.formationId as string, p.point, d.top as HorizonGrid, d.base as HorizonGrid | null);
      case 'fracture':
        return this.fracture(this.app.engine.wellbore!.fractures[d.index as number]);
      case 'top':
        return this.zone(d.zone as Zone);
      case 'pay':
        return this.pay(d.interval as { top: number; base: number });
      default:
        return null;
      case 'contextWell':
        return view(
          `15/9-${String(d.name).replace('15/9-', '')}`,
          'Volve wellbore — context',
          '#8795a3',
          [d.status === 'definitive' ? ['Trajectory', 'definitive directional survey', 'measured'] : ['Trajectory', 'from pick coordinates', 'reconstructed'], ['Logs', 'not in demo package', '']],
          d.status === 'definitive'
            ? 'Equinor definitive directional survey (positions from the survey UTM coordinates). Its formation picks also constrain the regional structural surfaces.'
            : 'Trajectory reconstructed through the official formation-pick coordinates (MD, TVD, easting, northing) of this wellbore. Its picks also constrain the regional structural surfaces.',
        );
      case 'detailWell': {
        const w = this.app.field.wells.find((x) => x.id === d.wellId)!;
        return view(
          w.name,
          w.summary,
          '#7fe3ff',
          [
            ['Survey', w.trajectory.status, w.trajectory.status === 'reconstructed' ? 'reconstructed' : 'measured'],
            ['TD', `${fmt.n(w.tdMD, 1)} m MD`, 'measured'],
            ['Logs', w.lasFile ?? '—', w.lasFile ? 'measured' : ''],
            ['Operator CPI', w.cpiFile ? 'available' : '—', w.cpiFile ? 'interpreted' : ''],
            ['Production', w.productionWell ?? '—', w.productionWell ? 'measured' : ''],
          ],
          w.trajectory.note,
          [{ label: 'Open this well', primary: true, onPress: () => this.app.selectWell(w.id) }],
        );
      }
      case 'platform': {
        const m = this.app.field.meta;
        return view(
          m.facility,
          `${m.name} field · ${m.block} · ${m.country}`,
          '#ffb547',
          [
            ['Operator', m.operator, ''],
            ['CRS', m.crs, ''],
            ['Origin E / N', `${m.originE.toFixed(1)} / ${m.originN.toFixed(1)}`, ''],
            ['Datum', `${m.datum} +${m.datumElevation} m`, 'measured'],
            ['Water depth', `${m.waterDepth} m`, 'measured'],
          ],
          'Platform geometry is a stylised representation of a jack-up production unit; well slot positions are real.',
        );
      }
    }
  }

  wellAt(md: number): InspectorView {
    const app = this.app;
    const w = app.engine.activeWell;
    const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
    const z = w.zoneAt(md);
    const f = z ? FORMATION_BY_ID.get(z.formationId) : undefined;
    const tstat = w.trajectory.status === 'reconstructed' ? 'reconstructed' : 'measured';
    const rows: Row[] = [
      { h: 'Position' },
      ['MD', `${fmt.n(md, 2)} m`, 'measured'],
      ['TVD / TVDSS', `${fmt.n(t.tvd, 1)} / ${fmt.n(t.tvd - app.field.meta.datumElevation, 1)} m`, tstat],
      ['Inc / Azi', `${fmt.n(t.inc, 1)}° / ${fmt.n(t.azi, 1)}°`, tstat],
      ['Dogleg', `${fmt.n(t.dls, 2)}°/30 m`, tstat],
      ['Section', Trajectory.sectionType(t.inc), tstat],
    ];
    const logs = w.logs;
    if (logs) {
      const v = (k: string) => {
        const c = findCurve(logs, k);
        return c ? sampleCurve(logs.depth, c.values, md) : NaN;
      };
      const sec = w.holeSections.find((s) => md >= s.topMD && md <= s.baseMD);
      rows.push('sep', { h: 'Measured logs' });
      rows.push(['Hole (bit / caliper)', `${sec ? sec.hole : '—'} / ${fmt.n(v('CALI'), 2)} in`, 'measured']);
      rows.push(['Gamma ray', `${fmt.n(v('GR'), 1)} API`, 'measured']);
      rows.push(['Deep resistivity', `${fmt.res(v('RT'))} Ω·m`, 'measured']);
      rows.push(['Shallow resistivity', `${fmt.res(v('RSHAL'))} Ω·m`, 'measured']);
      rows.push(['Bulk density', `${fmt.n(v('RHOB'), 3)} g/cm³`, 'measured']);
      rows.push(['Neutron porosity', `${fmt.n(v('NPHI'), 3)} v/v`, 'measured']);
      rows.push(['Compressional sonic', findCurve(logs, 'DT') ? `${fmt.n(v('DT'), 1)} µs/ft` : 'not acquired', findCurve(logs, 'DT') ? 'measured' : '']);
      const p = w.petro;
      if (p) {
        const pv = (c: { values: Float32Array }) => sampleCurve(logs.depth, c.values, md);
        const k = nearestIdx(logs.depth, md);
        rows.push('sep', { h: 'Calculated interpretation' });
        rows.push(['Vshale', fmt.pct(pv(p.vsh)), 'calculated']);
        rows.push(['Effective porosity', fmt.pct(pv(p.phie), 1), 'calculated']);
        rows.push(['Water saturation', fmt.pct(pv(p.sw)), 'calculated']);
        rows.push(['Oil saturation', fmt.pct(pv(p.so)), 'calculated']);
        rows.push(['Net pay flag', k >= 0 ? (p.pay[k] ? 'PAY' : p.net[k] ? 'net, wet' : 'non-net') : '—', 'calculated']);
      }
      if (w.cpi) {
        const c = (k: string) => {
          const cc = w.cpi!.curves.get(k);
          return cc ? sampleCurve(w.cpi!.depth, cc.values, md) : NaN;
        };
        rows.push('sep', { h: 'Equinor CPI' });
        rows.push(['PHIF / SW', `${fmt.pct(c('PHIF'), 1)} / ${fmt.pct(c('SW'))}`, 'interpreted']);
        rows.push(['VSH / KLOGH', `${fmt.pct(c('VSH'))} / ${fmt.n(c('KLOGH'), 1)} mD`, 'interpreted']);
      }
    }
    return view(
      `${fmt.n(md, 1)} m MD`,
      `${w.name} · ${z?.name ?? ''}`,
      f?.color ?? '#7fe3ff',
      rows,
      f ? (
        <>
          <b>{f.name}</b> — {f.description}
        </>
      ) : undefined,
      [
        { label: 'Travel here', primary: true, onPress: () => app.travelTo(md) },
        { label: 'Centre logs', onPress: () => app.logs.setCursor(md) },
      ],
    );
  }

  private casing(c: CasingString, cement = false): InspectorView {
    const w = this.app.engine.activeWell;
    const t = w.trajectory.at(Math.min(c.shoeMD, w.trajectory.mdEnd));
    return view(
      cement ? `Cement sheath — ${c.name}` : c.name,
      `${w.name}`,
      '#9aa1a8',
      [
        ['Outer diameter', `${c.od.toFixed(3)} in`, 'reconstructed'],
        ['Hole size', `${c.hole} in`, 'measured'],
        ['Shoe', `${fmt.n(c.shoeMD, 1)} m MD`, 'reconstructed'],
        ['Shoe TVD', `${fmt.n(t.tvd, 1)} m`, 'reconstructed'],
        ['Shoe inclination', `${fmt.n(t.inc, 1)}°`, 'reconstructed'],
      ],
      cement ? 'Cement placement is schematic (full column for conductor & surface casing, ~500 m above the shoe otherwise). No cement-bond log is included in the public package.' : c.note,
      [],
      { prov: cement ? 'schematic' : 'reconstructed' },
    );
  }

  formation(id: string, point?: { x: number; y: number; z: number }, top?: HorizonGrid, base?: HorizonGrid | null): InspectorView | null {
    const f = FORMATION_BY_ID.get(id);
    if (!f) return null;
    const field = this.app.field;
    const hz = top ?? field.horizons.find((x) => x.id === id);
    const idx = field.horizons.findIndex((x) => x.id === id);
    const bz = base === undefined ? (field.horizons[idx + 1] ?? null) : base;
    const rows: Row[] = [
      ['Group', f.group, ''],
      ['Age', f.age, ''],
      ['Lithology', f.lithology === 'blackshale' ? 'organic-rich shale' : f.lithology, ''],
    ];
    if (hz && point) {
      const x = point.x;
      const n = -point.z;
      const tt = sampleHorizon(hz, x, n);
      const bb = bz ? sampleHorizon(bz, x, n) : NaN;
      const dip = horizonDip(hz, x, n);
      rows.push('sep', { h: 'At picked location' });
      rows.push(['Easting / Northing', `${fmt.n(field.meta.originE + x, 0)} / ${fmt.n(field.meta.originN + n, 0)}`, '']);
      rows.push(['Picked depth', `${fmt.n(-point.y, 1)} m TVDSS`, '']);
      rows.push(['Top of unit', `${fmt.n(tt, 1)} m TVDSS`, 'interpreted']);
      if (Number.isFinite(bb)) rows.push(['Base of unit', `${fmt.n(bb, 1)} m TVDSS`, 'interpreted']);
      if (Number.isFinite(bb)) rows.push(['Vertical thickness', `${fmt.n(bb - tt, 1)} m`, 'interpreted']);
      rows.push(['Structural dip', `${fmt.n(dip.dip, 1)}° → ${fmt.n(dip.azi, 0)}°`, 'interpreted']);
    }
    if (hz) {
      rows.push('sep');
      rows.push(['Control points', `${hz.controlPoints.length} wellbores`, 'interpreted']);
    }
    const zs = this.app.zoneSummaries().filter((s) => s.zone.formationId === id);
    if (zs.length) {
      const net = zs.reduce((a, s) => a + s.pay, 0);
      const gross = zs.reduce((a, s) => a + s.gross, 0);
      rows.push(['Penetrated by well', `${fmt.n(gross, 0)} m MD`, 'interpreted']);
      rows.push(['Net pay in well', `${fmt.n(net, 1)} m MD`, 'calculated']);
    }
    const app = this.app;
    const isolated = app.engine.geology.isolatedId === id;
    return view(
      f.name,
      'Formation (regional structural model)',
      f.color,
      rows,
      <>
        <p>{f.description}</p>
        <p className="mt-1 text-muted-foreground">Surface interpolated from Equinor formation picks (plane trend + inverse-distance residuals); exact at the picks, interpretive between wells.</p>
      </>,
      [
        { label: isolated ? 'Clear isolation' : 'Isolate', onPress: () => app.isolate(isolated ? null : id) },
        {
          label: 'Hide',
          onPress: () => {
            app.setLayer(id, { visible: false });
            app.inspector.set(null);
          },
        },
      ],
    );
  }

  private fracture(fr: Fracture): InspectorView {
    return view(
      'Natural fracture',
      `${fr.set} · ${fmt.n(fr.md, 1)} m MD`,
      '#c8d2dc',
      [
        ['Strike', `${fmt.n(fr.strike, 0)}°`, 'schematic'],
        ['Dip', `${fmt.n(fr.dip, 0)}°`, 'schematic'],
        ['Depth', `${fmt.n(fr.md, 1)} m MD`, 'schematic'],
      ],
      'Illustrative only. The public Volve package has no borehole-image or core fracture data for this wellbore, so fracture positions and orientations are generated to show how natural fractures in chalk intersect a borehole — they are not measurements.',
      [],
      { prov: 'schematic', text: 'Schematic — not measured' },
    );
  }

  zone(z: Zone): InspectorView {
    const f = FORMATION_BY_ID.get(z.formationId);
    const w = this.app.engine.activeWell;
    const top = w.tops.find((t) => Math.abs(t.md - z.topMD) < 0.2);
    const s = this.app.zoneSummaries().find((x) => x.zone === z);
    const t0 = w.trajectory.at(Math.min(z.topMD, w.trajectory.mdEnd));
    const t1 = w.trajectory.at(Math.min(z.baseMD, w.trajectory.mdEnd));
    const rows: Row[] = [
      ['Top', `${fmt.n(z.topMD, 1)} m MD`, 'interpreted'],
      ['Top TVDSS', `${fmt.n(t0.tvd - this.app.field.meta.datumElevation, 1)} m`, w.trajectory.status === 'reconstructed' ? 'reconstructed' : 'measured'],
      ['Along-hole length', `${fmt.n(z.baseMD - z.topMD, 1)} m`, 'interpreted'],
      ['Vertical extent', `${fmt.n(t1.tvd - t0.tvd, 1)} m`, 'interpreted'],
    ];
    if (top) rows.push(['Pick name', top.name, 'interpreted']);
    if (s && s.coverage > 0) {
      rows.push('sep', { h: 'Interval summary' });
      rows.push(['Net / gross', fmt.pct(s.ntg), 'calculated']);
      rows.push(['Net pay', `${fmt.n(s.pay, 1)} m`, 'calculated']);
      rows.push(['Avg φ (pay)', fmt.pct(s.phiAvg, 1), 'calculated']);
      rows.push(['Avg Sw (pay)', fmt.pct(s.swAvg), 'calculated']);
      rows.push(['RT geo-mean', `${fmt.res(s.rtAvg)} Ω·m`, 'measured']);
    }
    return view(f?.name ?? z.name, `${w.name} · formation top`, f?.color ?? '#888', rows, f?.description, [{ label: 'Travel to top', primary: true, onPress: () => this.app.travelTo(z.topMD + 1) }]);
  }

  private pay(iv: { top: number; base: number }): InspectorView {
    const w = this.app.engine.activeWell;
    const p = w.petro!;
    const d = w.logs!.depth;
    let phi = 0,
      sw = 0,
      n = 0,
      hc = 0;
    for (let i = 1; i < d.length; i++) {
      if (d[i] < iv.top || d[i] > iv.base) continue;
      const a = p.phie.values[i];
      const s = p.sw.values[i];
      if (!Number.isFinite(a) || !Number.isFinite(s)) continue;
      phi += a;
      sw += s;
      n++;
      hc += a * (1 - s) * (d[i] - d[i - 1]);
    }
    return view(
      'Net pay interval',
      `${w.name}`,
      '#ffb547',
      [
        ['Top – base', `${fmt.n(iv.top, 1)} – ${fmt.n(iv.base, 1)} m MD`, 'calculated'],
        ['Along-hole thickness', `${fmt.n(iv.base - iv.top, 1)} m`, 'calculated'],
        ['Mean φ', fmt.pct(phi / n, 1), 'calculated'],
        ['Mean Sw', fmt.pct(sw / n), 'calculated'],
        ['HC column (φ·So·h)', `${fmt.n(hc, 2)} m`, 'calculated'],
      ],
      <>
        Pay = Vsh ≤ {w.params.cutVsh}, φ ≥ {w.params.cutPhi}, Sw ≤ {w.params.cutSw}. Adjust cut-offs and Archie parameters in <b>Interpretation</b>.
      </>,
      [{ label: 'Travel here', primary: true, onPress: () => this.app.travelTo((iv.top + iv.base) / 2) }],
    );
  }
}

function nearestIdx(d: Float64Array, md: number) {
  if (md < d[0] || md > d[d.length - 1]) return -1;
  let lo = 0;
  let hi = d.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (d[m] <= md) lo = m;
    else hi = m;
  }
  return md - d[lo] < d[hi] - md ? lo : hi;
}

export const inspect = {
  pick: (app: App, p: PickResult) => new Inspect(app).pick(p),
  wellAt: (app: App, md: number) => new Inspect(app).wellAt(md),
  formation: (app: App, id: string) => new Inspect(app).formation(id),
};
