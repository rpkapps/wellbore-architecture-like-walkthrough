import { memo, useState } from 'react';
import { ChevronDownIcon, FoldVerticalIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import { Spinner } from '@tecton/react/components/spinner';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import type { Compaction } from '../../core/types';
import { compactNumber } from '../format';
import { Markdown } from '../markdown/Markdown';

/** 48,210 → "48k", 3,000 → "3k", 3,400 → "3.4k". */
const tokens = (n: number) => compactNumber(Math.round(n)).replace('.0k', 'k');

/** "≈ 48k → 3k tokens", or '' when the compaction did not measure them. */
export function compactionTokens(c: Pick<Compaction, 'tokensBefore' | 'tokensAfter'>): string {
  if (!c.tokensBefore || !c.tokensAfter) return '';
  return `≈ ${tokens(c.tokensBefore)} → ${tokens(c.tokensAfter)} tokens`;
}

/**
 * Where a summary took over from the messages above it: a quiet full-width
 * divider (the date and time on hover) that expands to the summary the model
 * now reads instead of them. The messages themselves stay in the transcript.
 */
export const CompactionDivider = memo(function CompactionDivider({ compaction }: { compaction: Compaction }) {
  const [open, setOpen] = useState(false);
  const when = new Date(compaction.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const saved = compactionTokens(compaction);
  const facts = [`${compaction.messages} message${compaction.messages === 1 ? '' : 's'}`, saved, compaction.auto ? 'summarised automatically' : 'summarised with /compact'].filter(Boolean);
  return (
    <Collapsible data-slot="assistant-compaction" className="group/compaction min-w-0 py-1" isExpanded={open} onExpandedChange={setOpen}>
      <TooltipTrigger>
        <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
          <FoldVerticalIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-medium">Earlier messages summarised to save space</span>
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-expanded/compaction:rotate-180 motion-reduce:transition-none" aria-hidden />
          <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
        </CollapsibleTrigger>
        <Tooltip>{`${compaction.auto ? 'Summarised automatically' : 'Summarised with /compact'} · ${when}`}</Tooltip>
      </TooltipTrigger>
      <CollapsibleContent>
        {open && (
          <div className="mt-1.5 flex flex-col gap-2 rounded-lg border border-border-subtle bg-muted/40 px-3 py-2.5">
            <p className="text-[0.6875rem] text-muted-foreground tabular-nums">
              {facts.join(' · ')} · {when}
            </p>
            <Markdown text={compaction.summary} className="gap-2 text-xs text-muted-foreground" />
            <p className="text-[0.6875rem] text-muted-foreground">The assistant reads this summary instead of the messages above it; they stay here for you.</p>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

/** "Compacting the conversation…" while a summary is being written, where "Thinking…" would be. */
export function CompactingLine() {
  return (
    <div role="status" data-slot="assistant-compacting" className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-3" aria-hidden />
      <span className="shimmer font-medium motion-reduce:shimmer-none">Compacting the conversation…</span>
    </div>
  );
}
