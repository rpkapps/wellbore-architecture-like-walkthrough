import { COLS, findColumn, parseCSV, type Table } from './csv';
import { ALIASES } from './las';
import { readXlsx } from './xlsx';

export type ImportKind = 'las' | 'logs' | 'tops' | 'survey' | 'production';

export interface Detected {
  kind: ImportKind;
  table?: Table;
  sheet?: string;
}

const LOG_MNEMONICS = new Set(Object.values(ALIASES).flat());

/** Classify one table by its columns. Order matters: the most specific signatures first. */
export function classifyTable(t: Table): ImportKind | null {
  const H = t.headers;
  const has = (c: string[]) => findColumn(H, c) >= 0;
  if ((has(COLS.date) || (has(COLS.year) && has(COLS.month))) && (has(COLS.oil) || has(COLS.gas) || has(COLS.water) || has(COLS.waterInj)))
    return 'production';
  if (has(COLS.inc) && has(COLS.azi)) return 'survey';
  if (has(['TVD']) && has(['NS', 'NORTH']) && has(['EW', 'EAST']) && !has(COLS.topName)) return 'survey';
  // logs before tops: a table with a depth column and any recognised log curve is a log file,
  // even if it also carries a formation/zone label column (e.g. the SEG facies data)
  const curveCols = H.filter((h) => LOG_MNEMONICS.has(h.replace(/[\(\[].*$/, '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '')));
  if (has(COLS.depth) && curveCols.length > 0) return 'logs';
  if (has(COLS.topName) && has(COLS.topMd)) return 'tops';
  if (H.length === 2 && H[0].startsWith('COL') && t.rows.every((r) => Number.isFinite(Number(r[1])) && !Number.isFinite(Number(r[0])))) return 'tops';
  if (has(COLS.depth)) return 'logs';
  return null;
}

const HELP =
  'Could not recognise the file. Expected LAS, or CSV / XLSX with logs (DEPTH + curves), tops (FORMATION + MD), survey (MD + INC + AZI) or production (DATE + OIL/GAS/WATER).';

export function detectKind(name: string, content: string | ArrayBuffer): Detected {
  if (/\.xlsx$/i.test(name) || typeof content !== 'string') {
    if (typeof content === 'string') throw new Error('Excel files must be read as binary.');
    const sheets = readXlsx(content);
    const found = sheets.map((s) => ({ ...s, kind: classifyTable(s.table) })).filter((s) => s.kind);
    if (!found.length) throw new Error(`${HELP} (checked sheets: ${sheets.map((s) => s.name).join(', ')})`);
    // prefer the most detailed sheet, e.g. "Daily Production Data" over "Monthly"
    const best = found.find((s) => /daily/i.test(s.name)) ?? found[0];
    return { kind: best.kind!, table: best.table, sheet: best.name };
  }
  if (/\.las$/i.test(name) || /^\s*~V/im.test(content.slice(0, 2000))) return { kind: 'las' };
  const t = parseCSV(content);
  const kind = classifyTable(t);
  if (!kind) throw new Error(HELP);
  return { kind, table: t };
}
