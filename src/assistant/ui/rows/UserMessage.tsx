import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileTextIcon, MousePointerClickIcon, PencilIcon } from 'lucide-react';
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@tecton/react/components/attachment';
import { Badge } from '@tecton/react/components/badge';
import { Bubble, BubbleContent } from '@tecton/react/components/bubble';
import { Button } from '@tecton/react/components/button';
import { Message, MessageContent, MessageFooter } from '@tecton/react/components/message';
import { Textarea } from '@tecton/react/components/textarea';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { CopyButton } from '@tecton/react/tecton/copy-button';
import type { ChatMessage, ContextItem, FilePart, ImagePart } from '../../core/types';
import { usePanel } from '../context';
import { formatBytes } from '../format';

function ContextChips({ items, renderIcon }: { items: ContextItem[]; renderIcon?: (name: string) => ReactNode }) {
  return (
    <div data-slot="assistant-message-context" className="flex max-w-[90%] flex-wrap justify-end gap-1">
      {items.map((item) => (
        <Badge key={item.id} variant="outline" title={item.description ?? item.label} className="max-w-full">
          {item.icon && renderIcon ? <span data-icon="inline-start" className="contents [&>svg]:size-3">{renderIcon(item.icon)}</span> : null}
          <span className="truncate">{item.label}</span>
        </Badge>
      ))}
    </div>
  );
}

function Attachments({ images, files }: { images: ImagePart[]; files: FilePart[] }) {
  return (
    <div data-slot="assistant-message-attachments" className="flex max-w-[90%] flex-wrap items-end justify-end gap-1.5">
      {images.map((img, i) => (
        <img
          key={`i${i}`}
          src={`data:${img.mediaType};base64,${img.data}`}
          alt={img.name ? `Attached image: ${img.name}` : 'Attached image'}
          className="h-16 max-w-32 rounded-lg border border-border-subtle object-cover"
        />
      ))}
      {files.map((file, i) => (
        <Attachment key={`f${i}`} size="xs" className="min-w-0">
          <AttachmentMedia>
            <FileTextIcon />
          </AttachmentMedia>
          <AttachmentContent className="pe-1">
            <AttachmentTitle className="max-w-40">{file.name}</AttachmentTitle>
            <AttachmentDescription>
              {(file.name.split('.').pop() ?? 'text').toUpperCase()} · {formatBytes(file.text.length)}
              {file.truncated ? ' · truncated' : ''}
            </AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ))}
    </div>
  );
}

function EditBox({ initial, onCancel, onSave }: { initial: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => value.trim() && onSave(value.trim());
  return (
    <div data-slot="assistant-edit" className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-2">
      <Textarea
        ref={ref}
        aria-label="Edit message"
        variant="text"
        value={value}
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="me-auto ps-1 text-xs text-muted-foreground">Later messages will be replaced.</span>
        <Button size="xs" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button size="xs" isDisabled={!value.trim()} onPress={save}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** A person's message: context chips, attachments, the text bubble, and copy / edit on hover. */
export const UserMessage = memo(function UserMessage({ message, canEdit }: { message: ChatMessage; canEdit: boolean }) {
  const { controller } = usePanel();
  const [editing, setEditing] = useState(false);
  const context = message.parts.flatMap((p) => (p.type === 'context' ? p.items : []));
  const images = message.parts.filter((p): p is ImagePart => p.type === 'image');
  const files = message.parts.filter((p): p is FilePart => p.type === 'file');
  const text = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  const events = message.parts.filter((p) => p.type === 'ui-event');

  return (
    <Message align="end" data-slot="assistant-user-message">
      <MessageContent className="gap-1.5">
        {context.length > 0 && <ContextChips items={context} renderIcon={controller.host.renderIcon} />}
        {(images.length > 0 || files.length > 0) && <Attachments images={images} files={files} />}
        {events.map((event, i) =>
          event.type === 'ui-event' ? (
            <p key={i} data-slot="assistant-ui-event" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MousePointerClickIcon className="size-3.5" aria-hidden />
              You pressed “{event.label ?? event.name}”
            </p>
          ) : null,
        )}
        {text &&
          (editing ? (
            <EditBox
              initial={text}
              onCancel={() => setEditing(false)}
              onSave={(next) => {
                setEditing(false);
                controller.editAndResend(message.id, next);
              }}
            />
          ) : (
            <Bubble variant="secondary" align="end">
              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
            </Bubble>
          ))}
        {text && !editing && (
          <MessageFooter className="-mt-1 gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
            <TooltipTrigger>
              <CopyButton value={text} size="icon-xs" aria-label="Copy message" />
              <Tooltip>Copy message</Tooltip>
            </TooltipTrigger>
            {canEdit && (
              <TooltipTrigger>
                <Button variant="ghost" size="icon-xs" aria-label="Edit message" onPress={() => setEditing(true)}>
                  <PencilIcon />
                </Button>
                <Tooltip>Edit message</Tooltip>
              </TooltipTrigger>
            )}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
});
