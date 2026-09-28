import { QUERY_DATASET, RENDER_UI } from './builtinTools';
import { SMALL_WINDOW, estimateTools } from './context';
import { sanitizeToolName } from './toolNames';
import type { AssistantTool } from './types';

/*
 * Tool deferral. An app with many tools can spend a large part of a small
 * context window on their definitions alone. Then only the core tools (and
 * the kit's own) are offered, plus `find_tools`: the model searches the
 * others by keyword, and the ones it finds are offered for the rest of the
 * thread. The choice is made at a thread's first turn and kept (the system
 * prompt mentions it, and must stay the same from turn to turn); it is made
 * again only when the thread moves to another connection.
 */

export const FIND_TOOLS = 'find_tools';
/** Tools are deferred when their definitions would take more than this share of the working window… */
export const DEFER_TOOLS_SHARE = 0.15;
/** …or whenever the window is this small. */
export const DEFER_TOOLS_WINDOW = SMALL_WINDOW;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** Always offered, deferred or not: the core tools and the kit's own. */
export const isAlwaysOffered = (t: AssistantTool) => !!t.core || t.name === RENDER_UI || t.name === QUERY_DATASET || t.name === FIND_TOOLS;

/** Whether to defer the tools in a window of `window` tokens (only when some tool could be deferred). */
export function shouldDeferTools(tools: AssistantTool[], window: number): boolean {
  if (!tools.some((t) => !isAlwaysOffered(t))) return false;
  if (window <= DEFER_TOOLS_WINDOW) return true;
  const wire = tools.map((t) => ({ name: sanitizeToolName(t.name), description: t.description, parameters: t.parameters }));
  return estimateTools(wire) > DEFER_TOOLS_SHARE * window;
}

/** The first sentence of a description (at most 200 characters). */
export function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'by', 'with', 'is', 'it', 'this', 'that', 'tool', 'tools', 'me', 'my', 'i', 'can', 'how']);

/** Lower-case words of a text; `view.color_by` and `colorBy` split into their words. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * The tools that match a query best: each query word scores where it occurs
 * (name 3, title 2, description 1; a shared prefix of four or more letters
 * scores half, so "colour" finds "color_by" and "plotting" finds "plot").
 */
export function rankTools(tools: AssistantTool[], query: string, limit = DEFAULT_LIMIT): AssistantTool[] {
  const words = [...new Set(tokenize(query))];
  if (!words.length) return [];
  const prefix = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i >= 4 || (i >= 3 && i === Math.min(a.length, b.length));
  };
  const scoreIn = (word: string, fieldWords: string[], weight: number) => {
    if (fieldWords.includes(word)) return weight;
    return fieldWords.some((f) => prefix(word, f)) ? weight / 2 : 0;
  };
  const scored = tools.map((t, i) => {
    const name = tokenize(t.name);
    const title = tokenize(t.title ?? '');
    const desc = tokenize(t.description);
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const s = Math.max(scoreIn(w, name, 3), scoreIn(w, title, 2), scoreIn(w, desc, 1));
      if (s > 0) matched++;
      score += s;
    }
    // tools that match more of the query words come first, then by weight
    return { t, i, score: score + matched * 2 };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT)))
    .map((x) => x.t);
}

export interface FindToolsOptions {
  /** the tools not offered yet */
  deferred: () => AssistantTool[];
  /** offers these tools (kit names) from the next step on, for the rest of the thread */
  enable: (names: string[]) => void;
  /** the wire name the model calls a tool by */
  toWire?: (kitName: string) => string;
}

/** The built-in `find_tools` tool, offered while tools are deferred. */
export function findToolsTool(opts: FindToolsOptions): AssistantTool {
  return {
    name: FIND_TOOLS,
    title: 'Find tools',
    kind: 'read',
    core: true,
    description:
      'Searches the app’s other tools by keywords and loads the best matches, which you can call from then on. ' +
      'Use it whenever none of your current tools fits the request, before saying something cannot be done. Describe the action or data you need ("colour well by log", "production history").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords for what the tool should do or read.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `How many tools to load (default ${DEFAULT_LIMIT}).` },
      },
      required: ['query'],
    },
    execute: (raw: unknown) => {
      const a = (raw ?? {}) as { query?: unknown; limit?: unknown };
      const query = typeof a.query === 'string' ? a.query : '';
      if (!query.trim()) throw new Error('Give "query": a few keywords for the tool you need.');
      const deferred = opts.deferred();
      const found = rankTools(deferred, query, typeof a.limit === 'number' ? a.limit : DEFAULT_LIMIT);
      if (!found.length)
        return { tools: [], message: `No tool matched "${query}". Try other words (${deferred.length} tools can still be searched), or answer with what you have.` };
      opts.enable(found.map((t) => t.name));
      const toWire = opts.toWire ?? sanitizeToolName;
      return {
        tools: found.map((t) => ({ name: toWire(t.name), ...(t.title ? { title: t.title } : {}), description: firstSentence(t.description) })),
        message: 'These tools are loaded: call them directly from now on.',
      };
    },
  };
}
