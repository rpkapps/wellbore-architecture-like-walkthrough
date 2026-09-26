import { cn } from 'cn';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
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

  return (
    <MessageScrollerProvider key={threadId} autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
      <MessageScroller data-slot="assistant-transcript" className={cn('flex-1', className)}>
        <MessageScrollerViewport className="px-3 pt-3 pb-6" aria-label="Conversation">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2" aria-busy={busy}>
            {messages.flatMap((message, i) => [
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
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
              ...(dividers.get(i) ?? []).map((c) => (
                <MessageScrollerItem key={`compaction:${c.id}`} messageId={`compaction:${c.id}`}>
                  <CompactionDivider compaction={c} />
                </MessageScrollerItem>
              )),
            ])}
            {(pending || (compacting && !compactingInReply)) && (
              <MessageScrollerItem messageId="assistant-pending" className="[content-visibility:visible]">
                <Message>
                  <AssistantAvatar />
                  <MessageContent>{compacting ? <CompactingLine /> : <ThinkingLine />}</MessageContent>
                </Message>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
