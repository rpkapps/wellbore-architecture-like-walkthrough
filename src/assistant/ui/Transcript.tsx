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
import { usePanel } from './context';
import { AssistantAvatar, AssistantMessage, ThinkingLine } from './rows/AssistantMessage';
import { UserMessage } from './rows/UserMessage';
import { useAssistantSelector } from './useAssistant';

/** Rows this close to the end always render; older ones skip layout and paint while off screen. */
const LIVE_ROWS = 4;

/**
 * The conversation. It subscribes to the message list, the status and the
 * reasoning setting only: a stream frame replaces the streaming message (and
 * the list), so every other row keeps its props and skips rendering.
 */
export function Transcript({ className }: { className?: string }) {
  const { controller } = usePanel();
  const threadId = useAssistantSelector(controller, (s) => s.thread.id);
  const messages = useAssistantSelector(controller, (s) => s.thread.messages);
  const status = useAssistantSelector(controller, (s) => s.status);
  const showReasoning = useAssistantSelector(controller, (s) => s.settings.showReasoning);
  const busy = status === 'submitted' || status === 'streaming';

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  // the turn was sent but the controller has not added the reply yet
  const pending = busy && messages[messages.length - 1]?.role === 'user';

  return (
    <MessageScrollerProvider key={threadId} autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={48}>
      <MessageScroller data-slot="assistant-transcript" className={cn('flex-1', className)}>
        <MessageScrollerViewport className="px-3 pt-3 pb-6" aria-label="Conversation">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2" aria-busy={busy}>
            {messages.map((message, i) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
                className={i >= messages.length - LIVE_ROWS ? '[content-visibility:visible]' : '[contain-intrinsic-size:auto_200px]'}
              >
                {message.role === 'user' ? (
                  <UserMessage message={message} canEdit={!busy} />
                ) : (
                  <AssistantMessage message={message} isLast={i === lastAssistant && i === messages.length - 1} busy={i === lastAssistant && busy} showReasoning={showReasoning} />
                )}
              </MessageScrollerItem>
            ))}
            {pending && (
              <MessageScrollerItem messageId="assistant-pending" className="[content-visibility:visible]">
                <Message>
                  <AssistantAvatar />
                  <MessageContent>
                    <ThinkingLine />
                  </MessageContent>
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
