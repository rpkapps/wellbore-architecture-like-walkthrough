import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from 'cn';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@tecton/react/components/message-scroller';
import { Message, MessageContent } from '@tecton/react/components/message';
import type { Compaction } from '../core/types';
import { usePanel } from './context';
import { CompactingLine, CompactionDivider } from './parts/Compaction';
import { AssistantAvatar, AssistantMessage, ThinkingLine } from './rows/AssistantMessage';
import { UserMessage } from './rows/UserMessage';
import { useAssistantSelector } from './useAssistant';

/** Rows this close to the end always render; older ones skip layout and paint while off screen. */
const LIVE_ROWS = 4;

const NO_COMPACTIONS: Compaction[] = [];

/**
 * The conversation. It subscribes to the message list, the status, the
 * compactions and the reasoning setting only: a stream frame replaces the
 * streaming message (and the list), so every other row keeps its props and
 * skips rendering. A divider marks where each summary took over (the
 * messages before it stay, a little muted).
 */
export function Transcript({ className }: { className?: string }) {
  const { controller } = usePanel();
  const threadId = useAssistantSelector(controller, (s) => s.thread.id);
  const messages = useAssistantSelector(controller, (s) => s.thread.messages);
  const status = useAssistantSelector(controller, (s) => s.status);
  const showReasoning = useAssistantSelector(controller, (s) => s.settings.showReasoning);
  const compactions = useAssistantSelector(controller, (s) => s.thread.compactions ?? NO_COMPACTIONS);
  const compacting = useAssistantSelector(controller, (s) => !!s.context?.compacting);
  const busy = status === 'submitted' || status === 'streaming';

  // the divider goes after the last message a summary covers; the latest boundary mutes what is above it
  const dividers = new Map<number, Compaction[]>();
  let summarisedThrough = -1;
  for (const c of compactions) {
    const at = messages.findIndex((m) => m.id === c.throughMessageId);
    if (at < 0) continue;
    dividers.set(at, [...(dividers.get(at) ?? []), c]);
    summarisedThrough = Math.max(summarisedThrough, at);
  }

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  // the turn was sent but the controller has not added the reply yet
  const pending = busy && messages[messages.length - 1]?.role === 'user';
  // a summary is being written: in the reply that is running, or on a row of its own (`/compact`)
  const compactingInReply = compacting && busy && !pending && lastAssistant === messages.length - 1;

  // one block per turn (a message of the person's and what followed it), so the last one can hold the viewport's height
  const turns: { key: string; rows: ReactNode[] }[] = [];
  messages.forEach((message, i) => {
    if (message.role === 'user' || !turns.length) turns.push({ key: message.id, rows: [] });
    const rows = turns[turns.length - 1].rows;
    rows.push(
      <MessageScrollerItem
        key={message.id}
        messageId={message.id}
        className={cn(
          i >= messages.length - LIVE_ROWS ? '[content-visibility:visible]' : '[contain-intrinsic-size:auto_200px]',
          i <= summarisedThrough && 'opacity-70 transition-opacity focus-within:opacity-100 hover:opacity-100 motion-reduce:transition-none',
        )}
      >
        {message.role === 'user' ? (
          <UserMessage message={message} canEdit={!busy} />
        ) : (
          <AssistantMessage
            message={message}
            isLast={i === lastAssistant && i === messages.length - 1}
            busy={i === lastAssistant && busy}
            showReasoning={showReasoning}
            compacting={i === lastAssistant && compactingInReply}
          />
        )}
      </MessageScrollerItem>,
    );
    for (const c of dividers.get(i) ?? [])
      rows.push(
        <MessageScrollerItem key={`compaction:${c.id}`} messageId={`compaction:${c.id}`}>
          <CompactionDivider compaction={c} />
        </MessageScrollerItem>,
      );
  });
  if (pending || (compacting && !compactingInReply)) {
    if (!turns.length) turns.push({ key: 'pending', rows: [] });
    turns[turns.length - 1].rows.push(
      <MessageScrollerItem key="assistant-pending" messageId="assistant-pending" className="[content-visibility:visible]">
        <Message>
          <AssistantAvatar />
          <MessageContent>{compacting ? <CompactingLine /> : <ThinkingLine />}</MessageContent>
        </Message>
      </MessageScrollerItem>,
    );
  }
  let lastUser: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'user') {
      lastUser = messages[i].id;
      break;
    }

  /*
   * Scrolling: the scroller follows the end while the person is there and
   * stays still once they scroll away. Nothing re-anchors a message: the
   * last turn is at least as tall as the viewport (less a peek at the turn
   * before), so a message just sent sits at the top once the view goes to
   * the end, and its reply fills the space below it without moving it.
   * Approvals, collapsing rows and status changes only change heights.
   */
  return (
    <MessageScrollerProvider key={threadId} autoScroll defaultScrollPosition="end">
      <MessageScroller data-slot="assistant-transcript" className={cn('flex-1', className)}>
        <MessageScrollerViewport className="px-3 pt-3 pb-6 [container-type:size]" aria-label="Conversation">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2" aria-busy={busy}>
            {turns.map((turn, t) => (
              <div key={turn.key} data-slot="assistant-turn" className={cn('flex flex-col gap-2', t === turns.length - 1 && t > 0 && 'min-h-[calc(100cqh-2.5rem)]')}>
                {turn.rows}
              </div>
            ))}
            <FollowSentMessage lastUserId={lastUser} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** Takes the view to the end (the new turn at the top) when the person sends a message, even from further up. */
function FollowSentMessage({ lastUserId }: { lastUserId: string | null }) {
  const { scrollToEnd } = useMessageScroller();
  const seen = useRef(lastUserId);
  useLayoutEffect(() => {
    if (lastUserId === seen.current) return;
    seen.current = lastUserId;
    if (lastUserId) scrollToEnd({ behavior: 'auto' });
  }, [lastUserId, scrollToEnd]);
  return null;
}
