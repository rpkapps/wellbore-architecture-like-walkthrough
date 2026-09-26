import { z } from 'zod';
import type { AssistantTool, Dataset, DatasetColumn, DatasetRow, Json, ToolContext, ToolOutput } from '../assistant/core/types';
import { combineContacts, contactEvidence, type ContactEstimate } from '../data/contacts';
import type { FieldModel, Well } from '../data/dataset';
import type { SimModel } from '../data/bwsim';
import { ropByZone } from '../data/drilling';
import { DEFAULT_PARAMS, payIntervals, summariseZones, type PetroParams } from '../data/petro';
import { FORMATION_BY_ID, FORMATIONS, MODEL_HORIZONS } from '../data/stratigraphy';
import type { ProductionRecord } from '../data/types';
import {
  availableCurves,
  blockValue,
  coverage,
  curveStats,
  findWell,
  hasLogs,
  isoDay,
  isoMonth,
  lowerBound,
  parseIsoDate,
  resolveCurve,
  round,
  sig,
  tvdssAt,
  wellKey,
  yieldToPage,
  type CurveRef,
} from './wells';

/*
 * The read-only data tools: what the model asks for numbers. Each returns a
 * small `content` (what the model reads) and, when the answer is a table,
 * datasets whose rows stay in the browser: the kit summarises them for the
 * model and charts bind to them by id. They work on the FieldModel alone (plus
 * a few read-outs of the app), so they run in tests against the real files.
 */

/** What the data tools read from the app: the field, and a few live values. */
export interface DataContext {
  field: FieldModel;
  /** the well open in the 3D view (the default for `well`) */
  activeWell?: () => Well | undefined;
  /** the oil–water contact the contacts overlay estimated, if it is on */
  contacts?: () => ContactEstimate | null | undefined;
  /** the reservoir simulation model, when the simulation view has loaded one */
  simulation?: () => SimModel | null | undefined;
  /** the further Volve wells are shown in the app */
  extraWellsOn?: () => boolean;
}

/** Most rows a log or trajectory dataset gets (a coarser step keeps it under this). */
export const MAX_ROWS = 4000;
/** Most rows any dataset gets. */
const HARD_CAP = 10000;
/** Tables with at most this many rows are also given to the model in full. */
const INLINE_ROWS = 40;

type DS = Omit<Dataset, 'id' | 'createdAt'>;

/**
 * A JSON Schema without what a model does not need: Zod's `$schema`, the
 * integer bounds it adds (±2^53−1), `propertyNames: {type: string}`, empty
 * `additionalProperties` (both the default) and empty defaults.
 */
export function leanSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(leanSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === '$schema') continue;
    if ((k === 'maximum' || k === 'minimum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
    if (k === 'propertyNames' || (k === 'additionalProperties' && v && typeof v === 'object' && !Object.keys(v).length)) continue;
    // an empty default says no more than the property being optional
    if (k === 'default' && (v === '' || (typeof v === 'object' && v !== null && !Object.keys(v).length))) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, x]) => [p, leanSchema(x)])) : leanSchema(v);
  }
  return out;
}

/** A tool with a Zod input: validated before it runs, its JSON Schema sent to the model. */
export function zodTool<S extends z.ZodType>(t: {
  name: string;
  title: string;
  description: string;
  input: S;
  kind?: 'read' | 'write';
  run: (args: z.output<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}): AssistantTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    kind: t.kind ?? 'read',
    parameters: leanSchema(z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>,
    execute: (args, ctx) => {
      const r = t.input.safeParse(args ?? {});
      if (!r.success) throw new Error(`Invalid arguments for ${t.name}: ${z.prettifyError(r.error)}`);
      return t.run(r.data, ctx);
    },
  };
}

/** A dataset column. */
const col = (key: string, label?: string, unit?: string, type: DatasetColumn['type'] = 'number'): DatasetColumn => ({ key, ...(label ? { label } : {}), ...(unit ? { unit } : {}), type });

/** A tool result with datasets; small tables are also in `content`, so the model sees every number. */
function out(content: Record<string, Json>, datasets: DS[] = []): ToolOutput {
  for (const d of datasets) if (d.rows.length > HARD_CAP) d.rows = d.rows.slice(0, HARD_CAP);
  const c: Record<string, Json> = { ...content };
  if (datasets.length === 1 && datasets[0].rows.length <= INLINE_ROWS && !('rows' in c)) c.rows = datasets[0].rows as Json;
  return { content: c, datasets };
}

const optWell = z.string().optional().describe('Well id or name (default: the open well)');
const curvesArg = z.array(z.string()).min(1).max(16).describe('Curve mnemonics or aliases: GR, RT, RDEEP, RSHAL, RHOB, NPHI, DT, DTS, CALI, BS, PEF, DRHO, ROP; CPI names; or VSH, PHIE, SW, SO, BVW, HCPV, NET, PAY (interpretation)');

const fname = (id: string) => FORMATION_BY_ID.get(id)?.name ?? id;
const isGeo = (id: string) => id !== 'air' && id !== 'sea';

export function dataTools(dc: DataContext): AssistantTool[] {
  const { field } = dc;
  const datum = field.meta.datumElevation;
  /** The named well, or the open one; loads its files (logs, CPI, daily production) once. */
  const wellArg = async (key: string | undefined, ctx?: ToolContext): Promise<Well> => {
    const w = key ? findWell(field, key) : dc.activeWell?.();
    if (!w) throw new Error(`Name a well: ${field.wells.map((x) => x.id).join(', ')}.`);
    if (!w.loaded && (w.lasFile || w.cpiFile || w.productionFile)) await field.ensureLoaded(w);
    if (ctx?.signal.aborted) throw new Error('Cancelled.');
    return w;
  };
  const zoneAt = (w: Well, md: number) => {
    const z = w.zoneAt(md);
    return z ? z.name : null;
  };
  const needLogs = (w: Well) => {
    if (!w.logs) throw new Error(`${w.name} has no logs. Wells with logs: ${field.wells.filter(hasLogs).map((x) => x.id).join(', ')}.`);
    return w.logs;
  };
  const tvdss = (w: Well, md: number) => tvdssAt(field, w, md);

  return [
    // ------------------------------------------------------------------ the field
    zodTool({
      name: 'data.field_overview',
      title: 'Field overview',
      description:
        'The Volve field at a glance: field facts (operator, block, datum, water depth, CRS), every well with its status, TD, whether it has logs, CPI and production, the formation column and the well open in the app. Call it first for questions about the field or to find well ids.',
      input: z.object({}),
      run: () => {
        const active = dc.activeWell?.();
        const extraOn = dc.extraWellsOn?.() ?? true;
        const rows: DatasetRow[] = field.wells.map((w) => {
          const end = w.trajectory.at(w.trajectory.mdEnd);
          const cum = w.productionMonthly.reduce((s, r) => s + r.oil, 0);
          return {
            id: w.id,
            name: w.name,
            role: w.primary ? 'primary' : w.extra ? 'extra' : w.userAdded ? 'uploaded' : w.liveSource ? 'live' : 'main',
            shownInApp: !w.extra || extraOn || w === active,
            trajectory: w.trajectory.status,
            tdMd: round(w.tdMD, 1),
            tdTvdss: round(end.tvd - datum, 1),
            maxInc: round(Math.max(...w.trajectory.inc), 1),
            logs: hasLogs(w),
            cpi: !!(w.cpi || w.cpiFile),
            production: w.productionMonthly.length > 0 || !!w.productionFile,
            cumOilSm3: cum ? Math.round(cum) : null,
          };
        });
        const m = field.meta;
        return out(
          {
            field: { name: m.name, block: m.block, country: m.country, operator: m.operator, facility: m.facility, crs: m.crs, datum: `${m.datum}, ${m.datumElevation} m above MSL`, waterDepthM: m.waterDepth, licence: m.licence },
            activeWell: active ? { id: active.id, name: active.name } : null,
            productionSeries: [...field.productionMonthly.keys()],
            formations: MODEL_HORIZONS.map((id) => `${id}: ${fname(id)}${FORMATION_BY_ID.get(id)?.reservoir ? ' (reservoir)' : ''}`),
            simulation: !!(dc.simulation?.() || field.simulationFile),
            note: 'Depths: MD and TVD from the drill floor; TVDSS below mean sea level (TVD − datum elevation). role "extra" wells show in the 3D view only once the "extraWells" feature is on, but their data can be read.',
          },
          [{ title: 'Volve wells', source: 'Equinor Volve data (manifest, surveys, monthly production)', columns: [col('id', 'Well id', undefined, 'string'), col('name', 'Name', undefined, 'string'), col('role', 'Role', undefined, 'string'), col('shownInApp', 'Shown', undefined, 'boolean'), col('trajectory', 'Trajectory', undefined, 'string'), col('tdMd', 'TD', 'm MD'), col('tdTvdss', 'TD', 'm TVDSS'), col('maxInc', 'Max inc.', '°'), col('logs', 'Logs', undefined, 'boolean'), col('cpi', 'CPI', undefined, 'boolean'), col('production', 'Production', undefined, 'boolean'), col('cumOilSm3', 'Cum. oil', 'Sm3')], rows }],
        );
      },
    }),

    zodTool({
      name: 'data.well_info',
      title: 'Well information',
      description:
        'Everything about one well: trajectory summary (kick-off, max inclination, landing, TD in MD/TVD/TVDSS, displacement), casing, formation tops and zones, every log curve with unit, provenance and depth coverage, CPI curves, the interpretation parameters and a production summary. Use it before plotting to learn the curve names.',
      input: z.object({ well: optWell }),
      run: async ({ well: key }, ctx) => {
        const w = await wellArg(key, ctx);
        const t = w.trajectory;
        let maxInc = 0, maxIncMd = 0, maxDls = 0, maxDlsMd = 0, kop: number | null = null, landing: number | null = null;
        for (let i = 0; i < t.md.length; i++) {
          if (t.inc[i] > maxInc) (maxInc = t.inc[i]), (maxIncMd = t.md[i]);
          if (t.dls[i] > maxDls) (maxDls = t.dls[i]), (maxDlsMd = t.md[i]);
          if (kop === null && t.inc[i] > 5) kop = t.md[i];
          if (landing === null && t.inc[i] > 80) landing = t.md[i];
        }
        const end = t.at(t.mdEnd);
        const curves = availableCurves(w).map((c) => {
          const cov = coverage(c);
          return { key: c.key, unit: c.unit || null, description: c.description !== c.mnemonic ? c.description : null, source: c.source, provenance: c.provenance, fromMd: round(cov?.fromMd, 1), toMd: round(cov?.toMd, 1) };
        });
        const prod = w.productionMonthly;
        const params = Object.entries(w.params).filter(([k, v]) => v !== DEFAULT_PARAMS[k as keyof PetroParams]);
        return {
          id: w.id,
          name: w.name,
          summary: w.summary,
          role: w.primary ? 'primary' : w.extra ? 'extra' : w.userAdded ? 'uploaded' : 'main',
          ...(w.sister ? { sidetrackOf: w.sister } : {}),
          ...(w.kickoffMD ? { sidetrackKickoffMd: w.kickoffMD } : {}),
          trajectory: {
            status: t.status,
            note: t.note,
            tdMd: round(w.tdMD, 1),
            tdTvd: round(end.tvd, 1),
            tdTvdss: round(end.tvd - datum, 1),
            buildStartMd: round(kop, 0),
            maxInclination: { deg: round(maxInc, 1), md: round(maxIncMd, 0) },
            horizontalFromMd: round(landing, 0),
            maxDogleg: { degPer30m: round(maxDls, 2), md: round(maxDlsMd, 0) },
            displacementAtTdM: round(Math.hypot(end.ns, end.ew), 0),
            aziAtTd: round(end.azi, 1),
          },
          casing: w.casing.map((c) => ({ name: c.name, hole: `${c.hole}"`, shoeMd: round(c.shoeMD, 0), provenance: c.provenance })),
          tops: w.tops.map((p) => ({ name: p.name, formation: p.formationId, md: round(p.md, 1), tvdss: round((p.tvd ?? t.at(p.md).tvd) - datum, 1) })),
          zones: w.zones.filter((z) => isGeo(z.formationId)).map((z) => ({ zone: z.name, formation: z.formationId, topMd: round(z.topMD, 1), baseMd: round(z.baseMD, 1) })),
          curves: curves as Json,
          interpretation: w.petro?.available ? { available: true, inputs: w.petro.inputs as Json, changedParameters: Object.fromEntries(params) as Json } : { available: false, why: w.logs ? 'needs density (RHOB) and resistivity (RT) logs' : 'no logs' },
          production: prod.length
            ? {
                series: w.productionWell ?? null,
                from: isoMonth(prod[0].t),
                to: isoMonth(prod[prod.length - 1].t),
                cumOilSm3: Math.round(prod.reduce((s, r) => s + r.oil, 0)),
                cumGasSm3: Math.round(prod.reduce((s, r) => s + r.gas, 0)),
                cumWaterSm3: Math.round(prod.reduce((s, r) => s + r.water, 0)),
                cumWaterInjSm3: Math.round(prod.reduce((s, r) => s + r.waterInj, 0)),
                daily: !!w.production,
              }
            : null,
        };
      },
    }),

    // ------------------------------------------------------------------ logs
    zodTool({
      name: 'data.log_samples',
      title: 'Log samples',
      description:
        'Log curves of a well over a depth range as a dataset (columns md, tvdss, zone and one per curve, with units), resampled to `step` metres (block mean; geometric for resistivity). Default step keeps ≤ 4,000 rows. Also returns the tops in range (for markers).',
      input: z.object({
        well: optWell,
        curves: curvesArg,
        fromMd: z.number().min(0).optional().describe('Top of the range, m MD (default: where the curves start)'),
        toMd: z.number().min(0).optional().describe('Base of the range, m MD (default: where they end)'),
        step: z.number().positive().optional().describe('Sample spacing, m'),
        includeInterpretation: z.boolean().optional().describe('Also add VSH, PHIE, SW and PAY from the petrophysical interpretation'),
      }),
      run: async ({ well: key, curves, fromMd, toMd, step, includeInterpretation }, ctx) => {
        const w = await wellArg(key, ctx);
        needLogs(w);
        const all = availableCurves(w);
        const names = [...curves, ...(includeInterpretation ? ['VSH', 'PHIE', 'SW', 'PAY'] : [])];
        const refs: CurveRef[] = [];
        for (const n of names) {
          const r = resolveCurve(w, n, all);
          if (!refs.includes(r)) refs.push(r);
        }
        const covs = refs.map(coverage).filter((c): c is NonNullable<typeof c> => !!c);
        if (!covs.length) throw new Error(`${refs.map((r) => r.key).join(', ')} have no data in ${w.name}.`);
        const top = Math.max(0, fromMd ?? Math.min(...covs.map((c) => c.fromMd)));
        const base = Math.min(w.tdMD, toMd ?? Math.max(...covs.map((c) => c.toMd)));
        if (!(base > top)) throw new Error(`Empty range ${top}–${base} m MD (${w.name} is logged ${round(Math.min(...covs.map((c) => c.fromMd)), 0)}–${round(Math.max(...covs.map((c) => c.toMd)), 0)} m MD).`);
        const native = refs[0].depth.length > 1 ? (refs[0].depth[refs[0].depth.length - 1] - refs[0].depth[0]) / (refs[0].depth.length - 1) : 0.15;
        const min = Math.max(native, (base - top) / MAX_ROWS);
        const s = Math.max(step ?? min, min);
        const rows: DatasetRow[] = [];
        for (let md = top; md <= base + 1e-6; md += s) {
          const row: DatasetRow = { md: round(md, 2), tvdss: round(tvdss(w, md), 2), zone: zoneAt(w, md) };
          for (const r of refs) row[r.key] = sig(blockValue(r, md - s / 2, md + s / 2), 4);
          rows.push(row);
        }
        const tops = w.tops.filter((p) => p.md >= top && p.md <= base).map((p) => ({ name: p.name, formation: p.formationId, md: round(p.md, 1), tvdss: round(tvdss(w, p.md), 1) }));
        return out(
          {
            well: w.id,
            range: `${round(top, 1)}–${round(base, 1)} m MD`,
            step: round(s, 3),
            ...(step && s > step ? { stepRaised: `step raised from ${step} m to keep ≤ ${MAX_ROWS} rows` } : {}),
            curves: refs.map((r) => ({ key: r.key, unit: r.unit, provenance: r.provenance, source: r.source, ...(r.log ? { scale: 'log' } : {}) })),
            tops,
          },
          [
            {
              title: `${w.name} · ${refs.map((r) => r.key).join(', ')}`,
              source: `${w.name}, ${round(top, 0)}–${round(base, 0)} m MD, every ${round(s, 2)} m`,
              columns: [col('md', 'MD', 'm'), col('tvdss', 'TVDSS', 'm'), col('zone', 'Zone', undefined, 'string'), ...refs.map((r) => col(r.key, r.key, r.unit || undefined))],
              rows,
            },
          ],
        );
      },
    }),

    zodTool({
      name: 'data.curve_stats',
      title: 'Curve statistics',
      description: 'Min, P10, P50, P90, max, mean (and geometric mean for resistivity) of curves of a well over a depth range, optionally per zone (formation). Uses every raw sample.',
      input: z.object({
        well: optWell,
        curves: curvesArg,
        fromMd: z.number().min(0).optional(),
        toMd: z.number().min(0).optional(),
        byZone: z.boolean().optional().describe('One row per curve and zone'),
      }),
      run: async ({ well: key, curves, fromMd, toMd, byZone }, ctx) => {
        const w = await wellArg(key, ctx);
        needLogs(w);
        const all = availableCurves(w);
        const refs = curves.map((n) => resolveCurve(w, n, all));
        const top = fromMd ?? 0;
        const base = toMd ?? w.tdMD;
        const windows = byZone ? w.zones.filter((z) => isGeo(z.formationId) && z.baseMD > top && z.topMD < base).map((z) => ({ zone: z.name, a: Math.max(top, z.topMD), b: Math.min(base, z.baseMD) })) : [{ zone: null, a: top, b: base }];
        const rows: DatasetRow[] = [];
        for (const r of refs)
          for (const win of windows) {
            const s = curveStats(r, win.a, win.b);
            if (!s.n && byZone) continue;
            rows.push({
              curve: r.key,
              unit: r.unit,
              ...(byZone ? { zone: win.zone } : {}),
              topMd: round(win.a, 1),
              baseMd: round(win.b, 1),
              n: s.n,
              min: sig(s.min),
              p10: sig(s.p10),
              p50: sig(s.p50),
              p90: sig(s.p90),
              max: sig(s.max),
              mean: sig(s.mean),
              ...(r.log ? { geomean: sig(s.geomean) } : {}),
            });
          }
        return out({ well: w.id, provenance: [...new Set(refs.map((r) => `${r.key}: ${r.provenance}`))] }, [
          {
            title: `${w.name} · curve statistics${byZone ? ' by zone' : ''}`,
            source: `${w.name}, ${round(top, 0)}–${round(base, 0)} m MD`,
            columns: [col('curve', 'Curve', undefined, 'string'), col('unit', 'Unit', undefined, 'string'), ...(byZone ? [col('zone', 'Zone', undefined, 'string')] : []), col('topMd', 'Top', 'm MD'), col('baseMd', 'Base', 'm MD'), col('n', 'Samples'), col('min', 'Min'), col('p10', 'P10'), col('p50', 'P50'), col('p90', 'P90'), col('max', 'Max'), col('mean', 'Mean'), col('geomean', 'Geo. mean')],
            rows,
          },
        ]);
      },
    }),

    zodTool({
      name: 'data.value_at',
      title: 'Values at a depth',
      description: 'The values of all (or the named) curves of a well at one measured depth, with the zone, TVD, TVDSS, inclination and azimuth there.',
      input: z.object({ well: optWell, md: z.number().min(0).describe('Measured depth, m'), curves: z.array(z.string()).optional() }),
      run: async ({ well: key, md, curves }, ctx) => {
        const w = await wellArg(key, ctx);
        const p = w.trajectory.at(md);
        const all = availableCurves(w);
        const refs = curves?.length ? curves.map((n) => resolveCurve(w, n, all)) : all;
        const values: Record<string, Json> = {};
        for (const r of refs) {
          const v = blockValue(r, md - 0.08, md + 0.08);
          values[r.key] = Number.isFinite(v) ? `${sig(v)}${r.unit && r.unit !== 'flag' ? ` ${r.unit}` : ''}${r.source === 'logs' ? '' : ` (${r.provenance})`}` : null;
        }
        return { well: w.id, md, tvd: round(p.tvd, 1), tvdss: round(p.tvd - datum, 1), inclination: round(p.inc, 1), azimuth: round(p.azi, 1), zone: zoneAt(w, md), beyondTd: md > w.tdMD, values };
      },
    }),

    zodTool({
      name: 'data.tops',
      title: 'Formation tops',
      description: 'Formation tops (operator picks) of one well or of every well: formation, pick name, MD, TVD and TVDSS. Provenance: interpreted (Volve official well picks).',
      input: z.object({ well: z.string().optional().describe('Well id or name; omit for every well') }),
      run: async ({ well: key }) => {
        const wells = key ? [findWell(field, key)] : field.wells;
        const rows: DatasetRow[] = [];
        for (const w of wells)
          for (const p of w.tops) {
            const tvd = p.tvd ?? w.trajectory.at(p.md).tvd;
            rows.push({ well: w.id, formation: p.formationId, formationName: fname(p.formationId), pick: p.name, md: round(p.md, 1), tvd: round(tvd, 1), tvdss: round(tvd - datum, 1) });
          }
        const byFormation: Record<string, Json> = {};
        if (!key)
          for (const id of MODEL_HORIZONS) {
            const r = rows.filter((x) => x.formation === id);
            if (r.length) byFormation[fname(id)] = { wells: r.length, tvdssMin: Math.min(...r.map((x) => x.tvdss as number)), tvdssMax: Math.max(...r.map((x) => x.tvdss as number)) };
          }
        return out({ ...(key ? { well: wells[0].id } : { wells: wells.length, byFormation }), provenance: 'interpreted (operator picks)' }, [
          {
            title: key ? `${wells[0].name} · formation tops` : 'Formation tops · all wells',
            source: 'Volve official well picks',
            columns: [col('well', 'Well', undefined, 'string'), col('formation', 'Formation id', undefined, 'string'), col('formationName', 'Formation', undefined, 'string'), col('pick', 'Pick', undefined, 'string'), col('md', 'MD', 'm'), col('tvd', 'TVD', 'm'), col('tvdss', 'TVDSS', 'm')],
            rows,
          },
        ]);
      },
    }),

    // ------------------------------------------------------------------ petrophysics
    zodTool({
      name: 'data.zone_summary',
      title: 'Zone petrophysics',
      description:
        'Petrophysical summary per zone of a well from the live interpretation: gross, net and pay thickness (m MD), net-to-gross, pay-averaged porosity, pore-volume-weighted Sw, hydrocarbon column (Σφ·So·h, m), geometric-mean resistivity and data coverage; plus mean ROP per zone where there is an ROP log. Provenance: calculated.',
      input: z.object({ well: optWell }),
      run: async ({ well: key }, ctx) => {
        const w = await wellArg(key, ctx);
        const logs = needLogs(w);
        if (!w.petro?.available) throw new Error(`${w.name} cannot be interpreted: it needs density (RHOB) and resistivity (RT) logs.`);
        const zs = summariseZones(logs, w.petro, w.zones.filter((z) => isGeo(z.formationId)));
        const rop = new Map(ropByZone(logs, w.zones).map((r) => [`${r.formationId}@${r.topMD}`, r.meanRop]));
        const rows: DatasetRow[] = zs
          .filter((s) => s.gross > 0)
          .map((s) => ({
            zone: s.zone.name,
            formation: s.zone.formationId,
            topMd: round(s.zone.topMD, 1),
            baseMd: round(s.zone.baseMD, 1),
            topTvdss: round(tvdss(w, s.zone.topMD), 1),
            grossM: round(s.gross, 1),
            netM: round(s.net, 1),
            payM: round(s.pay, 1),
            ntg: round(s.ntg, 3),
            phiAvg: round(s.phiAvg, 3),
            swAvg: round(s.swAvg, 3),
            hcColumnM: round(s.hcColumn, 2),
            rtGeomean: sig(s.rtAvg, 3),
            coverage: round(s.coverage, 2),
            ropMean: sig(rop.get(`${s.zone.formationId}@${s.zone.topMD}`), 3),
          }));
        const tot = zs.reduce((a, s) => ({ gross: a.gross + s.gross, net: a.net + s.net, pay: a.pay + s.pay, hc: a.hc + s.hcColumn }), { gross: 0, net: 0, pay: 0, hc: 0 });
        const p = w.params;
        return out(
          {
            well: w.id,
            provenance: 'calculated (this app, from measured logs and the parameters below)',
            cutoffs: `net: Vsh < ${p.cutVsh}, φ > ${p.cutPhi}; pay: net and Sw < ${p.cutSw}`,
            model: `Vsh ${p.vshMethod} (GR ${p.grClean}–${p.grShale}), φ ${p.porosityMethod} (ρma ${p.rhoMa}, ρfl ${p.rhoFl}), Sw ${p.satModel} (a ${p.a}, m ${p.m}, n ${p.n}, Rw ${p.rw} Ω·m)`,
            totals: { grossM: round(tot.gross, 1), netM: round(tot.net, 1), payM: round(tot.pay, 1), hcColumnM: round(tot.hc, 2) },
            note: 'Thicknesses are along hole (m MD): in a horizontal well they exceed the true vertical thickness.',
          },
          [
            {
              title: `${w.name} · zone summary`,
              source: `${w.name}, live petrophysical interpretation`,
              columns: [
                col('zone', 'Zone', undefined, 'string'),
                col('formation', 'Formation id', undefined, 'string'),
                col('topMd', 'Top', 'm MD'),
                col('baseMd', 'Base', 'm MD'),
                col('topTvdss', 'Top', 'm TVDSS'),
                col('grossM', 'Gross', 'm'),
                col('netM', 'Net', 'm'),
                col('payM', 'Pay', 'm'),
                col('ntg', 'N/G', 'v/v'),
                col('phiAvg', 'φ avg', 'v/v'),
                col('swAvg', 'Sw avg', 'v/v'),
                col('hcColumnM', 'HC column', 'm'),
                col('rtGeomean', 'Rt', 'Ω·m'),
                col('coverage', 'Coverage', 'fraction'),
                col('ropMean', 'ROP', 'm/h'),
              ],
              rows,
            },
          ],
        );
      },
    }),

    zodTool({
      name: 'data.pay_intervals',
      title: 'Pay intervals',
      description: 'Continuous net-pay intervals of a well (the interpretation’s pay flag), with thickness, zone, TVDSS and average porosity and Sw in each. Provenance: calculated.',
      input: z.object({ well: optWell, minThickness: z.number().min(0).optional().describe('Shortest interval kept, m MD (default 0.5)') }),
      run: async ({ well: key, minThickness = 0.5 }, ctx) => {
        const w = await wellArg(key, ctx);
        const logs = needLogs(w);
        const p = w.petro;
        if (!p?.available) throw new Error(`${w.name} cannot be interpreted: it needs density (RHOB) and resistivity (RT) logs.`);
        const d = logs.depth;
        const rows: DatasetRow[] = payIntervals(d, p.pay, minThickness).map((iv) => {
          let phi = 0, sw = 0, n = 0;
          for (let i = lowerBound(d, iv.top); i < d.length && d[i] <= iv.base; i++) {
            if (!p.pay[i]) continue;
            phi += p.phie.values[i];
            sw += p.sw.values[i];
            n++;
          }
          return { topMd: round(iv.top, 2), baseMd: round(iv.base, 2), thicknessM: round(iv.base - iv.top, 2), zone: zoneAt(w, (iv.top + iv.base) / 2), topTvdss: round(tvdss(w, iv.top), 1), baseTvdss: round(tvdss(w, iv.base), 1), phiAvg: round(n ? phi / n : NaN, 3), swAvg: round(n ? sw / n : NaN, 3) };
        });
        const total = rows.reduce((s, r) => s + (r.thicknessM as number), 0);
        const thickest = [...rows].sort((a, b) => (b.thicknessM as number) - (a.thicknessM as number)).slice(0, 8);
        return out({ well: w.id, intervals: rows.length, totalPayM: round(total, 1), thickest: thickest as Json, provenance: 'calculated', link: 'Travel to one with app://depth/<md>' }, [
          {
            title: `${w.name} · pay intervals`,
            source: `${w.name}, live interpretation, intervals ≥ ${minThickness} m`,
            columns: [col('topMd', 'Top', 'm MD'), col('baseMd', 'Base', 'm MD'), col('thicknessM', 'Thickness', 'm MD'), col('zone', 'Zone', undefined, 'string'), col('topTvdss', 'Top', 'm TVDSS'), col('baseTvdss', 'Base', 'm TVDSS'), col('phiAvg', 'φ avg', 'v/v'), col('swAvg', 'Sw avg', 'v/v')],
            rows,
          },
        ]);
      },
    }),

    // ------------------------------------------------------------------ production
    productionTool(dc),

    // ------------------------------------------------------------------ geometry
    zodTool({
      name: 'data.trajectory',
      title: 'Well trajectory',
      description: 'The path of a well as a dataset: md, tvd, tvdss, inclination, azimuth, dogleg severity (°/30 m), north and east offsets from the platform origin (m) and zone; or the survey stations as delivered.',
      input: z.object({ well: optWell, step: z.number().positive().optional().describe('Spacing, m MD (default keeps ≤ 2,000 rows)'), stations: z.boolean().optional().describe('The survey stations instead of a resampled path') }),
      run: async ({ well: key, step, stations }, ctx) => {
        const w = await wellArg(key, ctx);
        const t = w.trajectory;
        const rows: DatasetRow[] = [];
        const push = (md: number, p: { tvd: number; inc: number; azi: number; dls?: number; ns: number; ew: number }) =>
          rows.push({ md: round(md, 1), tvd: round(p.tvd, 2), tvdss: round(p.tvd - datum, 2), inc: round(p.inc, 2), azi: round(p.azi, 2), dls: round(p.dls ?? NaN, 2), ns: round(p.ns, 2), ew: round(p.ew, 2), zone: zoneAt(w, md) });
        if (stations) for (const s of t.stations) push(s.md, s);
        else {
          const s = Math.max(step ?? 0, (t.mdEnd - t.mdStart) / 2000, t.step);
          for (let md = t.mdStart; md <= t.mdEnd + 1e-6; md += s) push(md, t.at(md));
        }
        return out({ well: w.id, status: t.status, note: t.note, rows: rows.length, provenance: t.status === 'reconstructed' ? 'reconstructed' : 'measured' }, [
          {
            title: `${w.name} · trajectory`,
            source: `${w.name}, ${t.status} survey (${t.source})`,
            columns: [col('md', 'MD', 'm'), col('tvd', 'TVD', 'm'), col('tvdss', 'TVDSS', 'm'), col('inc', 'Inclination', '°'), col('azi', 'Azimuth', '°'), col('dls', 'DLS', '°/30 m'), col('ns', 'North', 'm'), col('ew', 'East', 'm'), col('zone', 'Zone', undefined, 'string')],
            rows,
          },
        ]);
      },
    }),

    zodTool({
      name: 'data.formations',
      title: 'Formations',
      description: 'The stratigraphic column of the Volve area, top down: id, name, group, age, lithology, whether it is a reservoir, and a description (NPD lexicon).',
      input: z.object({}),
      run: () => {
        const rows: DatasetRow[] = FORMATIONS.map((f) => ({ id: f.id, name: f.name, group: f.group, age: f.age, lithology: f.lithology, reservoir: !!f.reservoir, inModel: MODEL_HORIZONS.includes(f.id), description: f.description }));
        return out({ formations: rows.length }, [
          { title: 'Volve stratigraphy', source: 'NPD lithostratigraphic lexicon', columns: [col('id', 'Id', undefined, 'string'), col('name', 'Name', undefined, 'string'), col('group', 'Group', undefined, 'string'), col('age', 'Age', undefined, 'string'), col('lithology', 'Lithology', undefined, 'string'), col('reservoir', 'Reservoir', undefined, 'boolean'), col('inModel', 'In 3D model', undefined, 'boolean'), col('description', 'Description', undefined, 'string')], rows },
        ]);
      },
    }),

    zodTool({
      name: 'data.contacts',
      title: 'Oil–water contact',
      description: 'The oil–water contact estimated from the logged wells (deepest oil and shallowest water in clean Hugin–Skagerrak sands, from the live Sw): depth (m TVDSS) ± uncertainty, basis, method and each well’s evidence. Provenance: calculated.',
      input: z.object({}),
      run: async (_a, ctx) => {
        let est = dc.contacts?.() ?? null;
        if (!est) {
          const extra = dc.extraWellsOn?.() ?? false;
          const list = field.wells.filter((w) => w.lasFile && (!w.extra || extra));
          const ev = [];
          for (const w of list) {
            if (!w.loaded) {
              await field.ensureLoaded(w);
              await yieldToPage();
            }
            if (ctx.signal.aborted) throw new Error('Cancelled.');
            if (w.logs && w.petro) ev.push(contactEvidence(w.name, w.logs, w.petro, w.zones, w.trajectory, datum));
          }
          est = combineContacts(ev);
        }
        if (!est) return { found: false, why: 'No clean reservoir sands with oil or water readings in the logged wells.' };
        const rows: DatasetRow[] = est.evidence.map((e) => ({ well: e.well, oilDownToTvdss: round(e.odt, 1), waterUpToTvdss: round(e.wut, 1), samples: e.samples, conflicts: est!.conflicts.includes(e.well) }));
        return out(
          { depthTvdss: round(est.depth, 1), plusMinusM: round(est.plusMinus, 1), shallowTvdss: round(est.shallow, 1), deepTvdss: round(est.deep, 1), basis: est.basis, method: est.method, conflicts: est.conflicts, provenance: 'calculated' },
          [{ title: 'Oil–water contact evidence', source: 'Live Sw interpretation of the logged wells', columns: [col('well', 'Well', undefined, 'string'), col('oilDownToTvdss', 'Oil down to', 'm TVDSS'), col('waterUpToTvdss', 'Water up to', 'm TVDSS'), col('samples', 'Samples'), col('conflicts', 'Conflicts', undefined, 'boolean')], rows }],
        );
      },
    }),

    zodTool({
      name: 'data.simulation_summary',
      title: 'Simulation summary',
      description: 'The reservoir simulation’s summary vectors over time (field oil production total and rate, water cut, pressure…; or one well’s), when the simulation view has loaded the model. Provenance: calculated (Eclipse / OPM Flow run).',
      input: z.object({ well: z.string().optional().describe('A well name of the model (see `wells` in the result); omit for field vectors') }),
      run: ({ well: key }) => {
        const m = dc.simulation?.();
        if (!m) return { available: false, why: field.simulationFile ? 'The simulation model is not loaded: open the simulation view (features.set {"feature":"simulation","on":true}) and call again.' : 'No simulation model is loaded; one can be imported as a .bwsim package in Data.' };
        const s = m.header.summary;
        if (!s) return { available: false, why: 'The loaded model has no summary vectors.', model: m.header.name };
        let vectors = s.field;
        if (key) {
          const k = Object.keys(s.wells ?? {}).find((n) => n.replace(/[^A-Z0-9]/gi, '').toUpperCase().endsWith(key.replace(/[^A-Z0-9]/gi, '').toUpperCase()));
          if (!k) throw new Error(`No well "${key}" in the model. Wells: ${Object.keys(s.wells ?? {}).join(', ') || 'none'}.`);
          vectors = s.wells![k];
        }
        const keys = Object.keys(vectors);
        const rows: DatasetRow[] = s.t.map((t, i) => Object.fromEntries([['date', isoDay(t)], ...keys.map((k) => [k, sig(vectors[k][i], 5)])]));
        const last = rows[rows.length - 1] ?? {};
        return out({ model: m.header.name, note: m.header.summaryNote ?? m.header.note, vectors: keys.map((k) => `${k} (${simUnit(k)})`), wells: Object.keys(s.wells ?? {}), last: last as Json, provenance: m.header.provenance }, [
          { title: `${m.header.name} · ${key ?? 'field'} summary`, source: m.header.source, columns: [col('date', 'Date', undefined, 'date'), ...keys.map((k) => col(k, k, simUnit(k)))], rows },
        ]);
      },
    }),

    zodTool({
      name: 'data.compare_wells',
      title: 'Compare wells',
      description:
        'One curve in several wells for correlation: by default a TVDSS grid with one column per well (each well sampled where it first reaches that TVDSS), or `layout: "long"` with rows well, md, tvdss, value, zone. Returns each well’s tops in range (TVDSS) for markers.',
      input: z.object({
        wells: z.array(z.string()).optional().describe('Well ids or names; default: every logged well shown in the app'),
        curve: z.string().describe('One curve mnemonic or alias (GR, RDEEP, RHOB, NPHI, PHIE, SW…)'),
        fromTvdss: z.number().optional(),
        toTvdss: z.number().optional(),
        step: z.number().positive().optional().describe('Spacing, m (default keeps ≤ 2,000 rows)'),
        layout: z.enum(['wide', 'long']).optional(),
      }),
      run: async ({ wells: keys, curve, fromTvdss, toTvdss, step, layout = 'wide' }, ctx) => {
        const extra = dc.extraWellsOn?.() ?? true;
        const ws = keys?.length ? keys.map((k) => findWell(field, k)) : field.wells.filter((w) => hasLogs(w) && (!w.extra || extra));
        const refs: { w: Well; r: CurveRef }[] = [];
        const skipped: string[] = [];
        for (const w of ws) {
          await wellArg(w.id, ctx);
          await yieldToPage();
          try {
            refs.push({ w, r: resolveCurve(w, curve) });
          } catch {
            skipped.push(w.id);
          }
        }
        if (!refs.length) throw new Error(`None of ${ws.map((w) => w.id).join(', ')} has "${curve}".`);
        // the TVDSS range the curves cover
        let lo = Infinity, hi = -Infinity;
        for (const { w, r } of refs) {
          const c = coverage(r);
          if (!c) continue;
          lo = Math.min(lo, tvdss(w, c.fromMd));
          hi = Math.max(hi, tvdss(w, c.toMd));
        }
        const top = fromTvdss ?? lo;
        const base = toTvdss ?? hi;
        if (!(base > top)) throw new Error(`Empty TVDSS range ${top}–${base} m.`);
        const unit = refs[0].r.unit;
        const tops = refs.map(({ w }) => ({ well: w.id, tops: w.tops.map((p) => ({ name: p.name, tvdss: round((p.tvd ?? w.trajectory.at(p.md).tvd) - datum, 1) })).filter((p) => p.tvdss! >= top && p.tvdss! <= base) }));
        const content = { curve: refs[0].r.key, unit, provenance: refs[0].r.provenance, range: `${round(top, 0)}–${round(base, 0)} m TVDSS`, ...(skipped.length ? { withoutCurve: skipped } : {}), tops, ...(refs[0].r.log ? { scale: 'log' } : {}) };
        if (layout === 'long') {
          const rows: DatasetRow[] = [];
          const per = Math.max(1, Math.floor(HARD_CAP / refs.length));
          for (const { w, r } of refs) {
            const t = w.trajectory;
            const a = t.mdAtTVD(top + datum);
            const md0 = Number.isFinite(a) ? a : t.mdStart;
            const md1 = Math.min(w.tdMD, t.mdEnd);
            const s = Math.max(step ?? 0, (md1 - md0) / per, 0.15);
            for (let md = md0; md <= md1; md += s) {
              const z = tvdss(w, md);
              if (z < top || z > base) continue;
              rows.push({ well: w.id, md: round(md, 2), tvdss: round(z, 2), value: sig(blockValue(r, md - s / 2, md + s / 2)), zone: zoneAt(w, md) });
            }
          }
          return out(content, [{ title: `${content.curve} · ${refs.length} wells`, source: `${refs.map((x) => x.w.id).join(', ')}, ${content.range}`, columns: [col('well', 'Well', undefined, 'string'), col('md', 'MD', 'm'), col('tvdss', 'TVDSS', 'm'), col('value', content.curve, unit), col('zone', 'Zone', undefined, 'string')], rows }]);
        }
        const s = Math.max(step ?? 0, (base - top) / 2000, 0.15);
        const grid: number[] = [];
        for (let z = top; z <= base + 1e-6; z += s) grid.push(z);
        const rows: DatasetRow[] = grid.map((z) => ({ tvdss: round(z, 2) }));
        for (const { w, r } of refs) {
          const t = w.trajectory;
          let i = 0;
          const k = wellKey(w);
          for (let g = 0; g < grid.length; g++) {
            const target = grid[g] + datum;
            // walk forward along the path to where it first reaches this depth
            while (i < t.md.length - 1 && t.tvd[i + 1] < target) i++;
            if (i >= t.md.length - 1 || t.tvd[i] > target) {
              rows[g][k] = null;
              continue;
            }
            const f = (target - t.tvd[i]) / (t.tvd[i + 1] - t.tvd[i] || 1);
            const md = t.md[i] + f * (t.md[i + 1] - t.md[i]);
            // a vertical step s is a longer stretch of hole where the well is inclined
            const cos = Math.max(0.05, Math.cos((t.inc[i] * Math.PI) / 180));
            rows[g][k] = sig(blockValue(r, md - s / (2 * cos), md + s / (2 * cos)));
          }
        }
        return out({ ...content, columns: refs.map(({ w }) => `${wellKey(w)} = ${w.name}`) }, [
          { title: `${content.curve} · ${refs.length} wells by TVDSS`, source: `${refs.map((x) => x.w.id).join(', ')}, ${content.range}, every ${round(s, 2)} m`, columns: [col('tvdss', 'TVDSS', 'm'), ...refs.map(({ w }) => col(wellKey(w), w.name, unit))], rows },
        ]);
      },
    }),
  ];
}

/** A unit for a summary vector by the Eclipse naming convention. */
function simUnit(k: string): string {
  if (/WCT$/.test(k)) return 'fraction';
  if (/GOR$/.test(k)) return 'Sm3/Sm3';
  if (/PR$|BHP$|THP$/.test(k) && /^(F|W)(PR|BHP|THP)$/.test(k)) return 'bar';
  if (/(O|W|G|L)(P|I)T$/.test(k)) return 'Sm3';
  if (/(O|W|G|L)(P|I)R$/.test(k)) return 'Sm3/d';
  return '';
}

const PROD_FIELDS = ['oil', 'gas', 'water', 'waterInj', 'hours', 'bhp', 'whp', 'choke', 'watercut', 'gor'] as const;
type ProdField = (typeof PROD_FIELDS)[number];
const VOLUMES: ProdField[] = ['oil', 'gas', 'water', 'waterInj'];
const PROD_UNIT: Record<ProdField, string> = { oil: 'Sm3', gas: 'Sm3', water: 'Sm3', waterInj: 'Sm3', hours: 'h', bhp: 'bar', whp: 'bar', choke: '%', watercut: 'fraction', gor: 'Sm3/Sm3' };
const PROD_LABEL: Record<ProdField, string> = { oil: 'Oil', gas: 'Gas', water: 'Water', waterInj: 'Water injected', hours: 'On-stream hours', bhp: 'Bottom-hole pressure', whp: 'Wellhead pressure', choke: 'Choke', watercut: 'Water cut', gor: 'GOR' };

/** Monthly means of the pressures and choke of a daily series (the monthly file has none). */
function monthlyMeans(daily: ProductionRecord[]) {
  const m = new Map<number, { bhp: number[]; whp: number[]; choke: number[] }>();
  for (const r of daily) {
    const d = new Date(r.t);
    const k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const e = m.get(k) ?? m.set(k, { bhp: [], whp: [], choke: [] }).get(k)!;
    if (r.bhp) e.bhp.push(r.bhp);
    if (r.whp) e.whp.push(r.whp);
    if (r.choke) e.choke.push(r.choke);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : undefined);
  return new Map([...m].map(([k, v]) => [k, { bhp: mean(v.bhp), whp: mean(v.whp), choke: mean(v.choke) }]));
}

/** The production tool: monthly (all wells, official) or daily (wells with daily files) volumes, rates, pressures. */
function productionTool(dc: DataContext): AssistantTool {
  const { field } = dc;
  return zodTool({
    name: 'data.production_history',
    title: 'Production history',
    description:
      'Production and injection over time as a dataset with a `date` column (yyyy-mm monthly, yyyy-mm-dd daily): oil, gas, water and water injected (Sm3 per period, or Sm3/d with rates), on-stream hours, bottom-hole and wellhead pressure (bar), choke (%), water cut and GOR. One well, or every well (wide: one column per well and field, keys like F12_oil; or long: a `well` column). Also returns cumulative totals. Provenance: measured (Equinor production data). (`data.production` only opens the production sheet.)',
    input: z.object({
      well: z.string().optional().describe('Well id or name; omit for every well with production'),
      period: z.enum(['monthly', 'daily']).optional().describe('Default monthly; daily exists for F-11, F-1 C, F-12, F-14, F-15 D, F-4, F-5'),
      from: z.string().optional().describe('yyyy, yyyy-mm or yyyy-mm-dd'),
      to: z.string().optional(),
      fields: z.array(z.enum(PROD_FIELDS)).optional().describe('Default oil, gas, water (and waterInj for injectors)'),
      rates: z.boolean().optional().describe('Volumes as calendar-day rates, Sm3/d (monthly only; daily volumes already are)'),
      layout: z.enum(['wide', 'long']).optional().describe('With every well: one column per well and field (wide, default) or a well column (long)'),
    }),
    run: async ({ well: key, period = 'monthly', from, to, fields, rates, layout = 'wide' }, ctx) => {
      const t0 = from ? parseIsoDate(from) : -Infinity;
      const t1 = to ? parseIsoDate(to, true) : Infinity;
      // the series: [label, key, records]
      const series: { label: string; key: string; records: ProductionRecord[]; means?: ReturnType<typeof monthlyMeans> }[] = [];
      const wellsWith = () => field.wells.filter((w) => w.productionMonthly.length || w.productionFile).map((w) => w.id);
      const load = async (w: Well) => {
        if (!w.loaded && (w.lasFile || w.productionFile)) await field.ensureLoaded(w);
        if (ctx.signal.aborted) throw new Error('Cancelled.');
      };
      if (key) {
        const w = findWell(field, key);
        const wantsDaily = period === 'daily' || fields?.some((f) => f === 'bhp' || f === 'whp' || f === 'choke');
        if (wantsDaily && w.productionFile) await load(w);
        const recs = period === 'daily' ? w.production?.records : w.productionMonthly;
        if (!recs?.length) throw new Error(`${w.name} has no ${period} production. Wells with production: ${wellsWith().join(', ')}.`);
        series.push({ label: w.name, key: wellKey(w), records: recs, means: period === 'monthly' && w.production ? monthlyMeans(w.production.records) : undefined });
      } else if (period === 'daily') {
        for (const w of field.wells.filter((x) => x.productionFile)) {
          await load(w);
          await yieldToPage();
          if (w.production?.records.length) series.push({ label: w.name, key: wellKey(w), records: w.production.records });
        }
      } else
        for (const [name, recs] of field.productionMonthly) {
          const w = field.wells.find((x) => x.productionWell === name);
          if (recs.length) series.push({ label: w?.name ?? name, key: w ? wellKey(w) : name.replace(/^15\/9-/, '').replace(/[^A-Za-z0-9]/g, ''), records: recs, means: w?.production ? monthlyMeans(w.production.records) : undefined });
        }
      const injector = series.some((s) => s.records.some((r) => r.waterInj > 0));
      const fs: ProdField[] = fields?.length ? [...new Set(fields)] : ['oil', 'gas', 'water', ...(injector ? (['waterInj'] as ProdField[]) : [])];
      const days = (t: number) => (period === 'daily' ? 1 : new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 0)).getUTCDate());
      const unit = (f: ProdField) => (VOLUMES.includes(f) && (rates || period === 'daily') ? 'Sm3/d' : PROD_UNIT[f]);
      const value = (s: (typeof series)[number], r: ProductionRecord, f: ProdField): number | null => {
        switch (f) {
          case 'watercut':
            return r.oil + r.water > 0 ? round(r.water / (r.oil + r.water), 4) : null;
          case 'gor':
            return r.oil > 0 ? sig(r.gas / r.oil, 4) : null;
          case 'bhp':
          case 'whp':
          case 'choke':
            return round(r[f] ?? s.means?.get(r.t)?.[f], 2);
          case 'hours':
            return round(r.hours, 1);
          default:
            return sig(rates && period === 'monthly' ? r[f] / days(r.t) : r[f], 6);
        }
      };
      const date = period === 'daily' ? isoDay : isoMonth;
      const totals = series.map((s) => {
        const recs = s.records.filter((r) => r.t >= t0 && r.t <= t1);
        const sum = (f: 'oil' | 'gas' | 'water' | 'waterInj') => Math.round(recs.reduce((a, r) => a + r[f], 0));
        const peak = recs.reduce<ProductionRecord | null>((b, r) => (!b || r.oil > b.oil ? r : b), null);
        return { well: s.label, from: recs[0] ? date(recs[0].t) : null, to: recs.length ? date(recs[recs.length - 1].t) : null, oilSm3: sum('oil'), gasSm3: sum('gas'), waterSm3: sum('water'), waterInjSm3: sum('waterInj'), ...(peak && peak.oil > 0 ? { peakOil: { date: date(peak.t), sm3: Math.round(peak.oil) } } : {}) };
      });
      const all = { oilSm3: totals.reduce((a, t) => a + t.oilSm3, 0), gasSm3: totals.reduce((a, t) => a + t.gasSm3, 0), waterSm3: totals.reduce((a, t) => a + t.waterSm3, 0), waterInjSm3: totals.reduce((a, t) => a + t.waterInjSm3, 0) };
      let columns: DatasetColumn[];
      let rows: DatasetRow[];
      const single = series.length === 1;
      if (single || layout === 'long') {
        columns = [col('date', 'Date', undefined, 'date'), ...(single ? [] : [col('well', 'Well', undefined, 'string')]), ...fs.map((f) => col(f, PROD_LABEL[f], unit(f)))];
        rows = [];
        for (const s of series) for (const r of s.records) if (r.t >= t0 && r.t <= t1) rows.push({ date: date(r.t), ...(single ? {} : { well: s.label }), ...Object.fromEntries(fs.map((f) => [f, value(s, r, f)])) });
        if (!single) rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      } else {
        columns = [col('date', 'Date', undefined, 'date'), ...series.flatMap((s) => fs.map((f) => col(`${s.key}_${f}`, `${s.label} ${PROD_LABEL[f].toLowerCase()}`, unit(f))))];
        const byDate = new Map<string, DatasetRow>();
        for (const s of series)
          for (const r of s.records) {
            if (r.t < t0 || r.t > t1) continue;
            const d = date(r.t);
            const row = byDate.get(d) ?? byDate.set(d, { date: d }).get(d)!;
            for (const f of fs) row[`${s.key}_${f}`] = value(s, r, f);
          }
        rows = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
        for (const r of rows) for (const c of columns) if (!(c.key in r)) r[c.key] = null;
      }
      if (!rows.length) throw new Error(`No production between ${from ?? 'the start'} and ${to ?? 'the end'}.`);
      return out(
        {
          period,
          units: rates || period === 'daily' ? 'volumes as Sm3/d' : 'volumes as Sm3 per month',
          fields: fs,
          ...(single ? {} : { columns: `${layout === 'long' ? 'well column' : 'one column per well and field'}: ${series.map((s) => `${s.key} = ${s.label}`).join(', ')}` }),
          cumulative: totals as Json,
          ...(single ? {} : { fieldTotal: all }),
          provenance: 'measured (Equinor Volve production data)',
          ...(rows.length > HARD_CAP ? { truncated: `first ${HARD_CAP} of ${rows.length} rows: narrow the dates or use monthly` } : {}),
        },
        [{ title: `${single ? series[0].label : 'Volve wells'} · ${period} production`, source: `Equinor Volve ${period} production${single ? `, ${series[0].label}` : ''}${from || to ? `, ${from ?? '…'} to ${to ?? '…'}` : ''}`, columns, rows }],
      );
    },
  });
}
