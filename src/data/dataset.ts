import { findCurve, parseLAS } from './las';
import { parseCSV, picksFromTable, productionFromTable, sameWell, surveyFromTable, toMonthly } from './csv';
import { DEFAULT_PARAMS, autoGrLimits, interpret, type PetroParams, type PetroResult } from './petro';
import { FORMATION_BY_ID, formationIdForPick, formationOrder } from './stratigraphy';
import { buildHorizons, type ModelExtent } from './surfaces';
import { Trajectory, stationsFromSurvey } from './trajectory';
import type {
  ContextWell,
  HorizonGrid,
  LogSet,
  PickRow,
  ProductionRecord,
  ProductionSeries,
  Provenance,
  Top,
  TrajectoryStatus,
  Zone,
} from './types';

export interface FieldMeta {
  name: string;
  block: string;
  country: string;
  operator: string;
  facility: string;
  crs: string;
  originE: number;
  originN: number;
  datum: string;
  datumElevation: number;
  waterDepth: number;
  licence: string;
  sources: string[];
}

export interface CasingString {
  name: string;
  od: number; // inches
  hole: number; // inches
  topMD: number;
  shoeMD: number;
  provenance: Provenance;
  note: string;
}

export interface HoleSection {
  hole: number;
  topMD: number;
  baseMD: number;
}

interface ManifestWell {
  id: string;
  name: string;
  primary?: boolean;
  las?: string;
  cpi?: string;
  survey: string;
  surveyStatus: TrajectoryStatus;
  surveyNote: string;
  picksWell: string;
  production?: string;
  productionWell?: string;
  kickoffMD?: number;
  sister?: string;
  summary: string;
}

export class Well {
  logs?: LogSet;
  cpi?: LogSet;
  tops: Top[] = [];
  zones: Zone[] = [];
  production?: ProductionSeries;
  productionMonthly: ProductionRecord[] = [];
  casing: CasingString[] = [];
  holeSections: HoleSection[] = [];
  params: PetroParams = { ...DEFAULT_PARAMS };
  petro?: PetroResult;
  loaded = false;
  loading?: Promise<void>;
  kickoffMD?: number;
  sister?: string;
  primary = false;
  lasFile?: string;
  cpiFile?: string;
  productionFile?: string;
  productionWell?: string;
  userAdded = false;

  constructor(
    public id: string,
    public name: string,
    public trajectory: Trajectory,
    public summary: string,
  ) {}

  get tdMD() {
    const logEnd = this.logs ? this.logs.depth[this.logs.depth.length - 1] : 0;
    return Math.max(this.trajectory.mdEnd, logEnd);
  }

  /** Recompute interpretation, zones and hole geometry after any data change. */
  refresh(datumElevation: number, waterDepth: number) {
    if (this.logs) {
      this.petro = interpret(this.logs, this.params);
      this.holeSections = holeSectionsFromBitSize(this.logs);
      this.casing = casingFromSections(this.holeSections);
    }
    this.zones = zonesFromTops(this.tops, this.trajectory, datumElevation, waterDepth, this.tdMD);
  }

  autoCalibrate() {
    if (!this.logs) return;
    const g = autoGrLimits(this.logs);
    if (g) {
      this.params.grClean = g.clean;
      this.params.grShale = g.shale;
    }
  }

  zoneAt(md: number): Zone | undefined {
    for (const z of this.zones) if (md >= z.topMD && md < z.baseMD) return z;
    return this.zones[this.zones.length - 1];
  }
}

const STANDARD_HOLES = [36, 26, 17.5, 12.25, 8.5, 6];
const CASING_FOR_HOLE: Record<string, { od: number; name: string }> = {
  '36': { od: 30, name: '30" conductor' },
  '26': { od: 20, name: '20" surface casing' },
  '17.5': { od: 13.375, name: '13⅜" intermediate casing' },
  '12.25': { od: 9.625, name: '9⅝" production casing' },
  '8.5': { od: 7, name: '7" liner' },
};

export function holeSectionsFromBitSize(logs: LogSet): HoleSection[] {
  const bs = findCurve(logs, 'BS');
  if (!bs) return [];
  const d = logs.depth;
  const out: HoleSection[] = [];
  let cur: HoleSection | null = null;
  for (let i = 0; i < d.length; i++) {
    const v = bs.values[i];
    if (!Number.isFinite(v)) continue;
    const snapped = STANDARD_HOLES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    if (!cur || cur.hole !== snapped) {
      if (cur) cur.baseMD = d[i];
      cur = { hole: snapped, topMD: d[i], baseMD: d[i] };
      out.push(cur);
    } else cur.baseMD = d[i];
  }
  // drop slivers (< 20 m) and merge neighbours with the same size
  const clean: HoleSection[] = [];
  for (const s of out) {
    // the first (conductor) section starts above the first log sample, so keep it regardless of length
    if (s.baseMD - s.topMD < 20 && s !== out[0]) {
      if (clean.length) clean[clean.length - 1].baseMD = s.baseMD;
      continue;
    }
    const last = clean[clean.length - 1];
    if (last && last.hole === s.hole) last.baseMD = s.baseMD;
    else clean.push({ ...s });
  }
  if (clean.length) clean[0].topMD = 0;
  return clean;
}

export function casingFromSections(sections: HoleSection[]): CasingString[] {
  const out: CasingString[] = [];
  // every hole section except the last one (reservoir section, completion not in dataset) is cased
  for (let i = 0; i < sections.length - 1; i++) {
    const s = sections[i];
    const c = CASING_FOR_HOLE[String(s.hole)];
    if (!c) continue;
    out.push({
      name: c.name,
      od: c.od,
      hole: s.hole,
      topMD: 0,
      shoeMD: Math.max(s.topMD + 5, s.baseMD - 3),
      provenance: 'reconstructed',
      note: `Inferred from the bit-size (BS) log: ${s.hole}" hole ${s.topMD.toFixed(0)}–${s.baseMD.toFixed(0)} m MD; standard North Sea hole/casing pairing assumed.`,
    });
  }
  return out;
}

export function zonesFromTops(
  tops: Top[],
  traj: Trajectory,
  datumElevation: number,
  waterDepth: number,
  td: number,
): Zone[] {
  const zones: Zone[] = [];
  const mdMSL = traj.mdAtTVD(datumElevation);
  const mdSeabed = Number.isFinite(traj.mdAtTVD(datumElevation + waterDepth))
    ? traj.mdAtTVD(datumElevation + waterDepth)
    : datumElevation + waterDepth;
  zones.push({ formationId: 'air', name: 'Air gap / rig', topMD: 0, baseMD: Number.isFinite(mdMSL) ? mdMSL : datumElevation });
  zones.push({ formationId: 'sea', name: 'North Sea water column', topMD: zones[0].baseMD, baseMD: mdSeabed });
  // sort, resolving picks at identical MD: prefer explicit tops over "base" picks
  const sorted = [...tops].sort((a, b) => a.md - b.md || (/base/i.test(a.name) ? 1 : 0) - (/base/i.test(b.name) ? 1 : 0));
  const merged: Top[] = [];
  for (const t of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.md - t.md) < 0.05) {
      if (/base/i.test(last.name) && !/base/i.test(t.name)) merged[merged.length - 1] = t;
      continue;
    }
    if (last && last.formationId === t.formationId) continue;
    merged.push(t);
  }
  let start = mdSeabed;
  let currentId = 'nordland';
  for (const t of merged) {
    const md = Math.max(t.md, mdSeabed);
    if (md > start + 0.01) {
      zones.push({ formationId: currentId, name: FORMATION_BY_ID.get(currentId)?.name ?? currentId, topMD: start, baseMD: md });
      start = md;
    }
    currentId = t.formationId;
  }
  zones.push({ formationId: currentId, name: FORMATION_BY_ID.get(currentId)?.name ?? currentId, topMD: start, baseMD: Math.max(td, start + 1) });
  return zones;
}

export class FieldModel {
  wells: Well[] = [];
  context: ContextWell[] = [];
  picks: PickRow[] = [];
  horizons: HorizonGrid[] = [];
  extent!: ModelExtent;
  productionMonthly = new Map<string, ProductionRecord[]>();
  baseUrl = '';

  constructor(public meta: FieldMeta) {}

  get primary(): Well {
    return this.wells.find((w) => w.primary) ?? this.wells[0];
  }

  rebuildHorizons() {
    this.extent = computeExtent(this);
    this.horizons = buildHorizons(this.picks, { e: this.meta.originE, n: this.meta.originN }, this.meta.datumElevation, this.extent);
  }

  topsForWell(picksWell: string): Top[] {
    return this.picks
      .filter((p) => sameWell(p.well, picksWell))
      .map((p) => ({
        name: p.pick,
        formationId: formationIdForPick(p.pick),
        md: p.md,
        tvd: p.tvd,
        obs: p.obs,
        source: 'Volve official well picks',
        provenance: 'interpreted' as Provenance,
      }))
      .sort((a, b) => a.md - b.md || formationOrder(a.formationId) - formationOrder(b.formationId));
  }

  async ensureLoaded(well: Well, onProgress?: (msg: string) => void): Promise<void> {
    if (well.loaded) return;
    if (well.loading) return well.loading;
    well.loading = (async () => {
      if (well.lasFile) {
        onProgress?.(`Reading ${well.lasFile}`);
        const txt = await fetchText(this.baseUrl + well.lasFile);
        well.logs = parseLAS(txt, `Equinor Volve — ${well.lasFile}`, 'measured');
      }
      if (well.cpiFile) {
        onProgress?.(`Reading Equinor CPI ${well.cpiFile}`);
        const txt = await fetchText(this.baseUrl + well.cpiFile);
        well.cpi = parseLAS(txt, `Equinor CPI — ${well.cpiFile}`, 'interpreted');
      }
      if (well.productionFile) {
        onProgress?.(`Reading production ${well.productionFile}`);
        const txt = await fetchText(this.baseUrl + well.productionFile);
        well.production = productionFromTable(parseCSV(txt), `Equinor Volve production — ${well.productionFile}`, well.productionWell, 'measured');
      }
      well.autoCalibrate();
      well.refresh(this.meta.datumElevation, this.meta.waterDepth);
      well.loaded = true;
    })();
    return well.loading;
  }
}

function computeExtent(field: FieldModel): ModelExtent {
  let xMin = Infinity, xMax = -Infinity, nMin = Infinity, nMax = -Infinity;
  const add = (ew: number, ns: number) => {
    xMin = Math.min(xMin, ew);
    xMax = Math.max(xMax, ew);
    nMin = Math.min(nMin, ns);
    nMax = Math.max(nMax, ns);
  };
  for (const w of field.wells) for (let i = 0; i < w.trajectory.md.length; i += 10) add(w.trajectory.ew[i], w.trajectory.ns[i]);
  for (const c of field.context) {
    // only wells near the platform define the model box
    if (Math.hypot(c.ew[0], c.ns[0]) > 1500) continue;
    for (let i = 0; i < c.md.length; i++) add(c.ew[i], c.ns[i]);
  }
  const m = 700;
  xMin -= m; xMax += m; nMin -= m; nMax += m;
  // make square-ish for nicer block aspect
  const w = xMax - xMin, h = nMax - nMin;
  if (w > h) { nMin -= (w - h) / 2; nMax += (w - h) / 2; } else { xMin -= (h - w) / 2; xMax += (h - w) / 2; }
  return { xMin, xMax, nMin, nMax };
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.text();
}

export async function loadVolve(baseUrl: string, onProgress?: (msg: string, frac: number) => void): Promise<FieldModel> {
  onProgress?.('Reading dataset manifest', 0.02);
  const manifest = JSON.parse(await fetchText(baseUrl + 'manifest.json')) as { field: FieldMeta; wells: ManifestWell[]; picks: string; productionMonthly: string; contextTrajectories: string };
  const field = new FieldModel(manifest.field);
  field.baseUrl = baseUrl;

  onProgress?.('Reading formation picks (34 wellbores)', 0.08);
  const [picksTxt, ctxTxt, prodTxt] = await Promise.all([
    fetchText(baseUrl + manifest.picks),
    fetchText(baseUrl + manifest.contextTrajectories),
    fetchText(baseUrl + manifest.productionMonthly),
  ]);
  field.picks = picksFromTable(parseCSV(picksTxt));

  // context trajectories
  const ctx = parseCSV(ctxTxt);
  const byWell = new Map<string, number[][]>();
  for (const r of ctx.rows) {
    const k = r[0];
    if (!byWell.has(k)) byWell.set(k, []);
    byWell.get(k)!.push([+r[1], +r[2], +r[3], +r[4]]);
  }
  for (const [name, rows] of byWell) {
    field.context.push({
      name: name.replace(/^NO\s+/, ''),
      md: new Float64Array(rows.map((r) => r[0])),
      tvd: new Float64Array(rows.map((r) => r[1])),
      ns: new Float64Array(rows.map((r) => r[2])),
      ew: new Float64Array(rows.map((r) => r[3])),
    });
  }

  // monthly production (all wells)
  const prodTable = parseCSV(prodTxt);
  const names = [...new Set(prodTable.rows.map((r) => r[0]))];
  for (const n of names) {
    const s = productionFromTable(prodTable, 'Equinor Volve monthly production', n, 'measured');
    field.productionMonthly.set(n, s.records);
  }

  onProgress?.('Reading directional surveys', 0.16);
  for (const mw of manifest.wells) {
    const sv = surveyFromTable(parseCSV(await fetchText(baseUrl + mw.survey)));
    const stations = stationsFromSurvey(sv.stations, sv.hasPositions);
    const traj = new Trajectory(stations, mw.surveyStatus, mw.surveyNote, mw.survey);
    const w = new Well(mw.id, mw.name, traj, mw.summary);
    w.primary = !!mw.primary;
    w.lasFile = mw.las;
    w.cpiFile = mw.cpi;
    w.productionFile = mw.production;
    w.productionWell = mw.productionWell;
    w.kickoffMD = mw.kickoffMD;
    w.sister = mw.sister;
    w.tops = field.topsForWell(mw.picksWell);
    if (mw.productionWell) w.productionMonthly = field.productionMonthly.get(mw.productionWell) ?? [];
    w.refresh(field.meta.datumElevation, field.meta.waterDepth);
    field.wells.push(w);
  }

  onProgress?.('Interpolating structural surfaces from picks', 0.24);
  field.rebuildHorizons();

  const primary = field.primary;
  onProgress?.(`Loading ${primary.name} logs`, 0.3);
  await field.ensureLoaded(primary, (m) => onProgress?.(m, 0.5));
  onProgress?.('Building scene', 0.8);
  return field;
}

export { toMonthly };
