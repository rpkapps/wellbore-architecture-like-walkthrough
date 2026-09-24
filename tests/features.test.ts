import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadVolve, type FieldModel } from '../src/data/dataset';
import { steerProfile } from '../src/data/geosteer';
import { combineContacts, contactEvidence } from '../src/data/contacts';
import { uncertaintyAlong } from '../src/data/uncertainty';
import { ropByZone } from '../src/data/drilling';
import { corrAxis, corrDatum, corrTrack, corrZones } from '../src/data/correlation';
import { bvwLine, crossplotPoints, mdIntervals, pickettLine } from '../src/data/crossplot';
import { contourSegments, horizonCrossing, horizonRange, productionAt, productionSpan } from '../src/data/mapview';
import { waterSaturation } from '../src/data/petro';
import { findCurve } from '../src/data/las';
import { sampleHorizon } from '../src/data/surfaces';

// serve public/ through fetch so the real loader runs unchanged
globalThis.fetch = (async (url: string) => {
  const path = String(url).replace(/^\.\//, 'public/');
  const body = readFileSync(path, 'utf8');
  return { ok: true, status: 200, text: async () => body } as Response;
}) as typeof fetch;

let field: FieldModel;
beforeAll(async () => {
  field = await loadVolve('./data/volve/');
  for (const w of field.wells) if (w.lasFile) await field.ensureLoaded(w);
}, 60000);

describe('geosteering profile', () => {
  it('F-11 B travels mostly inside the Hugin model interval along its lateral', () => {
    const w = field.wells.find((x) => x.id === 'F-11B')!;
    const p = steerProfile(w.trajectory, field.horizons, field.meta.datumElevation, 'hugin', w.tops, { zones: w.zones });
    expect(p.source).toBe('tied');
    expect(p.window).not.toBeNull();
    const tot = p.footage.in + p.footage.above + p.footage.below;
    expect(tot).toBeGreaterThan(500);
    // tied surfaces reproduce the pick-based Hugin footage (≈ 580 m) closely
    const hugin = w.zones.filter((z) => z.formationId === 'hugin').reduce((s, z) => s + Math.min(z.baseMD, w.trajectory.mdEnd) - z.topMD, 0);
    expect(Math.abs(p.footage.in - hugin)).toBeLessThan(0.1 * hugin);
    // the tied surfaces pass through the crossings
    for (const tie of p.ties) {
      const s = p.samples.reduce((a, b) => (Math.abs(b.md - tie.md) < Math.abs(a.md - tie.md) ? b : a));
      const err = Math.abs((tie.which === "top" ? s.top : s.base) - tie.tvdss);
      if (err >= 2) console.log("tie", JSON.stringify(tie), JSON.stringify(s));
      expect(err).toBeLessThan(2);
    }
    const model = steerProfile(w.trajectory, field.horizons, field.meta.datumElevation, 'hugin', w.tops, { source: 'model' });
    expect(model.footage.in).toBeLessThan(p.footage.in);
    // the picks record several entries into the Hugin
    expect(p.crossings.filter((c) => c.kind === 'enter').length).toBeGreaterThanOrEqual(3);
  });
});

describe('oil-water contact from logs', () => {
  it('finds a contact bracket in the Hugin', () => {
    const ev = field.wells
      .filter((w) => w.logs && w.petro)
      .map((w) => contactEvidence(w.name, w.logs!, w.petro!, w.zones, w.trajectory, field.meta.datumElevation));
    const c = combineContacts(ev);
    expect(c).not.toBeNull();
    // Volve Hugin reservoir lies ~2750–3200 m TVDSS; the wells bracket different contacts
    expect(c!.conflicts.length).toBeGreaterThan(0);
    expect(c!.depth).toBeGreaterThan(2700);
    expect(c!.depth).toBeLessThan(3300);
    // F-11 A brackets the contact; F-11 B saw oil deeper than that (different block / timing)
    console.log('OWC', c!.depth.toFixed(1), '±', c!.plusMinus.toFixed(1), JSON.stringify(ev));
  });
});

describe('survey uncertainty', () => {
  it('grows with depth and is larger on reconstructed sections', () => {
    const a = field.wells.find((x) => x.id === 'F-11A')!;
    const b = field.wells.find((x) => x.id === 'F-11B')!;
    const ua = uncertaintyAlong(a.trajectory, 50);
    expect(ua[ua.length - 1].major).toBeGreaterThan(ua[5].major);
    const ub = uncertaintyAlong(b.trajectory, 50, undefined, { reconstructedFrom: b.kickoffMD, picks: b.tops });
    const ubNo = uncertaintyAlong(b.trajectory, 50);
    expect(ub[ub.length - 1].major).toBeGreaterThanOrEqual(ubNo[ubNo.length - 1].major);
    // 1σ at TD of a ~4.5 km well with a 0.5° azimuth bias: several metres, not hundreds
    expect(ua[ua.length - 1].major).toBeGreaterThan(2);
    expect(ua[ua.length - 1].major).toBeLessThan(60);
  });
});

describe('ROP by formation', () => {
  it('computes drilling time and harmonic mean ROP', () => {
    const w = field.wells.find((x) => x.id === 'F-11B')!;
    const z = ropByZone(w.logs!, w.zones);
    expect(z.length).toBeGreaterThan(3);
    for (const r of z) {
      expect(r.meanRop).toBeGreaterThan(0);
      expect(r.hours).toBeGreaterThan(0);
    }
    console.log('ROP', z.map((r) => `${r.name}: ${r.meanRop.toFixed(1)} m/h, ${r.hours.toFixed(1)} h`).join('; '));
  });
});

describe('simulation package (.bwsim)', () => {
  it('reads the preloaded Volve grid written by scripts/prepare_sim.py', async () => {
    const { readBwsimAny } = await import('../src/data/bwsim');
    const b = readFileSync('public/data/volve/sim/volve_opm.bwsim.gz');
    const m = await readBwsimAny(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    // time-lapse from the OPM Flow re-run: oil saturation falls as the field is produced
    expect(m.header.dates.length).toBeGreaterThan(25);
    const mean = (a: Float32Array) => {
      let s = 0, k = 0;
      for (const v of a) if (Number.isFinite(v)) (s += v), k++;
      return s / k;
    };
    const so0 = mean(m.step('SOIL', 0)!);
    const so1 = mean(m.step('SOIL', m.header.dates.length - 1)!);
    expect(so1).toBeLessThan(so0 * 0.7);
    const fopt = m.header.summary!.field.FOPT;
    expect(fopt[fopt.length - 1]).toBeGreaterThan(9e6);
    expect(fopt[fopt.length - 1]).toBeLessThan(12e6);
    expect(m.header.dims).toEqual([108, 100, 63]);
    expect(m.n).toBe(183545);
    const poro = m.prop('PORO')!;
    const perm = m.prop('PERMX')!;
    let pmax = 0;
    let kmax = 0;
    for (let i = 0; i < m.n; i++) {
      if (poro[i] > pmax) pmax = poro[i];
      if (perm[i] > kmax) kmax = perm[i];
    }
    expect(pmax).toBeGreaterThan(0.2);
    expect(pmax).toBeLessThan(0.4);
    expect(kmax).toBeGreaterThan(100);
    // reservoir cells sit at Hugin depths
    let zmin = Infinity;
    for (let i = 0; i < m.n; i++) zmin = Math.min(zmin, m.center[i * 3 + 2]);
    expect(zmin).toBeGreaterThan(2700);
  });
  it('round-trips through the TypeScript writer', async () => {
    const { readBwsim, writeBwsim } = await import('../src/data/bwsim');
    const f = (a: number[]) => new Float32Array(a);
    const u = (a: number[]) => new Uint8Array(a);
    const buf = writeBwsim(
      { name: 't', source: 's', note: '', provenance: 'user', dims: [2, 1, 1], nActive: 2, dates: ['2010-01-01', '2012-01-01'], static: [{ key: 'PORO', label: 'Porosity', unit: 'v/v', min: 0, max: 0.4 }], dynamic: [{ key: 'SOIL', label: 'Oil', unit: 'v/v', min: 0, max: 1 }] },
      { cx: f([0, 50]), cy: f([0, 0]), cz: f([3000, 3001]), sx: f([50, 50]), sy: f([50, 50]), sz: f([2, 2]), i: u([0, 1]), j: u([0, 0]), k: u([0, 0]) },
      { PORO: f([0.2, 0.3]) },
      { SOIL: [f([0.8, 0.7]), f([0.4, NaN])] },
    );
    const m = readBwsim(buf);
    expect(m.center[5]).toBeCloseTo(3001);
    expect(m.prop('PORO')![1]).toBeCloseTo(0.3, 2);
    expect(m.step('SOIL', 1)![0]).toBeCloseTo(0.4, 2);
    expect(Number.isNaN(m.step('SOIL', 1)![1])).toBe(true);
  });
});

describe('well correlation', () => {
  it('flattens on the Hugin top at the official pick depth', () => {
    const w = field.wells.find((x) => x.id === 'F-11A')!;
    const axis = corrAxis(w.trajectory, 'tvdss', field.meta.datumElevation);
    const zones = corrZones(w.zones, axis);
    // Volve picks: F-11 A Hugin Fm. top at 2943.3 m TVDSS
    expect(corrDatum(zones, 'hugin')).toBeCloseTo(2943.3, 0);
    for (let i = 1; i < zones.length; i++) expect(zones[i].top).toBeGreaterThanOrEqual(zones[i - 1].base - 0.01);
  });

  it('keeps only the first downward pass of a horizontal well in TVDSS', () => {
    const w = field.wells.find((x) => x.id === 'F-11B')!;
    const gr = findCurve(w.logs, 'GR')!;
    const tv = corrTrack(w.logs!.depth, gr.values, corrAxis(w.trajectory, 'tvdss', field.meta.datumElevation), 0.5);
    const md = corrTrack(w.logs!.depth, gr.values, corrAxis(w.trajectory, 'md', field.meta.datumElevation), 0.5);
    for (let i = 1; i < tv.length; i++) expect(tv[i].d).toBeGreaterThan(tv[i - 1].d);
    // the ~1500 m lateral undulates within a few tens of metres of TVD, so most of it folds away
    expect(md.length).toBeGreaterThan(tv.length + 1500);
    expect(md[md.length - 1].d).toBeCloseTo(md[md.length - 1].md, 6);
  });
});

describe('crossplots', () => {
  it('Pickett iso-Sw lines satisfy Archie with the well parameters', () => {
    const w = field.wells.find((x) => x.id === 'F-11A')!;
    const p = { ...w.params, satModel: 'archie' as const };
    for (const sw of [1, 0.5, 0.2])
      for (const [rt, phi] of pickettLine(p, sw, 0.02, 0.4)) expect(waterSaturation(rt, phi, 0, p)).toBeCloseTo(Math.min(1, sw), 3);
    for (const [sw, phi] of bvwLine(0.05)) expect(sw * phi).toBeCloseTo(0.05, 6);
  });

  it('builds Hugin points for the calculated and measured plots', () => {
    const w = field.wells.find((x) => x.id === 'F-11A')!;
    const pk = crossplotPoints('pickett', w.logs!, w.petro, w.zones, { formationId: 'hugin' });
    const nd = crossplotPoints('nd', w.logs!, w.petro, w.zones, { formationId: 'hugin' });
    expect(pk.length).toBeGreaterThan(100);
    expect(nd.length).toBeGreaterThan(100);
    expect(pk.every((q) => q.formationId === 'hugin' && q.x > 0 && q.y > 0)).toBe(true);
    // Hugin sandstone: bulk density mostly 2.0–2.7 g/cm³
    const rhob = nd.map((q) => q.y).sort((a, b) => a - b);
    expect(rhob[Math.floor(rhob.length / 2)]).toBeGreaterThan(2.0);
    expect(rhob[Math.floor(rhob.length / 2)]).toBeLessThan(2.7);
  });

  it('groups selected depths into intervals', () => {
    expect(mdIntervals([10, 10.5, 11, 30, 30.5, 11.5])).toEqual([
      { top: 10, base: 11.5, n: 4 },
      { top: 30, base: 30.5, n: 2 },
    ]);
  });
});

describe('map view', () => {
  it('contours lie on the horizon at their level', () => {
    const g = field.horizons.find((x) => x.id === 'hugin')!;
    const r = horizonRange(g);
    const level = Math.round((r.min + r.max) / 2);
    const seg = contourSegments(g, level);
    expect(seg.length).toBeGreaterThan(40);
    for (let i = 0; i < seg.length; i += 2) expect(sampleHorizon(g, seg[i], seg[i + 1])).toBeCloseTo(level, 1);
  });

  it('finds where a well meets the Hugin top', () => {
    const g = field.horizons.find((x) => x.id === 'hugin')!;
    const w = field.wells.find((x) => x.id === 'F-11A')!;
    const c = horizonCrossing(w.trajectory, g, field.meta.datumElevation)!;
    expect(c).not.toBeNull();
    expect(Math.abs(c.tvdss - sampleHorizon(g, c.ew, c.ns))).toBeLessThan(2);
    // the model surface honours the F-11 A pick (3594.6 m MD) closely
    expect(Math.abs(c.md - 3594.6)).toBeLessThan(30);
  });

  it('accumulates monthly production up to a date', () => {
    const rs = field.productionMonthly.get('15/9-F-12')!;
    const total = rs.reduce((s, r) => s + r.oil, 0);
    expect(productionAt(rs, Infinity).cumOil).toBeCloseTo(total, 3);
    expect(productionAt(rs, rs[0].t - 1).started).toBe(false);
    // mid-month: the month's volume divided by its days
    const k = rs.findIndex((r) => r.oil > 0);
    const r = rs[k];
    const next = rs[k + 1];
    const days = Math.round((next.t - r.t) / 86400000);
    const s = productionAt(rs, r.t + 10 * 86400000);
    expect(s.oilRate).toBeCloseTo(r.oil / days, 6);
    expect(s.cumOil).toBeCloseTo(rs.slice(0, k + 1).reduce((a, q) => a + q.oil, 0), 3);
    const span = productionSpan(field.productionMonthly.values())!;
    expect(new Date(span.t0).getUTCFullYear()).toBe(2008);
    expect(new Date(span.t1).getUTCFullYear()).toBe(2016);
  });
});
