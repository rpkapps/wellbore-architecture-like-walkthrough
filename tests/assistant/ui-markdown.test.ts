import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/assistant/ui/markdown/Markdown';
import { inlineText, parseBlocks, parseInline, safeHref, splitBlocks } from '../../src/assistant/ui/markdown/parse';

const html = (text: string, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(Markdown, { text, ...extra }));

describe('markdown: blocks', () => {
  it('splits at blank lines but never inside a fence, and keeps a loose list together', () => {
    expect(splitBlocks('a\n\nb')).toEqual(['a', 'b']);
    expect(splitBlocks('```js\nx\n\ny\n```\n\nafter')).toEqual(['```js\nx\n\ny\n```', 'after']);
    expect(splitBlocks('- one\n\n- two\n\n  more')).toHaveLength(1);
  });

  it('parses headings, rules, quotes and paragraphs', () => {
    const blocks = parseBlocks('# Title\nsome text\n\n---\n> quoted');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'hr', 'quote']);
  });

  it('parses nested, ordered and task lists', () => {
    const [list] = parseBlocks('3. first\n4. second\n   - nested\n- [x] done');
    expect(list.t).toBe('list');
    if (list.t !== 'list') return;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items[1].children[0].t).toBe('list');
    expect(list.items[2].task).toBe(true);
  });

  it('parses GFM tables with alignment and tolerates a missing delimiter mid-stream', () => {
    const [table] = parseBlocks('| a | b |\n|:--|--:|\n| 1 | 2 |');
    expect(table.t).toBe('table');
    if (table.t === 'table') {
      expect(table.align).toEqual(['left', 'right']);
      expect(table.rows).toHaveLength(1);
    }
    expect(parseBlocks('| a | b |')[0].t).toBe('p');
  });

  it('keeps an unterminated fence open (streaming)', () => {
    const [code] = parseBlocks('```python\nprint(1)');
    expect(code).toEqual({ t: 'code', lang: 'python', v: 'print(1)', open: true });
  });
});

describe('markdown: inlines', () => {
  it('parses emphasis, code, strikethrough and breaks', () => {
    const nodes = parseInline('**bold** *it* `code` ~~del~~\nnext');
    expect(nodes.map((n) => n.t)).toEqual(['strong', 'text', 'em', 'text', 'code', 'text', 'del', 'br', 'text']);
  });

  it('leaves snake_case and unclosed delimiters alone', () => {
    expect(inlineText(parseInline('view.color_by and snake_case_name'))).toBe('view.color_by and snake_case_name');
    expect(parseInline('**not closed')).toEqual([{ t: 'text', v: '**not closed' }]);
  });

  it('allows only http(s), mailto and app:// links', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('app://camera/fly')?.kind).toBe('app');
    expect(safeHref('https://x.org')?.kind).toBe('web');
    const [link] = parseInline('[x](javascript:alert(1))');
    expect(link).toEqual({ t: 'text', v: 'x' });
  });

  it('autolinks bare and bracketed URLs without trailing punctuation', () => {
    const nodes = parseInline('see https://example.com/a, or <https://b.org>.');
    const links = nodes.filter((n) => n.t === 'link');
    expect(links.map((l) => (l.t === 'link' ? l.href : ''))).toEqual(['https://example.com/a', 'https://b.org']);
  });
});

describe('markdown: rendering', () => {
  it('renders safely: no raw HTML, external links open in a new tab', () => {
    const out = html('<script>alert(1)</script> [site](https://example.com)');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
  });

  it('renders app links as buttons only when the host handles them', () => {
    expect(html('[Go](app://x)', { onLink: () => undefined })).toContain('data-slot="assistant-app-link"');
    expect(html('[Go](app://x)')).not.toContain('<button');
  });

  it('renders code blocks with a language label, tables, task lists and headings', () => {
    const out = html('## Zones\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n- [x] done\n\n```ts\nconst a = 1;\n```');
    expect(out).toContain('<h3');
    expect(out).toContain('<table');
    expect(out).toContain('text-align:right');
    expect(out).toContain('aria-label="Done"');
    expect(out).toContain('>ts<');
    expect(out).toContain('const a = 1;');
  });

  it('marks the markdown as streaming for the caret', () => {
    expect(html('partial', { streaming: true })).toContain('data-streaming="true"');
  });
});
