import type { PetroResult } from './petro';
import type { Trajectory } from './trajectory';
import type { LogSet, Zone } from './types';

export interface ContactEvidence {
  well: string;
  /** deepest clean-sand sample reading as hydrocarbon-bearing (oil down to), TVDSS m */
  odt: number | null;
  /** shallowest clean-sand sample reading as water-bearing below the ODT (water up to), TVDSS m */
  wut: number | null;
  samples: number;
}

export interface ContactEstimate {
  /** best estimate of the free-water / oil-water contact, TVDSS m */
  depth: number;
  /** half-width of the uncertainty band (m) */
  plusMinus: number;
  shallow: number;
  deep: number;
  evidence: ContactEvidence[];
  method: string;
  /** wells whose evidence contradicts this contact (other compartment / moved contact) */
  conflicts: string[];
  /** which evidence the estimate rests on */
  basis: string;
}

const CLEAN_VSH = 0.35;
const MIN_PHI = 0.1;
const HC_SW = 0.5;
const WATER_SW = 0.8;

/**
 * Contact evidence from one logged well: sort the clean, porous reservoir
 * samples by TVDSS, then find the deepest hydrocarbon reading (Sw < 0.5) and
 * the shallowest water reading (Sw > 0.8) below it. Isolated readings (< 3 m
 * of consecutive samples) are ignored so a thin wet streak cannot fake a contact.
 */
export function contactEvidence(
  well: string,
  logs: LogSet,
  petro: PetroResult,
  zones: Zone[],
  traj: Trajectory,
  datumElevation: number,
  formations = ['hugin', 'sleipner', 'skagerrak'],
): ContactEvidence {
  const d = logs.depth;
  const pts: { tvdss: number; sw: number }[] = [];
  for (let i = 0; i < d.length; i++) {
    const md = d[i];
    const z = zones.find((q) => md >= q.topMD && md < q.baseMD);
    if (!z || !formations.includes(z.formationId)) continue;
    const vsh = petro.vsh.values[i];
    const phi = petro.phie.values[i];
    const sw = petro.sw.values[i];
    if (!(vsh < CLEAN_VSH) || !(phi > MIN_PHI) || !Number.isFinite(sw)) continue;
    if (md > traj.mdEnd) continue;
    pts.push({ tvdss: traj.at(md).tvd - datumElevation, sw });
  }
  pts.sort((a, b) => a.tvdss - b.tvdss);
  if (pts.length < 10) return { well, odt: null, wut: null, samples: pts.length };
  // smooth with a running median over ~1.5 m of TVD so single samples do not decide
  const k = 3;
  const sm = pts.map((_, i) => {
    const w = pts.slice(Math.max(0, i - k), Math.min(pts.length, i + k + 1)).map((p) => p.sw).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  // runs of consistent readings at least 3 m thick
  const thick = (i: number, pred: (s: number) => boolean) => {
    let j = i;
    while (j < pts.length && pred(sm[j])) j++;
    return pts[Math.min(j, pts.length - 1)].tvdss - pts[i].tvdss >= 3 ? j : -1;
  };
  let odt: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    if (sm[i] < HC_SW) {
      const j = thick(i, (s) => s < HC_SW);
      if (j > 0) {
        odt = pts[j - 1].tvdss;
        i = j;
      }
    }
  }
  let wut: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    if (odt !== null && pts[i].tvdss <= odt) continue;
    if (sm[i] > WATER_SW && thick(i, (s) => s > WATER_SW) > 0) {
      wut = pts[i].tvdss;
      break;
    }
  }
  return { well, odt, wut, samples: pts.length };
}

/**
 * Combine per-well evidence. A common contact must lie below every ODT and
 * above every WUT. If the wells agree, the estimate is the middle of that
 * bracket; if they do not (e.g. separate fault blocks, or a contact that
 * moved during production between logging runs), the estimate comes from the
 * best-bracketed single well and the conflicting wells are listed.
 */
export function combineContacts(ev: ContactEvidence[]): ContactEstimate | null {
  const odts = ev.map((e) => e.odt).filter((v): v is number => v !== null);
  const wuts = ev.map((e) => e.wut).filter((v): v is number => v !== null);
  if (!odts.length && !wuts.length) return null;
  const method = `Deepest oil (Sw < ${HC_SW}) and shallowest water (Sw > ${WATER_SW}) in clean sands (Vsh < ${CLEAN_VSH}, φ > ${MIN_PHI}) of the Hugin–Skagerrak interval, from the live Sw calculation`;
  const maxOdt = odts.length ? Math.max(...odts) : -Infinity;
  const minWut = wuts.length ? Math.min(...wuts) : Infinity;
  if (maxOdt < minWut && Number.isFinite(maxOdt) && Number.isFinite(minWut)) {
    return { depth: (maxOdt + minWut) / 2, plusMinus: Math.max(0.5, (minWut - maxOdt) / 2), shallow: maxOdt, deep: minWut, evidence: ev, method, conflicts: [], basis: 'all wells' };
  }
  // wells disagree: median of the single-well brackets, spread as the uncertainty
  const bracketed = ev.filter((e) => e.odt !== null && e.wut !== null && e.wut > e.odt);
  if (bracketed.length) {
    const mids = bracketed.map((e) => (e.odt! + e.wut!) / 2).sort((a, b) => a - b);
    const depth = mids[mids.length >> 1];
    const conflicts = ev.filter((e) => (e.odt !== null && e.odt > depth) || (e.wut !== null && e.wut < depth)).map((e) => e.well);
    return {
      depth,
      plusMinus: Math.max(0.5, (mids[mids.length - 1] - mids[0]) / 2),
      shallow: mids[0],
      deep: mids[mids.length - 1],
      evidence: ev,
      method,
      conflicts,
      basis: `median of ${bracketed.length} single-well brackets — the wells do not share one contact`,
    };
  }
  // only one-sided evidence: report a bound
  if (Number.isFinite(maxOdt)) return { depth: maxOdt, plusMinus: 0, shallow: maxOdt, deep: maxOdt, evidence: ev, method, conflicts: [], basis: 'oil-down-to only (contact is deeper)' };
  return { depth: minWut, plusMinus: 0, shallow: minWut, deep: minWut, evidence: ev, method, conflicts: [], basis: 'water-up-to only (contact is shallower)' };
}
