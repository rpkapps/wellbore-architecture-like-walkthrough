import { KICKOFF_ALLOWANCE, SF_CAUTION, boxDist, classify, closestOn, kickoffBetween, radiusAt, type AcStatus, type AcWell } from './anticollision';
import type { Trajectory } from './trajectory';

/**
 * Travelling cylinder: the offset wellbores around the active (reference) well
 * at one depth, looking down the hole. Each offset path near that depth is
 * projected onto the plane normal to the reference there, with high side (the
 * upper side of the hole) up and angles clockwise from it; a near-vertical
 * hole has no high side, so north is up instead.
 *
 * The closest point of each offset is found in 3D (as in `antiCollision`), so
 * the distance and separation factor are those the anti-collision overlay
 * reports at that depth; its dot in the plot is that point projected onto the
 * plane. The stretch of the offset drawn is ±`half` m along its own hole from
 * the closest point.
 */

/** Plot range: offsets whose closest point is further than this are left out (m). */
export const TC_RANGE = 100;
/** Range rings (m). */
export const TC_RINGS = [5, 10, 20, 40, 70, 100];
/** How much of each offset path is drawn, either side of its closest point along its own hole (m MD). */
export const TC_HALF = 150;
/** Sample spacing of the drawn offset paths (m MD). */
export const TC_STEP = 5;
/** Below this inclination (°) the high side is not defined well enough: north is up. */
export const TC_NORTH_BELOW = 3;

type V3 = [number, number, number];

/** The plane across the reference hole at one depth: an origin and three unit vectors in (NS, EW, TVD) — TVD down. */
export interface TcFrame {
  md: number;
  inc: number;
  azi: number;
  origin: V3;
  /** down the hole */
  along: V3;
  /** high side (or north, near vertical): up in the plot */
  up: V3;
  /** 90° clockwise from `up`, looking down the hole: right in the plot */
  right: V3;
  /** the hole is near vertical and `up` is north */
  north: boolean;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The normal plane of a trajectory at a depth (clamped to the hole). */
export function normalPlane(t: Trajectory, md: number): TcFrame {
  const m = Math.min(Math.max(md, t.mdStart), t.mdEnd);
  const p = t.at(m);
  const i = (p.inc * Math.PI) / 180;
  const a = (p.azi * Math.PI) / 180;
  const along: V3 = [Math.sin(i) * Math.cos(a), Math.sin(i) * Math.sin(a), Math.cos(i)];
  const north = p.inc < TC_NORTH_BELOW;
  // high side: straight up (−TVD) with the along-hole part taken out; near vertical, north the same way
  const ref: V3 = north ? [1, 0, 0] : [0, 0, -1];
  const k = dot(ref, along);
  const up = unit([ref[0] - k * along[0], ref[1] - k * along[1], ref[2] - k * along[2]]);
  // looking down the hole with `up` up: (N, E, down) is right-handed, so right = along × up
  const right = unit(cross(along, up));
  return { md: m, inc: p.inc, azi: p.azi, origin: [p.ns, p.ew, p.tvd], along, up, right, north };
}

/** A point in the plane's coordinates: x right, y up (m), and how far it lies ahead of the plane down the hole (m). */
export function toPlane(f: TcFrame, ns: number, ew: number, tvd: number): { x: number; y: number; along: number } {
  const d: V3 = [ns - f.origin[0], ew - f.origin[1], tvd - f.origin[2]];
  return { x: dot(d, f.right), y: dot(d, f.up), along: dot(d, f.along) };
}

/** Clockwise angle from high side (or north) of a point in the plane, 0–360°. */
export function tcAngle(x: number, y: number): number {
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** The plot's radial scale: the square root of the distance over the range (0 at the centre, 1 on the outer ring), so near wells get room. */
export function tcRadius(r: number, range = TC_RANGE): number {
  return Math.sqrt(Math.max(0, r) / range);
}

/** A point of the plane on the plot, as a fraction of the outer ring's radius (x right, y up). */
export function tcPlot(x: number, y: number, range = TC_RANGE): { x: number; y: number } {
  const d = Math.hypot(x, y);
  const q = d > 1e-9 ? tcRadius(d, range) / d : 0;
  return { x: x * q, y: y * q };
}

export interface TcPoint {
  /** in the plane: right, up (m) */
  x: number;
  y: number;
  /** ahead of the plane, down the reference hole (m) */
  along: number;
  /** on the offset (m MD) */
  md: number;
}

export interface TcOffset {
  key: string;
  name: string;
  status: AcStatus;
  /** at the closest point: separation factor, centre-to-centre distance (3D, m) and the offset's MD */
  sf: number;
  dist: number;
  offMD: number;
  /** the closest point, projected */
  at: TcPoint;
  /** the offset path ±`half` m along its hole from the closest point, projected */
  path: TcPoint[];
  /** kick-off shared with the reference (sidetrack or parent), if any */
  kickoff: number | null;
}

export interface TcView {
  refKey: string;
  md: number;
  frame: TcFrame;
  sigma: number;
  caution: number;
  range: number;
  /** the reference well's own k·σ radius here (m) */
  refRadius: number;
  /** the offsets in range, lowest SF first */
  offsets: TcOffset[];
  /** wellbores that are the same hole as the reference here (a parent or sidetrack above its kick-off): not a risk, not drawn */
  shared: TcOffset[];
}

export interface TcOptions {
  sigma?: number;
  caution?: number;
  range?: number;
  half?: number;
  step?: number;
  /** kick-offs shared with the reference by offset key (`kickoffBetween`), filled as they are found: keep it between calls on the same reference */
  kickoffs?: Map<string, number | null>;
}

/**
 * The travelling cylinder of `ref` at `md`: every other wellbore whose closest
 * point is within `range`, its path near there projected on the normal plane,
 * with the separation factor at k = `sigma`. A wellbore that is the same hole
 * here (above the kick-off it shares with the reference, or just below it
 * while the new hole is still leaving the old one, as `antiCollision` counts
 * it) is listed under `shared` instead.
 */
export function travellingCylinder(ref: AcWell, wells: AcWell[], md: number, opts: TcOptions = {}): TcView {
  const k = opts.sigma ?? 2;
  const caution = opts.caution ?? SF_CAUTION;
  const range = opts.range ?? TC_RANGE;
  const half = opts.half ?? TC_HALF;
  const step = opts.step ?? TC_STEP;
  const frame = normalPlane(ref.traj, md);
  const m = frame.md;
  const o = frame.origin;
  const rRef = radiusAt(ref.ellipses, m);
  const offsets: TcOffset[] = [];
  const shared: TcOffset[] = [];
  for (const w of wells) {
    if (w.key === ref.key || boxDist(o, w.box) > range) continue;
    const c = closestOn(w.traj, o[0], o[1], o[2]);
    if (c.dist > range) continue;
    const sf = c.dist / Math.max(1e-3, k * (rRef + radiusAt(w.ellipses, c.md)));
    let kop = opts.kickoffs?.get(w.key);
    if (kop === undefined) {
      kop = kickoffBetween(ref, w);
      opts.kickoffs?.set(w.key, kop);
    }
    const isShared = kop !== null && (m <= kop || (m <= kop + KICKOFF_ALLOWANCE && sf < caution));
    const at = { ...toPlane(frame, c.ns, c.ew, c.tvd), md: c.md };
    const path: TcPoint[] = [];
    const t = w.traj;
    const a = Math.max(t.mdStart, c.md - half);
    const b = Math.min(t.mdEnd, c.md + half);
    // on the step grid, with the closest point itself in the line
    for (let s = Math.ceil(a / step) * step; s <= b + 1e-9; s += step) {
      if (path.length && path[path.length - 1].md < c.md && s > c.md) path.push(at);
      const q = t.at(s);
      path.push({ ...toPlane(frame, q.ns, q.ew, q.tvd), md: s });
    }
    if (!path.length || path[path.length - 1].md < c.md) path.push(at);
    const row: TcOffset = { key: w.key, name: w.name, status: isShared ? 'shared' : classify(sf, caution), sf, dist: c.dist, offMD: c.md, at, path, kickoff: kop };
    (isShared ? shared : offsets).push(row);
  }
  const bySF = (p: TcOffset, q: TcOffset) => p.sf - q.sf || p.name.localeCompare(q.name);
  offsets.sort(bySF);
  shared.sort(bySF);
  return { refKey: ref.key, md: m, frame, sigma: k, caution, range, refRadius: k * rRef, offsets, shared };
}
