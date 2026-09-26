import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { cn } from 'cn';
import { CircleHelpIcon, DownloadIcon, EyeIcon, FileUpIcon, FoldVerticalIcon, KeyRoundIcon, ShieldCheckIcon, SlidersHorizontalIcon, SquarePenIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tecton/react/components/alert-dialog';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Kbd } from '@tecton/react/components/kbd';
import { Panel, PanelFooter } from '@tecton/react/tecton/panel';
import type { ComposerCommandItem } from '@tecton/react/tecton/composer';
import type { AssistantController, AssistantTool } from '../core/types';
import { AssistantComposer, type ComposerHandle } from './AssistantComposer';
import { PanelContext, type PanelContextValue, type SettingsTarget } from './context';
import { EmptyState, Onboarding } from './EmptyState';
import { describeWith, downloadText, slugFileName, toolTitle as titleOf } from './format';
import { Header } from './Header';
import { SettingsDialog } from './settings/SettingsDialog';
import { Transcript } from './Transcript';
import { useAssistantSelector } from './useAssistant';
import './assistant.css';

const COMMANDS: ComposerCommandItem[] = [
  { id: 'new', command: 'new', label: 'Start a new chat', group: 'Chat', icon: <SquarePenIcon /> },
  { id: 'compact', command: 'compact', label: 'Summarise the conversation so far', group: 'Chat', icon: <FoldVerticalIcon /> },
  { id: 'export', command: 'export', label: 'Export the chat as Markdown', group: 'Chat', icon: <DownloadIcon /> },
  { id: 'clear', command: 'clear', label: 'Delete this chat', group: 'Chat', icon: <Trash2Icon /> },
  { id: 'model', command: 'model', label: 'Change the model', group: 'Settings', icon: <KeyRoundIcon /> },
  { id: 'mode-read', command: 'mode', label: 'Mode: read only', description: 'Never changes the app', group: 'Settings', icon: <EyeIcon /> },
  { id: 'mode-ask', command: 'mode', label: 'Mode: ask first', description: 'Asks before each change', group: 'Settings', icon: <ShieldCheckIcon /> },
  { id: 'mode-auto', command: 'mode', label: 'Mode: auto', description: 'Acts on its own', group: 'Settings', icon: <ZapIcon /> },
  { id: 'settings', command: 'settings', label: 'Open settings', group: 'Settings', icon: <SlidersHorizontalIcon /> },
  { id: 'help', command: 'help', label: 'Commands and shortcuts', group: 'Help', icon: <CircleHelpIcon /> },
];

export interface AssistantPanelProps {
  controller: AssistantController;
  /** shows a close button in the header */
  onClose?: () => void;
  className?: string;
  /** the header's title while the chat has none of its own (defaults to "<appName> Assistant") */
  title?: string;
  /**
   * Focus the message box: each new value moves focus there (with the caret
   * after its text), also when the panel mounts with a value it has not
   * taken yet. A host's "open the assistant" shortcut bumps it.
   */
  focusRequest?: number;
}

/**
 * The assistant's chat panel. It fills its container (a docked side panel
 * or a floating window, from 320 px wide): header with chats and model,
 * the transcript, and the composer. Everything it shows comes from
 * `controller`; it holds only view state (dialogs, the composer's draft).
 */
export function AssistantPanel({ controller, onClose, className, title, focusRequest }: AssistantPanelProps) {
  const heading = title ?? `${controller.host.appName} Assistant`;
  const hasMessages = useAssistantSelector(controller, (s) => s.thread.messages.length > 0);
  const hasProvider = useAssistantSelector(controller, (s) => s.provider !== null);
  const threadId = useAssistantSelector(controller, (s) => s.thread.id);

  const composer = useRef<ComposerHandle>(null);
  const [settings, setSettings] = useState<{ open: boolean; target?: SettingsTarget }>({ open: false });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

  const titles = useRef(new Map<string, string>());
  const described = useRef(new Map<string, string | null>());
  const toolsByName = useRef(new Map<string, AssistantTool | null>());
  const context = useMemo<PanelContextValue>(
    () => ({
      controller,
      openSettings: (target) => setSettings({ open: true, ...(target ? { target } : {}) }),
      toolTitle: (name) => {
        let t = titles.current.get(name);
        if (t === undefined) {
          t = titleOf(name, controller.host.tools());
          titles.current.set(name, t);
        }
        return t;
      },
      // the first description of a call is kept: the app's state changes once it ran ("Hide Log curtain" would become "Show…")
      describeCall: (call) => {
        if (call.state === 'streaming') return undefined;
        const hit = described.current.get(call.id);
        if (hit !== undefined) return hit ?? undefined;
        // the host may build its tools on each read: one read fills the map for every name
        if (!toolsByName.current.has(call.name)) {
          for (const t of controller.host.tools()) toolsByName.current.set(t.name, t);
          if (!toolsByName.current.has(call.name)) toolsByName.current.set(call.name, null);
        }
        const tool = toolsByName.current.get(call.name);
        const text = describeWith(tool, call.args);
        described.current.set(call.id, text ?? null);
        return text;
      },
      focusComposer: () => composer.current?.focus(),
    }),
    [controller],
  );

  const exportChat = useCallback(() => {
    const snap = controller.getSnapshot();
    const name = slugFileName(snap.thread.title, 'md');
    downloadText(name, controller.exportMarkdown(snap.thread.id));
    setFlash(`Saved ${name}`);
  }, [controller]);

  const copyTranscript = useCallback(() => {
    navigator.clipboard.writeText(controller.exportMarkdown()).then(
      () => setFlash('Transcript copied'),
      () => setFlash('Copy failed'),
    );
  }, [controller]);

  const onCommand = useCallback(
    (id: string) => {
      switch (id) {
        case 'new':
          controller.newThread();
          break;
        case 'compact':
          if (controller.getSnapshot().thread.messages.length > 1) controller.compact();
          else setFlash('Nothing to summarise yet');
          break;
        case 'export':
          if (controller.getSnapshot().thread.messages.length) exportChat();
          break;
        case 'clear':
          if (controller.getSnapshot().thread.messages.length) setConfirmDelete(true);
          break;
        case 'model':
          if (controller.getSnapshot().provider) setModelMenuOpen(true);
          else setSettings({ open: true, target: { section: 'connection' } });
          break;
        case 'mode-read':
        case 'mode-ask':
        case 'mode-auto':
          controller.updateSettings({ autonomy: id.slice(5) as 'read' | 'ask' | 'auto' });
          setFlash(`Mode: ${id === 'mode-read' ? 'read only' : id === 'mode-ask' ? 'ask first' : 'auto'}`);
          break;
        case 'settings':
          setSettings({ open: true, target: { section: 'general' } });
          break;
        case 'help':
          setHelpOpen(true);
          break;
      }
    },
    [controller, exportChat],
  );

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <PanelContext.Provider value={context}>
      <Panel
        data-slot="assistant-panel"
        variant="flat"
        aria-label={heading}
        className={cn('@container relative h-full min-h-0 w-full min-w-0 bg-background text-foreground', className)}
        onDragEnter={(e) => {
          if (!hasFiles(e) || !hasProvider) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e) && hasProvider) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          dragDepth.current = 0;
          setDragging(false);
          if (!hasFiles(e) || !hasProvider) return;
          e.preventDefault();
          composer.current?.addFiles(Array.from(e.dataTransfer.files));
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!files.length || !hasProvider) return;
          e.preventDefault();
          composer.current?.addFiles(files);
        }}
      >
        <Header
          title={heading}
          onClose={onClose}
          modelMenuOpen={modelMenuOpen}
          onModelMenuOpenChange={setModelMenuOpen}
          onExport={exportChat}
          onCopyTranscript={copyTranscript}
          onDeleteChat={() => setConfirmDelete(true)}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {hasMessages ? <Transcript /> : hasProvider ? <EmptyState onSend={(text) => composer.current?.sendText(text)} /> : <Onboarding />}
          <div aria-live="polite" className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            {flash && <span className="rounded-full border border-border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-md">{flash}</span>}
          </div>
        </div>
        <PanelFooter className="flex-col items-stretch gap-1.5 border-t-0 px-3 pt-0 pb-3">
          <AssistantComposer key={threadId} handle={composer} commands={COMMANDS} onCommand={onCommand} focusRequest={focusRequest} />
        </PanelFooter>
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm text-foreground">
            <FileUpIcon className="size-6 text-primary" aria-hidden />
            Drop images or text files to attach them
          </div>
        )}
      </Panel>

      <SettingsDialog isOpen={settings.open} target={settings.target} onOpenChange={(open) => setSettings((s) => ({ ...s, open }))} />

      <AlertDialog isOpen={confirmDelete} onOpenChange={setConfirmDelete} size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>The conversation and the data its tools produced are removed from this browser.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onPress={() => controller.deleteThread(controller.getSnapshot().thread.id)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      <Dialog isOpen={helpOpen} onOpenChange={setHelpOpen} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Commands and shortcuts</DialogTitle>
          <DialogDescription>Type / at the start of the message box for commands.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          {COMMANDS.filter((c, i, all) => all.findIndex((x) => x.command === c.command) === i).map((c) => (
            <div key={c.id} className="contents">
              <dt>
                <Kbd>/{c.command}</Kbd>
              </dt>
              <dd className="text-muted-foreground">{c.command === 'mode' ? 'Read only, ask first or auto' : c.label}</dd>
            </div>
          ))}
          <dt>
            <Kbd>Enter</Kbd>
          </dt>
          <dd className="text-muted-foreground">Send (Shift+Enter for a new line)</dd>
          <dt>
            <Kbd>↑</Kbd>
          </dt>
          <dd className="text-muted-foreground">Earlier messages</dd>
          <dt>
            <Kbd>Esc</Kbd>
          </dt>
          <dd className="text-muted-foreground">Stop the reply</dd>
        </dl>
      </Dialog>
    </PanelContext.Provider>
  );
}
