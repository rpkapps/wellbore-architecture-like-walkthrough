/*
 * The frame around a chart or a table: its title, and a quiet toolbar that
 * shows on hover or focus — expand into a large dialog, download the rows as
 * CSV, copy them as TSV (charts, for pasting into a spreadsheet).
 */
import { useState, type ReactNode } from 'react';
import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Skeleton } from '@tecton/react/components/skeleton';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { Check, ClipboardCopy, Download, Maximize2 } from 'lucide-react';
import type { DatasetColumn } from '../../core/types';
import { fileName, toCsv, toTsv } from '../data';

type Rec = Record<string, unknown>;

interface FrameProps {
  title?: string;
  subtitle?: string;
  rows: readonly Rec[];
  columns: readonly DatasetColumn[];
  /** charts offer "copy as TSV" */
  copyable?: boolean;
  /** the content, at its normal size or expanded in the dialog */
  children: (expanded: boolean) => ReactNode;
  /** no toolbar (inside the expanded dialog itself) */
  bare?: boolean;
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ToolButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      <Button variant="ghost" size="icon-xs" aria-label={label} onPress={onPress}>
        {children}
      </Button>
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  );
}

/** A titled block with the expand / download / copy toolbar. */
export function DataFrame({ title, subtitle, rows, columns, copyable, children, bare }: FrameProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasRows = rows.length > 0;
  const toolbar = !bare && hasRows && (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/frame:opacity-100 group-focus-within/frame:opacity-100 [@media(hover:none)]:opacity-100">
      <ToolButton label="Expand" onPress={() => setOpen(true)}>
        <Maximize2 />
      </ToolButton>
      <ToolButton label="Download CSV" onPress={() => download(fileName(title, 'csv'), toCsv(rows as Rec[], columns), 'text/csv;charset=utf-8')}>
        <Download />
      </ToolButton>
      {copyable && (
        <ToolButton
          label={copied ? 'Copied' : 'Copy data (TSV)'}
          onPress={() => {
            void navigator.clipboard?.writeText(toTsv(rows as Rec[], columns)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <ClipboardCopy />}
        </ToolButton>
      )}
    </div>
  );
  return (
    <section className="group/frame flex min-w-0 flex-col gap-2" aria-label={title || undefined}>
      {(title || subtitle || toolbar) && (
        <header className="flex min-h-6 items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            {title && <h4 className="truncate text-sm font-semibold text-foreground">{title}</h4>}
            {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {toolbar}
        </header>
      )}
      {children(false)}
      {!bare && (
        <Dialog isOpen={open} onOpenChange={setOpen} className="sm:max-w-[min(92vw,1100px)]">
          <DialogHeader>
            <DialogTitle>{title || 'Data'}</DialogTitle>
            {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
          </DialogHeader>
          {open && <div className="min-w-0">{children(true)}</div>}
        </Dialog>
      )}
    </section>
  );
}

/** A placeholder while a chart's definition is still streaming in. */
export function PendingBlock({ height, title }: { height: number; title?: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={title ? `Loading ${title}` : 'Loading chart'}>
      {title ? <span className="text-sm font-semibold text-foreground">{title}</span> : <Skeleton className="h-4 w-40" />}
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/** A quiet note inside a surface (a missing dataset, an unsupported component). */
export function Note({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{children}</div>;
}
