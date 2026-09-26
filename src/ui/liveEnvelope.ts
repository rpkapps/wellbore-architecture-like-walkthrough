import type { TimeSeries } from '../connect/store';

/**
 * The live charts' drawing budget: one span per pixel column, whatever the
 * number of readings. A channel's readings are folded into min / max bins
 * of a fixed width in time, anchored to absolute time, so the window can
 * slide every frame without refolding anything: new readings only touch the
 * last bins, and a frame reads the ~W bins it shows.
 */

/** A bin width close to (and not below) `span / columns`, from a fixed ladder so small resizes keep it. */
export function binWidth(span: number, columns: number): number {
  const target = Math.max(1, span / Math.max(1, columns));
  return 2 ** Math.ceil(Math.log2(target));
}

export class Envelope {
  /** ms per bin */
  bin = 0;
  /** absolute bin number of slot 0 */
  base = 0;
  /** bins in use */
  size = 0;
  mn = new Float32Array(0);
  mx = new Float32Array(0);
  /** rows of the series folded in, and the time of the last one (a series that dropped or re-sorted rows no longer has it there) */
  private done = 0;
  private lastT = NaN;

  /** Bring the bins up to date with the series; refolds everything only when the bin width or the rows' order changed. */
  update(s: TimeSeries, v: Float32Array, bin: number) {
    const intact = this.bin === bin && this.done <= s.n && (this.done === 0 || s.t[this.done - 1] === this.lastT);
    if (!intact) {
      this.bin = bin;
      this.done = 0;
      this.size = 0;
      this.base = s.n ? Math.floor(s.t[0] / bin) : 0;
    }
    for (let i = this.done; i < s.n; i++) {
      const x = v[i];
      if (Number.isNaN(x)) continue;
      const k = Math.floor(s.t[i] / bin) - this.base;
      // readings older than the first bin (not expected once sorted): start again from them
      if (k < 0) {
        this.done = 0;
        this.bin = 0;
        this.update(s, v, bin);
        return;
      }
      this.ensure(k + 1);
      if (Number.isNaN(this.mn[k])) {
        this.mn[k] = x;
        this.mx[k] = x;
      } else {
        if (x < this.mn[k]) this.mn[k] = x;
        if (x > this.mx[k]) this.mx[k] = x;
      }
    }
    this.done = s.n;
    this.lastT = s.n ? s.t[s.n - 1] : NaN;
  }

  private ensure(n: number) {
    if (n > this.mn.length) {
      const cap = Math.max(n, this.mn.length * 2, 1024);
      const mn = new Float32Array(cap).fill(NaN);
      const mx = new Float32Array(cap).fill(NaN);
      mn.set(this.mn.subarray(0, this.size));
      mx.set(this.mx.subarray(0, this.size));
      this.mn = mn;
      this.mx = mx;
    }
    if (n > this.size) {
      this.mn.fill(NaN, this.size, n);
      this.mx.fill(NaN, this.size, n);
      this.size = n;
    }
  }

  /** Slots of the bins that overlap [t0, t1], clamped to those in use. */
  range(t0: number, t1: number): [number, number] {
    const a = Math.max(0, Math.floor(t0 / this.bin) - this.base);
    const b = Math.min(this.size - 1, Math.floor(t1 / this.bin) - this.base);
    return [a, b];
  }
}

/**
 * The time the charts show at their right edge. Readings arrive in batches
 * (a few a second), so drawing the newest one makes the strip jump; instead
 * the edge trails the newest reading by `lag` of wall-clock time and moves on
 * every frame at the rate the data has been arriving, never past the data
 * and never backwards. When nothing new has come for a while it rests on
 * the newest reading.
 */
export class LiveClock {
  /** data ms per wall ms */
  private rate = 0;
  private arrivedAt = 0;
  private lastData = NaN;
  private shown = -Infinity;
  constructor(
    private readonly lag = 400,
    private readonly idleAfter = 2000,
  ) {}

  /** A batch arrived: the newest reading is now `last`. */
  arrive(last: number, now: number) {
    // no new reading (another well's batch, or a repeat): the pace stays as it was
    if (!Number.isFinite(last) || last === this.lastData) return;
    if (Number.isFinite(this.lastData) && last > this.lastData && now > this.arrivedAt) {
      const observed = (last - this.lastData) / (now - this.arrivedAt);
      this.rate = this.rate ? this.rate * 0.7 + observed * 0.3 : observed;
    } else if (!Number.isFinite(this.lastData) || last < this.lastData) {
      // a first batch, or the series restarted: nothing to pace by yet
      this.rate = 0;
      this.shown = -Infinity;
    }
    this.lastData = last;
    this.arrivedAt = now;
  }

  /** Is the edge still moving (data arrived recently and its pace is known)? */
  moving(now: number) {
    return this.rate > 0 && now - this.arrivedAt < this.idleAfter;
  }

  /** The time at the right edge now. */
  edge(now: number): number {
    if (!Number.isFinite(this.lastData)) return NaN;
    if (!this.moving(now)) return (this.shown = Math.max(this.shown, this.lastData));
    const t = this.lastData - this.rate * this.lag + this.rate * (now - this.arrivedAt);
    this.shown = Math.max(this.shown, Math.min(this.lastData, t));
    return this.shown;
  }
}
