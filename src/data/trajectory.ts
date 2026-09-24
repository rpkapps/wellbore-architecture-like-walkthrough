import type { SurveyStation, TrajectoryStatus } from './types';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface PathPoint {
  md: number;
  tvd: number;
  ns: number;
  ew: number;
  inc: number;
  azi: number;
  dls: number; // deg / 30 m
}

/** Minimum-curvature integration of MD/INC/AZI stations. */
export function minimumCurvature(
  stations: { md: number; inc: number; azi: number }[],
  tie = { tvd: 0, ns: 0, ew: 0 },
): SurveyStation[] {
  const out: SurveyStation[] = [];
  let tvd = tie.tvd;
  let ns = tie.ns;
  let ew = tie.ew;
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (i > 0) {
      const p = stations[i - 1];
      const dmd = s.md - p.md;
      const i1 = p.inc * D2R;
      const i2 = s.inc * D2R;
      const a1 = p.azi * D2R;
      const a2 = s.azi * D2R;
      const cosDL = Math.cos(i2 - i1) - Math.sin(i1) * Math.sin(i2) * (1 - Math.cos(a2 - a1));
      const dl = Math.acos(Math.min(1, Math.max(-1, cosDL)));
      const rf = dl < 1e-9 ? 1 : (2 / dl) * Math.tan(dl / 2);
      ns += (dmd / 2) * (Math.sin(i1) * Math.cos(a1) + Math.sin(i2) * Math.cos(a2)) * rf;
      ew += (dmd / 2) * (Math.sin(i1) * Math.sin(a1) + Math.sin(i2) * Math.sin(a2)) * rf;
      tvd += (dmd / 2) * (Math.cos(i1) + Math.cos(i2)) * rf;
    }
    out.push({ md: s.md, inc: s.inc, azi: s.azi, tvd, ns, ew });
  }
  return out;
}

function dirVec(inc: number, azi: number): [number, number, number] {
  const i = inc * D2R;
  const a = azi * D2R;
  return [Math.sin(i) * Math.cos(a), Math.sin(i) * Math.sin(a), Math.cos(i)]; // N, E, down
}

function vecToIncAzi(v: [number, number, number]): [number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  const inc = Math.acos(Math.min(1, Math.max(-1, v[2] / len))) * R2D;
  let azi = Math.atan2(v[1], v[0]) * R2D;
  if (azi < 0) azi += 360;
  return [inc, azi];
}

/**
 * A wellbore trajectory resampled to a dense, regular MD grid so that all
 * geometry (tubes, markers, cameras) can use cheap linear interpolation.
 */
export class Trajectory {
  readonly md: Float64Array;
  readonly tvd: Float64Array;
  readonly ns: Float64Array;
  readonly ew: Float64Array;
  readonly inc: Float64Array;
  readonly azi: Float64Array;
  readonly dls: Float64Array;
  readonly step: number;
  readonly stations: SurveyStation[];

  constructor(
    stations: SurveyStation[],
    readonly status: TrajectoryStatus,
    readonly note: string,
    readonly source: string,
    step = 2,
  ) {
    this.stations = stations;
    const md0 = stations[0].md;
    const md1 = stations[stations.length - 1].md;
    const n = Math.max(2, Math.ceil((md1 - md0) / step) + 1);
    this.step = (md1 - md0) / (n - 1);
    this.md = new Float64Array(n);
    this.tvd = new Float64Array(n);
    this.ns = new Float64Array(n);
    this.ew = new Float64Array(n);
    this.inc = new Float64Array(n);
    this.azi = new Float64Array(n);
    this.dls = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const md = md0 + k * this.step;
      while (j < stations.length - 2 && stations[j + 1].md < md) j++;
      const a = stations[j];
      const b = stations[j + 1] ?? a;
      const span = b.md - a.md;
      const t = span > 0 ? Math.min(1, Math.max(0, (md - a.md) / span)) : 0;
      // minimum-curvature interpolation: slerp the tangent, integrate the arc
      const va = dirVec(a.inc, a.azi);
      const vb = dirVec(b.inc, b.azi);
      const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
      const dl = Math.acos(dot);
      let p: [number, number, number];
      let dir: [number, number, number];
      if (dl < 1e-6 || span <= 0) {
        dir = va;
        p = [a.ns + va[0] * (md - a.md), a.ew + va[1] * (md - a.md), a.tvd + va[2] * (md - a.md)];
        // blend towards the exact station positions to cancel rounding drift
        const w = t;
        const q: [number, number, number] = [b.ns - vb[0] * (b.md - md), b.ew - vb[1] * (b.md - md), b.tvd - vb[2] * (b.md - md)];
        p = [p[0] * (1 - w) + q[0] * w, p[1] * (1 - w) + q[1] * w, p[2] * (1 - w) + q[2] * w];
      } else {
        const s = Math.sin(dl);
        const wa = Math.sin((1 - t) * dl) / s;
        const wb = Math.sin(t * dl) / s;
        dir = [va[0] * wa + vb[0] * wb, va[1] * wa + vb[1] * wb, va[2] * wa + vb[2] * wb];
        // position on the circular arc: integral of slerp
        const R = span / dl;
        const c1 = (Math.cos(0) - Math.cos(t * dl)) / s; // ∫ sin(τ) dτ terms
        const ca = (Math.cos((1 - t) * dl) - Math.cos(dl)) / s;
        const pa = R * ca;
        const pb = R * c1;
        p = [a.ns + va[0] * pa + vb[0] * pb, a.ew + va[1] * pa + vb[1] * pb, a.tvd + va[2] * pa + vb[2] * pb];
        // correct small inconsistency vs. supplied positions (positional surveys)
        const Rb = R * ((1 - Math.cos(dl)) / s);
        const endErr = [
          b.ns - (a.ns + (va[0] + vb[0]) * Rb),
          b.ew - (a.ew + (va[1] + vb[1]) * Rb),
          b.tvd - (a.tvd + (va[2] + vb[2]) * Rb),
        ];
        p = [p[0] + endErr[0] * t, p[1] + endErr[1] * t, p[2] + endErr[2] * t];
      }
      const [inc, azi] = vecToIncAzi(dir);
      this.md[k] = md;
      this.ns[k] = p[0];
      this.ew[k] = p[1];
      this.tvd[k] = p[2];
      this.inc[k] = inc;
      this.azi[k] = azi;
      this.dls[k] = span > 0 ? ((dl * R2D) / span) * 30 : 0;
    }
  }

  get mdStart() {
    return this.md[0];
  }
  get mdEnd() {
    return this.md[this.md.length - 1];
  }

  at(md: number): PathPoint {
    const n = this.md.length;
    const f = Math.min(n - 1.000001, Math.max(0, (md - this.md[0]) / this.step));
    const i = Math.floor(f);
    const t = f - i;
    const L = (a: Float64Array) => a[i] + (a[i + 1] - a[i]) * t;
    let da = this.azi[i + 1] - this.azi[i];
    if (da > 180) da -= 360;
    if (da < -180) da += 360;
    return {
      md,
      tvd: L(this.tvd),
      ns: L(this.ns),
      ew: L(this.ew),
      inc: L(this.inc),
      azi: (this.azi[i] + da * t + 360) % 360,
      dls: L(this.dls),
    };
  }

  /** MD at which TVD first reaches the given value (NaN if never). */
  mdAtTVD(tvd: number): number {
    for (let i = 1; i < this.md.length; i++) {
      if (this.tvd[i] >= tvd) {
        const t = (tvd - this.tvd[i - 1]) / (this.tvd[i] - this.tvd[i - 1] || 1);
        return this.md[i - 1] + t * this.step;
      }
    }
    return NaN;
  }

  /** Closest MD to a local (ns, ew, tvd) point. */
  closestMD(ns: number, ew: number, tvd: number): { md: number; dist: number } {
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < this.md.length; i++) {
      const d = (this.ns[i] - ns) ** 2 + (this.ew[i] - ew) ** 2 + (this.tvd[i] - tvd) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return { md: this.md[bi], dist: Math.sqrt(best) };
  }

  /** Classify hole section by inclination. */
  static sectionType(inc: number): 'vertical' | 'deviated' | 'high-angle' | 'horizontal' {
    if (inc < 5) return 'vertical';
    if (inc < 60) return 'deviated';
    if (inc < 80) return 'high-angle';
    return 'horizontal';
  }
}

/** Build stations from a parsed survey table (angles and/or positions). */
export function stationsFromSurvey(
  rows: { md: number; inc: number; azi: number; tvd: number; ns: number; ew: number }[],
  hasPositions: boolean,
  tie = { tvd: 0, ns: 0, ew: 0 },
): SurveyStation[] {
  const hasAngles = rows.every((r) => Number.isFinite(r.inc) && Number.isFinite(r.azi));
  let st: SurveyStation[];
  if (hasAngles && !hasPositions) {
    const first = rows[0];
    const pre = first.md > 0 ? [{ md: 0, inc: 0, azi: 0 }] : [];
    st = minimumCurvature([...pre, ...rows], tie);
  } else if (hasPositions) {
    st = rows.map((r) => ({ ...r }));
    // derive angles where missing from positional differences
    for (let i = 0; i < st.length; i++) {
      if (Number.isFinite(st[i].inc) && Number.isFinite(st[i].azi)) continue;
      const a = st[Math.max(0, i - 1)];
      const b = st[Math.min(st.length - 1, i + 1)];
      const [inc, azi] = vecToIncAzi([b.ns - a.ns, b.ew - a.ew, b.tvd - a.tvd]);
      st[i].inc = inc;
      st[i].azi = azi;
    }
    if (st[0].md > 0) st.unshift({ md: 0, inc: 0, azi: 0, tvd: st[0].tvd - st[0].md, ns: st[0].ns, ew: st[0].ew });
  } else throw new Error('Survey lacks usable angles or positions');
  return st;
}
