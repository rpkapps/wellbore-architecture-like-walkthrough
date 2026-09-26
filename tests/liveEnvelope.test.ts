import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/connect/store';
import { binWidth, Envelope, LiveClock } from '../src/ui/liveEnvelope';

/** Readings of one channel at the given times. */
function append(s: TimeSeries, t: number[], v: number[]) {
  s.append(Float64Array.from(t), [{ name: 'ROP', unit: 'm/h', values: Float32Array.from(v) }]);
}

describe('live chart bins', () => {
  it('picks a bin width from a fixed ladder, no narrower than span / columns', () => {
    expect(binWidth(1000, 100)).toBe(16);
    expect(binWidth(1000, 90)).toBe(16);
    expect(binWidth(300_000, 600)).toBe(512);
  });

  it('keeps the min and max of each bin, and folds in only new readings', () => {
    const s = new TimeSeries();
    append(s, [0, 1, 2, 3], [5, 1, 7, 3]);
    const e = new Envelope();
    e.update(s, s.channels.get('ROP')!.v, 2);
    expect(e.size).toBe(2);
    expect([e.mn[0], e.mx[0], e.mn[1], e.mx[1]]).toEqual([1, 5, 3, 7]);
    append(s, [4, 5], [9, -2]);
    e.update(s, s.channels.get('ROP')!.v, 2);
    expect([e.mn[2], e.mx[2]]).toEqual([-2, 9]);
    // the earlier bins were not refolded
    expect([e.mn[0], e.mx[0]]).toEqual([1, 5]);
    expect(e.range(1, 4)).toEqual([0, 2]);
  });

  it('refolds when the bin width changes or the series dropped its oldest rows', () => {
    const s = new TimeSeries(8);
    append(s, [0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7, 8]);
    const e = new Envelope();
    e.update(s, s.channels.get('ROP')!.v, 4);
    expect(e.size).toBe(2);
    e.update(s, s.channels.get('ROP')!.v, 8);
    expect([e.size, e.mn[0], e.mx[0]]).toEqual([1, 1, 8]);
    // passing the maximum drops the oldest rows (t 0–3 go): the bins start again from what is left
    append(s, [8, 9], [9, 10]);
    e.update(s, s.channels.get('ROP')!.v, 8);
    expect(s.t[0]).toBe(4);
    expect([e.mn[0], e.mx[0], e.mn[1], e.mx[1]]).toEqual([5, 8, 9, 10]);
  });
});

describe('live chart clock', () => {
  it('moves the edge smoothly between batches, trailing the newest reading and never passing it', () => {
    const c = new LiveClock(400, 2000);
    c.arrive(10_000, 0);
    c.arrive(11_000, 250); // 4 data ms per wall ms
    expect(c.moving(260)).toBe(true);
    const a = c.edge(300);
    const b = c.edge(400);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(11_000);
    // a late batch: the edge waits at the newest reading instead of running ahead
    expect(c.edge(2000)).toBe(11_000);
  });

  it('never moves backwards, and rests on the newest reading when readings stop', () => {
    const c = new LiveClock(400, 2000);
    c.arrive(0, 0);
    c.arrive(1000, 250);
    const before = c.edge(490);
    c.arrive(1100, 500); // a slower batch
    expect(c.edge(500)).toBeGreaterThanOrEqual(before);
    expect(c.moving(5000)).toBe(false);
    expect(c.edge(5000)).toBe(1100);
  });
});
