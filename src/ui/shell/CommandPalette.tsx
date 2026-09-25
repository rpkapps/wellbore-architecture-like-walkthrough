import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@tecton/react/components/command';
import { Input } from '@tecton/react/components/input';
import { Kbd } from '@tecton/react/components/kbd';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CornerDownLeftIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ActionCategory, ActionChoice, ActionInput, AnyAction } from '../../actions/registry';
import type { App } from '../app';
import { useSignal } from '../signal';

const ORDER: ActionCategory[] = ['Navigate', 'View', 'Scene', 'Panels', 'Workspace', 'Features', 'Interpretation', 'Data', 'Preferences', 'Help'];
const RECENT_KEY = 'bw.palette.recent';
const MAX_RECENT = 5;

type Entry = { key: string; action: AnyAction<App>; choice?: ActionChoice<ActionInput> };

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The command palette (⌘K / Ctrl+K): every action of the app by name. An
 * action with choices opens them as a second page (or, while typing, its
 * choices match directly: "hydro" finds Colour by → Hydrocarbons); an action
 * that needs a value asks for it. Everything runs through `app.actions`, the
 * same registry an assistant will call.
 */
export function CommandPalette({ app }: { app: App }) {
  const open = useSignal(app.paletteOpen);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<AnyAction<App> | null>(null);
  const [prompt, setPrompt] = useState<AnyAction<App> | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  // ⌘K / Ctrl+K from anywhere, even inside a field
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        app.paletteOpen.set(!app.paletteOpen.value);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [app]);

  // every opening starts at the top level
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPage(null);
    setPrompt(null);
  }, [open]);

  const close = () => app.paletteOpen.set(false);
  const run = async (a: AnyAction<App>, input?: ActionInput, key = a.id) => {
    close();
    const r = await app.actions.run(a.id, input);
    if (!r.ok) app.toast(r.error, 'error');
    const next = [key, ...recent.filter((k) => k !== key)].slice(0, MAX_RECENT);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked */
    }
  };
  const pick = (e: Entry) => {
    if (e.choice) return void run(e.action, e.choice.input, e.key);
    if (e.action.choices) {
      setPage(e.action);
      setQuery('');
    } else if (e.action.prompt) {
      setPrompt(e.action);
      setQuery('');
    } else void run(e.action);
  };

  const actions = useMemo(() => (open ? app.actions.list().filter((a) => !a.hidden && app.actions.enabled(a)) : []), [app, open]);
  const choicesOf = (a: AnyAction<App>): Entry[] => {
    try {
      return (a.choices?.(app) ?? []).map((c, i) => ({ key: `${a.id}#${JSON.stringify(c.input) ?? i}`, action: a, choice: c }));
    } catch {
      return [];
    }
  };

  // the entries of this page: the actions, or one action's choices; typing at the top level also finds choices
  const q = query.trim();
  let groups: { heading: string; entries: Entry[] }[];
  if (page) groups = [{ heading: page.title, entries: choicesOf(page) }];
  else {
    const top: Entry[] = actions.map((a) => ({ key: a.id, action: a }));
    const flat = q ? actions.flatMap(choicesOf) : [];
    const all = [...top, ...flat];
    const byKey = new Map(all.map((e) => [e.key, e]));
    const recents = q ? [] : recent.map((k) => byKey.get(k) ?? (k.includes('#') ? findChoice(k) : undefined)).filter((e): e is Entry => !!e);
    groups = [
      ...(recents.length ? [{ heading: 'Recent', entries: recents.map((e) => ({ ...e, key: `recent:${e.key}` })) }] : []),
      ...ORDER.map((c) => ({ heading: c, entries: all.filter((e) => e.action.category === c) })).filter((g) => g.entries.length),
    ];
  }
  function findChoice(k: string): Entry | undefined {
    const a = actions.find((x) => x.id === k.split('#')[0]);
    return a ? choicesOf(a).find((e) => e.key === k) : undefined;
  }

  return (
    <CommandDialog open={open} onOpenChange={(o) => app.paletteOpen.set(o)} title="Command palette" description="Find and run any command" className="sm:max-w-xl">
      {prompt?.prompt ? (
        <PromptPage action={prompt} onBack={() => setPrompt(null)} onRun={(input) => run(prompt, input)} app={app} />
      ) : (
        <Command inputValue={query} onInputChange={setQuery}>
          <div className="flex items-center gap-1 pr-1">
            {page && (
              <button
                type="button"
                onClick={() => (setPage(null), setQuery(''))}
                className="ml-1 flex h-6 shrink-0 items-center gap-0.5 rounded-md bg-ui-accent/15 pr-2 pl-1 text-xs font-medium text-fg-1 hover:bg-ui-accent/25"
              >
                <ChevronLeftIcon className="size-3.5" />
                {page.title}
              </button>
            )}
            <div className="min-w-0 flex-1">
              <CommandInput
                placeholder={page ? `Choose ${page.title.toLowerCase()}…` : 'Type a command, a well, a formation…'}
                onKeyDown={(e) => {
                  // Backspace on an empty field goes back up
                  if (e.key === 'Backspace' && !query && page) setPage(null);
                }}
              />
            </div>
          </div>
          <CommandList className="max-h-[min(60vh,28rem)]" renderEmptyState={() => <CommandEmpty>No command matches “{query}”.</CommandEmpty>}>
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.entries.map((e) => (
                  <CommandItem key={e.key} id={e.key} textValue={textOf(e)} onAction={() => pick(e)}>
                    <Row entry={e} inPage={!!page} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <Footer />
        </Command>
      )}
    </CommandDialog>
  );
}

function textOf(e: Entry) {
  const words = [e.action.title, ...(e.action.keywords ?? []), e.action.category];
  if (e.choice) words.unshift(e.choice.label, ...(e.choice.keywords ?? []));
  return words.join(' ');
}

function Row({ entry: e, inPage }: { entry: Entry; inPage: boolean }) {
  const a = e.action;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.93rem] text-fg-1">
          {e.choice && !inPage ? (
            <>
              <span className="text-fg-2">{a.title}</span>
              <ChevronRightIcon className="mx-0.5 inline size-3 text-fg-3" />
              {e.choice.label}
            </>
          ) : (
            (e.choice?.label ?? a.title)
          )}
        </span>
        {!e.choice && <span className="type-caption truncate">{a.description}</span>}
      </span>
      {e.choice?.current && <CheckIcon aria-label="current" className="size-3.5 shrink-0 text-ui-accent" />}
      {!e.choice && (a.choices || a.prompt) && <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-fg-3" />}
      {a.shortcut && !e.choice && <CommandShortcut>{a.shortcut}</CommandShortcut>}
    </span>
  );
}

function Footer() {
  return (
    <div className="type-caption flex items-center gap-3 border-t border-border-subtle px-3 py-1.5">
      <span className="flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>
          <CornerDownLeftIcon className="size-3" />
        </Kbd>
        run
      </span>
      <span className="flex items-center gap-1">
        <Kbd>⌫</Kbd> back
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Kbd>Esc</Kbd> close
      </span>
    </div>
  );
}

/** An action that needs a value: one field, Enter runs it. */
function PromptPage({ action, onBack, onRun, app }: { action: AnyAction<App>; onBack: () => void; onRun: (input: ActionInput) => void; app: App }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const p = action.prompt!;
  const submit = () => {
    const input = p.parse(text, app);
    if (!input) return setErr(`That is not a valid ${p.label.toLowerCase()}.`);
    const check = action.input?.safeParse(input);
    if (check && !check.success) return setErr(check.error.issues[0]?.message ?? 'Invalid value.');
    onRun(input);
  };
  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="flex h-6 items-center gap-0.5 rounded-md bg-ui-accent/15 pr-2 pl-1 text-xs font-medium text-fg-1 hover:bg-ui-accent/25">
          <ChevronLeftIcon className="size-3.5" />
          {action.title}
        </button>
        <span className="type-caption">{action.description}</span>
      </div>
      <Input
        autoFocus
        aria-label={p.label}
        placeholder={p.placeholder}
        value={text}
        onChange={(e) => (setText(e.target.value), setErr(null))}
        onKeyDown={(e) => e.key === 'Backspace' && !text && onBack()}
        aria-invalid={!!err || undefined}
      />
      <span className={`type-caption ${err ? 'text-destructive!' : ''}`}>{err ?? `${p.label} · Enter to run`}</span>
    </form>
  );
}
