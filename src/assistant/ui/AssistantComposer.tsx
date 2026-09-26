import { cloneElement, isValidElement, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { CameraIcon, EyeIcon, FileTextIcon, ImageIcon, PaperclipIcon, ShieldCheckIcon, TriangleAlertIcon, XIcon, ZapIcon } from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, DropdownMenuGroup } from '@tecton/react/components/dropdown-menu';
import { InputGroupButton } from '@tecton/react/components/input-group';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import {
  Composer,
  ComposerAttachments,
  ComposerCommands,
  ComposerField,
  ComposerHint,
  ComposerInput,
  ComposerStatusMessage,
  ComposerSubmit,
  ComposerToolbar,
  type ComposerAttachmentItem,
  type ComposerCommandItem,
} from '@tecton/react/tecton/composer';
import type { AutonomyMode, ContextItem, FilePart, ImagePart } from '../core/types';
import { usePanel } from './context';
import { readAttachment, TEXT_FILE_EXTENSIONS } from './format';
import { shallowEqual, useAssistantSelector } from './useAssistant';

/** The autonomy modes, for the composer's picker and the settings. */
export const AUTONOMY: { id: AutonomyMode; label: string; short: string; description: string; icon: typeof EyeIcon }[] = [
  { id: 'read', label: 'Read only', short: 'Read', description: 'Looks and answers; never changes the app.', icon: EyeIcon },
  { id: 'ask', label: 'Ask first', short: 'Ask', description: 'Asks before every change to the app.', icon: ShieldCheckIcon },
  { id: 'auto', label: 'Auto', short: 'Auto', description: 'Acts on its own; still asks before deleting data.', icon: ZapIcon },
];

/** What the panel can do to the composer from outside (drop, paste, the empty state's cards). */
export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  /** sends `text` with the current context and attachments, as if typed */
  sendText: (text: string) => void;
  focus: () => void;
}

function withIconSlot(node: ReactNode): ReactNode {
  return isValidElement<Record<string, unknown>>(node) ? cloneElement(node, { 'data-icon': 'inline-start' }) : node;
}

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', ...TEXT_FILE_EXTENSIONS.map((e) => `.${e}`)].join(',');

/** The host's context items, re-read when it says they changed. */
function useHostContext(): ContextItem[] {
  const { controller } = usePanel();
  const { host } = controller;
  const [items, setItems] = useState<ContextItem[]>(() => host.context?.() ?? []);
  useEffect(() => {
    setItems(host.context?.() ?? []);
    return host.subscribeContext?.(() => setItems(host.context?.() ?? []));
  }, [host]);
  return items;
}

export interface AssistantComposerProps {
  commands: ComposerCommandItem[];
  onCommand: (id: string) => void;
  handle?: Ref<ComposerHandle>;
}

/**
 * The message box: context chips from the host, attached images and files,
 * slash commands, attach / capture / autonomy in the toolbar, send or stop.
 * It subscribes to the status and a few settings only, never to the stream.
 */
export function AssistantComposer({ commands, onCommand, handle }: AssistantComposerProps) {
  const { controller, focusComposer } = usePanel();
  const { host } = controller;
  const status = useAssistantSelector(controller, (s) => s.status);
  const history = useAssistantSelector(
    controller,
    (s) => s.thread.messages.flatMap((m) => (m.role === 'user' ? m.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])) : [])),
    shallowEqual,
  );
  const provider = useAssistantSelector(controller, (s) => s.provider);
  const autonomy = useAssistantSelector(controller, (s) => s.settings.autonomy);
  const threadId = useAssistantSelector(controller, (s) => s.thread.id);

  const context = useHostContext();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [images, setImages] = useState<ImagePart[]>([]);
  const [files, setFiles] = useState<FilePart[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // a removed chip stays removed while its id is current; once the host drops it, it may come back
  useEffect(() => {
    setDismissed((current) => {
      const ids = new Set(context.map((c) => c.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [context]);

  // a new thread starts with a clean box
  useEffect(() => {
    setImages([]);
    setFiles([]);
    setNotice(null);
  }, [threadId]);

  const activeContext = useMemo(() => context.filter((c) => !dismissed.has(c.id)), [context, dismissed]);

  const addFiles = useCallback(
    async (list: File[]) => {
      const results = await Promise.all(list.map(readAttachment));
      const rejected = results.flatMap((r) => (r.kind === 'rejected' ? [r.reason] : []));
      const imgs = results.flatMap((r) => (r.kind === 'image' ? [r.part] : []));
      const txt = results.flatMap((r) => (r.kind === 'file' ? [r.part] : []));
      if (imgs.length) setImages((cur) => [...cur, ...imgs]);
      if (txt.length) setFiles((cur) => [...cur, ...txt]);
      const truncated = txt.filter((f) => f.truncated).map((f) => f.name);
      const messages = [
        ...rejected,
        ...(imgs.length && provider && provider.vision === false ? [`${provider.model} may not read images: switch to a vision model or it will only see the file names.`] : []),
        ...(truncated.length ? [`${truncated.join(', ')}: only the first 200 KB will be sent.`] : []),
      ];
      setNotice(messages.length ? messages.join(' ') : null);
      focusComposer();
    },
    [provider, focusComposer],
  );

  const send = useCallback(
    (text: string) => {
      controller.send({
        text,
        ...(activeContext.length ? { context: activeContext } : {}),
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
      });
      setImages([]);
      setFiles([]);
      setNotice(null);
    },
    [controller, activeContext, images, files],
  );

  useImperativeHandle(
    handle,
    () => ({
      addFiles: (list) => void addFiles(list),
      sendText: send,
      focus: () => formRef.current?.querySelector('textarea')?.focus(),
    }),
    [addFiles, send],
  );

  const capture = async () => {
    if (!host.captureView) return;
    setCapturing(true);
    try {
      const shot = await host.captureView();
      if (shot) {
        setImages((cur) => [...cur, { type: 'image', mediaType: shot.mediaType, data: shot.data, name: 'view.png' }]);
        if (provider?.vision === false) setNotice(`${provider.model} may not read images: switch to a vision model to use the capture.`);
      } else setNotice('The view could not be captured.');
    } catch {
      setNotice('The view could not be captured.');
    } finally {
      setCapturing(false);
      focusComposer();
    }
  };

  const attachmentItems: ComposerAttachmentItem[] = [
    ...activeContext.map((c) => ({
      id: `ctx:${c.id}`,
      label: c.label,
      ...(c.icon && host.renderIcon ? { icon: withIconSlot(host.renderIcon(c.icon)) } : {}),
    })),
    ...images.map((img, i) => ({ id: `img:${i}`, label: img.name ?? `Image ${i + 1}`, icon: <ImageIcon data-icon="inline-start" /> })),
    ...files.map((f, i) => ({ id: `file:${i}`, label: f.name, ...(f.truncated ? { description: 'first 200 KB' } : {}), icon: <FileTextIcon data-icon="inline-start" /> })),
  ];

  const remove = (key: string) => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    if (kind === 'ctx') setDismissed((cur) => new Set(cur).add(id));
    else if (kind === 'img') setImages((cur) => cur.filter((_, i) => String(i) !== id));
    else if (kind === 'file') setFiles((cur) => cur.filter((_, i) => String(i) !== id));
  };

  const mode = AUTONOMY.find((m) => m.id === autonomy) ?? AUTONOMY[1];
  const ModeIcon = mode.icon;
  const noProvider = provider === null;

  return (
    <div data-slot="assistant-composer" className="contents">
      <Composer
        ref={formRef}
        status={status}
        onStop={() => controller.stop()}
        onSubmit={({ text }) => send(text)}
        history={history}
        historyLimit={50}
        isDisabled={noProvider}
        className="w-full"
      >
        {notice && (
          <div role="status" className="flex items-start gap-2 rounded-md bg-warning-surface px-2.5 py-1.5 text-xs text-warning-surface-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">{notice}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="-my-1" onPress={() => setNotice(null)}>
              <XIcon />
            </Button>
          </div>
        )}
        <ComposerField>
          <ComposerCommands items={commands} onCommand={(item) => onCommand(item.id)} countMessage={(n) => `${n} command${n === 1 ? '' : 's'}`} />
          <ComposerAttachments items={attachmentItems} onRemove={(key) => remove(String(key))} aria-label="Context and attachments" />
          <ComposerInput placeholder={noProvider ? 'Connect a model to start…' : `Ask ${host.appName} anything…`} rows={1} />
          <ComposerToolbar aria-label="Message tools">
            <TooltipTrigger>
              <InputGroupButton size="icon-xs" aria-label="Attach images or files" isDisabled={noProvider} onPress={() => fileInput.current?.click()}>
                <PaperclipIcon />
              </InputGroupButton>
              <Tooltip>Attach images or files</Tooltip>
            </TooltipTrigger>
            {host.captureView && (
              <TooltipTrigger>
                <InputGroupButton size="icon-xs" aria-label="Attach a picture of the view" isDisabled={noProvider || capturing} onPress={() => void capture()}>
                  <CameraIcon />
                </InputGroupButton>
                <Tooltip>Attach a picture of the view</Tooltip>
              </TooltipTrigger>
            )}
            <DropdownMenuTrigger>
              <TooltipTrigger>
                <InputGroupButton size="xs" aria-label={`Autonomy: ${mode.label}`}>
                  <ModeIcon data-icon="inline-start" />
                  {mode.short}
                </InputGroupButton>
                <Tooltip>{`${mode.label}: ${mode.description}`}</Tooltip>
              </TooltipTrigger>
              <DropdownMenu
                placement="top start"
                className="w-64"
                selectionMode="single"
                selectedKeys={[autonomy]}
                onAction={(key) => controller.updateSettings({ autonomy: key as AutonomyMode })}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>What may the assistant do?</DropdownMenuLabel>
                  {AUTONOMY.map((m) => (
                    <DropdownMenuItem key={m.id} id={m.id} textValue={m.label}>
                      <m.icon className="mt-0.5 self-start" />
                      <span className="flex flex-col">
                        <span>{m.label}</span>
                        <span className="text-xs text-muted-foreground">{m.description}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenu>
            </DropdownMenuTrigger>
            <span className="flex-1" />
            <ComposerSubmit />
          </ComposerToolbar>
        </ComposerField>
        <ComposerHint className="truncate px-1 text-[0.6875rem]">
          Enter to send · Shift+Enter for a new line · / for commands{history.length > 0 ? ' · ↑ for earlier messages' : ''}
        </ComposerHint>
        <ComposerStatusMessage />
      </Composer>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) void addFiles(list);
        }}
      />
    </div>
  );
}
