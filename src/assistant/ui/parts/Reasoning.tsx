import { memo, useState } from 'react';
import { cn } from 'cn';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import type { ReasoningPart } from '../../core/types';
import { formatSeconds } from '../format';
import { Markdown } from '../markdown/Markdown';

/** The model's thinking: "Thinking…" (shimmering) while it streams, "Thought for 12s" after; collapsed by default. */
export const Reasoning = memo(function Reasoning({ part, live }: { part: ReasoningPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const label = live ? 'Thinking…' : part.durationMs ? `Thought for ${formatSeconds(part.durationMs)}` : part.redacted && !part.text ? 'Thinking (hidden by the provider)' : 'Thought';
  // the last line, as a one-line preview while the model thinks
  const preview = live && !open ? part.text.trim().split('\n').pop()?.slice(-140) : '';
  return (
    <Collapsible data-slot="assistant-reasoning" className="group/reasoning -mx-2 min-w-0" isExpanded={open} onExpandedChange={setOpen} isDisabled={!part.text}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent">
        <BrainIcon className="size-3.5 shrink-0" aria-hidden />
        <span className={cn('shrink-0 font-medium', live && 'shimmer motion-reduce:shimmer-none')}>{label}</span>
        {preview ? <span className="min-w-0 flex-1 truncate opacity-70">{preview}</span> : <span className="flex-1" />}
        {part.text && <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-expanded/reasoning:rotate-180 motion-reduce:transition-none" aria-hidden />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && (
          <div className="ms-3.5 mt-1 mb-1 max-h-80 overflow-y-auto border-s border-border-subtle ps-3.5">
            <Markdown text={part.text} className="gap-2 text-xs text-muted-foreground" />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});
