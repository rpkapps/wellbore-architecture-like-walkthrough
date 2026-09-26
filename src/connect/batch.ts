/**
 * The columnar table every connector speaks. A codec turns bytes into
 * batches, transforms reshape batches, and the assembler turns the final
 * batches into frames for the app (`frames.ts`). Numbers live in Float64Arrays
 * (NaN = missing) so a batch can cross to the main thread without copying;
 * text columns are plain string arrays.
 */
export type BatchKind = 'channels' | 'survey' | 'tops' | 'production';
export type IndexType = 'time' | 'depth';

export interface Column {
  name: string;
  unit?: string;
  description?: string;
  /** numbers (NaN = missing; times are epoch milliseconds) or text */
  values: Float64Array | string[];
}

export interface Batch {
  /** what the rows are, when the format knows (LAS, WITSML, DLIS…) or a mapping said so */
  kind?: BatchKind;
  /** the column the rows are indexed by, for channels */
  index?: { column: string; type: IndexType };
  /** the well every row belongs to, when the format names one */
  well?: string;
  /** a column naming the well per row (multi-well tables and topics) */
  wellColumn?: string;
  columns: Column[];
  /** header values worth keeping (LAS ~W, WITSML well info, topic and key…) */
  meta?: Record<string, string>;
}

export const isNumeric = (c: Column): c is Column & { values: Float64Array } => c.values instanceof Float64Array;

export function rowCount(b: Batch): number {
  return b.columns.length ? b.columns[0].values.length : 0;
}

export function column(b: Batch, name: string | undefined): Column | undefined {
  if (!name) return undefined;
  const exact = b.columns.find((c) => c.name === name);
  if (exact) return exact;
  const k = key(name);
  return b.columns.find((c) => key(c.name) === k);
}

/** Loose name key: case, punctuation and a unit in brackets do not matter. */
export const key = (s: string) =>
  s
    .toUpperCase()
    .replace(/[([].*?[)\]]/g, '')
    .replace(/[^A-Z0-9]/g, '');

// ------------------------------------------------------------------ parsing values

const MISSING = new Set(['', 'NA', 'N/A', 'NAN', 'NULL', 'NONE', '-', '--', '-999.25', '-999', '-9999', '-99999']);

/** A number from text: "1 234,5" and "1,234.5" both read; common null markers read as NaN. */
export function parseNumber(s: string, decimalComma = false): number {
  const t = s.trim();
  if (MISSING.has(t.toUpperCase())) return NaN;
  let v = Number(t);
  if (Number.isFinite(v)) return v;
  let u = t.replace(/\s/g, '');
  u = decimalComma ? u.replace(/\./g, '').replace(',', '.') : u.replace(/,(?=\d{3}(\D|$))/g, '');
  v = Number(u);
  return Number.isFinite(v) ? v : NaN;
}

const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DMY = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

/** Epoch ms from an ISO date-time, "dd.mm.yyyy hh:mm:ss", or NaN. Times without a zone are UTC. */
export function parseTime(s: string): number {
  const t = s.trim();
  if (ISO.test(t)) {
    let s = t.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    if (s.length === 10) s += 'T00:00:00Z';
    else if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s += 'Z';
    const v = Date.parse(s);
    return Number.isFinite(v) ? v : NaN;
  }
  const m = DMY.exec(t);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0', ms = '0'] = m;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number(`0.${ms}`) * 1000));
  }
  return NaN;
}

/** A column from text cells: numeric when most cells are numbers, time when most are dates, text otherwise. */
export function columnFromCells(name: string, cells: string[], opts: { decimalComma?: boolean; unit?: string } = {}): Column {
  const n = cells.length;
  let nums = 0;
  let times = 0;
  let filled = 0;
  const probe = Math.min(n, 200);
  for (let i = 0; i < probe; i++) {
    const c = cells[Math.floor((i * n) / probe)] ?? '';
    if (!c.trim() || MISSING.has(c.trim().toUpperCase())) continue;
    filled++;
    if (Number.isFinite(parseNumber(c, opts.decimalComma))) nums++;
    else if (Number.isFinite(parseTime(c))) times++;
  }
  const split = splitNameUnit(name, opts.unit);
  const unit = split.unit;
  name = split.name;
  if (filled && times / filled > 0.8) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = parseTime(cells[i] ?? '');
    return { name, unit: 'ms', values: v, description: 'time' };
  }
  if (!filled || nums / filled > 0.8) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = parseNumber(cells[i] ?? '', opts.decimalComma);
    return { name, unit, values: v };
  }
  return { name, unit, values: cells.map((c) => c ?? '') };
}

/** "DEPTH (ft)" / "GR [gAPI]" → the unit inside the brackets. */
export function unitFromName(name: string): string | undefined {
  const m = /[([]\s*([^)\]]+?)\s*[)\]]\s*$/.exec(name);
  return m ? m[1] : undefined;
}

/** "GR [gAPI]" → { name: "GR", unit: "gAPI" }: names stay clean, so steps and mappings match them. */
export function splitNameUnit(raw: string, unit?: string): { name: string; unit?: string } {
  const u = unitFromName(raw);
  if (!u) return { name: raw, unit };
  const name = raw.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  return name ? { name, unit: unit || u } : { name: raw, unit };
}

// ------------------------------------------------------------------ building batches

/** A batch from a header row and text rows. */
export function batchFromRows(headers: string[], rows: string[][], opts: { decimalComma?: boolean; units?: string[] } = {}): Batch {
  const columns = headers.map((h, j) =>
    columnFromCells(
      h,
      rows.map((r) => r[j] ?? ''),
      { decimalComma: opts.decimalComma, unit: opts.units?.[j] || undefined },
    ),
  );
  return { columns };
}

/**
 * A batch from JSON records. Nested objects flatten to dotted names
 * ("bit.depth"); arrays of numbers stay as JSON text. Records with different
 * shapes are split into one batch per shape, in order, so a stream mixing
 * survey stations and sensor readings keeps them apart.
 */
export function batchesFromRecords(records: unknown[]): Batch[] {
  const out: Batch[] = [];
  let shape = '';
  let group: Record<string, unknown>[] = [];
  const flush = () => {
    if (group.length) out.push(batchFromFlat(group));
    group = [];
  };
  for (const r of records) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
    const flat = flatten(r as Record<string, unknown>);
    const s = Object.keys(flat).sort().join('\u0000');
    if (s !== shape) {
      flush();
      shape = s;
    }
    group.push(flat);
  }
  flush();
  return out;
}

function flatten(o: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      // {value, uom} pairs (WITSML JSON, OSDU) read as one number with a unit
      if ('value' in inner && ('uom' in inner || 'unit' in inner) && Object.keys(inner).length <= 3) {
        out[name] = inner.value;
        out[`${name}\u0001unit`] = inner.uom ?? inner.unit;
      } else flatten(inner, name, out);
    } else out[name] = v;
  }
  return out;
}

function batchFromFlat(rows: Record<string, unknown>[]): Batch {
  const names = Object.keys(rows[0]).filter((k) => !k.endsWith('\u0001unit'));
  const columns: Column[] = names.map((name) => {
    const unit = rows[0][`${name}\u0001unit`];
    const vals = rows.map((r) => r[name]);
    const numeric = vals.every((v) => v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean');
    if (numeric) {
      const a = new Float64Array(vals.length);
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        a[i] = typeof v === 'number' ? v : typeof v === 'boolean' ? +v : NaN;
      }
      return { ...splitNameUnit(name, typeof unit === 'string' ? unit : undefined), values: a };
    }
    return columnFromCells(
      name,
      vals.map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))),
      { unit: typeof unit === 'string' ? unit : undefined },
    );
  });
  return { columns };
}

// ------------------------------------------------------------------ reshaping

/** Rows [from, to) of a batch. */
export function slice(b: Batch, from: number, to: number): Batch {
  return { ...b, columns: b.columns.map((c) => ({ ...c, values: c.values.slice(from, to) as Float64Array | string[] })) };
}

/** Rows where `keep[i]` is set. */
export function pick(b: Batch, keep: Uint8Array): Batch {
  let n = 0;
  for (let i = 0; i < keep.length; i++) n += keep[i];
  return {
    ...b,
    columns: b.columns.map((c) => {
      if (isNumeric(c)) {
        const v = new Float64Array(n);
        for (let i = 0, j = 0; i < keep.length; i++) if (keep[i]) v[j++] = c.values[i];
        return { ...c, values: v };
      }
      return { ...c, values: (c.values as string[]).filter((_, i) => keep[i]) };
    }),
  };
}

/** Same columns (by name) stacked; a column missing from one batch fills with NaN / ''. */
export function concat(batches: Batch[]): Batch {
  if (batches.length === 1) return batches[0];
  const first = batches[0];
  const names: string[] = [];
  const proto = new Map<string, Column>();
  for (const b of batches)
    for (const c of b.columns)
      if (!proto.has(c.name)) {
        proto.set(c.name, c);
        names.push(c.name);
      }
  const total = batches.reduce((s, b) => s + rowCount(b), 0);
  const columns = names.map((name) => {
    const p = proto.get(name)!;
    if (isNumeric(p)) {
      const v = new Float64Array(total).fill(NaN);
      let o = 0;
      for (const b of batches) {
        const c = b.columns.find((x) => x.name === name);
        if (c && isNumeric(c)) v.set(c.values, o);
        o += rowCount(b);
      }
      return { ...p, values: v };
    }
    const v: string[] = [];
    for (const b of batches) {
      const c = b.columns.find((x) => x.name === name);
      const n = rowCount(b);
      for (let i = 0; i < n; i++) v.push(c ? String(c.values[i] ?? '') : '');
    }
    return { ...p, values: v };
  });
  return { ...first, columns, meta: Object.assign({}, ...batches.map((b) => b.meta ?? {})) };
}

/** A short text rendering of the first rows, for previews and error messages. */
export function head(b: Batch, n = 5): { columns: { name: string; unit?: string; numeric: boolean }[]; rows: string[][] } {
  const rows: string[][] = [];
  const m = Math.min(n, rowCount(b));
  for (let i = 0; i < m; i++)
    rows.push(
      b.columns.map((c) => {
        const v = c.values[i];
        if (typeof v === 'string') return v;
        if (!Number.isFinite(v)) return '';
        if (c.unit === 'ms' && v > 1e11)
          return new Date(v)
            .toISOString()
            .replace('T', ' ')
            .replace(/\.000Z$|Z$/, '');
        return Number.isInteger(v) ? String(v) : String(+v.toPrecision(6));
      }),
    );
  return { columns: b.columns.map((c) => ({ name: c.name, unit: c.unit, numeric: isNumeric(c) })), rows };
}
