import { strFromU8, unzipSync } from 'fflate';
import type { Table } from './csv';

/**
 * Minimal .xlsx reader (values only): enough to import real operator
 * spreadsheets such as the Equinor "Volve production data.xlsx" workbook
 * without converting them to CSV first. Dates come through as Excel serial
 * numbers, which the production importer understands.
 */
export function readXlsx(data: ArrayBuffer | Uint8Array): { name: string; table: Table }[] {
  const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : '');
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('Not a valid .xlsx workbook.');
  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const shared: string[] = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(decode([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const out: { name: string; table: Table }[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(attr(m[0], 'name') ?? 'Sheet');
    const rid = attr(m[0], 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    if (!path || !files[path]) continue;
    const rows = readSheet(strFromU8(files[path]), shared);
    const first = rows.findIndex((r) => r.some((c) => c !== ''));
    if (first < 0) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
    const headers = pad(rows[first]).map((h, i) => h || `COL${i + 1}`);
    out.push({ name, table: { headers, rows: rows.slice(first + 1).filter((r) => r.some((c) => c !== '')).map(pad), comments: [] } });
  }
  return out;
}

function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rIdx = Number(attr(rm[1], 'r') ?? rows.length + 1) - 1;
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = attr(cm[1], 't');
      const body = cm[2] ?? '';
      let v = '';
      if (type === 'inlineStr') v = decode([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        v = vm ? decode(vm[1]) : '';
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
      }
      row[col] = v.trim();
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    rows[rIdx] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/&amp;/g, '&');
}
