import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@tecton/react/components/command';
import { Input } from '@tecton/react/components/input';
import { Kbd } from '@tecton/react/components/kbd';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CornerDownLeftIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionCategory, ActionChoice, ActionInput, AnyAction } from '../../actions/registry';
import type { App } from '../app';
import { useSignal } from '../signal';
import { frequentKeys, indexFields, parseHistory, rank, recentKeys, recordRun, type RunRecord, type SearchDoc } from './paletteSearch';

const ORDER: ActionCategory[] = ['Navigate', 'View', 'Scene', 'Panels', 'Workspace', 'Features', 'Interpretation', 'Data', 'Preferences', 'Help'];
const HISTORY_KEY = 'bw.palette.recent';
/** at most this many results while typing: the best ones, not a wall */
const MAX_RESULTS = 50;
/** choices another action lists better: "Go to panel" names every panel with where it is */
const SUPERSEDED = new Set(['panels.show']);
/** the palette ranks and filters its own list, so the field's filter lets everything through */
const ALL = () => true;

/**
 * The prefixes the palette understands, listed when you type `?`. Picking one
 * types its prefix, so the list doubles as a way in.
 */
const MODES: { prefix: string; title: string; detail: string }[] = [
  { prefix: '>', title: 'Panels: where is it?', detail: 'Every panel with its place (sidebar, slot, tab, floating or hidden); Enter brings it into view' },
  { prefix: '', title: 'Commands and settings', detail: 'Plain words find commands by name, place or description: “colour”, “section box”, “porosity”' },
  { prefix: '', title: 'Wells and formations', detail: 'A well or formation name opens the well, or isolates or inspects the formation: “F-12”, “Hugin”' },
];

type Entry = {
  key: string;
  action?: AnyAction<App>;
  choice?: ActionChoice<ActionInput>;
  /** a row of the `?` list: picking it types this prefix */
  mode?: (typeof MODES)[number];
};

function loadHistory(): RunRecord[] {
  try {
    return parseHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

const docs = new WeakMap<Entry, SearchDoc>();
/** An entry's search text by tier (name, then keywords and place, then description), built once per entry. */
function docOf(e: Entry): SearchDoc {
  let d = docs.get(e);
  if (d) return d;
  const a = e.action;
  if (e.mode) d = indexFields({ primary: [e.mode.title], secondary: [e.mode.prefix], tertiary: [e.mode.detail] });
  else if (e.choice && a)
    d = indexFields({
      primary: [e.choice.label],
      secondary: [a.title, ...(a.keywords ?? []), ...(e.choice.keywords ?? []), a.category, a.where ?? ''],
      tertiary: [e.choice.detail ?? '', e.choice.description ?? '', a.description],
    });
  else d = indexFields({ primary: [a?.title ?? ''], secondary: [...(a?.keywords ?? []), a?.category ?? '', a?.where ?? ''], tertiary: [a?.description ?? ''] });
  docs.set(e, d);
  return d;
}

/**
 * The command palette (⌘K / Ctrl+K): every action of the app by name, and
 * the answer to "where is it?". Typing matches names first, then keywords
 * and where a command lives, then descriptions; each result shows its place
 * in the interface ("Scene › Display"), so the palette teaches the layout.
 * An empty field lists what you ran recently and often; `>` lists every panel
 * with where it is; `?` lists these modes. An action with choices opens them
 * as a second page (while typing, its choices match directly: "hydro" finds
 * Colour by → Hydrocarbons); an action that needs a value asks for it.
 * Everything runs through `app.actions`, the same registry an assistant calls.
 */
export function CommandPalette({ app }: { app: App }) {
  const open = useSignal(app.paletteOpen);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<AnyAction<App> | null>(null);
  const [prompt, setPrompt] = useState<AnyAction<App> | null>(null);
  const [history, setHistory] = useState<RunRecord[]>(loadHistory);

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
    if (!r.ok) return void app.toast(r.error, 'error');
    const next = recordRun(history, key, Date.now());
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: remembered until the page reloads */
    }
  };
  const pick = (e: Entry) => {
    if (e.mode) return setQuery(e.mode.prefix);
    const a = e.action!;
    if (e.choice) return void run(a, e.choice.input, e.key);
    if (a.choices) {
      setPage(a);
      setQuery('');
    } else if (a.prompt) {
      setPrompt(a);
      setQuery('');
    } else void run(a);
  };

  const mode = page ? 'page' : query.startsWith('>') ? 'panels' : query.startsWith('?') ? 'help' : 'commands';
  const text = mode === 'panels' || mode === 'help' ? query.slice(1) : query;

  // everything the palette can list, built once per opening (the choices read the app's state as it is now)
  const base = useMemo(() => {
    if (!open) return null;
    const choicesOf = (a: AnyAction<App>): Entry[] => {
      try {
        return (a.choices?.(app) ?? []).map((c, i) => ({ key: `${a.id}#${JSON.stringify(c.input) ?? i}`, action: a, choice: c }));
      } catch {
        return [];
      }
    };
    const actions = app.actions.list().filter((a) => !a.hidden && app.actions.enabled(a));
    const top: Entry[] = actions.map((a) => ({ key: a.id, action: a }));
    const choices = actions.filter((a) => !SUPERSEDED.has(a.id)).flatMap(choicesOf);
    const reveal = actions.find((a) => a.id === 'panels.reveal');
    return {
      choicesOf,
      top,
      choices,
      panels: reveal ? choices.filter((e) => e.action === reveal) : [],
      help: top.filter((e) => e.action!.category === 'Help'),
      modes: MODES.map((m, i): Entry => ({ key: `mode:${i}`, mode: m })),
    };
  }, [app, open]);

  // one action's choices, built once per page so their search text is indexed once
  const pageEntries = useMemo(() => (page && base ? base.choicesOf(page) : []), [base, page]);
  const typing = text.trim() !== '';
  const groups = useMemo(() => {
    if (!base) return [];
    const counts = new Map(history.map((r) => [r.k, r.n]));
    const find = (list: Entry[]) => (typing ? rank(list, docOf, text, { boost: (e) => counts.get(e.key) ?? 0, limit: MAX_RESULTS }) : list);
    if (page) return [{ heading: page.title, entries: find(pageEntries) }];
    if (mode === 'panels') return [{ heading: 'Panels and where they are', entries: find(base.panels) }];
    if (mode === 'help')
      return [
        { heading: 'Type to…', entries: find(base.modes) },
        { heading: 'Help', entries: find(base.help) },
      ].filter((g) => g.entries.length);
    if (typing) return [{ heading: 'Results', entries: find([...base.top, ...base.choices]) }];
    // nothing typed: what you ran recently and often first, then everything by category (without repeating them)
    const byKey = new Map([...base.top, ...base.choices].map((e) => [e.key, e]));
    const resolve = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
    const recent = resolve(recentKeys(history, 5));
    const often = resolve(frequentKeys(history, 3, recentKeys(history, 5)));
    const shown = new Set([...recent, ...often].map((e) => e.key));
    const tag = (p: string, l: Entry[]) => l.map((e) => ({ ...e, key: `${p}:${e.key}` }));
    return [
      { heading: 'Recent', entries: tag('recent', recent) },
      { heading: 'Frequently used', entries: tag('often', often) },
      ...ORDER.map((c) => ({ heading: c as string, entries: base.top.filter((e) => e.action!.category === c && !shown.has(e.key)) })),
    ].filter((g) => g.entries.length);
  }, [base, page, pageEntries, mode, text, typing, history]);

  const pickRef = useRef(pick);
  pickRef.current = pick;
  const bare = !!page || mode === 'panels';
  const items = useMemo(
    () =>
      groups.map((g) => (
        <CommandGroup key={g.heading} heading={g.heading}>
          {g.entries.map((e) => (
            <CommandItem key={e.key} id={e.key} textValue={textOf(e)} onAction={() => pickRef.current(e)}>
              <Row entry={e} bare={bare} />
            </CommandItem>
          ))}
        </CommandGroup>
      )),
    [groups, bare],
  );

  const placeholder = page
    ? `Choose ${page.title.toLowerCase()}…`
    : mode === 'panels'
      ? 'Find a panel…'
      : mode === 'help'
        ? 'Pick a mode, or open the help'
        : 'Type a command, a panel, a well, a formation…  (? for help)';
  return (
    <CommandDialog open={open} onOpenChange={(o) => app.paletteOpen.set(o)} title="Command palette" description="Find and run any command" className="sm:max-w-xl">
      {prompt?.prompt ? (
        <PromptPage action={prompt} onBack={() => setPrompt(null)} onRun={(input) => run(prompt, input)} app={app} />
      ) : (
        <Command inputValue={query} onInputChange={setQuery} filter={ALL}>
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
                placeholder={placeholder}
                onKeyDown={(e) => {
                  // Backspace on an empty field goes back up
                  if (e.key === 'Backspace' && !query && page) setPage(null);
                }}
              />
            </div>
          </div>
          <CommandList
            className="max-h-[min(60vh,28rem)]"
            renderEmptyState={() => (
              <CommandEmpty>
                {mode === 'panels' ? 'No panel' : 'Nothing'} matches “{text.trim()}”. Type <Kbd>?</Kbd> for the modes.
              </CommandEmpty>
            )}
          >
            {items}
          </CommandList>
          <Footer />
        </Command>
      )}
    </CommandDialog>
  );
}

/** What assistive tech reads for a row (the palette does its own matching). */
function textOf(e: Entry) {
  if (e.mode) return `${e.mode.title}. ${e.mode.detail}`;
  const a = e.action!;
  const name = e.choice ? `${a.title}: ${e.choice.label}` : a.title;
  const place = e.choice?.detail ?? a.where;
  return place ? `${name} (${place})` : name;
}

/**
 * One result: its name, then where it lives in the interface and what it does.
 * Memoised: the entries keep their identity while you type, so only rows that
 * appear or move render.
 */
const Row = memo(function Row({ entry: e, bare }: { entry: Entry; bare: boolean }) {
  if (e.mode)
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Kbd className="w-7 shrink-0">{e.mode.prefix || 'abc'}</Kbd>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.93rem] text-fg-1">{e.mode.title}</span>
          <span className="type-caption truncate">{e.mode.detail}</span>
        </span>
      </span>
    );
  const a = e.action!;
  // a choice shows its own detail (a panel's place) or, out of its page, its action's place; an action its place and description
  const place = e.choice ? (e.choice.detail ?? (bare ? undefined : a.where)) : a.where;
  const about = e.choice ? undefined : a.description;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.93rem] text-fg-1">
          {e.choice && !bare ? (
            <>
              <span className="text-fg-2">{a.title}</span>
              <ChevronRightIcon className="mx-0.5 inline size-3 text-fg-3" />
              {e.choice.label}
            </>
          ) : (
            (e.choice?.label ?? a.title)
          )}
        </span>
        {(place || about) && (
          <span className="type-caption truncate">
            {place && <span className="text-fg-2">{place}</span>}
            {place && about && ' · '}
            {about}
          </span>
        )}
      </span>
      {e.choice?.current && <CheckIcon aria-label="current" className="size-3.5 shrink-0 text-ui-accent" />}
      {!e.choice && (a.choices || a.prompt) && <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-fg-3" />}
      {a.shortcut && !e.choice && <CommandShortcut>{a.shortcut}</CommandShortcut>}
    </span>
  );
});

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
      <span className="hidden items-center gap-1 sm:flex">
        <Kbd>&gt;</Kbd> panels
      </span>
      <span className="flex items-center gap-1">
        <Kbd>?</Kbd> modes
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
