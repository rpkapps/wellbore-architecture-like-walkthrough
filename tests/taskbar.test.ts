import { describe, expect, it } from 'vitest';
import { missingCurves } from '../src/data/crossplot';
import type { LogSet } from '../src/data/types';
import { markTicks } from '../src/ui/marking';
import { curate, placeNear, TASKBAR_PLAN } from '../src/ui/taskbar';

const entry = (id: string, category = 'Scene', label = id, checked?: boolean) => ({ action: { id, category }, label, checked });

describe('task bar curation', () => {
  it('shows the planned steps that apply, with short labels, and keeps the rest for ⋯ in order', () => {
    const entries = [
      entry('scene.formation', 'Scene', 'Hide'),
      entry('scene.isolate', 'Scene', 'Isolate', false),
      entry('views.crossplot_zone', 'Panels', 'Crossplot this zone'),
      entry('views.flatten_correlation', 'Panels', 'Flatten correlation on this top'),
      entry('views.geosteer_target', 'Panels', 'Set as geosteering target'),
      entry('selection.properties', 'Panels', 'Properties'),
    ];
    const { primary, rest } = curate('formation', entries);
    expect(primary.map((p) => p.entry.action.id)).toEqual(['scene.isolate', 'views.crossplot_zone', 'views.flatten_correlation', 'views.geosteer_target']);
    expect(primary.map((p) => p.label)).toEqual(['Isolate', 'Crossplot zone', 'Flatten on top', 'Geosteer target']);
    expect(rest.map((e) => e.action.id)).toEqual(['scene.formation', 'selection.properties']);
  });

  it('leaves out planned steps that do not apply to this object', () => {
    // a formation the open well does not cross: no crossplot of its zone
    const { primary } = curate('formation', [entry('scene.isolate'), entry('views.flatten_correlation'), entry('views.geosteer_target')]);
    expect(primary.map((p) => p.entry.action.id)).toEqual(['scene.isolate', 'views.flatten_correlation', 'views.geosteer_target']);
  });

  it('caps the buttons, the rest going to ⋯', () => {
    const { primary, rest } = curate(
      'well',
      TASKBAR_PLAN.well.map((p) => entry(p.id)),
      2,
    );
    expect(primary).toHaveLength(2);
    expect(rest.map((e) => e.action.id)).toEqual(TASKBAR_PLAN.well.slice(2).map((p) => p.id));
  });

  it('fills a kind the plan says little about with its first actions, never Properties', () => {
    const { primary, rest } = curate('overlay', [entry('selection.properties', 'Panels', 'Properties'), entry('view.display', 'Scene', 'Hide'), entry('features.set', 'Features', 'Turn off')]);
    expect(primary.map((p) => p.label)).toEqual(['Hide', 'Turn off']);
    expect(rest.map((e) => e.action.id)).toEqual(['selection.properties']);
    expect(curate('contact', []).primary).toEqual([]);
  });
});

describe('task bar placement', () => {
  const free = { left: 0, top: 0, right: 1000, bottom: 700 };
  const bar = { w: 300, h: 36 };

  it('centres the bar above the object with a gap, so it never covers it', () => {
    const at = placeNear({ x: 500, y: 400 }, bar, free)!;
    expect(at.left).toBe(350);
    expect(at.top + bar.h).toBeLessThanOrEqual(400 - 20);
  });

  it('goes below the object near the top, and stays inside the free area', () => {
    const at = placeNear({ x: 980, y: 30 }, bar, free)!;
    expect(at.top).toBeGreaterThan(30);
    expect(at.left + bar.w).toBeLessThanOrEqual(free.right);
  });

  it('docks (null) when the object is outside the free area', () => {
    expect(placeNear({ x: -20, y: 300 }, bar, free)).toBeNull();
    expect(placeNear({ x: 500, y: 760 }, bar, free)).toBeNull();
  });
});

describe('marking ticks on the timeline', () => {
  it('maps intervals to pixels along the strip', () => {
    const t = markTicks([[1000, 1500]], 4000, 800);
    expect(t).toEqual([{ x: 200, w: 100, top: 1000, base: 1500, md: 1250, count: 1 }]);
  });

  it('gives a one-sample interval a visible width', () => {
    const [t] = markTicks([[2000, 2000]], 4000, 800, 2);
    expect(t.w).toBe(2);
  });

  it('merges intervals a few pixels apart, travelling to the longest', () => {
    // 5 m per px: 10 m apart is 2 px
    const t = markTicks(
      [
        [3000, 3005],
        [3015, 3060],
        [3500, 3510],
      ],
      4000,
      800,
    );
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ top: 3000, base: 3060, count: 2, md: 3037.5 });
    expect(t[1]).toMatchObject({ top: 3500, count: 1 });
  });

  it('ignores intervals off the well and draws nothing without a width', () => {
    expect(markTicks([[5000, 5100]], 4000, 800)).toEqual([]);
    expect(markTicks([[100, 200]], 4000, 0)).toEqual([]);
  });
});

describe('crossplot inputs', () => {
  const logs = (curves: Record<string, number[]>): LogSet =>
    ({ depth: new Float64Array([1, 2]), curves: new Map(Object.entries(curves).map(([k, v]) => [k, { mnemonic: k, unit: '', description: '', values: new Float32Array(v) }])) }) as unknown as LogSet;

  it('names the curves a plot needs that the well lacks', () => {
    expect(missingCurves('nd', undefined)).toEqual(['NPHI', 'RHOB']);
    expect(missingCurves('nd', logs({ RHOB: [2.3, 2.4] }))).toEqual(['NPHI']);
    // a curve with no values is as good as none
    expect(missingCurves('pickett', logs({ RHOB: [2.3, 2.4], RT: [NaN, NaN] }))).toEqual(['RT']);
  });
});
