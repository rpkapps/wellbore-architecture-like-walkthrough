import { z } from 'zod';
import { column, isNumeric, key, pick, rowCount, type Batch, type Column } from './batch';
import { compile } from './expr';
import { detect, findRole } from './frames';
import { defineTransform, type TransformStep } from './plugin';
import { converter, dimension, PREFERRED } from './units';

/**
 * The built-in transforms. Each is declared by a Zod schema (its form in
 * the connect dialog and its input for an assistant) and returns a step that
 * may keep state between batches: a stream is transformed as it arrives,
 * never re-read.
 */

const same = (b: Batch): Batch[] => [b];
const numCol = (b: Batch, name: string | undefined) => {
  const c = column(b, name);
  return c && isNumeric(c) ? c : undefined;
};
const withColumns = (b: Batch, columns: Column[]): Batch => ({ ...b, columns });

// ------------------------------------------------------------------ map

const MapOptions = z.object({
  kind: z.enum(['auto', 'channels', 'survey', 'tops', 'production']).default('auto').describe('What the rows are'),
  index: z.string().default('').describe('Column to index channels by (empty: found automatically)'),
  indexType: z.enum(['auto', 'time', 'depth']).default('auto').describe('Whether the index is a time or a depth'),
  timeFormat: z.enum(['auto', 'epoch-s', 'epoch-ms', 'epoch-us', 'excel']).default('auto').describe('How a numeric time index is written'),
  well: z.string().default('').describe('Well name for every row (empty: from the data)'),
  wellColumn: z.string().default('').describe('Column naming the well per row'),
  rename: z.record(z.string(), z.string()).default({}).describe('New names, {from: to}'),
  units: z.record(z.string(), z.string()).default({}).describe('Declare the unit of a column, {column: unit}'),
  keep: z.array(z.string()).default([]).describe('Only these channels (empty: all)'),
  drop: z.array(z.string()).default([]).describe('Channels to leave out'),
});

export const mapTransform = defineTransform<z.output<typeof MapOptions>>({
  id: 'map',
  label: 'Map columns',
  description: 'Say what the data is: the index column and whether it is a time or a depth, the well, names, units, and which channels to keep.',
  options: MapOptions,
  create(o) {
    const keep = new Set(o.keep.map((k) => k.toUpperCase()));
    const drop = new Set(o.drop.map((k) => k.toUpperCase()));
    return {
      apply(b) {
        let cols = b.columns.map((c) => {
          const name = o.rename[c.name] ?? c.name;
          const unit = o.units[c.name] ?? o.units[name] ?? c.unit;
          return name === c.name && unit === c.unit ? c : { ...c, name, unit };
        });
        const indexName = o.index ? (o.rename[o.index] ?? o.index) : undefined;
        const wellName = o.wellColumn ? (o.rename[o.wellColumn] ?? o.wellColumn) : undefined;
        cols = cols.filter((c) => {
          const k = c.name.toUpperCase();
          if (c.name === indexName || c.name === wellName) return true;
          if (drop.has(k)) return false;
          return !keep.size || keep.has(k) || c.unit === 'ms';
        });
        let out: Batch = { ...b, columns: cols };
        if (o.kind !== 'auto') out.kind = o.kind;
        if (o.well) out.well = o.well;
        if (wellName) out.wellColumn = wellName;
        if (indexName) {
          const ic = column(out, indexName);
          if (ic) {
            const first = isNumeric(ic) ? ic.values.find(Number.isFinite) : undefined;
            // epoch-like numbers are times: no measured depth reaches 100 000 km
            const looksTime = ic.unit === 'ms' || /time|date|^t$|^ts$/i.test(ic.name) || (first !== undefined && first > 1e8);
            const type = o.indexType === 'auto' ? (looksTime ? 'time' : 'depth') : o.indexType;
            out.index = { column: ic.name, type };
            out.kind ??= 'channels';
          }
        }
        out = detect(out);
        // numbers standing for times: epoch seconds, microseconds, Excel serial days
        if (out.index?.type === 'time') {
          const ic = numCol(out, out.index.column);
          if (ic && ic.unit !== 'ms') {
            const v = ic.values;
            let f = o.timeFormat;
            if (f === 'auto') {
              const x = v.find(Number.isFinite) ?? 0;
              f = x > 1e14 ? 'epoch-us' : x > 1e11 ? 'epoch-ms' : x > 1e8 ? 'epoch-s' : x > 20000 && x < 80000 ? 'excel' : 'epoch-ms';
            }
            const k = { 'epoch-s': (t: number) => t * 1000, 'epoch-ms': (t: number) => t, 'epoch-us': (t: number) => t / 1000, excel: (t: number) => (t - 25569) * 86400000 }[f];
            out = withColumns(
              out,
              out.columns.map((c) => (c === ic ? { ...c, unit: 'ms', description: 'time', values: v.map(k) } : c)),
            );
          }
        }
        return [out];
      },
    };
  },
});

// ------------------------------------------------------------------ units

const UnitsOptions = z.object({
  metric: z.boolean().default(true).describe('Convert every recognised unit to the metric unit BoreWalk shows'),
  convert: z
    .array(z.object({ column: z.string().min(1), to: z.string().min(1) }))
    .default([])
    .describe('Convert these columns to a unit'),
});

export const unitsTransform = defineTransform<z.output<typeof UnitsOptions>>({
  id: 'units',
  label: 'Convert units',
  description: 'ft → m, psi → bar, °F → °C, klbf → kN, gpm → L/min and so on: to metric, or per column to a chosen unit.',
  options: UnitsOptions,
  create(o, ctx) {
    const warned = new Set<string>();
    return {
      apply(b) {
        const cols = b.columns.map((c) => {
          if (!isNumeric(c) || !c.unit || c.unit === 'ms') return c;
          const explicit = o.convert.find((x) => x.column === c.name || x.column.toUpperCase() === c.name.toUpperCase());
          const to = explicit?.to ?? (o.metric ? PREFERRED[dimension(c.unit) ?? ''] : undefined);
          if (!to || to === c.unit) return c;
          const f = converter(c.unit, to);
          if (!f) {
            if (explicit && !warned.has(c.name)) {
              warned.add(c.name);
              ctx.log(`Cannot convert ${c.name} from ${c.unit} to ${to}.`, 'warn');
            }
            return c;
          }
          return { ...c, unit: to, values: c.values.map(f) };
        });
        return [withColumns(b, cols)];
      },
    };
  },
});

// ------------------------------------------------------------------ time → depth

const TimeToDepthOptions = z.object({
  bitDepth: z.string().default('').describe('Bit depth channel (empty: DBTM, BITDEP… found automatically)'),
  holeDepth: z.string().default('').describe('Hole depth channel (empty: DMEA, HDTH… found automatically)'),
  step: z.number().positive().max(10).default(0.1).describe('Depth step of the output, metres'),
  mode: z.enum(['new-hole', 'bit']).default('new-hole').describe('Only new hole drilled on bottom, or every reading at the bit'),
  aggregate: z.enum(['mean', 'last', 'max', 'min']).default('mean').describe('Readings falling in one depth step'),
  onBottom: z.number().min(0).max(50).default(0.5).describe('Bit within this many metres of hole depth counts as on bottom'),
  offsets: z.record(z.string(), z.number()).default({}).describe('Sensor distance behind the bit per channel, metres (e.g. GR 12.4)'),
  channels: z.array(z.string()).default([]).describe('Channels to put on depth (empty: all)'),
  keepTime: z.boolean().default(true).describe('Also keep the time-indexed readings (for the live charts)'),
});

interface Acc {
  bin: number;
  sum: number;
  n: number;
  last: number;
  max: number;
  min: number;
}

export const timeToDepthTransform = defineTransform<z.output<typeof TimeToDepthOptions>>({
  id: 'time-to-depth',
  label: 'Time to depth',
  description: 'Put time-indexed rig and MWD readings on measured depth, using the bit depth: each depth step gets the readings taken while drilling it, with sensor offsets behind the bit.',
  options: TimeToDepthOptions,
  create(o, ctx): TransformStep {
    const open = new Map<string, Acc>();
    const done = new Map<number, Map<string, number>>();
    const units = new Map<string, string>();
    let maxDepth = -Infinity;
    let warned = false;
    const offsets = new Map(Object.entries(o.offsets).map(([k, v]) => [key(k), v]));
    const offset = (name: string) => o.offsets[name] ?? offsets.get(key(name)) ?? 0;
    const value = (a: Acc) => (o.aggregate === 'mean' ? a.sum / a.n : o.aggregate === 'last' ? a.last : o.aggregate === 'max' ? a.max : a.min);
    const close = (name: string, a: Acc) => {
      if (!a.n) return;
      let row = done.get(a.bin);
      if (!row) done.set(a.bin, (row = new Map()));
      row.set(name, value(a));
    };
    const emit = (): Batch[] => {
      if (!done.size) return [];
      const bins = [...done.keys()].sort((x, y) => x - y);
      const names = [...units.keys()];
      const depth = Float64Array.from(bins, (b) => +(b * o.step).toFixed(6));
      const cols: Column[] = names.map((n) => ({ name: n, unit: units.get(n), values: Float64Array.from(bins, (b) => done.get(b)!.get(n) ?? NaN) }));
      done.clear();
      return [{ kind: 'channels', index: { column: 'DEPTH', type: 'depth' }, columns: [{ name: 'DEPTH', unit: 'm', values: depth }, ...cols], meta: { step: String(o.step) } }];
    };
    return {
      apply(input) {
        const b = detect(input);
        if (b.kind !== 'channels' || b.index?.type !== 'time') return [input];
        const bitC = (o.bitDepth ? numCol(b, o.bitDepth) : undefined) ?? (findRole(b, 'bitDepth', isNumeric) as (Column & { values: Float64Array }) | undefined);
        const holeC = (o.holeDepth ? numCol(b, o.holeDepth) : undefined) ?? (findRole(b, 'holeDepth', isNumeric) as (Column & { values: Float64Array }) | undefined);
        if (!bitC) {
          if (!warned) ctx.log('Time to depth: no bit depth channel found; set one in the step.', 'warn');
          warned = true;
          return [input];
        }
        const toM = bitC.unit && dimension(bitC.unit) === 'length' ? converter(bitC.unit, 'm')! : (v: number) => v;
        const holeToM = holeC?.unit && dimension(holeC.unit) === 'length' ? converter(holeC.unit, 'm')! : (v: number) => v;
        const wanted = new Set(o.channels.map((c) => c.toUpperCase()));
        const chans = b.columns.filter(
          (c): c is Column & { values: Float64Array } =>
            isNumeric(c) && c.name !== b.index!.column && c !== bitC && c !== holeC && c.unit !== 'ms' && (!wanted.size || wanted.has(c.name.toUpperCase())),
        );
        for (const c of chans) if (!units.has(c.name)) units.set(c.name, c.unit ?? '');
        const n = rowCount(b);
        for (let i = 0; i < n; i++) {
          const bit = toM(bitC.values[i]);
          if (!Number.isFinite(bit)) continue;
          const hole = holeC ? holeToM(holeC.values[i]) : NaN;
          if (o.mode === 'new-hole') {
            const onBottom = Number.isFinite(hole) ? hole - bit <= o.onBottom : true;
            if (!onBottom || bit < maxDepth - o.step) continue;
          }
          maxDepth = Math.max(maxDepth, bit);
          for (const c of chans) {
            const v = c.values[i];
            if (!Number.isFinite(v)) continue;
            const d = bit - offset(c.name);
            if (d < 0) continue;
            const bin = Math.floor(d / o.step + 1e-9);
            let a = open.get(c.name);
            if (a && a.bin !== bin) {
              if (o.mode === 'new-hole' && bin < a.bin) continue; // sensor behind its last reading: old hole
              close(c.name, a);
              a = undefined;
            }
            if (!a) open.set(c.name, (a = { bin, sum: 0, n: 0, last: v, max: -Infinity, min: Infinity }));
            a.sum += v;
            a.n++;
            a.last = v;
            a.max = Math.max(a.max, v);
            a.min = Math.min(a.min, v);
          }
        }
        const depthBatches = emit().map((d) => ({ ...d, well: b.well, wellColumn: undefined }));
        return o.keepTime ? [input, ...depthBatches] : depthBatches;
      },
      flush() {
        for (const [name, a] of open) close(name, a);
        open.clear();
        return emit();
      },
    };
  },
});

// ------------------------------------------------------------------ resample

const ResampleOptions = z.object({
  step: z.number().positive().describe('Step of the output index: metres for depth, seconds for time'),
  aggregate: z.enum(['mean', 'last', 'min', 'max']).default('mean'),
});

export const resampleTransform = defineTransform<z.output<typeof ResampleOptions>>({
  id: 'resample',
  label: 'Resample',
  description: 'Put channels on a regular index: one row per depth step or per time step, averaging (or taking the last, min or max of) the readings in it.',
  options: ResampleOptions,
  create(o) {
    let open: { bin: number; sums: Map<string, [number, number, number, number, number]> } | null = null;
    let template: Batch | null = null;
    const rows: { bin: number; vals: Map<string, number> }[] = [];
    let stepK = 1;
    const finish = (bin: number, sums: Map<string, [number, number, number, number, number]>) => {
      const vals = new Map<string, number>();
      for (const [k, [s, n, last, mn, mx]] of sums) vals.set(k, n ? (o.aggregate === 'mean' ? s / n : o.aggregate === 'last' ? last : o.aggregate === 'min' ? mn : mx) : NaN);
      rows.push({ bin, vals });
    };
    const emit = (): Batch[] => {
      if (!rows.length || !template?.index) return [];
      const idx = template.index.column;
      const names = template.columns.filter((c) => isNumeric(c) && c.name !== idx).map((c) => c.name);
      const out: Batch = {
        ...template,
        meta: { ...template.meta, step: String(o.step * stepK) },
        columns: [
          { ...column(template, idx)!, values: Float64Array.from(rows, (r) => r.bin * o.step * stepK) },
          ...names.map((n) => ({ ...column(template!, n)!, values: Float64Array.from(rows, (r) => r.vals.get(n) ?? NaN) })),
        ],
      };
      rows.length = 0;
      return [out];
    };
    return {
      apply(input) {
        const b = detect(input);
        const ic = b.index && numCol(b, b.index.column);
        if (!ic) return [input];
        template = b;
        stepK = b.index!.type === 'time' ? 1000 : 1;
        const width = o.step * stepK;
        const cols = b.columns.filter((c): c is Column & { values: Float64Array } => isNumeric(c) && c !== ic);
        for (let i = 0; i < ic.values.length; i++) {
          const t = ic.values[i];
          if (!Number.isFinite(t)) continue;
          const bin = Math.floor(t / width + 1e-9);
          if (open && bin !== open.bin) {
            if (bin < open.bin) continue;
            finish(open.bin, open.sums);
            open = null;
          }
          open ??= { bin, sums: new Map() };
          for (const c of cols) {
            const v = c.values[i];
            let s = open.sums.get(c.name);
            if (!s) open.sums.set(c.name, (s = [0, 0, NaN, Infinity, -Infinity]));
            if (!Number.isFinite(v)) continue;
            s[0] += v;
            s[1]++;
            s[2] = v;
            s[3] = Math.min(s[3], v);
            s[4] = Math.max(s[4], v);
          }
        }
        return emit();
      },
      flush() {
        if (open) finish(open.bin, open.sums);
        open = null;
        return emit();
      },
    };
  },
});

// ------------------------------------------------------------------ order and duplicates

const OrderOptions = z.object({
  mode: z.enum(['drop-late', 'sort']).default('drop-late').describe('Drop rows at or before the last index seen, or hold rows briefly and sort them'),
  window: z.number().min(0).default(2).describe('Sort window: seconds for time, metres for depth'),
});

export const orderTransform = defineTransform<z.output<typeof OrderOptions>>({
  id: 'order',
  label: 'Order and de-duplicate',
  description: 'Streams repeat and reorder readings. Drop a row whose index is not newer than the last one, or hold rows for a short window and release them in order.',
  options: OrderOptions,
  create(o) {
    let last = -Infinity;
    let held: Batch[] = [];
    return {
      apply(input) {
        const b = detect(input);
        const ic = b.index && numCol(b, b.index.column);
        if (!ic) return [input];
        if (o.mode === 'drop-late') {
          const keep = new Uint8Array(ic.values.length);
          for (let i = 0; i < keep.length; i++) {
            const t = ic.values[i];
            if (t > last) {
              keep[i] = 1;
              last = t;
            }
          }
          return keep.every(Boolean) ? [b] : [pick(b, keep)];
        }
        held.push(b);
        const all = held.flatMap((h) => {
          const c = numCol(h, h.index!.column)!;
          return [...c.values.keys()].map((i) => ({ h, i, t: c.values[i] }));
        });
        let newest = -Infinity;
        for (const r of all) if (r.t > newest) newest = r.t;
        const w = o.window * (b.index!.type === 'time' ? 1000 : 1);
        const ready = all.filter((r) => r.t <= newest - w && r.t > last).sort((x, y) => x.t - y.t);
        const rest = all.filter((r) => r.t > newest - w);
        if (!ready.length) return [];
        last = ready[ready.length - 1].t;
        const out = gather(b, ready);
        held = rest.length
          ? [
              gather(
                b,
                rest.sort((x, y) => x.t - y.t),
              ),
            ]
          : [];
        return [out];
      },
      flush() {
        const out = held;
        held = [];
        return out;
      },
    };
  },
});

function gather(proto: Batch, rows: { h: Batch; i: number }[]): Batch {
  return {
    ...proto,
    columns: proto.columns.map((pc) => {
      if (isNumeric(pc)) return { ...pc, values: Float64Array.from(rows, (r) => (numCol(r.h, pc.name)?.values[r.i] ?? NaN) as number) };
      return { ...pc, values: rows.map((r) => String(column(r.h, pc.name)?.values[r.i] ?? '')) };
    }),
  };
}

// ------------------------------------------------------------------ despike

const DespikeOptions = z.object({
  channels: z.array(z.string()).default([]).describe('Channels to clean (empty: all)'),
  window: z.number().int().min(3).max(101).default(7).describe('Readings looked back at'),
  threshold: z.number().positive().default(5).describe('A reading this many median deviations away is a spike'),
  replace: z.enum(['median', 'gap']).default('median').describe('Put the median in its place, or leave a gap'),
});

export const despikeTransform = defineTransform<z.output<typeof DespikeOptions>>({
  id: 'despike',
  label: 'Remove spikes',
  description: 'A running median filter: a reading far from the median of the ones before it (in median absolute deviations) is replaced or dropped.',
  options: DespikeOptions,
  create(o) {
    const hist = new Map<string, number[]>();
    const wanted = new Set(o.channels.map((c) => c.toUpperCase()));
    const med = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    return {
      apply(input) {
        const b = detect(input);
        const idx = b.index?.column;
        const cols = b.columns.map((c) => {
          if (!isNumeric(c) || c.name === idx || c.unit === 'ms' || (wanted.size && !wanted.has(c.name.toUpperCase()))) return c;
          const h = hist.get(c.name) ?? [];
          const v = (c.values as Float64Array).slice();
          for (let i = 0; i < v.length; i++) {
            const x = v[i];
            if (!Number.isFinite(x)) continue;
            if (h.length >= o.window - 1) {
              const m = med(h);
              const mad = med(h.map((y) => Math.abs(y - m))) || 1e-9;
              if (Math.abs(x - m) > o.threshold * 1.4826 * mad) {
                v[i] = o.replace === 'median' ? m : NaN;
                continue;
              }
            }
            h.push(x);
            if (h.length > o.window - 1) h.shift();
          }
          hist.set(c.name, h);
          return { ...c, values: v };
        });
        return [withColumns(b, cols)];
      },
    };
  },
});

// ------------------------------------------------------------------ rolling

const RollingOptions = z.object({
  column: z.string().min(1).describe('Channel to compute from'),
  fn: z.enum(['mean', 'min', 'max', 'sum', 'std', 'rate']).default('mean').describe('Rate is change per hour (time) or per metre (depth)'),
  window: z.number().positive().default(10).describe('Window length'),
  windowUnit: z.enum(['rows', 'index']).default('rows').describe('Window in rows, or in index units (seconds or metres)'),
  as: z.string().default('').describe('Name of the new channel (empty: COLUMN_FN)'),
  unit: z.string().default('').describe('Unit of the new channel'),
});

export const rollingTransform = defineTransform<z.output<typeof RollingOptions>>({
  id: 'rolling',
  label: 'Rolling window',
  description: 'A new channel from a trailing window over another: mean, min, max, sum, standard deviation, or rate of change (e.g. ROP from hole depth).',
  options: RollingOptions,
  create(o) {
    const win: { t: number; v: number }[] = [];
    const name = o.as || `${o.column}_${o.fn.toUpperCase()}`;
    return {
      apply(input) {
        const b = detect(input);
        const c = numCol(b, o.column);
        const ic = b.index && numCol(b, b.index.column);
        if (!c) return [input];
        const timeK = b.index?.type === 'time' ? 1000 : 1;
        const out = new Float64Array(c.values.length);
        for (let i = 0; i < out.length; i++) {
          const t = ic ? ic.values[i] : i;
          const v = c.values[i];
          if (Number.isFinite(v)) win.push({ t, v });
          if (o.windowUnit === 'rows') while (win.length > o.window) win.shift();
          else while (win.length && win[0].t < t - o.window * timeK) win.shift();
          const vs = win.map((w) => w.v);
          if (!vs.length) {
            out[i] = NaN;
            continue;
          }
          switch (o.fn) {
            case 'mean':
              out[i] = vs.reduce((s, x) => s + x, 0) / vs.length;
              break;
            case 'min':
              out[i] = Math.min(...vs);
              break;
            case 'max':
              out[i] = Math.max(...vs);
              break;
            case 'sum':
              out[i] = vs.reduce((s, x) => s + x, 0);
              break;
            case 'std': {
              const m = vs.reduce((s, x) => s + x, 0) / vs.length;
              out[i] = Math.sqrt(vs.reduce((s, x) => s + (x - m) ** 2, 0) / vs.length);
              break;
            }
            case 'rate': {
              const a = win[0];
              const z2 = win[win.length - 1];
              const dt = (z2.t - a.t) / (b.index?.type === 'time' ? 3600000 : 1);
              out[i] = dt > 0 ? (z2.v - a.v) / dt : NaN;
              break;
            }
          }
        }
        return [withColumns(b, [...b.columns.filter((x) => x.name !== name), { name, unit: o.unit || (o.fn === 'rate' ? '' : c.unit), values: out }])];
      },
    };
  },
});

// ------------------------------------------------------------------ derive / filter

const DeriveOptions = z.object({
  name: z.string().min(1).describe('Name of the new channel'),
  expression: z.string().min(1).max(2000).describe('Formula over other channels, e.g. (GR - 20) / (130 - 20)'),
  unit: z.string().default(''),
});

export const deriveTransform = defineTransform<z.output<typeof DeriveOptions>>({
  id: 'derive',
  label: 'Formula',
  description: 'A new channel computed row by row from others: + − × ÷ ^, comparisons, if(), min/max/clamp, log/exp and more. Names with spaces go in [brackets].',
  options: DeriveOptions,
  create(o) {
    const f = compile(o.expression);
    return {
      apply(b) {
        const cols = f.inputs.map((n) => numCol(b, n));
        if (cols.some((c) => !c)) return [b];
        const n = rowCount(b);
        const out = new Float64Array(n);
        const lookup = new Map(f.inputs.map((name, j) => [name, cols[j]!.values]));
        let i = 0;
        const row = (name: string) => lookup.get(name)![i];
        for (; i < n; i++) out[i] = f.eval(row);
        return [withColumns(b, [...b.columns.filter((c) => c.name !== o.name), { name: o.name, unit: o.unit, values: out }])];
      },
    };
  },
});

const FilterOptions = z.object({ expression: z.string().min(1).max(2000).describe('Keep rows where this is true, e.g. ROPA > 0 && WOBA > 2') });

export const filterTransform = defineTransform<z.output<typeof FilterOptions>>({
  id: 'filter',
  label: 'Filter rows',
  description: 'Keep only the rows where a condition holds, e.g. only while drilling (ROPA > 0) or only one well.',
  options: FilterOptions,
  create(o) {
    const f = compile(o.expression);
    return {
      apply(b) {
        const cols = f.inputs.map((n) => numCol(b, n));
        if (cols.some((c) => !c)) return [b];
        const n = rowCount(b);
        const keep = new Uint8Array(n);
        const lookup = new Map(f.inputs.map((name, j) => [name, cols[j]!.values]));
        let i = 0;
        const row = (name: string) => lookup.get(name)![i];
        for (; i < n; i++) keep[i] = f.eval(row) ? 1 : 0;
        return keep.every(Boolean) ? [b] : [pick(b, keep)];
      },
    };
  },
});

// ------------------------------------------------------------------ shift

const ShiftOptions = z.object({
  seconds: z.number().default(0).describe('Add to time indexes (clock offset), seconds'),
  metres: z.number().default(0).describe('Add to depth indexes (depth correction), metres'),
});

export const shiftTransform = defineTransform<z.output<typeof ShiftOptions>>({
  id: 'shift',
  label: 'Shift index',
  description: 'Correct a clock offset or a depth offset (e.g. a rig clock in local time, or a driller’s depth correction).',
  options: ShiftOptions,
  create(o) {
    return {
      apply(input) {
        const b = detect(input);
        const ic = b.index && numCol(b, b.index.column);
        if (!ic) return same(b);
        const d = b.index!.type === 'time' ? o.seconds * 1000 : o.metres;
        if (!d) return [b];
        return [
          withColumns(
            b,
            b.columns.map((c) => (c === ic ? { ...c, values: ic.values.map((v) => v + d) } : c)),
          ),
        ];
      },
    };
  },
});

export const BUILTIN_TRANSFORMS = [
  mapTransform,
  unitsTransform,
  timeToDepthTransform,
  resampleTransform,
  orderTransform,
  despikeTransform,
  rollingTransform,
  deriveTransform,
  filterTransform,
  shiftTransform,
];
