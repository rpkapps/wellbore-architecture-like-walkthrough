/*
 * The small inline Markdown the Text component allows: **bold**, *italic* /
 * _italic_, `code`, ~~strike~~ and [links](https://…). It builds React
 * elements from a tokenised string, so nothing in the text can become HTML;
 * links are kept only for http(s) and mailto URLs and open in a new tab.
 */
import type { ReactNode } from 'react';

/** A parsed inline span. */
export type InlineNode =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: InlineNode[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: InlineNode[] };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Parses inline Markdown into spans (unclosed markers stay literal text). */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = findClose(src, i + 1, ']');
      if (close > 0 && src[close + 1] === '(') {
        const paren = src.indexOf(')', close + 2);
        if (paren > 0) {
          const href = src.slice(close + 2, paren).trim();
          const label = src.slice(i + 1, close);
          flush();
          if (SAFE_URL.test(href)) out.push({ t: 'link', href, c: parseInline(label) });
          else out.push(...parseInline(label));
          i = paren + 1;
          continue;
        }
      }
    }
    const pair = src.startsWith('**', i) ? '**' : src.startsWith('__', i) ? '__' : src.startsWith('~~', i) ? '~~' : ch === '*' || ch === '_' ? ch : '';
    if (pair) {
      const end = findMarker(src, i + pair.length, pair);
      // `_` inside a word (snake_case) is not emphasis
      const intraword = pair === '_' && i > 0 && /\w/.test(src[i - 1]);
      if (end > i + pair.length && !intraword && !/\s/.test(src[i + pair.length])) {
        flush();
        const inner = parseInline(src.slice(i + pair.length, end));
        out.push({ t: pair === '~~' ? 'del' : pair.length === 2 ? 'strong' : 'em', c: inner });
        i = end + pair.length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function findClose(src: string, from: number, ch: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === ch) return j;
  }
  return -1;
}

function findMarker(src: string, from: number, marker: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === '`') {
      const end = src.indexOf('`', j + 1);
      if (end > 0) j = end;
      continue;
    }
    if (src.startsWith(marker, j) && !/\s/.test(src[j - 1] ?? '')) {
      // a single `*` must not be the start of `**`
      if (marker.length === 1 && src[j + 1] === marker) {
        j++;
        continue;
      }
      if (marker === '_' && /\w/.test(src[j + 1] ?? '')) continue;
      return j;
    }
  }
  return -1;
}

function render(nodes: InlineNode[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'strong':
        return (
          <strong key={k} className="font-semibold">
            {render(n.c, k + '.')}
          </strong>
        );
      case 'em':
        return <em key={k}>{render(n.c, k + '.')}</em>;
      case 'del':
        return <del key={k}>{render(n.c, k + '.')}</del>;
      case 'code':
        return (
          <code key={k} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:no-underline">
            {render(n.c, k + '.')}
          </a>
        );
    }
  });
}

/** Renders inline Markdown as React nodes. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{render(parseInline(text))}</>;
}

/** A block of Text: headings (`#`), bullet and numbered lists, paragraphs; everything inside is inline Markdown. */
export type BlockNode = { t: 'h'; level: number; text: string } | { t: 'ul' | 'ol'; items: string[] } | { t: 'p'; lines: string[] };

/** Splits text into the few block forms the Text component supports. */
export function parseBlocks(src: string): BlockNode[] {
  const out: BlockNode[] = [];
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const last = out[out.length - 1];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) out.push({ t: 'p', lines: [] });
    else if (h) out.push({ t: 'h', level: h[1].length, text: h[2] });
    else if (ul) {
      if (last?.t === 'ul') last.items.push(ul[1]);
      else out.push({ t: 'ul', items: [ul[1]] });
    } else if (ol) {
      if (last?.t === 'ol') last.items.push(ol[1]);
      else out.push({ t: 'ol', items: [ol[1]] });
    }
    else if (last?.t === 'p') last.lines.push(line);
    else out.push({ t: 'p', lines: [line] });
  }
  return out.filter((b) => b.t !== 'p' || b.lines.length);
}

const HEADING = ['text-lg font-semibold', 'text-base font-semibold', 'text-sm font-semibold', 'text-sm font-semibold', 'text-sm font-medium', 'text-sm font-medium'];

/** Renders Text with block Markdown; a single plain line stays a bare inline run. */
export function BlockMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length <= 1 && (!blocks[0] || (blocks[0].t === 'p' && blocks[0].lines.length === 1))) return <InlineMarkdown text={text} />;
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((b, i) => {
        if (b.t === 'h')
          return (
            <div key={i} role="heading" aria-level={Math.min(6, b.level + 2)} className={HEADING[b.level - 1]}>
              <InlineMarkdown text={b.text} />
            </div>
          );
        if (b.t === 'p')
          return (
            <div key={i}>
              {b.lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  <InlineMarkdown text={l} />
                </span>
              ))}
            </div>
          );
        const List = b.t === 'ul' ? 'ul' : 'ol';
        return (
          <List key={i} className={b.t === 'ul' ? 'list-disc space-y-0.5 pl-5' : 'list-decimal space-y-0.5 pl-5'}>
            {b.items.map((it, j) => (
              <li key={j}>
                <InlineMarkdown text={it} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
