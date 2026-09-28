import { createContext, Fragment, memo, useContext, useMemo, type ReactNode } from 'react';
import { cn } from 'cn';
import { ArrowUpRightIcon, CheckIcon, LayoutDashboardIcon } from 'lucide-react';
import { Link } from '@tecton/react/tecton/link';
import { CopyButton } from '@tecton/react/tecton/copy-button';
import { inlineText, parseBlocks, splitBlocks, type Block, type Inline } from './parse';

/** Where `app://` links go: the host's `onLink`. Without it they render as plain text. */
const LinkHandler = createContext<((href: string) => void) | undefined>(undefined);

function renderInline(nodes: Inline[], onLink: ((href: string) => void) | undefined): ReactNode {
  return nodes.map((node, i) => {
    switch (node.t) {
      case 'text':
        return <Fragment key={i}>{node.v}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'code':
        return (
          <code key={i} className="rounded-sm border border-border-subtle bg-muted px-1 py-px font-mono text-[0.85em] break-words">
            {node.v}
          </code>
        );
      case 'strong':
        return (
          <strong key={i} className="font-semibold text-foreground">
            {renderInline(node.c, onLink)}
          </strong>
        );
      case 'em':
        return <em key={i}>{renderInline(node.c, onLink)}</em>;
      case 'del':
        return (
          <del key={i} className="text-muted-foreground">
            {renderInline(node.c, onLink)}
          </del>
        );
      case 'link':
        if (node.kind === 'app') {
          if (!onLink) return <Fragment key={i}>{renderInline(node.c, onLink)}</Fragment>;
          return (
            <button
              key={i}
              type="button"
              data-slot="assistant-app-link"
              title={node.href}
              onClick={() => onLink(node.href)}
              className="mx-px inline-flex items-baseline gap-1 rounded-full border border-primary/40 bg-primary/15 px-2 text-[0.92em] leading-normal font-medium text-foreground outline-none transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {renderInline(node.c, onLink)}
              <ArrowUpRightIcon className="size-3 shrink-0 self-center text-primary" aria-hidden />
            </button>
          );
        }
        return (
          <Link key={i} href={node.href} target="_blank" rel="noopener noreferrer" variant="primary" size="inherit" className="underline underline-offset-2">
            {renderInline(node.c, onLink)}
          </Link>
        );
    }
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-semibold tracking-tight',
  2: 'text-base font-semibold tracking-tight',
  3: 'text-sm font-semibold',
  4: 'text-sm font-semibold text-muted-foreground',
};

function CodeBlock({ lang, value, open }: { lang: string; value: string; open: boolean }) {
  if (lang === 'a2ui') {
    // the controller turns these into a generated interface; while one streams, say so instead of showing JSON
    return (
      <div data-slot="assistant-code-block" className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <LayoutDashboardIcon className="size-3.5" aria-hidden />
        <span className={cn(open && 'shimmer motion-reduce:shimmer-none')}>{open ? 'Building an interface…' : 'Interface'}</span>
      </div>
    );
  }
  return (
    <div data-slot="assistant-code-block" className="group/code min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-muted/40">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-border-subtle ps-3 pe-1 text-xs text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        {!open && <CopyButton value={value} size="icon-xs" aria-label="Copy code" />}
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function BlockView({ block, onLink }: { block: Block; onLink: ((href: string) => void) | undefined }): ReactNode {
  switch (block.t) {
    case 'p':
      return <p>{renderInline(block.c, onLink)}</p>;
    case 'h': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
      return <Tag className={cn('mt-1 text-foreground first:mt-0', HEADING_CLASS[Math.min(block.level, 4)])}>{renderInline(block.c, onLink)}</Tag>;
    }
    case 'hr':
      return <hr className="border-border-subtle" />;
    case 'code':
      return <CodeBlock lang={block.lang} value={block.v} open={block.open} />;
    case 'quote':
      return (
        <blockquote className="flex flex-col gap-2 border-s-2 border-border ps-3 text-muted-foreground">
          {block.c.map((b, i) => (
            <BlockView key={i} block={b} onLink={onLink} />
          ))}
        </blockquote>
      );
    case 'list': {
      const isTaskList = block.items.some((item) => item.task !== undefined);
      const items = block.items.map((item, i) => (
        <li key={i} className={cn('ps-0.5', item.task !== undefined && (isTaskList && block.items.every((it) => it.task !== undefined) ? '-ms-5 flex list-none items-start gap-2 ps-0' : 'flex list-none items-start gap-2 ps-0'))}>
          {item.task !== undefined && (
            <span
              role="img"
              aria-label={item.task ? 'Done' : 'Not done'}
              className={cn(
                'mt-[0.2em] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                item.task ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
              )}
            >
              {item.task && <CheckIcon className="size-3" aria-hidden />}
            </span>
          )}
          <div className={cn('flex min-w-0 flex-col gap-1.5', item.task && 'text-muted-foreground')}>
            {item.c.length > 0 && <div>{renderInline(item.c, onLink)}</div>}
            {item.children.map((b, k) => (
              <BlockView key={k} block={b} onLink={onLink} />
            ))}
          </div>
        </li>
      ));
      const listClass = cn('flex flex-col gap-1 ps-5 marker:text-muted-foreground', block.ordered ? 'list-decimal' : 'list-disc');
      return block.ordered ? (
        <ol className={listClass} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul className={listClass}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div data-slot="assistant-table" className="max-w-full overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead className="bg-muted/50">
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? 'left' }} className="border-b border-border-subtle px-2.5 py-1.5 font-medium whitespace-nowrap text-muted-foreground">
                    {renderInline(cell, onLink)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-border-subtle last:border-b-0">
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: block.align[i] ?? 'left' }} className={cn('px-2.5 py-1.5 align-top', inlineText(cell).length <= 24 && 'whitespace-nowrap')}>
                      {renderInline(cell, onLink)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** One top-level chunk, re-parsed only when its source changes. */
const Chunk = memo(function Chunk({ src }: { src: string }) {
  const onLink = useContext(LinkHandler);
  const blocks = useMemo(() => parseBlocks(src), [src]);
  return (
    <>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} onLink={onLink} />
      ))}
    </>
  );
});

export interface MarkdownProps {
  text: string;
  /** the text is still arriving: shows a caret after the last block */
  streaming?: boolean;
  /** `app://` links call it (the host's `onLink`) */
  onLink?: (href: string) => void;
  className?: string;
}

/**
 * Safe, incremental Markdown for chat answers: no HTML is ever injected,
 * links are limited to http(s), mailto and `app://`, and while a reply
 * streams only its last chunk is parsed again.
 */
export const Markdown = memo(function Markdown({ text, streaming = false, onLink, className }: MarkdownProps) {
  const chunks = useMemo(() => splitBlocks(text), [text]);
  return (
    <LinkHandler.Provider value={onLink}>
      <div data-slot="assistant-markdown" data-streaming={streaming || undefined} className={cn('flex min-w-0 flex-col gap-3 text-sm leading-relaxed wrap-break-word', className)}>
        {chunks.map((src, i) => (
          <Chunk key={i} src={src} />
        ))}
      </div>
    </LinkHandler.Provider>
  );
});
