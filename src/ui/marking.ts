/**
 * Marking: depth intervals of one well that a view has picked out (the
 * crossplot's brushed samples, later a query's results). Every view can show
 * them; the timeline draws them as ticks, so scrubbing jumps between them.
 * Plain data, so an assistant can read it from `app.state`.
 */
export interface Marking {
  /** the well the intervals are on */
  well: string;
  /** top and base, m MD, in depth order */
  intervals: [number, number][];
  /** what marked them, for people ("Crossplot") */
  source: string;
}

/** The colour of marked samples, in the 3D view and on the timeline. */
export const MARKING_COLOR = '#ff5fd2';

/** A tick on the timeline: marked intervals that fall within a few pixels of each other, drawn and clicked as one. */
export interface MarkTick {
  /** left edge and width, px */
  x: number;
  w: number;
  /** the depth range it covers, m MD */
  top: number;
  base: number;
  /** where a click travels: the middle of its longest interval */
  md: number;
  /** how many intervals it stands for */
  count: number;
}

/**
 * Lays marked intervals out along a strip `W` px wide showing 0…`td` m MD.
 * Each tick is at least `minW` px wide, and intervals closer than `mergePx`
 * merge into one tick, so hundreds of one-sample intervals stay a readable
 * handful of ticks instead of a smear.
 */
export function markTicks(intervals: readonly (readonly [number, number])[], td: number, W: number, minW = 2, mergePx = 3): MarkTick[] {
  if (!(td > 0) || !(W > 0)) return [];
  const px = (md: number) => (Math.max(0, Math.min(td, md)) / td) * W;
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a && b >= 0 && a <= td).sort((p, q) => p[0] - q[0]);
  const out: MarkTick[] = [];
  let longest = 0;
  for (const [top, base] of sorted) {
    const x0 = px(top);
    const x1 = Math.max(px(base), x0 + minW);
    const last = out[out.length - 1];
    if (last && x0 - (last.x + last.w) < mergePx) {
      last.w = Math.max(last.x + last.w, x1) - last.x;
      last.base = Math.max(last.base, base);
      last.count++;
      if (base - top > longest) {
        longest = base - top;
        last.md = (top + base) / 2;
      }
      continue;
    }
    longest = base - top;
    out.push({ x: x0, w: x1 - x0, top, base, md: (top + base) / 2, count: 1 });
  }
  return out;
}
