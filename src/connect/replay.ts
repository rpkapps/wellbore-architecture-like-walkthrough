import { z } from 'zod';
import { parseCSV, surveyFromTable } from '../data/csv';
import { findCurve, parseLAS, sampleCurve } from '../data/las';
import { REPLAY_OFFSETS } from './offsets';
import { defineTransport } from './plugin';
import { sleep } from './transports';

/**
 * Plays a Volve well back as if it were being drilled now: a rig feed at one
 * reading per simulated second (bit and hole depth, ROP, WOB, RPM, torque,
 * standpipe pressure, flow, and MWD/LWD sensors a few metres behind the bit)
 * plus an MWD survey every stand, as JSON lines. It goes through the same
 * codec, steps and page updates as a real feed, so it is also the test bench
 * for them. The rig channels are made up to be plausible; the formation
 * readings and the survey are the well's real ones.
 */
const ReplayOptions = z.object({
  baseUrl: z.string().default('').describe('Where the dataset is (filled in by the app)'),
  well: z.string().default('').describe('Well id (empty: the main well)'),
  fromMd: z.number().min(0).default(2600).describe('Start drilling at this MD, metres; above it arrives as history'),
  speed: z.number().min(1).max(3600).default(60).describe('Simulated seconds per real second'),
  history: z.boolean().default(true).describe('Send the surveys and logs above the start depth first'),
  wellName: z.string().default('').describe('Name of the well it creates (empty: "<well> · live")'),
});
export type ReplayOptions = z.output<typeof ReplayOptions>;

const SURVEY_OFFSET = 16.5;
const STAND = 28.5;

// a small deterministic noise source, so a replay is the same every time
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export const replayTransport = defineTransport<ReplayOptions>({
  id: 'replay',
  label: 'Replay a Volve well',
  description: 'Drills a Volve well again in real time (or faster): a rig feed and MWD surveys as JSON lines, through the same pipeline as a real source. Needs no server.',
  live: true,
  defaultCodec: 'json',
  options: ReplayOptions,
  async open(o, sink, signal) {
    sink.format?.('json', {});
    const base = new URL(o.baseUrl || './data/volve/', self.location.href).href;
    const text = async (p: string) => {
      const r = await fetch(new URL(p, base), { signal });
      if (!r.ok) throw new Error(`Replay: ${r.status} for ${p}`);
      return r.text();
    };
    const manifest = JSON.parse(await text('manifest.json')) as { wells: { id: string; name: string; primary?: boolean; las?: string; survey: string }[] };
    const mw = manifest.wells.find((w) => w.id === o.well) ?? manifest.wells.find((w) => w.primary) ?? manifest.wells[0];
    if (!mw.las) throw new Error(`${mw.name} has no logs to replay.`);
    const [lasText, surveyText] = await Promise.all([text(mw.las), text(mw.survey)]);
    const logs = parseLAS(lasText, mw.las);
    const survey = surveyFromTable(parseCSV(surveyText)).stations;
    const name = o.wellName || `${mw.name} · live`;
    const td = logs.depth[logs.depth.length - 1];
    const curve = (k: string) => findCurve(logs, k);
    const c = { GR: curve('GR'), RDEP: curve('RDEEP') ?? curve('RT'), RHOB: curve('RHOB'), NPHI: curve('NPHI'), ROP: curve('ROP') };
    const at = (cv: typeof c.GR, md: number) => (cv ? sampleCurve(logs.depth, cv.values, md) : NaN);
    const surveyAt = (md: number) => {
      let i = 0;
      while (i < survey.length - 2 && survey[i + 1].md < md) i++;
      const a = survey[i];
      const b = survey[Math.min(i + 1, survey.length - 1)];
      const t = b.md > a.md ? Math.min(1, Math.max(0, (md - a.md) / (b.md - a.md))) : 0;
      return { inc: a.inc + (b.inc - a.inc) * t, azi: a.azi + (((b.azi - a.azi + 540) % 360) - 180) * t };
    };
    const r = rng(0x5eed);
    const round = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

    // ---- history: surveys and logs above the start depth
    const start = Math.min(Math.max(o.fromMd, logs.depth[0] + 50), td - 20);
    if (o.history) {
      const lines: string[] = [];
      for (const s of survey) if (s.md <= start - SURVEY_OFFSET) lines.push(JSON.stringify({ well: name, 'MD [m]': s.md, 'INC [deg]': s.inc, 'AZI [deg]': s.azi }));
      for (let i = 0; i < logs.depth.length; i += 1) {
        const md = logs.depth[i];
        if (md > start) break;
        const row: Record<string, unknown> = { well: name, 'DEPTH [m]': round(md, 3) };
        for (const [k, cv] of Object.entries(c)) if (k !== 'ROP' && cv && md <= start - REPLAY_OFFSETS[k]) row[`${k} [${cv.unit || ''}]`] = round(cv.values[i], 4);
        lines.push(JSON.stringify(row));
      }
      // one message per ~2 000 lines, as a feed would page it
      for (let i = 0; i < lines.length && !signal.aborted; i += 2000) await sink.data(lines.slice(i, i + 2000).join('\n'), { complete: true, name: 'history' });
      await sink.next?.();
    }
    sink.status('live', `${name} drilling from ${start.toFixed(0)} m`);

    // ---- the live feed
    let md = start;
    let simT = Date.now();
    let nextSurvey = Math.ceil((start - SURVEY_OFFSET) / STAND) * STAND + SURVEY_OFFSET;
    let connection = 0; // seconds of pumps-off for a connection
    let wall = performance.now();
    const unit = (cv: { unit: string } | undefined) => cv?.unit ?? '';
    while (!signal.aborted && md < td) {
      await sleep(250, signal);
      const now = performance.now();
      const simSeconds = Math.min(1800, Math.round(((now - wall) / 1000) * o.speed));
      wall += (simSeconds / o.speed) * 1000;
      if (!simSeconds) continue;
      const lines: string[] = [];
      for (let s = 0; s < simSeconds && md < td; s++) {
        simT += 1000;
        const gr = at(c.GR, md);
        let rop = at(c.ROP, md);
        if (!Number.isFinite(rop) || rop <= 0) rop = 25 - Math.min(15, Math.max(0, (gr - 40) / 6));
        rop = Math.min(90, Math.max(3, rop * (1 + 0.08 * r())));
        const drilling = connection <= 0;
        let bit = md;
        if (drilling) md += rop / 3600;
        else {
          connection--;
          bit = md - Math.min(1.5, (45 - connection) * 0.05);
        }
        if (drilling && md >= nextSurvey + SURVEY_OFFSET) {
          connection = 45; // a connection every stand: pumps off, bit off bottom
          const sv = surveyAt(nextSurvey);
          lines.push(JSON.stringify({ well: name, 'MD [m]': round(nextSurvey), 'INC [deg]': round(sv.inc, 3), 'AZI [deg]': round(sv.azi, 3) }));
          nextSurvey += STAND;
        }
        const shale = Number.isFinite(gr) ? Math.min(1, Math.max(0, (gr - 30) / 90)) : 0.5;
        const row: Record<string, unknown> = {
          well: name,
          time: simT,
          'DBTM [m]': round(bit, 3),
          'DMEA [m]': round(md, 3),
          'ROPA [m/h]': drilling ? round(rop, 1) : 0,
          'WOBA [kN]': drilling ? round(95 + 60 * shale + 8 * r(), 1) : round(4 + r(), 1),
          'RPMA [rpm]': drilling ? round(140 + 6 * r(), 0) : 0,
          'TQA [kN.m]': drilling ? round(14 + 9 * shale + 1.5 * r(), 2) : round(0.4 + 0.2 * r(), 2),
          'SPPA [bar]': drilling ? round(205 + md / 150 + 4 * r(), 1) : round(8 + r(), 1),
          'MFIA [L/min]': drilling ? round(2350 + 40 * r(), 0) : 0,
          'HKLA [kN]': round(drilling ? 1480 + md * 0.18 - (95 + 60 * shale) : 1600 + md * 0.18, 0),
        };
        for (const k of ['GR', 'RDEP', 'RHOB', 'NPHI'] as const) {
          const cv = c[k];
          if (!cv || !drilling) continue;
          const v = at(cv, bit - REPLAY_OFFSETS[k]);
          if (Number.isFinite(v)) row[`${k} [${unit(cv)}]`] = round(v * (1 + (k === 'RDEP' ? 0.03 : 0.01) * r()), 4);
        }
        lines.push(JSON.stringify(row));
      }
      if (lines.length) await sink.data(lines.join('\n'), { complete: true, name: 'rig', ts: simT });
    }
    if (!signal.aborted) sink.status('done', `${name} reached TD at ${td.toFixed(0)} m`);
  },
});
