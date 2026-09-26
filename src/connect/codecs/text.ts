import { z } from 'zod';
import { batchesFromRecords, batchFromRows, columnFromCells, parseNumber, type Batch, type Column } from '../batch';
import { defineCodec, type Chunk, type ChunkMeta } from '../plugin';

/** Chunks to text, keeping a multi-byte character split across chunks intact. */
export class TextStream {
  private dec = new TextDecoder();
  text(c: Chunk, meta: ChunkMeta): string {
    if (typeof c === 'string') return c;
    return this.dec.decode(c, { stream: !meta.complete });
  }
}

/** Splits a stream into whole lines; a complete message always ends its last line. */
export class LineSplitter {
  private rest = '';
  private text = new TextStream();
  push(c: Chunk, meta: ChunkMeta): string[] {
    const s = this.rest + this.text.text(c, meta);
    const lines = s.split(/\r\n|\n|\r/);
    this.rest = meta.complete ? '' : lines.pop()!;
    if (meta.complete && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  end(): string[] {
    const r = this.rest;
    this.rest = '';
    return r ? [r] : [];
  }
}

// ------------------------------------------------------------------ delimited text

const Delimited = z.object({
  delimiter: z.enum(['auto', ',', ';', 'tab', '|', 'space']).default('auto').describe('Column separator'),
  header: z.enum(['auto', 'first', 'none']).default('auto').describe('Whether the first row names the columns'),
  unitsRow: z.boolean().default(false).describe('The row after the header holds units'),
  skipLines: z.number().int().min(0).max(1000).default(0).describe('Lines to skip before the header'),
  comment: z.string().max(4).default('#').describe('Lines starting with this are ignored'),
  decimalComma: z.boolean().default(false).describe('Numbers use a decimal comma (1,5)'),
  columns: z.array(z.string()).default([]).describe('Column names, when the data has no header row'),
});
type DelimitedOptions = z.output<typeof Delimited>;

const DELIMS: Record<string, string> = { ',': ',', ';': ';', tab: '\t', '|': '|', space: ' ' };

export function splitLine(line: string, delim: string): string[] {
  if (delim === ' ') return line.trim().split(/\s+/);
  if (!line.includes('"')) return line.split(delim).map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function guessDelimiter(line: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, splitLine(line, d).length - 1] as const).sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ' ';
}

const numeric = (t: string, dc: boolean) => t !== '' && Number.isFinite(parseNumber(t, dc));

export const csvCodec = defineCodec<DelimitedOptions>({
  id: 'csv',
  label: 'CSV / delimited text',
  description: 'Comma, semicolon, tab or space separated rows, with or without a header and a units row. Streams row by row.',
  extensions: ['csv', 'tsv', 'txt', 'dat', 'asc'],
  mime: ['text/csv', 'text/tab-separated-values'],
  options: Delimited,
  sniff(_, text) {
    if (!text) return 0;
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#'))
      .slice(0, 5);
    if (lines.length < 2) return 0;
    const d = guessDelimiter(lines[0]);
    if (d === ' ') return 0.15;
    const n = splitLine(lines[0], d).length;
    return lines.every((l) => splitLine(l, d).length === n) ? 0.5 : 0.25;
  },
  create(o) {
    const lines = new LineSplitter();
    let delim = o.delimiter === 'auto' ? '' : DELIMS[o.delimiter];
    let headers: string[] | null = o.columns.length ? o.columns : o.header === 'none' ? null : null;
    let units: string[] | undefined;
    let skip = o.skipLines;
    let pending: string[][] = []; // rows seen before the header could be decided
    let decided = o.columns.length > 0 || o.header === 'none';
    let wantUnits = o.unitsRow;

    const rows = (ls: string[]): Batch[] => {
      const out: string[][] = [];
      for (const l of ls) {
        if (skip > 0) {
          skip--;
          continue;
        }
        if (!l.trim() || (o.comment && l.trimStart().startsWith(o.comment))) continue;
        if (!delim) delim = guessDelimiter(l);
        const cells = splitLine(l, delim);
        if (!decided) {
          pending.push(cells);
          if (o.header === 'first' || pending.length >= 2) {
            const [a, b] = pending;
            const textish = a.filter((t) => t !== '' && !numeric(t, o.decimalComma)).length;
            const isHeader =
              o.header === 'first' ||
              (textish > 0 && (!b || a.every((t) => !numeric(t, o.decimalComma)) || a.some((t, i) => !numeric(t, o.decimalComma) && t !== '' && numeric(b[i] ?? '', o.decimalComma))));
            decided = true;
            if (isHeader) {
              headers = a;
              pending = pending.slice(1);
            } else headers = a.map((_, i) => `COL${i + 1}`);
            for (const p of pending) {
              if (wantUnits) {
                units = p;
                wantUnits = false;
              } else out.push(p);
            }
            pending = [];
          }
          continue;
        }
        if (wantUnits && headers) {
          units = cells;
          wantUnits = false;
          continue;
        }
        out.push(cells);
      }
      if (!out.length) return [];
      const h = headers ?? out[0].map((_, i) => `COL${i + 1}`);
      return [batchFromRows(h, out, { decimalComma: o.decimalComma, units })];
    };
    return {
      push: (c, meta) => rows(lines.push(c, meta)),
      end: () => {
        const b = rows(lines.end());
        if (!decided && pending.length) {
          // a single row: treat it as data unless forced otherwise
          decided = true;
          const h = headers ?? pending[0].map((_, i) => `COL${i + 1}`);
          const extra = batchFromRows(h, pending, { decimalComma: o.decimalComma, units });
          pending = [];
          return [...b, extra];
        }
        return b;
      },
    };
  },
});

// ------------------------------------------------------------------ fixed width

const FixedWidth = z.object({
  columns: z
    .array(z.object({ name: z.string().min(1), start: z.number().int().min(0), width: z.number().int().min(1), unit: z.string().optional() }))
    .min(1)
    .describe('Each column: its name, first character (0-based) and width'),
  skipLines: z.number().int().min(0).default(0),
  comment: z.string().max(4).default('#'),
  decimalComma: z.boolean().default(false),
});

export const fixedWidthCodec = defineCodec<z.output<typeof FixedWidth>>({
  id: 'fixed-width',
  label: 'Fixed-width text',
  description: 'Columns at fixed character positions, as older logging and rig systems print them.',
  extensions: ['prn', 'fwf'],
  options: FixedWidth,
  create(o) {
    const lines = new LineSplitter();
    let skip = o.skipLines;
    const read = (ls: string[]): Batch[] => {
      const rows: string[][] = [];
      for (const l of ls) {
        if (skip > 0) {
          skip--;
          continue;
        }
        if (!l.trim() || (o.comment && l.trimStart().startsWith(o.comment))) continue;
        rows.push(o.columns.map((c) => l.slice(c.start, c.start + c.width).trim()));
      }
      return rows.length
        ? [
            batchFromRows(
              o.columns.map((c) => c.name),
              rows,
              { decimalComma: o.decimalComma, units: o.columns.map((c) => c.unit ?? '') },
            ),
          ]
        : [];
    };
    return { push: (c, m) => read(lines.push(c, m)), end: () => read(lines.end()) };
  },
});

// ------------------------------------------------------------------ regex lines

const Pattern = z.object({
  pattern: z.string().min(1).max(500).describe('A regular expression with named groups, e.g. (?<time>\\S+)\\s+(?<GR>[\\d.]+)'),
  flags: z
    .string()
    .regex(/^[imsu]*$/)
    .default('')
    .describe('Regular expression flags (i, m, s, u)'),
  units: z.record(z.string(), z.string()).default({}).describe('Unit per named group'),
  decimalComma: z.boolean().default(false),
});

export const regexCodec = defineCodec<z.output<typeof Pattern>>({
  id: 'regex',
  label: 'Text lines (pattern)',
  description: 'Any line-based text: a regular expression with named groups picks the values out of each line. Lines that do not match are skipped.',
  options: Pattern,
  create(o, ctx) {
    const re = new RegExp(o.pattern, o.flags.replace(/g/g, ''));
    const lines = new LineSplitter();
    let missed = 0;
    const read = (ls: string[]): Batch[] => {
      const recs: Record<string, string>[] = [];
      for (const l of ls) {
        const m = re.exec(l);
        if (m?.groups) recs.push(m.groups);
        else if (l.trim() && ++missed === 20) ctx.log('20 lines did not match the pattern and were skipped.', 'warn');
      }
      if (!recs.length) return [];
      const names = Object.keys(recs[0]);
      const cols: Column[] = names.map((n) =>
        columnFromCells(
          n,
          recs.map((r) => r[n] ?? ''),
          { decimalComma: o.decimalComma, unit: o.units[n] },
        ),
      );
      return [{ columns: cols }];
    };
    return { push: (c, m) => read(lines.push(c, m)), end: () => read(lines.end()) };
  },
});

// ------------------------------------------------------------------ key=value lines

export const keyValueCodec = defineCodec<{ separator: string }>({
  id: 'key-value',
  label: 'Key=value lines',
  description: 'One reading per line as "name=value" pairs (InfluxDB-style or syslog-style), e.g. time=2025-01-01T00:00:00Z DBTM=2412.5 ROPA=18.2.',
  options: z.object({ separator: z.string().min(1).max(2).default('=') }),
  sniff(_, text) {
    if (!text) return 0;
    const l = text.split(/\r?\n/).filter(Boolean).slice(0, 3);
    return l.length && l.every((x) => /^(\s*[\w.]+=[^\s]+){2,}\s*$/.test(x)) ? 0.55 : 0;
  },
  create(o) {
    const lines = new LineSplitter();
    const read = (ls: string[]) => {
      const recs: Record<string, unknown>[] = [];
      for (const l of ls) {
        const r: Record<string, unknown> = {};
        for (const part of l.trim().split(/[\s,]+/)) {
          const i = part.indexOf(o.separator);
          if (i <= 0) continue;
          const k = part.slice(0, i);
          const v = part.slice(i + o.separator.length).replace(/^"|"$/g, '');
          const n = parseNumber(v);
          r[k] = Number.isFinite(n) ? n : v;
        }
        if (Object.keys(r).length) recs.push(r);
      }
      return batchesFromRecords(recs);
    };
    return { push: (c, m) => read(lines.push(c, m)), end: () => read(lines.end()) };
  },
});
