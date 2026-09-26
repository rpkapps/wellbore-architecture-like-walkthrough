import { memo, useState } from 'react';
import { cn } from 'cn';
import { BanIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon, ShieldAlertIcon, WrenchIcon, XIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import { Spinner } from '@tecton/react/components/spinner';
import { CopyButton } from '@tecton/react/tecton/copy-button';
import type { ToolCallPart, ToolCallState } from '../../core/types';
import { usePanel } from '../context';
import { argsSummary, formatDuration, prettyJson } from '../format';

const TRIGGER_CLASS =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring';

/** The icon of a tool call's state: spinner, check, cross, shield, slash (an alert for a call stopped while it ran: it may have taken effect). */
export function ToolStateIcon({ state, interrupted }: { state: ToolCallState; interrupted?: boolean }) {
  if (state === 'cancelled' && interrupted) return <CircleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />;
  switch (state) {
    case 'streaming':
    case 'running':
      return <Spinner className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
    case 'done':
      return <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />;
    case 'error':
      return <XIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />;
    case 'awaiting-approval':
      return <ShieldAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />;
    default:
      return <BanIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  }
}

const STATE_LABEL: Record<ToolCallState, string> = {
  streaming: 'preparing',
  'awaiting-approval': 'waiting for approval',
  running: 'running',
  done: 'done',
  error: 'failed',
  denied: 'denied',
  cancelled: 'cancelled',
};

function JsonBlock({ label, value, tone }: { label: string; value: unknown; tone?: 'error' }) {
  const text = prettyJson(value);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        <CopyButton value={text} size="icon-xs" aria-label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre
        className={cn(
          'max-h-60 overflow-auto rounded-md border border-border-subtle bg-muted/40 p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-all',
          tone === 'error' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {text}
      </pre>
    </div>
  );
}

const duration = (call: ToolCallPart) => (call.startedAt && call.endedAt ? formatDuration(call.endedAt - call.startedAt) : '');

/** A call stopped while it ran is not crossed out: it may have taken effect. */
const interrupted = (call: ToolCallPart) => call.state === 'cancelled' && !!call.interrupted;
const stateLabel = (call: ToolCallPart) => (interrupted(call) ? 'stopped while running' : STATE_LABEL[call.state]);
const outcome = (call: ToolCallPart) => (call.state === 'denied' ? 'Denied' : interrupted(call) ? 'Interrupted' : call.state === 'cancelled' ? 'Cancelled' : duration(call));

/** One call: state icon, title, a one-line summary of its arguments, duration; expands to the JSON. */
export const ToolRow = memo(function ToolRow({ call }: { call: ToolCallPart }) {
  const { toolTitle } = usePanel();
  const [expanded, setExpanded] = useState(false);
  const title = toolTitle(call.name);
  const active = call.state === 'running' || call.state === 'streaming';
  const summary = argsSummary(call.args);
  return (
    <Collapsible data-slot="assistant-tool-row" data-state={call.state} className="group/tool min-w-0" isExpanded={expanded} onExpandedChange={setExpanded}>
      <CollapsibleTrigger className={TRIGGER_CLASS} aria-label={`${title}, ${stateLabel(call)}${summary ? `: ${summary}` : ''}`}>
        <ToolStateIcon state={call.state} interrupted={call.interrupted} />
        <span
          className={cn(
            'shrink-0 truncate font-medium text-foreground',
            active && 'shimmer motion-reduce:shimmer-none',
            (call.state === 'denied' || call.state === 'cancelled') && !interrupted(call) && 'text-muted-foreground line-through',
          )}
        >
          {title}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{outcome(call)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-expanded/tool:rotate-180 motion-reduce:transition-none" aria-hidden />
      </CollapsibleTrigger>
      {call.state === 'error' && call.error && !expanded && <p className="line-clamp-2 ps-7 pe-2 pb-1 text-xs text-destructive">{call.error}</p>}
      <CollapsibleContent>
        {expanded && (
          <div className="flex flex-col gap-2 ps-7 pe-2 pt-1 pb-2">
            <div className="font-mono text-[0.6875rem] text-muted-foreground">{call.name}</div>
            <JsonBlock label="Arguments" value={call.args ?? call.argsText ?? {}} />
            {call.error ? <JsonBlock label="Error" value={call.error} tone="error" /> : call.result !== undefined && <JsonBlock label="Result" value={call.result} />}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

/**
 * Consecutive tool calls of one reply. Up to two show as rows; more fold
 * under a summary line ("Used 4 tools · 2.3 s") that stays open while a
 * call runs and closes when they are done, unless the person toggled it.
 */
export const ToolGroup = memo(function ToolGroup({ calls }: { calls: ToolCallPart[] }) {
  const { toolTitle } = usePanel();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const rows = calls.map((call) => <ToolRow key={call.id} call={call} />);
  if (calls.length <= 2) {
    return (
      <div data-slot="assistant-tool-group" className="-mx-2 flex flex-col">
        {rows}
      </div>
    );
  }
  const active = calls.some((c) => c.state === 'running' || c.state === 'streaming');
  const failed = calls.filter((c) => c.state === 'error').length;
  const expanded = userExpanded ?? active;
  const start = Math.min(...calls.map((c) => c.startedAt ?? Infinity));
  const end = Math.max(...calls.map((c) => c.endedAt ?? 0));
  const total = !active && Number.isFinite(start) && end > start ? formatDuration(end - start) : '';
  const names = [...new Set(calls.map((c) => toolTitle(c.name)))];
  return (
    <Collapsible data-slot="assistant-tool-group" className="group/tools -mx-2 min-w-0" isExpanded={expanded} onExpandedChange={setUserExpanded}>
      <CollapsibleTrigger className={TRIGGER_CLASS}>
        {active ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className={cn('shrink-0 font-medium text-foreground', active && 'shimmer motion-reduce:shimmer-none')}>{active ? `Using tools` : `Used ${calls.length} tools`}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {failed > 0 && <span className="text-destructive">{failed} failed · </span>}
          {names.join(', ')}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{total}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-expanded/tools:rotate-180 motion-reduce:transition-none" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-3.5 flex flex-col border-s border-border-subtle ps-1">{expanded && rows}</div>
      </CollapsibleContent>
    </Collapsible>
  );
});
