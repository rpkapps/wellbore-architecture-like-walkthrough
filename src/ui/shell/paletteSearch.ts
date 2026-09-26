/**
 * The command palette's matching and its memory of what you ran, kept free of
 * React so both can be tested and stay cheap: the palette indexes its entries
 * once per opening, then every keystroke only runs `includes` over short,
 * already-normalised strings.
 */

/** The text of one palette entry, by how strongly a match in it counts. */
export interface SearchFields {
  /** what the row is called: the action's title, or the choice's label */
  primary: string[];
  /** keywords, category, where it lives, and a choice's parent action */
  secondary: string[];
  /** the description (and a choice's detail, such as a panel's location) */
  tertiary: string[];
}

/** An entry prepared for matching: each tier joined into one normalised haystack. */
export interface SearchDoc {
  primary: string;
  secondary: string;
  tertiary: string;
}

/**
 * Lower case, accents off, and British spelling folded into American so
 * "color" finds "Colour" (and the other way round).
 */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/colour/g, 'color');
}

export function indexFields(f: SearchFields): SearchDoc {
  const join = (l: string[]) => normalise(l.filter(Boolean).join(' \u0001 '));
  return { primary: join(f.primary), secondary: join(f.secondary), tertiary: join(f.tertiary) };
}

export function tokens(query: string): string[] {
  return normalise(query).split(/\s+/).filter(Boolean);
}

const wordStart = (hay: string, t: string) => {
  const i = hay.indexOf(t);
  return i === 0 || (i > 0 && !/[a-z0-9]/.test(hay[i - 1]));
};

/**
 * How well an entry matches, 0 when it does not. Every word of the query has
 * to appear somewhere; the entry then ranks by its weakest word: all in the
 * name (a title or a choice label) beats keywords, category or place, which
 * beats the description. Among name matches, a name that starts with the
 * query, words matched at a word start, and a shorter name rank higher; in
 * the lower tiers the given order (the palette's categories) decides.
 */
export function score(doc: SearchDoc, words: string[]): number {
  if (!words.length) return 1;
  let tier = 3;
  let bonus = 0;
  for (const t of words) {
    if (doc.primary.includes(t)) {
      if (wordStart(doc.primary, t)) bonus += 4;
      continue;
    }
    if (doc.secondary.includes(t)) tier = Math.min(tier, 2);
    else if (doc.tertiary.includes(t)) tier = Math.min(tier, 1);
    else return 0;
  }
  const phrase = words.join(' ');
  if (tier === 3 && doc.primary.startsWith(phrase)) bonus += 20;
  else if (tier === 3 && words.length > 1 && doc.primary.includes(phrase)) bonus += 10;
  // tiers are 100 apart, so no bonus lifts an entry over a better tier; below the name tier the given order decides
  return tier === 3 ? 300 + Math.min(bonus, 60) - Math.min(doc.primary.length, 120) / 4 : tier * 100;
}

/**
 * The entries that match, best first. Ties keep the given order (the
 * palette's category order), and `boost` (how often you ran it) breaks ties
 * within a tier before that. At most `limit` come back.
 */
export function rank<T>(entries: T[], doc: (e: T) => SearchDoc, query: string, opts: { boost?: (e: T) => number; limit?: number } = {}): T[] {
  const words = tokens(query);
  const scored: { e: T; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const s = score(doc(e), words);
    if (s > 0) scored.push({ e, s: s + Math.min(opts.boost?.(e) ?? 0, 10) / 2, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, opts.limit ?? Infinity).map((x) => x.e);
}

// ------------------------------------------------------------------ history

/** One remembered command: its key (action id, plus `#` and the choice's input), how often and when it last ran. */
export interface RunRecord {
  k: string;
  n: number;
  t: number;
}

export const HISTORY_CAP = 20;

/** Reads a stored history, including the older format (a list of keys, most recent first). */
export function parseHistory(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RunRecord[] = [];
  for (const r of raw) {
    if (typeof r === 'string') out.push({ k: r, n: 1, t: 0 });
    else if (r && typeof r === 'object' && typeof r.k === 'string') out.push({ k: r.k, n: Math.max(1, Number(r.n) || 1), t: Number(r.t) || 0 });
  }
  return out.slice(0, HISTORY_CAP);
}

/** The history after running `key`: it moves to the front with its count raised; the oldest fall off past the cap. */
export function recordRun(list: RunRecord[], key: string, now: number, cap = HISTORY_CAP): RunRecord[] {
  const had = list.find((r) => r.k === key);
  return [{ k: key, n: (had?.n ?? 0) + 1, t: now }, ...list.filter((r) => r.k !== key)].slice(0, cap);
}

/** The most recent keys, newest first. */
export function recentKeys(list: RunRecord[], n = 5): string[] {
  return list.slice(0, n).map((r) => r.k);
}

/** The keys run most often (at least twice), leaving out `exclude` (the recent ones, already listed). */
export function frequentKeys(list: RunRecord[], n = 3, exclude: Iterable<string> = []): string[] {
  const skip = new Set(exclude);
  return list
    .filter((r) => r.n >= 2 && !skip.has(r.k))
    .sort((a, b) => b.n - a.n || b.t - a.t)
    .slice(0, n)
    .map((r) => r.k);
}
