import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AC_STEP,
  KICKOFF_ALLOWANCE,
  SF_CAUTION,
  acWell,
  antiCollision,
  classify,
  closestOn,
  fieldWellbores,
  kickoffBetween,
  nearestAt,
  radiusAt,
  separationAt,
  sharedHoleTo,
  trajectoryFromPath,
  wellFamily,
  type AcWell,
} from '../src/data/anticollision';
import { loadVolve, type FieldModel } from '../src/data/dataset';
import { Trajectory, minimumCurvature } from '../src/data/trajectory';

/** A surveyed well from MD / INC / AZI stations, tied on at a surface position (m). */
function well(stations: [number, number, number][], tie = { ns: 0, ew: 0 }): Trajectory {
  const st = minimumCurvature(
    stations.map(([md, inc, azi]) => ({ md, inc, azi })),
    { tvd: 0, ...tie },
  );
  return new Trajectory(st, 'definitive', '', 'test');
}

const vertical = (td: number, tie = { ns: 0, ew: 0 }) => well([[0, 0, 0], [td, 0, 0]], tie);

describe('anti-collision: pieces', () => {
  it('classifies by separation factor', () => {
    expect(classify(0.8)).toBe('collision');
    expect(classify(1.0)).toBe('caution');
    expect(classify(1.49)).toBe('caution');
    expect(classify(SF_CAUTION)).toBe('clear');
    expect(classify(1.8, 2)).toBe('caution');
  });

  it('names the well a wellbore belongs to', () => {
    expect(wellFamily('15/9-F-11 T2')).toBe('15/9-F-11');
    expect(wellFamily('NO 15/9-F-11 B')).toBe('15/9-F-11');
    expect(wellFamily('15/9-F-12')).toBe('15/9-F-12');
  });

  it('finds the closest point on a path, between grid points', () => {
    const t = vertical(1000);
    const c = closestOn(t, 30, 40, 501.3);
    expect(c.dist).toBeCloseTo(50, 6);
    expect(c.md).toBeCloseTo(501.3, 6);
    // beyond TD: the end of the hole
    expect(closestOn(t, 0, 0, 1200).md).toBeCloseTo(1000, 6);
  });

  it('interpolates the ellipse radius', () => {
    const a = acWell('a', 'A', well([[0, 0, 0], [300, 0, 0], [2000, 60, 90]]));
    const r1 = radiusAt(a.ellipses, 1000);
    expect(r1).toBeGreaterThan(radiusAt(a.ellipses, 500));
    expect(r1).toBeLessThan(radiusAt(a.ellipses, 1500));
  });
});

describe('anti-collision: scan', () => {
  it('computes SF = distance / (k·σ_ref + k·σ_off) for two parallel wells', () => {
    const ref = acWell('ref', 'REF', vertical(2000));
    const off = acWell('off', 'OFF', vertical(2000, { ns: 12, ew: 0 }));
    const s = antiCollision(ref, [ref, off], { sigma: 2 });
    expect(s.offsets).toHaveLength(1);
    const o = s.offsets[0];
    expect(o.dist).toBeCloseTo(12, 3);
    const expected = 12 / (2 * (radiusAt(ref.ellipses, o.md) + radiusAt(off.ellipses, o.offMD)));
    expect(o.minSF).toBeCloseTo(expected, 6);
    // the ellipses grow with depth: the lowest SF is at TD
    expect(o.md).toBeCloseTo(2000, 6);
    // 3σ is closer to trouble than 1σ
    expect(antiCollision(ref, [off], { sigma: 3 }).offsets[0].minSF).toBeLessThan(antiCollision(ref, [off], { sigma: 1 }).offsets[0].minSF);
  });

  it('finds the close approach of a well that passes by, as one interval', () => {
    const ref = acWell('ref', 'REF', vertical(3000));
    // builds east from 60 m north of the reference, crosses beneath it at ~7 m and goes on
    const off = acWell('off', 'OFF', well([[0, 0, 0], [800, 0, 0], [1600, 50, 180], [3400, 50, 180]], { ns: 1200, ew: 7 }));
    const s = antiCollision(ref, [off], { sigma: 2 });
    const o = s.offsets[0];
    expect(o.status).toBe('collision');
    expect(o.dist).toBeLessThan(10);
    expect(o.intervals.length).toBe(1);
    const iv = o.intervals[0];
    expect(iv.from).toBeLessThan(o.md);
    expect(iv.to).toBeGreaterThan(o.md);
    expect(iv.minSF).toBeCloseTo(o.minSF, 9);
    // the per-depth worst SF matches
    const i = Array.from(s.mds).indexOf(o.md);
    expect(s.worst[i]).toBeCloseTo(o.minSF, 9);
    // the separation at that depth agrees with the scan
    const at = separationAt(ref, off, o.md, 2);
    expect(at.sf).toBeCloseTo(o.minSF, 6);
  });

  it('skips far wells by their bounding box, and stays fast', () => {
    const ref = acWell('ref', 'REF', well([[0, 0, 0], [500, 0, 0], [4000, 70, 45]]));
    const far: AcWell[] = [];
    for (let k = 0; k < 40; k++) far.push(acWell(`f${k}`, `F${k}`, well([[0, 0, 0], [500, 0, 0], [4000, 60, k * 9]], { ns: 5000 + k * 100, ew: -8000 })));
    const s = antiCollision(ref, far, { sigma: 2 });
    expect(s.offsets).toHaveLength(40);
    for (const o of s.offsets) {
      expect(o.status).toBe('clear');
      expect(o.intervals).toHaveLength(0);
      expect(Number.isFinite(o.minSF)).toBe(true);
    }
    expect(s.ms).toBeLessThan(1000);
  });

  it('reports the hole a sidetrack shares with its parent as shared, not a risk', () => {
    const parent = acWell('p', 'W-1', well([[0, 0, 0], [1500, 0, 0], [3000, 0, 0]]));
    // kicks off at 1500 m and builds 3°/30 m towards the east
    const side = acWell('s', 'W-1 A', well([[0, 0, 0], [1500, 0, 0], [2100, 60, 90], [3000, 60, 90]]), { kickoffMD: 1500, sister: 'p' });
    expect(sharedHoleTo(side.traj, parent.traj)).toBeGreaterThanOrEqual(1490);
    expect(kickoffBetween(side, parent)).toBeGreaterThanOrEqual(1500);
    const s = antiCollision(side, [parent], { sigma: 2, fromMD: 150 });
    const o = s.offsets[0];
    expect(o.shared).not.toBeNull();
    expect(o.shared!.kickoff).toBeGreaterThanOrEqual(1500);
    expect(o.shared!.to).toBeLessThanOrEqual(o.shared!.kickoff + KICKOFF_ALLOWANCE);
    // nothing reported inside the shared hole
    for (const iv of o.intervals) expect(iv.from).toBeGreaterThan(o.shared!.to);
    expect(o.md).toBeGreaterThan(o.shared!.to);
    expect(o.minSF).toBeGreaterThanOrEqual(SF_CAUTION);
    // a click inside the shared hole says so
    expect(nearestAt(s, side, [parent], 1000)?.status).toBe('shared');
  });

  it('keeps neighbouring slots apart: a few metres at the top is not a shared hole', () => {
    const a = vertical(1200, { ns: 0, ew: 0 });
    const b = well([[0, 0, 0], [400, 0, 0], [1200, 30, 20]], { ns: 2.5, ew: 0 });
    expect(sharedHoleTo(a, b)).toBeNull();
    const s = antiCollision(acWell('a', 'A', a), [acWell('b', 'B', b)], { sigma: 2, fromMD: 146 });
    // 2.5 m apart with sub-metre ellipses near the top: close, and the scan says how close
    expect(s.offsets[0].dist).toBeLessThan(3);
    expect(s.offsets[0].md).toBeLessThanOrEqual(500);
  });

  it('builds a trajectory from a positional path', () => {
    const t = trajectoryFromPath({ md: [0, 100, 100, 200], tvd: [0, 100, 100, 190], ns: [0, 0, 0, 30], ew: [0, 0, 0, 0] }, 'reconstructed');
    expect(t.mdEnd).toBe(200);
    expect(t.at(200).ns).toBeCloseTo(30, 3);
  });
});

// serve public/ through fetch so the real loader runs unchanged
globalThis.fetch = (async (url: string) => {
  const body = readFileSync(String(url).replace(/^\.\//, 'public/'), 'utf8');
  return { ok: true, status: 200, text: async () => body } as Response;
}) as typeof fetch;

describe('anti-collision: Volve', () => {
  let field: FieldModel;
  let all: AcWell[];
  beforeAll(async () => {
    field = await loadVolve('./data/volve/');
    all = fieldWellbores(field.wells, field.context, { picksFor: (n) => field.topsForWell(n) });
  }, 60000);

  it('takes every wellbore with a trajectory once', () => {
    expect(all.length).toBe(field.wells.length + field.context.filter((c) => !field.wells.some((w) => wellFamily(w.name) === wellFamily(c.name) && w.name.replace(/\s/g, '') === c.name.replace(/\s/g, ''))).length);
    expect(new Set(all.map((a) => a.name)).size).toBe(all.length);
    expect(all.some((a) => a.name === '15/9-F-11 T2')).toBe(true);
  });

  it('F-11 B: shared hole with F-11 A and F-11 T2 above the kick-off; the platform neighbours close in the top-hole', () => {
    const ref = all.find((a) => a.key === 'F-11B')!;
    const seabed = ref.traj.mdAtTVD(field.meta.datumElevation + field.meta.waterDepth);
    const s = antiCollision(ref, all, { sigma: 2, fromMD: seabed });
    const by = (n: string) => s.offsets.find((o) => o.name === n)!;
    // listed kick-off 2585 m; the paths part a little below it
    const a = by('15/9-F-11 A');
    expect(a.shared!.kickoff).toBeGreaterThanOrEqual(2585);
    expect(a.shared!.kickoff).toBeLessThan(2700);
    expect(a.md).toBeGreaterThan(a.shared!.to);
    expect(by('15/9-F-11 T2').shared).not.toBeNull();
    // other platform wells: no shared hole, closest in the top-hole where they leave the slots
    const f1 = by('15/9-F-1 A');
    expect(f1.shared).toBeNull();
    expect(f1.dist).toBeLessThan(10);
    expect(f1.md).toBeLessThan(1500);
    // F-12 is the closest surveyed neighbour: about 6 m apart around 1,240 m MD
    const f12 = by('15/9-F-12');
    expect(f12.dist).toBeGreaterThan(3);
    expect(f12.dist).toBeLessThan(10);
    expect(f12.status).not.toBe('clear');
    expect(f12.intervals.length).toBeGreaterThan(0);
    // the far exploration wells are clear by far
    expect(by('15/9-B-6').minSF).toBeGreaterThan(50);
    // sorted, lowest SF first
    for (let i = 1; i < s.offsets.length; i++) expect(s.offsets[i].minSF).toBeGreaterThanOrEqual(s.offsets[i - 1].minSF);
    expect(s.every).toBe(AC_STEP);
  });
});
