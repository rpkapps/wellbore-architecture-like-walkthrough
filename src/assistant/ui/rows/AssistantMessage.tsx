import { memo, useRef } from 'react';
import { cn } from 'cn';
import { RotateCcwIcon, SparklesIcon } from 'lucide-react';
import { Bubble, BubbleContent } from '@tecton/react/components/bubble';
import { Button } from '@tecton/react/components/button';
import { Message, MessageAvatar, MessageContent, MessageFooter } from '@tecton/react/components/message';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { CopyButton } from '@tecton/react/tecton/copy-button';
import type { ChatMessage, ErrorPart, ReasoningPart, TextPart, ToolCallPart, UIPart } from '../../core/types';
import { usePanel } from '../context';
import { formatUsage, messageText } from '../format';
import { Markdown } from '../markdown/Markdown';
import { ApprovalCard, ApprovalGroup } from '../parts/ApprovalCard';
import { CompactingLine } from '../parts/Compaction';
import { ErrorNotice } from '../parts/ErrorNotice';
import { Reasoning } from '../parts/Reasoning';
import { ToolGroup } from '../parts/ToolCalls';
import { UISurface } from '../parts/UISurface';

/** The built-in tool whose `ui` part shows instead of its activity row. */
const RENDER_UI_TOOL = 'render_ui';

type Item =
  | { k: 'reasoning'; key: string; part: ReasoningPart; live: boolean }
  | { k: 'text'; key: string; part: TextPart; live: boolean }
  | { k: 'tools'; key: string; calls: ToolCallPart[] }
  | { k: 'approval'; key: string; call: ToolCallPart }
  | { k: 'approvals'; key: string; calls: ToolCallPart[] }
  | { k: 'ui'; key: string; part: UIPart }
  | { k: 'error'; key: string; part: ErrorPart };

/** A call that has not finished: its approval card (or its step's) stays until it has. */
const unsettled = (p: ToolCallPart) => p.state === 'awaiting-approval' || p.state === 'running' || p.state === 'streaming';

/**
 * The calls that show in a step's grouped approval card, by id: the calls of
 * a step that asked for approval (`asked`), when more than one did and one of
 * them has not finished yet. Once they all have, they join the activity rows
 * together, in one change.
 */
function groupedApprovals(message: ChatMessage, asked: ReadonlySet<string>): Map<string, ToolCallPart[]> {
  const bySteps = new Map<number | 'none', ToolCallPart[]>();
  for (const p of message.parts)
    if (p.type === 'tool-call' && asked.has(p.id)) {
      const step = p.step ?? 'none';
      const list = bySteps.get(step);
      if (list) list.push(p);
      else bySteps.set(step, [p]);
    }
  const out = new Map<string, ToolCallPart[]>();
  for (const calls of bySteps.values()) if (calls.length > 1 && calls.some(unsettled)) for (const c of calls) out.set(c.id, calls);
  return out;
}

/** The parts of a reply as rows: consecutive tool calls grouped, render_ui calls hidden, waiting calls as approval cards (one per step). */
function toItems(message: ChatMessage, showReasoning: boolean, asked: ReadonlySet<string>): Item[] {
  const streaming = message.status === 'streaming';
  const items: Item[] = [];
  const cards = groupedApprovals(message, asked);
  let group: ToolCallPart[] | null = null;
  const last = message.parts.length - 1;
  message.parts.forEach((part, i) => {
    if (part.type !== 'tool-call') group = null;
    switch (part.type) {
      case 'reasoning':
        if (showReasoning && (part.text || part.redacted)) items.push({ k: 'reasoning', key: `r${i}`, part, live: streaming && i === last && part.durationMs === undefined });
        break;
      case 'text':
        if (part.text) items.push({ k: 'text', key: `t${i}`, part, live: streaming && i === last });
        break;
      case 'tool-call': {
        const card = cards.get(part.id);
        if (card) {
          if (card[0] === part) items.push({ k: 'approvals', key: `approvals:${part.id}`, calls: card });
          group = null;
        } else if (part.state === 'awaiting-approval') {
          items.push({ k: 'approval', key: part.id, call: part });
          group = null;
        } else if (part.name !== RENDER_UI_TOOL || part.state === 'error') {
          if (!group) {
            group = [];
            items.push({ k: 'tools', key: part.id, calls: group });
          }
          group.push(part);
        }
        break;
      }
      case 'ui':
        items.push({ k: 'ui', key: part.id, part });
        break;
      case 'error':
        items.push({ k: 'error', key: `e${i}`, part });
        break;
    }
  });
  return items;
}

/** "Thinking…" while the reply has nothing visible yet, or between steps. */
export function ThinkingLine({ label = 'Thinking…' }: { label?: string }) {
  return (
    <div role="status" data-slot="assistant-thinking" className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex gap-0.5" aria-hidden>
        <span className="size-1 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms] motion-reduce:animate-none" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms] motion-reduce:animate-none" />
      </span>
      <span className="shimmer font-medium motion-reduce:shimmer-none">{label}</span>
    </div>
  );
}

/** The assistant's avatar: the sparkle in a tinted disc. */
export function AssistantAvatar() {
  return (
    <MessageAvatar className="size-6 min-w-6 self-start bg-primary text-primary-foreground group-has-data-[slot=message-footer]/message:translate-y-0">
      <SparklesIcon className="size-3.5" aria-hidden />
    </MessageAvatar>
  );
}

export interface AssistantMessageProps {
  message: ChatMessage;
  /** the newest reply: its footer stays visible and offers Regenerate */
  isLast: boolean;
  /** a turn is running (hides Regenerate and Retry) */
  busy: boolean;
  showReasoning: boolean;
  /** a summary of the conversation is being written before the reply's next step */
  compacting?: boolean;
}

/** One reply: reasoning, text, tool activity, approvals, generated interfaces and errors, then its footer. */
export const AssistantMessage = memo(function AssistantMessage({ message, isLast, busy, showReasoning, compacting = false }: AssistantMessageProps) {
  const { controller } = usePanel();
  const streaming = message.status === 'streaming';
  // every call that has asked for approval in this reply: a step's calls share one card while they run
  const asked = useRef(new Set<string>()).current;
  for (const p of message.parts) if (p.type === 'tool-call' && p.state === 'awaiting-approval') asked.add(p.id);
  const items = toItems(message, showReasoning, asked);
  const lastPart = message.parts[message.parts.length - 1];
  const between =
    streaming &&
    (items.length === 0 ||
      (lastPart?.type === 'tool-call' && (lastPart.state === 'done' || lastPart.state === 'error' || lastPart.state === 'denied')) ||
      (lastPart?.type === 'reasoning' && !showReasoning) ||
      lastPart?.type === 'ui');
  const text = messageText(message);
  const usage = formatUsage(message.usage);
  const caption = [message.model, usage, message.status === 'stopped' ? 'Stopped' : ''].filter(Boolean).join(' · ');

  return (
    <Message data-slot="assistant-reply" data-status={message.status}>
      <AssistantAvatar />
      <MessageContent className="gap-2">
        {items.map((item) => {
          switch (item.k) {
            case 'reasoning':
              return <Reasoning key={item.key} part={item.part} live={item.live} />;
            case 'text':
              return (
                <Bubble key={item.key} variant="ghost">
                  <BubbleContent className="w-full">
                    <Markdown text={item.part.text} streaming={item.live} onLink={controller.host.onLink} />
                  </BubbleContent>
                </Bubble>
              );
            case 'tools':
              return <ToolGroup key={item.key} calls={item.calls} />;
            case 'approval':
              return <ApprovalCard key={item.key} call={item.call} />;
            case 'approvals':
              return <ApprovalGroup key={item.key} calls={item.calls} />;
            case 'ui':
              return <UISurface key={item.key} part={item.part} streaming={streaming} />;
            case 'error':
              return <ErrorNotice key={item.key} part={item.part} canRetry={isLast && !busy} />;
          }
        })}
        {streaming && compacting ? <CompactingLine /> : between && <ThinkingLine label={items.length === 0 ? 'Thinking…' : 'Working…'} />}
        {!streaming && (text || caption) && (
          <MessageFooter
            className={cn('-mt-1 min-h-6 gap-0.5 font-normal transition-opacity motion-reduce:transition-none', !isLast && 'opacity-0 group-hover/message:opacity-100 focus-within:opacity-100')}
          >
            {text && (
              <TooltipTrigger>
                <CopyButton value={text} size="icon-xs" aria-label="Copy reply" />
                <Tooltip>Copy reply</Tooltip>
              </TooltipTrigger>
            )}
            {isLast && !busy && !message.parts.some((p) => p.type === 'error') && (
              <TooltipTrigger>
                <Button variant="ghost" size="icon-xs" aria-label="Regenerate reply" onPress={() => controller.regenerate()}>
                  <RotateCcwIcon />
                </Button>
                <Tooltip>Regenerate reply</Tooltip>
              </TooltipTrigger>
            )}
            {caption && <span className="ms-1.5 min-w-0 truncate text-[0.6875rem] text-muted-foreground tabular-nums">{caption}</span>}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
});
