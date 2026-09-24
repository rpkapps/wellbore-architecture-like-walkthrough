import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLAS, sampleCurve, findCurve } from '../src/data/las';
import { parseCSV, picksFromTable, productionFromTable, surveyFromTable, topsFromTable, toMonthly } from '../src/data/csv';
import { Trajectory, minimumCurvature, stationsFromSurvey } from '../src/data/trajectory';
import { DEFAULT_PARAMS, interpret, waterSaturation } from '../src/data/petro';
import { buildHorizons, sampleHorizon } from '../src/data/surfaces';
import { holeSectionsFromBitSize, casingFromSections, zonesFromTops } from '../src/data/dataset';
import { formationIdForPick } from '../src/data/stratigraphy';

const D = 'public/data/volve/';
const read = (f: string) => readFileSync(D + f, 'utf8');

describe('LAS parser', () => {
  const las = parseLAS(read('15_9-F-11B.las'), 'F-11B');
  it('reads header and curves', () => {
    expect(las.wellName).toBe('15/9-F-11 B');
    expect(las.depth[0]).toBeCloseTo(188.5, 3);
    expect(las.curves.get('GR')?.unit).toBe('API');
    expect(las.curves.get('RT')?.unit).toBe('Ω·m');
    expect(las.curves.get('RACEHM')?.description).toBe('RACEHM');
  });
  it('treats -999.25 as null and interpolates', () => {
    const rhob = las.curves.get('RHOB')!;
    expect(Number.isNaN(sampleCurve(las.depth, rhob.values, 1000))).toBe(true);
    const v = sampleCurve(las.depth, rhob.values, 3500);
    expect(v).toBeGreaterThan(1.9);
    expect(v).toBeLessThan(3.0);
  });
  it('handles wrapped LAS 1.2 in feet', () => {
    const txt = `~V
VERS. 1.2 :
WRAP. YES :
~W
NULL. -999.25 :
WELL. TEST : WELL
~C
DEPT.F :
GR.GAPI :
ILD.OHMM :
~A
1000.0
 50.0 10.0
1000.5
 -999.25 12.0
`;
    const l = parseLAS(txt, 't');
    expect(l.depth[0]).toBeCloseTo(304.8, 3);
    expect(Number.isNaN(l.curves.get('GR')!.values[1])).toBe(true);
    expect(findCurve(l, 'RT')?.mnemonic).toBe('ILD');
  });
});

describe('trajectory', () => {
  it('minimum curvature reproduces the Equinor F-11 A definitive survey', () => {
    const sv = surveyFromTable(parseCSV(read('15_9-F-11A_survey.csv')));
    const tie = sv.stations[0];
    const mc = minimumCurvature(sv.stations, { tvd: tie.tvd, ns: tie.ns, ew: tie.ew });
    const last = mc[mc.length - 1];
    const ref = sv.stations[sv.stations.length - 1];
    expect(Math.abs(last.tvd - ref.tvd)).toBeLessThan(0.5);
    expect(Math.abs(last.ns - ref.ns)).toBeLessThan(0.5);
    expect(Math.abs(last.ew - ref.ew)).toBeLessThan(0.5);
  });
  it('dense resampling stays on the stations', () => {
    const sv = surveyFromTable(parseCSV(read('15_9-F-11B_survey.csv')));
    const t = new Trajectory(stationsFromSurvey(sv.stations, sv.hasPositions), 'reconstructed', '', '');
    for (const s of sv.stations.filter((_, i) => i % 50 === 0)) {
      const p = t.at(s.md);
      expect(Math.hypot(p.ns - s.ns, p.ew - s.ew, p.tvd - s.tvd)).toBeLessThan(0.6);
    }
    // F-11 B is horizontal in the reservoir
    expect(t.at(3700).inc).toBeGreaterThan(80);
    expect(t.at(500).inc).toBeLessThan(10);
  });
});

describe('petrophysics', () => {
  it('Archie basics', () => {
    const p = { ...DEFAULT_PARAMS, rw: 0.05, a: 1, m: 2, n: 2 };
    expect(waterSaturation(0.05 / 0.04, 0.2, 0, p)).toBeCloseTo(1, 5);
    expect(waterSaturation(20, 0.25, 0, p)).toBeCloseTo(Math.sqrt(0.05 / (0.0625 * 20)), 5);
  });
  it('calibrated defaults track Equinor CPI Sw on 15/9-F-11 A', () => {
    const las = parseLAS(read('15_9-F-11A.las'), 'A');
    const cpi = parseLAS(read('15_9-F-11A_CPI.las'), 'cpi', 'interpreted');
    const res = interpret(las, { ...DEFAULT_PARAMS });
    const sw = cpi.curves.get('SW')!;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < cpi.depth.length; i++) {
      const s = sw.values[i];
      const phi = cpi.curves.get('PHIF')!.values[i];
      if (!Number.isFinite(s) || !(phi > 0.1)) continue;
      const mine = sampleCurve(las.depth, res.sw.values, cpi.depth[i]);
      if (!Number.isFinite(mine)) continue;
      a.push(s);
      b.push(mine);
    }
    const mean = (x: number[]) => x.reduce((q, v) => q + v, 0) / x.length;
    const ma = mean(a), mb = mean(b);
    const cov = a.reduce((q, v, i) => q + (v - ma) * (b[i] - mb), 0);
    const r = cov / Math.sqrt(a.reduce((q, v) => q + (v - ma) ** 2, 0) * b.reduce((q, v) => q + (v - mb) ** 2, 0));
    expect(a.length).toBeGreaterThan(300);
    expect(r).toBeGreaterThan(0.8);
    expect(Math.abs(ma - mb)).toBeLessThan(0.08);
  });
});

describe('CSV importers', () => {
  it('headerless NPD tops', () => {
    const tops = topsFromTable(parseCSV('UTSIRA FM,846\nHUGIN FM,4317\nSKAGERRAK FM,4340\n'), 't');
    expect(tops.map((t) => t.formationId)).toEqual(['utsira', 'hugin', 'skagerrak']);
  });
  it('Volve daily production and monthly aggregation', () => {
    const s = productionFromTable(parseCSV(read('production_daily_F-11.csv')), 'p', '15/9-F-11');
    expect(s.period).toBe('daily');
    const total = s.records.reduce((q, r) => q + r.oil, 0);
    expect(total).toBeGreaterThan(1.1e6);
    const m = toMonthly(s);
    expect(m.length).toBeGreaterThan(30);
  });
  it('picks table', () => {
    const p = picksFromTable(parseCSV(read('Volve_well_picks.csv')));
    expect(p.length).toBeGreaterThan(400);
    expect(formationIdForPick('Hugin Fm. VOLVE Base')).toBe('sleipner');
  });
});

describe('field model', () => {
  it('hole sections & casing from bit size', () => {
    const las = parseLAS(read('15_9-F-11B.las'), 'F-11B');
    const hs = holeSectionsFromBitSize(las);
    expect(hs.map((h) => h.hole)).toEqual([36, 26, 17.5, 12.25, 8.5]);
    const cs = casingFromSections(hs);
    expect(cs.map((c) => c.od)).toEqual([30, 20, 13.375, 9.625]);
  });
  it('zones along F-11 B re-enter the Hugin several times', () => {
    const picks = picksFromTable(parseCSV(read('Volve_well_picks.csv')));
    const sv = surveyFromTable(parseCSV(read('15_9-F-11B_survey.csv')));
    const t = new Trajectory(stationsFromSurvey(sv.stations, sv.hasPositions), 'reconstructed', '', '');
    const tops = picks
      .filter((p) => p.well === 'NO 15/9-F-11 B')
      .map((p) => ({ name: p.pick, formationId: formationIdForPick(p.pick), md: p.md, source: '', provenance: 'interpreted' as const }));
    const zones = zonesFromTops(tops, t, 54.9, 91.1, 4770);
    expect(zones.filter((z) => z.formationId === 'hugin').length).toBeGreaterThanOrEqual(5);
    const horizons = buildHorizons(picks, { e: 435050.03, n: 6478563.55 }, 54.9, { xMin: -1500, xMax: 2500, nMin: -1500, nMax: 2500 }, 48);
    const hug = horizons.find((h) => h.id === 'hugin')!;
    const d = sampleHorizon(hug, 0, 0);
    expect(d).toBeGreaterThan(2600);
    expect(d).toBeLessThan(3300);
    // stratigraphic order
    for (let i = 1; i < horizons.length; i++) expect(horizons[i].depth[100]).toBeGreaterThanOrEqual(horizons[i - 1].depth[100]);
  });
});
