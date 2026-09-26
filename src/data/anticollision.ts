import { Trajectory, stationsFromSurvey } from './trajectory';
import { DEFAULT_ERROR_MODEL, uncertaintyAlong, type Ellipse, type ErrorModel } from './uncertainty';
import type { ContextWell, Top, TrajectoryStatus } from './types';

/**
 * Well anti-collision: how close the active (reference) well comes to every
 * other wellbore, as a separation factor
 *
 *   SF = centre-to-centre distance / (k·σ_ref + k·σ_off)
 *
 * where σ is the major semi-axis of each well's 1σ position-uncertainty
 * ellipse (the simplified MWD model of `uncertainty.ts`) at the two closest
 * points and k the confidence multiplier (1, 2 or 3σ). This is the classic
 * "sum of ellipse radii" separation factor, deliberately conservative (the
 * largest axis in every direction). It is not a full ISCWSA calculation: no
 * pedal-curve or combined covariance along the line between the wells, no
 * hole or casing radii, no along-hole (depth) error in the radius, no tool
 * codes, surface-position or survey-program errors.
 *
 * The reference is sampled every ~10 m MD from the seabed down (above it the
 * wells stand in their conductors in the platform's slot guides); on every
 * offset wellbore the closest point is found in 3D (the normal plane is not
 * used). Sidetracks and their parent share the hole above the kick-off: that
 * section, and the first metres below it while the new hole is still leaving
 * the old one, is reported as "shared hole", not as a risk.
 */

/** SF below this: the ellipses overlap — collision risk. */
export const SF_COLLISION = 1.0;
/** SF below this (and ≥ SF_COLLISION): caution — needs a closer look before drilling. */
export const SF_CAUTION = 1.5;
/** Caution thresholds offered in the settings. */
export const CAUTION_CHOICES = [1.25, 1.5, 2.0];
/** Reference sample spacing (m MD). */
export const AC_STEP = 10;
/** Two paths closer than this at the same MD are the same hole (m). */
export const SHARED_TOL = 1.0;
/** At least this much hole in common (m MD) before two paths count as parent and sidetrack, not neighbouring slots. */
export const SHARED_MIN = 50;
/** How far below a kick-off the sidetrack may still be leaving its parent (below the caution threshold) before that counts (m MD). */
export const KICKOFF_ALLOWANCE = 250;

export type AcStatus = 'collision' | 'caution' | 'clear' | 'shared';

export const AC_COLOR: Record<AcStatus, string> = {
  collision: '#ff5a67',
  caution: '#ffb547',
  clear: '#5fe0a0',
  shared: '#9aa1a8',
};

export const AC_LABEL: Record<AcStatus, string> = {
  collision: 'collision risk',
  caution: 'caution',
  clear: 'clear',
  shared: 'shared hole',
};

export function classify(sf: number, caution = SF_CAUTION): AcStatus {
  if (sf < SF_COLLISION) return 'collision';
  if (sf < caution) return 'caution';
  return 'clear';
}

/** The well a wellbore belongs to: its name without the sidetrack / re-entry suffix ("15/9-F-11 T2" → "15/9-F-11"). */
export function wellFamily(name: string): string {
  return name.trim().replace(/^NO\s+/i, '').split(/\s+/)[0].toUpperCase();
}

/** A wellbore prepared for the scan: its path and its 1σ ellipses. */
export interface AcWell {
  key: string;
  name: string;
  traj: Trajectory;
  /** 1σ uncertainty ellipses at a regular MD step (from `uncertaintyAlong`) */
  ellipses: Ellipse[];
  /** axis-aligned bounds of the path (ns, ew, tvd) */
  box: { min: [number, number, number]; max: [number, number, number] };
  /** the largest 1σ radius along the path */
  maxRadius: number;
  /** from the well list: kicked off from `sister` at this MD */
  kickoffMD?: number;
  sister?: string;
}

export function acWell(
  key: string,
  name: string,
  traj: Trajectory,
  opts: { reconstructedFrom?: number; picks?: Top[]; kickoffMD?: number; sister?: string } = {},
  model: ErrorModel = DEFAULT_ERROR_MODEL,
  every = AC_STEP,
): AcWell {
  const ellipses = uncertaintyAlong(traj, every, model, { reconstructedFrom: opts.reconstructedFrom, picks: opts.picks });
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < traj.md.length; i++) {
    const p = [traj.ns[i], traj.ew[i], traj.tvd[i]];
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  let maxRadius = 0;
  for (const e of ellipses) maxRadius = Math.max(maxRadius, e.major);
  return { key, name, traj, ellipses, box: { min, max }, maxRadius, kickoffMD: opts.kickoffMD, sister: opts.sister };
}

/** A regular trajectory through a positional path (the context wellbores carry MD / TVD / NS / EW only). */
export function trajectoryFromPath(
  p: { md: ArrayLike<number>; tvd: ArrayLike<number>; ns: ArrayLike<number>; ew: ArrayLike<number> },
  status: TrajectoryStatus,
  note = '',
  source = '',
): Trajectory {
  const rows: { md: number; inc: number; azi: number; tvd: number; ns: number; ew: number }[] = [];
  for (let i = 0; i < p.md.length; i++) {
    // repeated MDs would give zero-length intervals
    if (rows.length && p.md[i] <= rows[rows.length - 1].md + 1e-6) continue;
    rows.push({ md: p.md[i], inc: NaN, azi: NaN, tvd: p.tvd[i], ns: p.ns[i], ew: p.ew[i] });
  }
  return new Trajectory(stationsFromSurvey(rows, true), status, note, source);
}

/** A wellbore of the field with its own survey (a `Well`, structurally). */
export interface AcSourceWell {
  id: string;
  name: string;
  trajectory: Trajectory;
  kickoffMD?: number;
  sister?: string;
  tops?: Top[];
}

const sameName = (a: string, b: string) => {
  const k = (s: string) => s.toUpperCase().replace(/^NO\s+/, '').replace(/[^A-Z0-9]/g, '');
  return k(a) === k(b);
};

/**
 * Every wellbore of the field with a trajectory: the wells with their own
 * survey, then the context wellbores that are not one of them. A trajectory
 * reconstructed through pick coordinates gets the reconstruction allowance
 * of the uncertainty model (exact at the picks, wider between them).
 * `cache` keeps the prepared context wellbores (and the wells, by trajectory)
 * between calls.
 */
export function fieldWellbores(
  wells: AcSourceWell[],
  context: ContextWell[],
  opts: { picksFor?: (name: string) => Top[]; cache?: WeakMap<object, AcWell>; model?: ErrorModel } = {},
): AcWell[] {
  const cache = opts.cache;
  const model = opts.model ?? DEFAULT_ERROR_MODEL;
  const out: AcWell[] = [];
  for (const w of wells) {
    let a = cache?.get(w.trajectory);
    if (!a || a.key !== w.id || a.name !== w.name) {
      const t = w.trajectory;
      const recon = t.status === 'reconstructed' || t.status === 'user';
      const sister = w.sister ? (wells.find((x) => x.id === w.sister || sameName(x.name, w.sister!))?.name ?? w.sister) : undefined;
      a = acWell(w.id, w.name, t, recon ? { reconstructedFrom: w.kickoffMD ?? 0, picks: w.tops, kickoffMD: w.kickoffMD, sister } : { kickoffMD: w.kickoffMD, sister }, model);
      cache?.set(w.trajectory, a);
    }
    out.push(a);
  }
  // definitive context wellbores first: a reconstructed one may have been drilled out of one of them
  const ctx = context.filter((c) => !wells.some((w) => sameName(w.name, c.name)));
  ctx.sort((a, b) => (a.status === 'definitive' ? 0 : 1) - (b.status === 'definitive' ? 0 : 1));
  const surveyed = out.filter((a) => a.traj.status !== 'reconstructed' && a.traj.status !== 'user');
  for (const c of ctx) {
    let a = cache?.get(c);
    if (!a) {
      const t = trajectoryFromPath(c, c.status, '', 'context');
      if (c.status === 'reconstructed') {
        // exact where it is the same hole as a surveyed wellbore (a pilot drilled from the same slot): the allowance starts where they part
        let from = 0;
        for (const s of surveyed) from = Math.max(from, sharedHoleTo(t, s.traj) ?? 0);
        a = acWell(`ctx:${c.name}`, c.name, t, { reconstructedFrom: from, picks: opts.picksFor?.(c.name) }, model);
      } else a = acWell(`ctx:${c.name}`, c.name, t, {}, model);
      cache?.set(c, a);
    }
    out.push(a);
    if (c.status === 'definitive') surveyed.push(a);
  }
  return out;
}

/** 1σ radius (major semi-axis) at md, interpolated between the regular ellipses. */
export function radiusAt(list: Ellipse[], md: number): number {
  const n = list.length;
  if (!n) return 0;
  if (md <= list[0].md) return list[0].major;
  if (md >= list[n - 1].md) return list[n - 1].major;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].md <= md) lo = mid;
    else hi = mid;
  }
  const a = list[lo];
  const b = list[hi];
  const t = (md - a.md) / (b.md - a.md || 1);
  return a.major + (b.major - a.major) * t;
}

/** Grid points of a trajectory per chunk, for the closest-point search. */
const CHUNK = 8;

/** The point of `t` closest to (ns, ew, tvd): searched on the 2 m grid chunk by chunk (nearest chunks first), refined onto the neighbouring segments. */
export function closestOn(t: Trajectory, ns: number, ew: number, tvd: number): { md: number; dist: number; ns: number; ew: number; tvd: number } {
  const n = t.md.length;
  // any grid point of a chunk lies within `reach` (along the hole, so also in space) of the chunk's middle point
  const reach = (CHUNK / 2) * t.step * 1.01;
  const nc = Math.ceil(n / CHUNK);
  const lb = new Float64Array(nc);
  const order: number[] = [];
  for (let c = 0; c < nc; c++) {
    const i = Math.min(n - 1, c * CHUNK + (CHUNK >> 1));
    const d = Math.sqrt((t.ns[i] - ns) ** 2 + (t.ew[i] - ew) ** 2 + (t.tvd[i] - tvd) ** 2);
    lb[c] = Math.max(0, d - reach);
    order.push(c);
  }
  order.sort((a, b) => lb[a] - lb[b]);
  let best = Infinity; // squared
  let bi = 0;
  for (const c of order) {
    if (lb[c] * lb[c] >= best) break;
    const i1 = Math.min(n, (c + 1) * CHUNK);
    for (let i = c * CHUNK; i < i1; i++) {
      const d = (t.ns[i] - ns) ** 2 + (t.ew[i] - ew) ** 2 + (t.tvd[i] - tvd) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
  }
  // refine on the segments either side of the nearest grid point
  let out = { md: t.md[bi], dist: Math.sqrt(best), ns: t.ns[bi], ew: t.ew[bi], tvd: t.tvd[bi] };
  for (const j of [bi - 1, bi]) {
    if (j < 0 || j + 1 >= n) continue;
    const ax = t.ns[j], ay = t.ew[j], az = t.tvd[j];
    const bx = t.ns[j + 1] - ax, by = t.ew[j + 1] - ay, bz = t.tvd[j + 1] - az;
    const L = bx * bx + by * by + bz * bz;
    if (L < 1e-12) continue;
    const u = Math.min(1, Math.max(0, ((ns - ax) * bx + (ew - ay) * by + (tvd - az) * bz) / L));
    const q = { ns: ax + bx * u, ew: ay + by * u, tvd: az + bz * u };
    const d = Math.sqrt((q.ns - ns) ** 2 + (q.ew - ew) ** 2 + (q.tvd - tvd) ** 2);
    if (d < out.dist) out = { md: t.md[j] + (t.md[j + 1] - t.md[j]) * u, dist: d, ...q };
  }
  return out;
}

/** A stretch of the reference well below the caution threshold against one offset well. */
export interface AcInterval {
  /** reference MD range (m) */
  from: number;
  to: number;
  /** the closest approach in it (lowest SF): reference MD, offset MD, centre-to-centre distance */
  minSF: number;
  md: number;
  offMD: number;
  dist: number;
  status: AcStatus;
}

export interface AcOffset {
  key: string;
  name: string;
  /** lowest SF outside the shared hole (Infinity when the well is nowhere outside it) */
  minSF: number;
  /** where: reference MD, offset MD, centre-to-centre distance (m) */
  md: number;
  offMD: number;
  dist: number;
  status: AcStatus;
  /** the hole shared with the reference (sidetrack / parent): down to `to` (reference MD, the departure below the kick-off included) */
  shared: { to: number; kickoff: number } | null;
  /** stretches of the reference below the caution threshold */
  intervals: AcInterval[];
}

export interface AcScan {
  refKey: string;
  sigma: number;
  caution: number;
  every: number;
  /** where the scan starts on the reference (m MD) */
  fromMD: number;
  /** every offset wellbore, lowest SF first */
  offsets: AcOffset[];
  /** reference sample depths and, at each, the lowest SF against any offset outside a shared hole (Infinity where clear by bound) */
  mds: Float64Array;
  worst: Float64Array;
  /** time taken, ms */
  ms: number;
}

export interface AcOptions {
  /** confidence multiplier k (1, 2 or 3 σ) */
  sigma?: number;
  /** caution threshold (SF) */
  caution?: number;
  /** reference sample spacing (m MD) */
  every?: number;
  /** start of the scan on the reference (the seabed: above it the wells stand in their slots) */
  fromMD?: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Lower bound of the distance from a point to an axis-aligned box. */
export function boxDist(p: [number, number, number], b: AcWell['box']): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < b.min[k] ? b.min[k] - p[k] : p[k] > b.max[k] ? p[k] - b.max[k] : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Where the reference and the offset are the same hole: from the top down,
 * while the two paths are within `SHARED_TOL` at the same MD. Returns the
 * deepest shared MD, or null when they part within `SHARED_MIN` (two
 * neighbouring slots, not a shared hole).
 */
export function sharedHoleTo(ref: Trajectory, off: Trajectory): number | null {
  const start = Math.max(ref.mdStart, off.mdStart);
  const end = Math.min(ref.mdEnd, off.mdEnd);
  let to: number | null = null;
  for (let md = start; md <= end; md += 2) {
    const a = ref.at(md);
    const b = off.at(md);
    if (Math.hypot(a.ns - b.ns, a.ew - b.ew, a.tvd - b.tvd) > SHARED_TOL) break;
    to = md;
  }
  return to !== null && to - start >= SHARED_MIN ? to : null;
}

/** The kick-off shared by two wellbores: from their paths, and from the well list (`kickoffMD` of a sidetrack of the other). */
export function kickoffBetween(ref: AcWell, off: AcWell): number | null {
  let kop = sharedHoleTo(ref.traj, off.traj);
  const listed = (a: AcWell, b: AcWell) => a.kickoffMD !== undefined && a.sister !== undefined && (a.sister === b.key || sameName(a.sister, b.name));
  const meta = listed(ref, off) ? ref.kickoffMD! : listed(off, ref) ? off.kickoffMD! : null;
  if (meta !== null) kop = Math.max(kop ?? 0, meta);
  return kop;
}

/** Scan the reference well against every offset wellbore. */
export function antiCollision(ref: AcWell, offsets: AcWell[], opts: AcOptions = {}): AcScan {
  const t0 = now();
  const k = opts.sigma ?? 2;
  const caution = opts.caution ?? SF_CAUTION;
  const every = opts.every ?? AC_STEP;
  const rt = ref.traj;
  const from = Math.min(rt.mdEnd, Math.max(rt.mdStart, Number.isFinite(opts.fromMD) ? opts.fromMD! : rt.mdStart));
  const n = Math.max(1, Math.floor((rt.mdEnd - from) / every) + 1 + (((rt.mdEnd - from) % every) > 1e-6 ? 1 : 0));
  const mds = new Float64Array(n);
  const pts: [number, number, number][] = [];
  const rad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const md = Math.min(rt.mdEnd, from + i * every);
    mds[i] = md;
    const p = rt.at(md);
    pts.push([p.ns, p.ew, p.tvd]);
    rad[i] = radiusAt(ref.ellipses, md);
  }
  const worst = new Float64Array(n).fill(Infinity);
  const out: AcOffset[] = [];
  const sfOf = (dist: number, i: number, offMD: number, off: AcWell) => dist / Math.max(1e-3, k * (rad[i] + radiusAt(off.ellipses, offMD)));
  for (const off of offsets) {
    if (off.key === ref.key) continue;
    const kop = kickoffBetween(ref, off);
    // SF lower bound per sample, from the offset's bounding box and largest ellipse: most samples of most wells stop here
    const lb = new Float64Array(n);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      lb[i] = boxDist(pts[i], off.box) / Math.max(1e-3, k * (rad[i] + off.maxRadius));
      idx.push(i);
    }
    idx.sort((a, b) => lb[a] - lb[b]);
    const sf = new Float64Array(n).fill(Infinity);
    const offMD = new Float64Array(n).fill(NaN);
    const dist = new Float64Array(n).fill(NaN);
    let best = Infinity;
    // exact SF only where it could be below the caution threshold or below the lowest found so far
    for (const i of idx) {
      if (lb[i] >= Math.max(caution, best)) break;
      const [ns, ew, tvd] = pts[i];
      const c = closestOn(off.traj, ns, ew, tvd);
      const s = sfOf(c.dist, i, c.md, off);
      sf[i] = s;
      offMD[i] = c.md;
      dist[i] = c.dist;
      if (kop === null || mds[i] > kop + KICKOFF_ALLOWANCE) best = Math.min(best, s);
    }
    // shared hole: down to the kick-off, then while the sidetrack is still leaving the parent (below the caution threshold)
    let sharedTo = -Infinity;
    if (kop !== null) {
      sharedTo = kop;
      for (let i = 0; i < n; i++) {
        if (mds[i] <= kop) continue;
        if (mds[i] > kop + KICKOFF_ALLOWANCE || sf[i] >= caution) break;
        sharedTo = mds[i];
      }
    }
    const isShared = (i: number) => mds[i] <= sharedTo;
    // lowest SF and the stretches below the caution threshold, outside the shared hole
    let mi = -1;
    const intervals: AcInterval[] = [];
    let cur: AcInterval | null = null;
    for (let i = 0; i < n; i++) {
      const s = sf[i];
      if (isShared(i)) {
        cur = null;
        continue;
      }
      if (s < worst[i]) worst[i] = s;
      if (mi < 0 || s < sf[mi]) mi = i;
      if (s < caution) {
        if (!cur) {
          cur = { from: mds[i], to: mds[i], minSF: s, md: mds[i], offMD: offMD[i], dist: dist[i], status: classify(s, caution) };
          intervals.push(cur);
        }
        cur.to = mds[i];
        if (s < cur.minSF) Object.assign(cur, { minSF: s, md: mds[i], offMD: offMD[i], dist: dist[i], status: classify(s, caution) });
      } else cur = null;
    }
    let row: AcOffset;
    if (mi >= 0 && Number.isFinite(sf[mi])) {
      row = { key: off.key, name: off.name, minSF: sf[mi], md: mds[mi], offMD: offMD[mi], dist: dist[mi], status: classify(sf[mi], caution), shared: null, intervals };
    } else {
      // nothing exact outside the shared hole: every sample there is clear by its bound; measure at the sample with the smallest bound
      let bi = -1;
      for (let i = 0; i < n; i++) if (!isShared(i) && (bi < 0 || lb[i] < lb[bi])) bi = i;
      if (bi < 0) row = { key: off.key, name: off.name, minSF: Infinity, md: NaN, offMD: NaN, dist: NaN, status: 'shared', shared: null, intervals };
      else {
        const c = closestOn(off.traj, ...pts[bi]);
        const s = sfOf(c.dist, bi, c.md, off);
        row = { key: off.key, name: off.name, minSF: s, md: mds[bi], offMD: c.md, dist: c.dist, status: classify(s, caution), shared: null, intervals };
      }
    }
    if (kop !== null) row.shared = { to: Math.max(kop, sharedTo), kickoff: kop };
    out.push(row);
  }
  out.sort((a, b) => a.minSF - b.minSF || a.name.localeCompare(b.name));
  return { refKey: ref.key, sigma: k, caution, every, fromMD: from, offsets: out, mds, worst, ms: now() - t0 };
}

/** The separation to one offset at a reference depth. */
export function separationAt(
  ref: AcWell,
  off: AcWell,
  md: number,
  sigma = 2,
  caution = SF_CAUTION,
): { offMD: number; dist: number; sf: number; status: AcStatus; point: { ns: number; ew: number; tvd: number } } {
  const m = Math.min(Math.max(md, ref.traj.mdStart), ref.traj.mdEnd);
  const p = ref.traj.at(m);
  const c = closestOn(off.traj, p.ns, p.ew, p.tvd);
  const sf = c.dist / Math.max(1e-3, sigma * (radiusAt(ref.ellipses, m) + radiusAt(off.ellipses, c.md)));
  return { offMD: c.md, dist: c.dist, sf, status: classify(sf, caution), point: { ns: c.ns, ew: c.ew, tvd: c.tvd } };
}

/**
 * The offset wellbore that matters most at one reference depth (a click in
 * 3D): the lowest SF there, a shared hole reported as such. Wells whose box
 * is out of reach are skipped.
 */
export function nearestAt(
  scan: AcScan,
  ref: AcWell,
  wells: AcWell[],
  md: number,
): { well: AcWell; offMD: number; dist: number; sf: number; status: AcStatus } | null {
  const byKey = new Map(wells.map((w) => [w.key, w]));
  const p = ref.traj.at(Math.min(Math.max(md, ref.traj.mdStart), ref.traj.mdEnd));
  const r = radiusAt(ref.ellipses, md);
  type Hit = { well: AcWell; offMD: number; dist: number; sf: number; status: AcStatus };
  let best: Hit | null = null;
  // a shared hole is the well itself, not its nearest neighbour: it wins only when nothing else is near
  const rank = (x: Hit) => (x.status === 'shared' ? Infinity : x.sf);
  for (const o of scan.offsets) {
    const w = byKey.get(o.key);
    if (!w) continue;
    // a bound on the SF here skips the far ones
    const bound = boxDist([p.ns, p.ew, p.tvd], w.box) / Math.max(1e-3, scan.sigma * (r + w.maxRadius));
    if (best && bound >= rank(best) && best.status !== 'shared') continue;
    const s = separationAt(ref, w, md, scan.sigma, scan.caution);
    const shared = o.shared !== null && md <= o.shared.to;
    const cand: Hit = { well: w, offMD: s.offMD, dist: s.dist, sf: s.sf, status: shared ? 'shared' : s.status };
    if (!best || rank(cand) < rank(best) || (rank(cand) === rank(best) && cand.dist < best.dist)) best = cand;
  }
  return best;
}
