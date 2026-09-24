import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadVolve, type FieldModel } from '../src/data/dataset';
import { steerProfile } from '../src/data/geosteer';
import { combineContacts, contactEvidence } from '../src/data/contacts';
import { uncertaintyAlong } from '../src/data/uncertainty';
import { ropByZone } from '../src/data/drilling';

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
