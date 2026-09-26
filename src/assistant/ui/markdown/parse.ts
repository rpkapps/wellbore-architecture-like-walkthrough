/*
 * A small Markdown parser for chat answers: CommonMark's everyday subset plus
 * GFM tables, task lists, strikethrough and autolinks. It builds a tree (no
 * HTML strings), so rendering it cannot inject markup, and it tolerates the
 * half-written input of a streaming reply: an open fence is a code block
 * that is still growing, a table without its delimiter row yet is a
 * paragraph, an unclosed `**` is plain text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; kind: 'web' | 'app'; c: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** a task list item: checked or not; undefined for a plain item */
  task?: boolean;
  c: Inline[];
  children: Block[];
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string; open: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?/;
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (line: string) => line.trim() === '';

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

function fenceClose(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return indentOf(line) < 4 && trimmed.length >= fence.length && trimmed[0] === fence[0] && /^(`+|~+)$/.test(trimmed);
}

// ------------------------------------------------------------------ blocks

/**
 * Splits a document into top-level chunks at blank lines (never inside a
 * fence, and a list stays one chunk across blank lines), so a renderer can
 * memoise each chunk by its source and re-parse only the one that grows.
 */
export function splitBlocks(src: string): string[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length) chunks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      current.push(line);
      fence = open[2];
      continue;
    }
    if (isBlank(line)) flush();
    else current.push(line);
  }
  flush();
  // a list continues across blank lines when the next chunk is indented or another item
  const merged: string[] = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && LIST_ITEM.test(prev.split('\n', 1)[0]) && !HR.test(prev.split('\n', 1)[0]) && (indentOf(chunk) >= 2 || (LIST_ITEM.test(chunk.split('\n', 1)[0]) && !HR.test(chunk.split('\n', 1)[0])))) {
      merged[merged.length - 1] = `${prev}\n\n${chunk}`;
    } else merged.push(chunk);
  }
  return merged;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cell += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes('|') || !TABLE_DELIM.test(delim)) return false;
  if (!delim.includes('|') && splitRow(head).length > 1) return false;
  return true;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || (LIST_ITEM.test(line) && indentOf(line) < 4) || isTableStart(lines, i);
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => !isBlank(l)).map(indentOf);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => {
    let removed = 0;
    let k = 0;
    while (k < l.length && removed < min && (l[k] === ' ' || l[k] === '\t')) {
      removed += l[k] === '\t' ? 4 : 1;
      k++;
    }
    return l.slice(k);
  });
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start]) as RegExpExecArray;
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const raw: { first: string; rest: string[] }[] = [];
  let i = start;
  let prevBlank = false;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length) break;
      const nextIndent = indentOf(lines[j]);
      const nextItem = LIST_ITEM.exec(lines[j]);
      if (nextIndent > base || (nextItem && nextIndent >= base && nextIndent <= base + 1 && !HR.test(lines[j]))) {
        raw[raw.length - 1]?.rest.push('');
        prevBlank = true;
        i++;
        continue;
      }
      break;
    }
    const indent = indentOf(line);
    const item = LIST_ITEM.exec(line);
    if (item && indent >= base && indent <= base + 1 && !HR.test(line)) {
      raw.push({ first: item[3] ?? '', rest: [] });
      prevBlank = false;
      i++;
      continue;
    }
    if (indent < base && item) break;
    if (indent > base && raw.length) {
      raw[raw.length - 1].rest.push(line);
      prevBlank = false;
      i++;
      continue;
    }
    // a lazy continuation of the item's first paragraph
    if (raw.length && !prevBlank && !startsBlock(lines, i) && raw[raw.length - 1].rest.length === 0) {
      raw[raw.length - 1].first += `\n${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  const items: ListItem[] = raw.map(({ first: text, rest }) => {
    const task = /^\[([ xX])\][ \t]+/.exec(text);
    while (rest.length && isBlank(rest[rest.length - 1])) rest.pop();
    const item: ListItem = { c: parseInline(task ? text.slice(task[0].length) : text), children: rest.length ? parseBlocks(dedent(rest).join('\n')) : [] };
    if (task) item.task = task[1] !== ' ';
    return item;
  });
  return { block: { t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, next: i };
}

/** Parses one chunk (or a nested body) into blocks. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const body: string[] = [];
      let j = i + 1;
      let open = true;
      while (j < lines.length) {
        if (fenceClose(lines[j], fence[2])) {
          open = false;
          break;
        }
        body.push(indent ? lines[j].replace(new RegExp(`^ {0,${indent}}`), '') : lines[j]);
        j++;
      }
      blocks.push({ t: 'code', lang: fence[3] ?? '', v: body.join('\n'), open });
      i = open ? j : j + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((cell) => {
        const l = cell.startsWith(':');
        const r = cell.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) {
        const cells = splitRow(lines[j]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')));
        j++;
      }
      blocks.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map((cell) => parseInline(cell)), rows });
      i = j;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(body.join('\n')) });
      continue;
    }
    if (LIST_ITEM.test(line) && (LIST_ITEM.exec(line) as RegExpExecArray)[3] !== undefined) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

// ------------------------------------------------------------------ inlines

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;
const WEB_URL = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/;
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** A link target the renderer may follow, or null: http(s), mailto and the host's `app://`. */
export function safeHref(href: string): { href: string; kind: 'web' | 'app' } | null {
  const h = href.trim().replace(/^<|>$/g, '');
  if (/^app:\/\//i.test(h)) return { href: h, kind: 'app' };
  if (/^(https?:\/\/|mailto:)/i.test(h)) return { href: h, kind: 'web' };
  return null;
}

/** Finds a closing delimiter run of exactly `delim` after `from` that can close emphasis. */
function findCloser(s: string, delim: string, from: number): number {
  const ch = delim[0];
  let j = s.indexOf(delim, from);
  while (j !== -1) {
    const before = s[j - 1];
    const after = s[j + delim.length];
    const runOk = after !== ch && (delim.length > 1 || s[j - 1] !== ch);
    const flankOk = !isSpace(before) && (ch !== '_' || !isWord(after));
    if (runOk && flankOk && j > from) return j;
    j = s.indexOf(delim, j + 1);
  }
  return -1;
}

function findBracketEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

function findParenEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
    else if (ch === '\n') return -1;
  }
  return -1;
}

/** Parses inline Markdown into nodes. Unmatched delimiters stay as text. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === '\n') {
        flush();
        out.push({ t: 'br' });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }
    if (ch === '\n') {
      buf = buf.replace(/[ \t]+$/, '');
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const ticks = '`'.repeat(n);
      let end = s.indexOf(ticks, i + n);
      while (end !== -1 && s[end + n] === '`') end = s.indexOf(ticks, end + n + 1);
      if (end !== -1) {
        flush();
        let code = s.slice(i + n, end).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        out.push({ t: 'code', v: code });
        i = end + n;
        continue;
      }
      buf += ticks;
      i += n;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let n = 1;
      while (s[i + n] === ch) n++;
      const intraword = ch === '_' && isWord(s[i - 1]);
      if (!intraword && !isSpace(s[i + n])) {
        const tries = n >= 3 ? [3, 2, 1] : n === 2 ? [2, 1] : [1];
        let done = false;
        for (const len of tries) {
          const delim = ch.repeat(len);
          const start = i + len;
          const end = findCloser(s, delim, start);
          if (end === -1) continue;
          flush();
          const inner = parseInline(s.slice(start, end));
          out.push(len === 3 ? { t: 'strong', c: [{ t: 'em', c: inner }] } : { t: len === 2 ? 'strong' : 'em', c: inner });
          i = end + len;
          done = true;
          break;
        }
        if (done) continue;
      }
      buf += ch.repeat(n);
      i += n;
      continue;
    }
    if (ch === '~' && s[i + 1] === '~' && !isSpace(s[i + 2])) {
      const end = findCloser(s, '~~', i + 2);
      if (end !== -1) {
        flush();
        out.push({ t: 'del', c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const open = ch === '!' ? i + 1 : i;
      const close = findBracketEnd(s, open);
      if (close !== -1 && s[close + 1] === '(') {
        const pend = findParenEnd(s, close + 1);
        if (pend !== -1) {
          const target = s
            .slice(close + 2, pend)
            .trim()
            .replace(/\s+("[^"]*"|'[^']*')$/, '');
          const label = s.slice(open + 1, close);
          const safe = safeHref(target);
          flush();
          const children = parseInline(label);
          if (safe) out.push({ t: 'link', href: safe.href, kind: safe.kind, c: children.length ? children : [{ t: 'text', v: safe.href }] });
          else out.push(...children);
          i = pend + 1;
          continue;
        }
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:|app:\/\/)[^\s<>]+)>/i.exec(s.slice(i));
      if (auto) {
        const safe = safeHref(auto[1]);
        if (safe) {
          flush();
          out.push({ t: 'link', href: safe.href, kind: safe.kind, c: [{ t: 'text', v: auto[1] }] });
          i += auto[0].length;
          continue;
        }
      }
    }
    if ((ch === 'h' || ch === 'H') && !isWord(s[i - 1])) {
      const url = WEB_URL.exec(s.slice(i));
      if (url) {
        flush();
        out.push({ t: 'link', href: url[0], kind: 'web', c: [{ t: 'text', v: url[0] }] });
        i += url[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** The plain text of inline nodes (for a code block's copy, tests, labels). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : inlineText(n.c))).join('');
}
