import { useMemo, useState } from 'react';
import { cn } from 'cn';
import {
  ChevronDownIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@tecton/react/components/dropdown-menu';
import { Input } from '@tecton/react/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@tecton/react/components/input-group';
import { Popover, PopoverTrigger } from '@tecton/react/components/popover';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { PanelActions, PanelHeader } from '@tecton/react/tecton/panel';
import type { AssistantSnapshot } from '../core/types';
import { usePanel } from './context';
import { relativeTime } from './format';
import { shallowEqual, useAssistantSelector } from './useAssistant';

type ThreadMeta = AssistantSnapshot['threads'][number];

function ThreadRow({ thread, current, onOpen }: { thread: ThreadMeta; current: boolean; onOpen: () => void }) {
  const { controller } = usePanel();
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [draft, setDraft] = useState(thread.title);

  if (mode === 'rename')
    return (
      <li className="px-1 py-0.5">
        <Input
          autoFocus
          aria-label="Chat title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setMode('view')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (draft.trim()) controller.renameThread(thread.id, draft.trim());
              setMode('view');
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(thread.title);
              setMode('view');
            }
          }}
        />
      </li>
    );

  if (mode === 'delete')
    return (
      <li className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate">Delete “{thread.title}”?</span>
        <Button size="xs" variant="destructive" autoFocus onPress={() => controller.deleteThread(thread.id)}>
          Delete
        </Button>
        <Button size="xs" variant="ghost" onPress={() => setMode('view')}>
          Cancel
        </Button>
      </li>
    );

  return (
    <li className="group/thread relative flex items-center rounded-md hover:bg-accent has-[button:focus-visible]:bg-accent">
      <button
        type="button"
        aria-current={current || undefined}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageSquareIcon className={cn('size-3.5 shrink-0', current ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate text-sm', current && 'font-medium')}>{thread.title || 'Untitled chat'}</span>
        <span className="shrink-0 text-xs text-muted-foreground group-hover/thread:invisible group-has-[:focus-visible]/thread:invisible">{relativeTime(thread.updatedAt)}</span>
      </button>
      <span className="absolute end-1 flex opacity-0 group-hover/thread:opacity-100 group-has-[:focus-visible]/thread:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Rename “${thread.title}”`}
          onPress={() => {
            setDraft(thread.title);
            setMode('rename');
          }}
        >
          <PencilIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Delete “${thread.title}”`} onPress={() => setMode('delete')}>
          <Trash2Icon />
        </Button>
      </span>
    </li>
  );
}

/** The current chat's title; opens the list of recent chats (search when there are many, rename, delete). */
function ThreadSwitcher({ fallbackTitle }: { fallbackTitle: string }) {
  const { controller } = usePanel();
  const threads = useAssistantSelector(controller, (s) => s.threads, shallowEqual);
  const current = useAssistantSelector(controller, (s) => s.thread.id);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const currentMeta = threads.find((t) => t.id === current);
  const title = currentMeta && currentMeta.title && currentMeta.title !== 'New chat' ? currentMeta.title : fallbackTitle;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  }, [threads, query]);

  return (
    <PopoverTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Button variant="ghost" size="sm" className="min-w-0 flex-initial" aria-label={`Chat: ${title}. Recent chats`}>
        <span className="min-w-0 truncate font-medium">{title}</span>
        <ChevronDownIcon data-icon="inline-end" className="text-muted-foreground" />
      </Button>
      <Popover placement="bottom start" className="w-80 max-w-[calc(100vw-1.5rem)] gap-2 p-2" aria-label="Recent chats">
        <div className="flex items-center justify-between px-2 pt-1">
          <span className="text-xs font-medium text-muted-foreground">Recent chats</span>
          <Button
            size="xs"
            variant="ghost"
            onPress={() => {
              controller.newThread();
              setOpen(false);
            }}
          >
            <SquarePenIcon data-icon="inline-start" />
            New chat
          </Button>
        </div>
        {threads.length > 8 && (
          <InputGroup className="mx-0.5 w-auto">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput autoFocus aria-label="Search chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
          </InputGroup>
        )}
        <ul className="flex max-h-80 flex-col gap-px overflow-y-auto" aria-label="Chats">
          {shown.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              current={t.id === current}
              onOpen={() => {
                controller.openThread(t.id);
                setOpen(false);
              }}
            />
          ))}
          {shown.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted-foreground">No chats match “{query}”.</li>}
        </ul>
      </Popover>
    </PopoverTrigger>
  );
}

/** The connection in use, grouped by provider, and "Manage providers…". */
function ModelPicker({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { controller, openSettings } = usePanel();
  const providers = useAssistantSelector(controller, (s) => s.settings.providers);
  const activeId = useAssistantSelector(controller, (s) => s.settings.activeProviderId);
  const active = providers.find((p) => p.id === activeId) ?? null;
  const groups = useMemo(() => {
    const map = new Map<string, typeof providers>();
    for (const p of providers) {
      const key = p.label || p.presetId;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [providers]);

  if (!active)
    return (
      <Button variant="outline" size="xs" onPress={() => openSettings({ section: 'connection' })}>
        <PlugIcon data-icon="inline-start" />
        Connect
      </Button>
    );

  return (
    <DropdownMenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <TooltipTrigger>
        <Button variant="ghost" size="xs" className="max-w-24 min-w-0 text-muted-foreground @sm:max-w-40" aria-label={`Model: ${active.model}. Change model`}>
          <span className="min-w-0 truncate">{active.model}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
        <Tooltip>{`${active.label} · ${active.model}`}</Tooltip>
      </TooltipTrigger>
      <DropdownMenu
        placement="bottom end"
        className="w-64"
        selectionMode="single"
        selectedKeys={activeId ? [activeId] : []}
        onAction={(key) => {
          if (key === '__manage') openSettings({ section: 'connection', providerId: activeId ?? undefined });
          else controller.updateSettings({ activeProviderId: String(key) });
        }}
      >
        {groups.map(([label, list]) => (
          <DropdownMenuGroup key={label}>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {list.map((p) => (
              <DropdownMenuItem key={p.id} id={p.id} textValue={`${p.label} ${p.model}`}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{p.model}</span>
                  {(p.vision || p.tools === false) && (
                    <span className="text-xs text-muted-foreground">{[p.vision && 'vision', p.tools === false && 'no tools'].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuGroup selectionMode="none">
          <DropdownMenuItem id="__manage" textValue="Manage providers">
            <SettingsIcon />
            Manage providers…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

export interface HeaderProps {
  title: string;
  onClose?: () => void;
  modelMenuOpen: boolean;
  onModelMenuOpenChange: (open: boolean) => void;
  onExport: () => void;
  onCopyTranscript: () => void;
  onDeleteChat: () => void;
}

/** The panel's header: chat switcher, model picker, new chat, more, close. */
export function Header({ title, onClose, modelMenuOpen, onModelMenuOpenChange, onExport, onCopyTranscript, onDeleteChat }: HeaderProps) {
  const { controller, openSettings } = usePanel();
  const empty = useAssistantSelector(controller, (s) => s.thread.messages.length === 0);
  return (
    <PanelHeader data-slot="assistant-header" className="flex-nowrap items-center gap-1 ps-2 pe-3 py-2">
      <span className="ms-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden>
        <SparklesIcon className="size-3.5" />
      </span>
      <ThreadSwitcher fallbackTitle={title} />
      <PanelActions className="-me-1 gap-0.5">
        <ModelPicker isOpen={modelMenuOpen} onOpenChange={onModelMenuOpenChange} />
        <TooltipTrigger>
          <Button variant="ghost" size="icon-sm" aria-label="New chat" isDisabled={empty} onPress={() => controller.newThread()}>
            <SquarePenIcon />
          </Button>
          <Tooltip>New chat</Tooltip>
        </TooltipTrigger>
        <DropdownMenuTrigger>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" aria-label="More options">
              <EllipsisIcon />
            </Button>
            <Tooltip>More options</Tooltip>
          </TooltipTrigger>
          <DropdownMenu placement="bottom end" className="w-56">
            <DropdownMenuItem onAction={onExport} isDisabled={empty}>
              <DownloadIcon />
              Export as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onAction={onCopyTranscript} isDisabled={empty}>
              <ClipboardCopyIcon />
              Copy transcript
            </DropdownMenuItem>
            <DropdownMenuItem onAction={() => openSettings()}>
              <SettingsIcon />
              Settings
              <DropdownMenuShortcut>/settings</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onAction={onDeleteChat} isDisabled={empty}>
              <Trash2Icon />
              Delete chat
            </DropdownMenuItem>
          </DropdownMenu>
        </DropdownMenuTrigger>
        {onClose && (
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" aria-label="Close assistant" onPress={onClose}>
              <XIcon />
            </Button>
            <Tooltip>Close assistant</Tooltip>
          </TooltipTrigger>
        )}
      </PanelActions>
    </PanelHeader>
  );
}

