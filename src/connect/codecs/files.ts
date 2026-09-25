import { z } from 'zod';
import { parseLAS } from '../../data/las';
import { readXlsx } from '../../data/xlsx';
import { batchFromRows, type Batch } from '../batch';
import { defineCodec, type Chunk } from '../plugin';
import { TextStream } from './text';

/** Collects a stream until it ends, or takes a whole message at once. */
export function whole(onDoc: (bytes: Uint8Array, text: () => string) => Batch[] | Promise<Batch[]>) {
  const parts: Uint8Array[] = [];
  const run = (b: Uint8Array) => onDoc(b, () => new TextDecoder().decode(b));
  const bytes = (c: Chunk) => (typeof c === 'string' ? new TextEncoder().encode(c) : c);
  return {
    push(c: Chunk, meta: { complete: boolean }) {
      if (meta.complete) return run(bytes(c));
      parts.push(bytes(c));
      return [];
    },
    end() {
      if (!parts.length) return [];
      const n = parts.reduce((s, p) => s + p.length, 0);
      const all = new Uint8Array(n);
      let o = 0;
      for (const p of parts.splice(0)) {
        all.set(p, o);
        o += p.length;
      }
      return run(all);
    },
  };
}

export const lasCodec = defineCodec<Record<string, never>>({
  id: 'las',
  label: 'LAS 2.0',
  description: 'Log ASCII Standard 1.2 / 2.0 (wrapped or not). Depth is converted to metres; the well name comes from the ~W section.',
  extensions: ['las'],
  options: z.object({}),
  sniff(_, text) {
    return text && /^\s*~V/im.test(text.slice(0, 2000)) ? 0.95 : 0;
  },
  create() {
    return whole((_, text) => {
      const ls = parseLAS(text(), 'LAS', 'measured');
      const columns = [
        { name: 'DEPTH', unit: 'm', values: Float64Array.from(ls.depth) },
        ...[...ls.curves.values()].map((c) => ({ name: c.mnemonic, unit: c.unit, description: c.description, values: Float64Array.from(c.values) })),
      ];
      return [{ kind: 'channels', index: { column: 'DEPTH', type: 'depth' }, well: ls.header.WELL || undefined, columns, meta: ls.header }];
    });
  },
});

export const xlsxCodec = defineCodec<{ sheet: string }>({
  id: 'xlsx',
  label: 'Excel workbook',
  description: 'Every sheet of an .xlsx file (or one named sheet), read as a table.',
  extensions: ['xlsx', 'xlsm'],
  mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  options: z.object({ sheet: z.string().default('').describe('Only this sheet (empty: all)') }),
  sniff(head) {
    // a zip holding xl/
    return head[0] === 0x50 && head[1] === 0x4b && new TextDecoder().decode(head.subarray(0, 300)).includes('xl/') ? 0.9 : head[0] === 0x50 && head[1] === 0x4b ? 0.35 : 0;
  },
  create(o) {
    return whole((bytes) =>
      readXlsx(bytes)
        .filter((s) => !o.sheet || s.name === o.sheet)
        .filter((s) => s.table.rows.length)
        .map((s) => ({ ...batchFromRows(s.table.headers, s.table.rows), meta: { sheet: s.name } })),
    );
  },
});

// ------------------------------------------------------------------ WITS level 0

/**
 * WITS record 1 ("General time-based") item names, the drilling channels a
 * rig sends most. Other records keep their numeric code (W0801…) unless the
 * connector names them.
 */
export const WITS_ITEMS: Record<string, [string, string, string]> = {
  '0105': ['DATE', '', 'Date (YYMMDD)'],
  '0106': ['TIME', '', 'Time (HHMMSS)'],
  '0107': ['ACTC', '', 'Activity code'],
  '0108': ['DBTM', 'm', 'Bit depth (MD)'],
  '0109': ['DBTV', 'm', 'Bit depth (TVD)'],
  '0110': ['DMEA', 'm', 'Hole depth (MD)'],
  '0111': ['DVER', 'm', 'Hole depth (TVD)'],
  '0112': ['BPOS', 'm', 'Block position'],
  '0113': ['ROPA', 'm/h', 'Rate of penetration (avg)'],
  '0114': ['HKLA', 'kN', 'Hookload (avg)'],
  '0115': ['HKLX', 'kN', 'Hookload (max)'],
  '0116': ['WOBA', 'kN', 'Weight on bit (avg)'],
  '0117': ['WOBX', 'kN', 'Weight on bit (max)'],
  '0118': ['TQA', 'kN.m', 'Rotary torque (avg)'],
  '0119': ['TQX', 'kN.m', 'Rotary torque (max)'],
  '0120': ['RPMA', 'rpm', 'Rotary speed (avg)'],
  '0121': ['SPPA', 'kPa', 'Standpipe pressure (avg)'],
  '0122': ['CHKP', 'kPa', 'Casing (choke) pressure'],
  '0123': ['SPM1', 'spm', 'Pump stroke rate #1'],
  '0124': ['SPM2', 'spm', 'Pump stroke rate #2'],
  '0125': ['SPM3', 'spm', 'Pump stroke rate #3'],
  '0126': ['TVA', 'm3', 'Tank volume (active)'],
  '0127': ['TVCA', 'm3', 'Tank volume change (active)'],
  '0128': ['MFOP', '%', 'Mud flow out %'],
  '0129': ['MFOA', 'L/min', 'Mud flow out (avg)'],
  '0130': ['MFIA', 'L/min', 'Mud flow in (avg)'],
  '0131': ['MDOA', 'kg/m3', 'Mud density out (avg)'],
  '0132': ['MDIA', 'kg/m3', 'Mud density in (avg)'],
  '0133': ['MTOA', 'degC', 'Mud temperature out (avg)'],
  '0134': ['MTIA', 'degC', 'Mud temperature in (avg)'],
  '0135': ['MCOA', 'mS/m', 'Mud conductivity out (avg)'],
  '0136': ['MCIA', 'mS/m', 'Mud conductivity in (avg)'],
  '0137': ['STKC', '', 'Pump stroke count (cum)'],
  '0138': ['LSTK', '', 'Lag strokes'],
  '0139': ['DRTM', 'm', 'Depth returns (MD)'],
  '0140': ['GASA', '%', 'Gas (avg)'],
};

const Wits = z.object({
  items: z
    .record(z.string().regex(/^\d{4}$/), z.string().min(1))
    .default({})
    .describe('Names for item codes, e.g. {"0841": "GR"}'),
  units: z
    .record(z.string().regex(/^\d{4}$/), z.string())
    .default({})
    .describe('Units for item codes'),
});

function witsTime(date?: string, time?: string): number {
  if (!date || !time) return NaN;
  const d = date.padStart(6, '0');
  const t = time.padStart(6, '0');
  const y = +d.slice(0, 2);
  return Date.UTC(y < 70 ? 2000 + y : 1900 + y, +d.slice(2, 4) - 1, +d.slice(4, 6), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
}

export const witsCodec = defineCodec<z.output<typeof Wits>>({
  id: 'wits0',
  label: 'WITS level 0',
  description: 'The ASCII rig feed: records between "&&" and "!!", one "RRIIvalue" item per line. Record 1 items get their standard names; time comes from items 0105/0106 or arrival.',
  extensions: ['wits'],
  options: Wits,
  sniff(_, text) {
    return text && /^&&\r?\n\d{4}/m.test(text.slice(0, 400)) ? 0.95 : 0;
  },
  create(o) {
    const text = new TextStream();
    let buf = '';
    let rec: Map<string, string> | null = null;
    const done: { at: number; rec: Map<string, string> }[] = [];
    const lines = (s: string, arrival: number) => {
      for (const raw of s.split(/\r\n|\n|\r/)) {
        const l = raw.trim();
        if (l === '&&') rec = new Map();
        else if (l === '!!') {
          if (rec?.size) done.push({ at: arrival, rec });
          rec = null;
        } else if (rec && /^\d{4}/.test(l)) rec.set(l.slice(0, 4), l.slice(4).trim());
      }
    };
    const emit = (): Batch[] => {
      if (!done.length) return [];
      // one batch per record type (record 1 drilling, record 8 MWD…)
      const byRec = new Map<string, typeof done>();
      for (const d of done.splice(0)) {
        const r = [...d.rec.keys()][0].slice(0, 2);
        byRec.set(r, [...(byRec.get(r) ?? []), d]);
      }
      const out: Batch[] = [];
      for (const [r, list] of byRec) {
        // items 01–06 of every record are well, sidetrack, record, sequence, date and time
        const codes = [...new Set(list.flatMap((d) => [...d.rec.keys()]))].filter((c) => +c.slice(2) > 6).sort();
        const time = Float64Array.from(list, (d) => {
          const t = witsTime(d.rec.get(`${r}05`), d.rec.get(`${r}06`));
          return Number.isFinite(t) ? t : d.at;
        });
        const cols = codes.map((c) => {
          const std = WITS_ITEMS[c];
          return {
            name: o.items[c] ?? std?.[0] ?? `W${c}`,
            unit: o.units[c] ?? std?.[1] ?? '',
            description: std?.[2] ?? `WITS item ${c}`,
            values: Float64Array.from(list, (d) => Number(d.rec.get(c) ?? NaN)),
          };
        });
        const well = list[0].rec.get(`${r}01`);
        out.push({
          kind: 'channels',
          index: { column: 'TIME', type: 'time' },
          well: well || undefined,
          columns: [{ name: 'TIME', unit: 'ms', description: 'time', values: time }, ...cols],
          meta: { record: r },
        });
      }
      return out;
    };
    return {
      push(c, meta) {
        const s = buf + text.text(c, meta);
        // keep a partial record for the next chunk
        const last = s.lastIndexOf('!!');
        const cut = meta.complete ? s.length : last < 0 ? 0 : last + 2;
        buf = s.slice(cut);
        lines(s.slice(0, cut), meta.ts ?? Date.now());
        return emit();
      },
      end() {
        lines(buf, Date.now());
        buf = '';
        return emit();
      },
    };
  },
});
