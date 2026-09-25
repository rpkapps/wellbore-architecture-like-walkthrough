import type { Curve, LogSet, Provenance } from '../data/types';
import type { LogChannel } from './frames';

/**
 * Where streamed data accumulates on the page. Both stores keep spare
 * capacity and grow by doubling, so appending a second of readings is a
 * copy into place rather than a new array per update.
 */

function grow<T extends Float64Array | Float32Array>(a: T, need: number, fill = NaN): T {
  if (need <= a.length) return a;
  const C = a.constructor as { new (n: number): T };
  const b = new C(Math.max(need, a.length * 2, 1024));
  b.fill(fill as never);
  b.set(a);
  return b;
}

/**
 * A well's depth log that keeps growing. It adopts the well's existing
 * curves on first use; incoming rows below the deepest depth are appended,
 * rows inside the range update the nearest sample (a NaN never overwrites a
 * value, so partial rows from different sensors combine).
 */
export class LiveLog {
  private depth: Float64Array;
  private curves = new Map<string, { meta: Omit<Curve, 'values'>; v: Float32Array }>();
  private n: number;
  private base: LogSet | undefined;

  constructor(
    existing: LogSet | undefined,
    private readonly source: string,
  ) {
    this.base = existing;
    this.n = existing?.depth.length ?? 0;
    this.depth = grow(new Float64Array(0), Math.max(1024, this.n * 2));
    if (existing) {
      this.depth.set(existing.depth);
      for (const [k, c] of existing.curves) {
        const v = grow(new Float32Array(0), this.depth.length);
        v.set(c.values);
        this.curves.set(k, { meta: { mnemonic: c.mnemonic, unit: c.unit, description: c.description, provenance: c.provenance, source: c.source }, v });
      }
    }
  }

  get length() {
    return this.n;
  }
  get last() {
    return this.n ? this.depth[this.n - 1] : -Infinity;
  }

  /** Merge rows; returns whether a curve that did not exist before appeared. */
  merge(key: Float64Array, channels: LogChannel[], binWidth = 0, provenance: Provenance = 'measured'): boolean {
    let added = false;
    for (const ch of channels) {
      if (!this.curves.has(ch.name)) {
        added = true;
        this.curves.set(ch.name, {
          meta: { mnemonic: ch.name, unit: ch.unit, description: ch.description || ch.name, provenance, source: this.source },
          v: new Float32Array(this.depth.length).fill(NaN),
        });
      }
    }
    const cols = channels.map((c) => ({ src: c.values, dst: this.curves.get(c.name)! }));
    // a row matches an existing one within half a sampling step (of the log, or of the incoming bins
    // when the step that made them said how wide they are); past the last row, rows are appended
    const step = this.n > 1 ? (this.depth[this.n - 1] - this.depth[0]) / (this.n - 1) : 0;
    const tol = Math.max(step, binWidth) > 0 ? Math.max(step, binWidth) / 2 : 1e-6;
    // bins coarser than the log's rows cover several of them: spread each value over the rows it covers
    const spread = binWidth > step * 1.2 ? binWidth / 2 : 0;
    for (let i = 0; i < key.length; i++) {
      const d = key[i];
      if (!Number.isFinite(d)) continue;
      let at: number;
      if (!this.n || d > this.depth[this.n - 1] + (binWidth > 0 ? binWidth / 2 : tol)) {
        at = this.n++;
        this.ensure(this.n);
        this.depth[at] = d;
      } else {
        at = this.nearest(d);
        if (Math.abs(this.depth[at] - d) > tol) {
          // between samples of a coarser log, or above its top: insert in order
          at = this.insert(d);
        }
      }
      for (const c of cols) {
        const v = c.src[i];
        if (Number.isNaN(v)) continue;
        c.dst.v[at] = v;
        if (spread) {
          for (let j = at - 1; j >= 0 && d - this.depth[j] < spread; j--) if (Number.isNaN(c.dst.v[j])) c.dst.v[j] = v;
          for (let j = at + 1; j < this.n && this.depth[j] - d < spread; j++) if (Number.isNaN(c.dst.v[j])) c.dst.v[j] = v;
        }
      }
    }
    return added;
  }

  /** The current log as the rest of the app reads it (views, no copies). */
  view(wellName: string): LogSet {
    const curves = new Map<string, Curve>();
    for (const [k, c] of this.curves) curves.set(k, { ...c.meta, values: c.v.subarray(0, this.n) });
    return {
      wellName,
      depth: this.depth.subarray(0, this.n),
      curves,
      header: this.base?.header ?? {},
      source: this.base ? `${this.base.source} + ${this.source}` : this.source,
      provenance: this.base?.provenance ?? 'measured',
    };
  }

  private ensure(n: number) {
    if (n <= this.depth.length) return;
    this.depth = grow(this.depth, n, 0);
    for (const c of this.curves.values()) c.v = grow(c.v, this.depth.length);
  }

  private nearest(d: number): number {
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.depth[m] <= d) lo = m;
      else hi = m;
    }
    return Math.abs(this.depth[lo] - d) <= Math.abs(this.depth[hi] - d) ? lo : hi;
  }

  private insert(d: number): number {
    this.ensure(this.n + 1);
    let at = 0;
    while (at < this.n && this.depth[at] < d) at++;
    this.depth.copyWithin(at + 1, at, this.n);
    this.depth[at] = d;
    for (const c of this.curves.values()) {
      c.v.copyWithin(at + 1, at, this.n);
      c.v[at] = NaN;
    }
    this.n++;
    return at;
  }
}

/** Time-indexed readings of one well, for the live charts. Oldest rows go when it passes `max`. */
export class TimeSeries {
  t = new Float64Array(4096);
  readonly channels = new Map<string, { unit: string; description?: string; v: Float32Array }>();
  n = 0;
  constructor(private readonly max = 400_000) {}

  get first() {
    return this.n ? this.t[0] : NaN;
  }
  get last() {
    return this.n ? this.t[this.n - 1] : NaN;
  }

  append(key: Float64Array, channels: LogChannel[]) {
    for (const c of channels) if (!this.channels.has(c.name)) this.channels.set(c.name, { unit: c.unit, description: c.description, v: new Float32Array(this.t.length).fill(NaN) });
    const need = this.n + key.length;
    if (need > this.t.length) {
      this.t = grow(this.t, need, 0);
      for (const c of this.channels.values()) c.v = grow(c.v, this.t.length);
    }
    const inOrder = !this.n || key[0] >= this.t[this.n - 1];
    const at = this.n;
    this.t.set(key, at);
    for (const [name, c] of this.channels) {
      const src = channels.find((x) => x.name === name);
      if (src) c.v.set(src.values, at);
      else c.v.fill(NaN, at, at + key.length);
    }
    this.n = need;
    if (!inOrder) this.sort();
    if (this.n > this.max) this.drop(this.n - Math.floor(this.max * 0.75));
  }

  /** Index of the first row at or after time `t`. */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.t[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  private sort() {
    const order = [...Array(this.n).keys()].sort((a, b) => this.t[a] - this.t[b]);
    this.t = Float64Array.from({ length: this.t.length }, (_, i) => (i < this.n ? this.t[order[i]] : 0));
    for (const c of this.channels.values()) {
      const v = c.v;
      c.v = Float32Array.from({ length: v.length }, (_, i) => (i < this.n ? v[order[i]] : NaN));
    }
  }

  private drop(k: number) {
    this.t.copyWithin(0, k, this.n);
    for (const c of this.channels.values()) c.v.copyWithin(0, k, this.n);
    this.n -= k;
  }
}
