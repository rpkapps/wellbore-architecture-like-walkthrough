import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { acWell, fieldWellbores, radiusAt, separationAt, type AcWell } from '../src/data/anticollision';
import { TC_HALF, normalPlane, tcAngle, tcPlot, tcRadius, toPlane, travellingCylinder } from '../src/data/cylinder';
import { loadVolve, type FieldModel } from '../src/data/dataset';
import { Trajectory, minimumCurvature } from '../src/data/trajectory';

function well(stations: [number, number, number][], tie = { ns: 0, ew: 0 }): Trajectory {
  const st = minimumCurvature(
    stations.map(([md, inc, azi]) => ({ md, inc, azi })),
    { tvd: 0, ...tie },
  );
  return new Trajectory(st, 'definitive', '', 'test');
}
const vertical = (td: number, tie = { ns: 0, ew: 0 }) => well([[0, 0, 0], [td, 0, 0]], tie);

describe('travelling cylinder: the plane across the hole', () => {
  it('is orthonormal, with the high side up and right 90° clockwise, looking down the hole', () => {
    // horizontal towards the north: high side is straight up, right is east
    const f = normalPlane(well([[0, 0, 0], [300, 0, 0], [1200, 90, 0], [2000, 90, 0]]), 1800);
    expect(f.north).toBe(false);
    expect(f.along[0]).toBeCloseTo(1, 3);
    expect(f.up[2]).toBeCloseTo(-1, 3);
    expect(f.right[1]).toBeCloseTo(1, 3);
    for (const [a, b] of [
      [f.along, f.up],
      [f.along, f.right],
      [f.up, f.right],
    ])
      expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(0, 9);
    // a point above the hole plots up, one east of it right, one ahead of it on the axis
    const o = f.origin;
    expect(toPlane(f, o[0], o[1], o[2] - 10)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(10, 6) });
    expect(toPlane(f, o[0], o[1] + 7, o[2])).toMatchObject({ x: expect.closeTo(7, 6), y: expect.closeTo(0, 6) });
    expect(toPlane(f, o[0] + 30, o[1], o[2]).along).toBeCloseTo(30, 6);
  });

  it('puts the high side up for an inclined hole, whatever the azimuth', () => {
    const f = normalPlane(well([[0, 0, 0], [300, 0, 0], [1000, 40, 135], [2000, 40, 135]]), 1500);
    expect(f.inc).toBeCloseTo(40, 3);
    // up leans back up the hole: its TVD part is −sin(inc), its plan part points along the azimuth
    expect(f.up[2]).toBeCloseTo(-Math.sin((40 * Math.PI) / 180), 3);
    expect(Math.atan2(f.up[1], f.up[0]) * (180 / Math.PI)).toBeCloseTo(135, 1);
  });

  it('has north up in a vertical hole, and east on the right', () => {
    const f = normalPlane(vertical(1000), 500);
    expect(f.north).toBe(true);
    expect(f.up[0]).toBeCloseTo(1, 6);
    expect(f.right[1]).toBeCloseTo(1, 6);
  });

  it('measures angles clockwise from the top, on a square-root radial scale', () => {
    expect(tcAngle(0, 1)).toBeCloseTo(0, 6);
    expect(tcAngle(1, 0)).toBeCloseTo(90, 6);
    expect(tcAngle(0, -1)).toBeCloseTo(180, 6);
    expect(tcAngle(-1, 0)).toBeCloseTo(270, 6);
    expect(tcRadius(100, 100)).toBe(1);
    expect(tcRadius(25, 100)).toBe(0.5);
    const p = tcPlot(0, -25, 100);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(-0.5, 9);
    expect(tcPlot(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('travelling cylinder: the offsets', () => {
  it('projects a parallel well to one spot, with the SF of the scan', () => {
    const ref = acWell('ref', 'REF', vertical(2000));
    const off = acWell('off', 'OFF', vertical(2000, { ns: 0, ew: 12 }));
    const far = acWell('far', 'FAR', vertical(2000, { ns: 300, ew: 0 }));
    const v = travellingCylinder(ref, [ref, off, far], 1000, { sigma: 2 });
    expect(v.offsets.map((o) => o.key)).toEqual(['off']);
    const o = v.offsets[0];
    expect(o.dist).toBeCloseTo(12, 3);
    expect(o.at.x).toBeCloseTo(12, 3);
    expect(o.at.y).toBeCloseTo(0, 3);
    expect(o.sf).toBeCloseTo(separationAt(ref, off, 1000, 2).sf, 6);
    expect(v.refRadius).toBeCloseTo(2 * radiusAt(ref.ellipses, 1000), 6);
    // the drawn stretch: ±150 m along the offset, all on the same spot, running from behind the plane to ahead of it
    expect(o.path[0].md).toBeCloseTo(1000 - TC_HALF, 6);
    expect(o.path[o.path.length - 1].md).toBeCloseTo(1000 + TC_HALF, 6);
    for (const p of o.path) expect(Math.hypot(p.x - 12, p.y)).toBeLessThan(0.01);
    expect(o.path[0].along).toBeCloseTo(-TC_HALF, 3);
    // a wider range takes in the far well
    expect(travellingCylinder(ref, [off, far], 1000, { range: 400 }).offsets.map((q) => q.key)).toEqual(['off', 'far']);
  });

  it('draws a crossing well as a line through its closest point', () => {
    // the reference runs north, horizontal; the offset crosses it 20 m below, running east
    const ref = acWell('ref', 'REF', well([[0, 0, 0], [300, 0, 0], [1200, 90, 0], [3000, 90, 0]]));
    const p = ref.traj.at(2000);
    const off = acWell('x', 'X', well([[0, 90, 90], [600, 90, 90]], { ns: p.ns, ew: p.ew - 300 }));
    // (tie the offset 20 m below the reference's plane)
    const t = off.traj;
    const shifted = acWell('x', 'X', new Trajectory(t.stations.map((s) => ({ ...s, tvd: p.tvd + 20 })), 'definitive', '', 'test'));
    const v = travellingCylinder(ref, [shifted], 2000);
    expect(v.offsets).toHaveLength(1);
    const o = v.offsets[0];
    expect(o.dist).toBeCloseTo(20, 1);
    // below the hole: straight down on the plot, low side
    expect(tcAngle(o.at.x, o.at.y)).toBeCloseTo(180, 0);
    // the path runs left to right through it, in the plane
    const xs = o.path.map((q) => q.x);
    expect(Math.min(...xs)).toBeLessThan(-100);
    expect(Math.max(...xs)).toBeGreaterThan(100);
    for (const q of o.path) expect(Math.abs(q.along)).toBeLessThan(0.5);
  });

  it('lists a sidetrack above its kick-off as shared hole, not as a risk', () => {
    const parent = acWell('p', 'W-1', well([[0, 0, 0], [1500, 0, 0], [3000, 0, 0]]));
    const side = acWell('s', 'W-1 A', well([[0, 0, 0], [1500, 0, 0], [2100, 60, 90], [3000, 60, 90]]), { kickoffMD: 1500, sister: 'p' });
    const kops = new Map<string, number | null>();
    const above = travellingCylinder(side, [parent], 1000, { kickoffs: kops });
    expect(above.offsets).toHaveLength(0);
    expect(above.shared.map((o) => o.key)).toEqual(['p']);
    expect(above.shared[0].status).toBe('shared');
    expect(kops.get('p')).toBeGreaterThanOrEqual(1500);
    // well below it (past the allowance), the parent is an offset like any other
    const below = travellingCylinder(side, [parent], 1800, { kickoffs: kops });
    expect(below.shared).toHaveLength(0);
    expect(below.offsets.map((o) => o.key)).toEqual(['p']);
  });
});

globalThis.fetch = (async (url: string) => {
  const body = readFileSync(String(url).replace(/^\.\//, 'public/'), 'utf8');
  return { ok: true, status: 200, text: async () => body } as Response;
}) as typeof fetch;

describe('travelling cylinder: Volve', () => {
  let field: FieldModel;
  let all: AcWell[];
  beforeAll(async () => {
    field = await loadVolve('./data/volve/');
    all = fieldWellbores(field.wells, field.context, { picksFor: (n) => field.topsForWell(n) });
  }, 60000);

  it('F-11 B at 1,240 m: F-12 about 6 m away at SF ≈ 1.05 (2σ), the F-1 family about 79 m; its sidetrack sisters are shared hole', () => {
    const ref = all.find((a) => a.key === 'F-11B')!;
    const v = travellingCylinder(ref, all, 1240, { sigma: 2 });
    expect(v.frame.inc).toBeGreaterThan(15);
    expect(v.frame.north).toBe(false);
    const f12 = v.offsets[0];
    expect(f12.name).toBe('15/9-F-12');
    expect(f12.dist).toBeGreaterThan(4);
    expect(f12.dist).toBeLessThan(9);
    expect(f12.sf).toBeGreaterThan(0.9);
    expect(f12.sf).toBeLessThan(1.2);
    expect(f12.status).toBe('caution');
    const f1 = v.offsets.filter((o) => /^15\/9-F-1( [A-C])?$/.test(o.name));
    expect(f1.length).toBeGreaterThanOrEqual(3);
    for (const o of f1) {
      expect(o.dist).toBeGreaterThan(70);
      expect(o.dist).toBeLessThan(90);
      expect(o.status).toBe('clear');
    }
    expect(v.shared.map((o) => o.name).sort()).toEqual(['15/9-F-11 A', '15/9-F-11 T2']);
    for (const o of v.offsets) expect(o.dist).toBeLessThanOrEqual(v.range);
  });
});
