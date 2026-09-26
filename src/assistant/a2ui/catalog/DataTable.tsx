/*
 * The data catalog's DataTable: a Tecton (React Aria) table over a dataset,
 * inline rows or a data-model array. Sortable headers, a sticky header in a
 * height-capped scroller, numbers right-aligned in tabular figures, and the
 * first rows only until the person asks for all of them.
 */
import { useMemo, useState } from 'react';
import { Button } from '@tecton/react/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tecton/react/components/table';
import type { SortDescriptor } from 'react-aria-components';
import type { DatasetColumn } from '../../core/types';
import { formatCell, inferColumns, num, timeValue, type CellFormat } from '../data';
import { useRuntime, useRows, useText, type NodeProps } from '../runtime';
import { DataFrame, Note, PendingBlock } from './frame';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface TableColumn {
  key: string;
  label: string;
  unit?: string;
  format?: CellFormat;
  digits?: number;
  numeric: boolean;
}

const FORMATS = new Set(['number', 'integer', 'percent', 'date', 'datetime', 'text']);
const MAX_EXPANDED = 2000;

/** The columns to show: the props' list, or every known column (at most 12). */
export function tableColumns(props: Rec, knownColumns: readonly DatasetColumn[], rows: readonly Rec[]): TableColumn[] {
  const known = knownColumns.length ? knownColumns : inferColumns(rows);
  const byKey = new Map(known.map((c) => [c.key, c]));
  const list: Rec[] = Array.isArray(props.columns)
    ? props.columns.map((c) => (typeof c === 'string' ? { key: c } : isRec(c) ? c : null)).filter((c): c is Rec => !!c && typeof c.key === 'string')
    : known.slice(0, 12).map((c) => ({ key: c.key }));
  return list.map((c) => {
    const key = String(c.key);
    const meta = byKey.get(key);
    const format = typeof c.format === 'string' && FORMATS.has(c.format) ? (c.format as CellFormat) : meta?.type === 'date' ? 'date' : undefined;
    const sample = rows.find((r) => r[key] !== null && r[key] !== undefined && r[key] !== '')?.[key];
    const numeric = format === 'number' || format === 'integer' || format === 'percent' || (format === undefined && (meta?.type === 'number' || typeof sample === 'number'));
    return {
      key,
      label: typeof c.label === 'string' && c.label ? c.label : (meta?.label ?? key),
      unit: typeof c.unit === 'string' ? c.unit : meta?.unit,
      format: format ?? (numeric ? 'number' : undefined),
      digits: typeof c.digits === 'number' ? Math.max(0, Math.min(10, c.digits)) : undefined,
      numeric,
    };
  });
}

/** Rows in the requested order (numbers and dates compare as such, empty cells last). */
export function sortRows(rows: readonly Rec[], col: TableColumn | undefined, direction: 'ascending' | 'descending'): Rec[] {
  if (!col) return rows as Rec[];
  const dir = direction === 'descending' ? -1 : 1;
  const key = (v: unknown): number | string | null => {
    if (v === null || v === undefined || v === '') return null;
    if (col.numeric) return num(v);
    if (col.format === 'date' || col.format === 'datetime') return timeValue(v);
    return String(v).toLowerCase();
  };
  return rows
    .map((r, i) => ({ r, i, k: key(r[col.key]) }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1;
      if (a.k < b.k) return -dir;
      if (a.k > b.k) return dir;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

function TableView({ rows, columns, limit, maxHeight, label }: { rows: readonly Rec[]; columns: TableColumn[]; limit: number; maxHeight: number; label: string }) {
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined);
  const sorted = useMemo(() => (sort ? sortRows(rows, columns.find((c) => c.key === sort.column), sort.direction ?? 'ascending') : rows), [rows, columns, sort]);
  const visible = sorted.slice(0, limit);
  return (
    <div className="w-full overflow-auto rounded-md border border-border-subtle [&_[data-slot=table-container]]:overflow-visible" style={{ maxHeight }}>
      <Table aria-label={label} sortDescriptor={sort} onSortChange={setSort}>
        <TableHeader>
          {columns.map((c, i) => (
            <TableHead key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting className={c.numeric ? 'sticky top-0 z-10 text-right' : 'sticky top-0 z-10'}>
              {c.label}
              {c.unit && <span className="ml-1 font-normal opacity-70">{c.unit}</span>}
            </TableHead>
          ))}
        </TableHeader>
        <TableBody renderEmptyState={() => 'No rows'}>
          {visible.map((r, ri) => (
            <TableRow key={ri} id={ri}>
              {columns.map((c) => (
                <TableCell key={c.key} className={c.numeric ? 'text-right tabular-nums' : undefined}>
                  {formatCell(r[c.key], c.format, c.digits)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DataTableNode({ node, scope }: NodeProps) {
  const rt = useRuntime();
  const src = useRows(node, scope);
  const title = useText(node.title, scope);
  const [all, setAll] = useState(false);
  const columns = useMemo(() => tableColumns(node, src.columns, src.rows), [node, src.columns, src.rows]);
  const collapsed = typeof node.maxRows === 'number' && node.maxRows > 0 ? Math.floor(node.maxRows) : 8;
  const maxHeight = typeof node.height === 'number' ? Math.max(160, Math.min(900, node.height)) : 380;
  if (rt.streaming && rt.surface.pending.includes(node.id)) return <PendingBlock height={Math.min(maxHeight, 44 * (collapsed + 1))} title={title} />;
  if (src.missing) return <Note>Dataset “{src.missing}” is not available in this conversation.</Note>;
  const n = src.rows.length;
  const label = title || src.title || 'Table';
  const subtitle = [src.title && src.title !== title ? src.title : '', `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`].filter(Boolean).join(' · ');
  const exportCols: DatasetColumn[] = columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit }));
  return (
    <DataFrame title={title || undefined} subtitle={subtitle} rows={src.rows} columns={exportCols}>
      {(expanded) =>
        expanded ? (
          <div className="flex flex-col gap-2">
            <TableView rows={src.rows} columns={columns} limit={MAX_EXPANDED} maxHeight={Math.round(window.innerHeight * 0.66)} label={label} />
            {n > MAX_EXPANDED && <span className="text-xs text-muted-foreground">First {MAX_EXPANDED.toLocaleString()} rows shown; download the CSV for all {n.toLocaleString()}.</span>}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <TableView rows={src.rows} columns={columns} limit={all ? Math.min(n, MAX_EXPANDED) : collapsed} maxHeight={maxHeight} label={label} />
            {n > collapsed && (
              <Button variant="ghost" size="xs" onPress={() => setAll((v) => !v)}>
                {all ? 'Show fewer' : `Show all (${n.toLocaleString()})`}
              </Button>
            )}
          </div>
        )
      }
    </DataFrame>
  );
}

export { DataTableNode as DataTable };
