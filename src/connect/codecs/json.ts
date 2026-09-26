import { z } from 'zod';
import { batchesFromRecords, columnFromCells, type Batch, type Column } from '../batch';
import { defineCodec } from '../plugin';
import { LineSplitter, TextStream } from './text';
import { decodeMsgpack } from './msgpack';

const Shape = z.object({
  path: z.string().max(200).default('').describe('Where the rows are inside each document, e.g. "data.items" (empty: found automatically)'),
  shape: z.enum(['auto', 'records', 'columns', 'rows', 'split']).default('auto').describe('Records [{…}], columns {a:[…]}, rows [[…]] or split {columns, data}'),
});
export type ShapeOptions = z.output<typeof Shape>;

const ARRAY_KEYS = ['data', 'items', 'records', 'rows', 'values', 'results', 'readings', 'samples', 'points', 'entries', 'hits', 'result', 'value'];

function at(v: unknown, path: string): unknown {
  if (!path) return v;
  let cur = v;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(p) ? cur[+p] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Batches from a parsed JSON (or MessagePack) document of any common shape. */
export function batchesFromValue(doc: unknown, o: ShapeOptions): Batch[] {
  const v = at(doc, o.path);
  if (v === undefined || v === null) return [];
  const shape = o.shape === 'auto' ? guess(v) : o.shape;
  switch (shape) {
    case 'records':
      return batchesFromRecords(Array.isArray(v) ? v.map(unwrap) : [v]);
    case 'rows': {
      const rows = v as unknown[][];
      if (!rows.length) return [];
      const header = rows[0].every((c) => typeof c === 'string') && rows.length > 1 && rows[1].some((c) => typeof c === 'number');
      const names = header ? (rows[0] as string[]) : rows[0].map((_, i) => `COL${i + 1}`);
      return [fromMatrix(names, header ? rows.slice(1) : rows)];
    }
    case 'split': {
      const s = v as { columns: string[]; data: unknown[][]; index?: unknown[]; index_name?: string };
      const names = [...s.columns];
      let data = s.data;
      if (s.index && s.index.length === data.length) {
        names.unshift(s.index_name ?? 'index');
        data = data.map((r, i) => [s.index![i], ...r]);
      }
      return [fromMatrix(names, data)];
    }
    case 'columns': {
      const obj = v as Record<string, unknown[]>;
      const cols: Column[] = Object.entries(obj)
        .filter(([, a]) => Array.isArray(a))
        .map(([name, a]) =>
          a.every((x) => x === null || typeof x === 'number')
            ? { name, values: Float64Array.from(a as (number | null)[], (x) => (x === null ? NaN : x)) }
            : columnFromCells(
                name,
                a.map((x) => (x === null || x === undefined ? '' : String(x))),
              ),
        );
      return cols.length ? [{ columns: cols }] : [];
    }
    default: {
      // an envelope: find the array inside
      if (isObj(v)) for (const k of ARRAY_KEYS) if (Array.isArray(v[k]) || isObj(v[k])) return batchesFromValue(v[k], { path: '', shape: 'auto' });
      return [];
    }
  }
}

function unwrap(r: unknown): unknown {
  // search engines wrap each document (Elastic / OpenSearch hits)
  return isObj(r) && isObj(r._source) ? r._source : r;
}

function guess(v: unknown): ShapeOptions['shape'] | 'envelope' {
  if (Array.isArray(v)) {
    if (!v.length) return 'records';
    if (Array.isArray(v[0])) return 'rows';
    return 'records';
  }
  if (!isObj(v)) return 'records';
  if (Array.isArray(v.columns) && Array.isArray(v.data)) return 'split';
  const vals = Object.values(v);
  const arrays = vals.filter(Array.isArray) as unknown[][];
  if (arrays.length >= 2 && arrays.length === vals.length && arrays.every((a) => a.length === arrays[0].length && !isObj(a[0]))) return 'columns';
  for (const k of ARRAY_KEYS) if (Array.isArray(v[k]) || (isObj(v[k]) && k !== 'value')) return 'envelope' as never;
  return 'records';
}

function fromMatrix(names: string[], rows: unknown[][]): Batch {
  const columns = names.map((name, j) => {
    const vals = rows.map((r) => r[j]);
    if (vals.every((x) => x === null || x === undefined || typeof x === 'number'))
      return { name, values: Float64Array.from(vals as (number | null)[], (x) => (typeof x === 'number' ? x : NaN)) } as Column;
    return columnFromCells(
      name,
      vals.map((x) => (x === null || x === undefined ? '' : String(x))),
    );
  });
  return { columns };
}

// ------------------------------------------------------------------ JSON and JSON Lines

export const jsonCodec = defineCodec<ShapeOptions>({
  id: 'json',
  label: 'JSON / JSON Lines',
  description:
    'One document per message or file, or one document per line (NDJSON). Records, columns, row arrays and pandas "split" shapes are read; the rows are found inside envelopes like {"data": […]}.',
  extensions: ['json', 'ndjson', 'jsonl', 'geojson'],
  mime: ['application/json', 'application/x-ndjson', 'application/jsonl'],
  options: Shape,
  sniff(_, text) {
    const t = text?.trimStart() ?? '';
    return t.startsWith('{') || t.startsWith('[') ? 0.7 : 0;
  },
  create(o) {
    const text = new TextStream();
    const lines = new LineSplitter();
    let mode: 'unknown' | 'lines' | 'document' = 'unknown';
    let doc = '';
    const parseLines = (ls: string[]) => {
      const recs: unknown[] = [];
      const out: Batch[] = [];
      for (const l of ls) {
        const t = l.trim();
        if (!t) continue;
        const v = JSON.parse(t);
        if (isObj(v) && !o.path && o.shape === 'auto' && guess(v) === 'records') recs.push(v);
        else {
          if (recs.length) out.push(...batchesFromRecords(recs.splice(0)));
          out.push(...batchesFromValue(v, o));
        }
      }
      if (recs.length) out.push(...batchesFromRecords(recs));
      return out;
    };
    return {
      push(c, meta) {
        if (meta.complete) {
          // a whole message: one document, or several lines of them
          const s = text.text(c, meta).trim();
          if (!s) return [];
          try {
            return batchesFromValue(JSON.parse(s), o);
          } catch {
            return parseLines(s.split(/\r?\n/));
          }
        }
        if (mode === 'document') {
          doc += text.text(c, meta);
          return [];
        }
        const ls = lines.push(c, meta);
        if (mode === 'unknown') {
          const first = ls.find((l) => l.trim());
          if (first === undefined) return [];
          try {
            JSON.parse(first);
            mode = 'lines';
          } catch {
            mode = 'document';
            doc = ls.join('\n') + '\n';
            return [];
          }
        }
        return parseLines(ls);
      },
      end() {
        if (mode === 'document') {
          const s = doc + lines.end().join('\n');
          doc = '';
          return s.trim() ? batchesFromValue(JSON.parse(s), o) : [];
        }
        return parseLines(lines.end());
      },
    };
  },
});

// ------------------------------------------------------------------ MessagePack

export const msgpackCodec = defineCodec<ShapeOptions>({
  id: 'msgpack',
  label: 'MessagePack',
  description: 'Binary JSON: one MessagePack value per message, read like JSON (records, columns, rows).',
  extensions: ['msgpack', 'mpk'],
  mime: ['application/msgpack', 'application/x-msgpack'],
  options: Shape,
  create(o) {
    const parts: Uint8Array[] = [];
    const decode = (b: Uint8Array) => {
      const out: Batch[] = [];
      for (const v of decodeMsgpack(b)) out.push(...batchesFromValue(v, o));
      return out;
    };
    return {
      push(c, meta) {
        const b = typeof c === 'string' ? new TextEncoder().encode(c) : c;
        if (meta.complete) return decode(b);
        parts.push(b);
        return [];
      },
      end() {
        if (!parts.length) return [];
        const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o2 = 0;
        for (const p of parts.splice(0)) {
          all.set(p, o2);
          o2 += p.length;
        }
        return decode(all);
      },
    };
  },
});
