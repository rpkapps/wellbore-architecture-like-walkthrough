/*
 * Generated UI written into the text of an answer instead of a `render_ui`
 * call: ```a2ui fenced blocks (a JSON array, one object, or JSONL) and the
 * official SDK's `<a2ui-json>…</a2ui-json>` tags. While an answer streams,
 * an unterminated block at the end is hidden from the text and yields no
 * block until it closes.
 */
import { parseMessagesText } from './normalize';

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(a2ui(?:[-+]json)?)[ \t]*$/i;
const TAG_OPEN = '<a2ui-json>';
const TAG_CLOSE = '</a2ui-json>';

/**
 * Splits A2UI blocks out of assistant text. `blocks[i]` holds the messages
 * of the i-th block, in order; a block whose JSON does not parse is kept as
 * its raw string (one element), so the validator can say why.
 */
export function extractA2UIFences(text: string): { text: string; blocks: unknown[][] } {
  if (!text || (!/a2ui/i.test(text) && !text.includes('```') && !text.includes('<a2'))) return { text, blocks: [] };
  const blocks: unknown[][] = [];
  const kept: string[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[2];
      let j = i + 1;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      if (j >= lines.length) break; // unterminated: still streaming, drop the rest
      blocks.push(toBlock(lines.slice(i + 1, j).join('\n')));
      i = j + 1;
      continue;
    }
    const tagAt = line.indexOf(TAG_OPEN);
    if (tagAt >= 0) {
      const rest = [line.slice(tagAt + TAG_OPEN.length), ...lines.slice(i + 1)].join('\n');
      const end = rest.indexOf(TAG_CLOSE);
      const before = line.slice(0, tagAt);
      if (before.trim()) kept.push(before);
      if (end < 0) {
        i = lines.length;
        break;
      }
      blocks.push(toBlock(rest.slice(0, end)));
      // continue after the closing tag, on the line where it ends
      const after = rest.slice(end + TAG_CLOSE.length);
      const afterLines = after.split('\n');
      lines.splice(i, lines.length - i, ...afterLines);
      if (!afterLines[0].trim()) i++;
      continue;
    }
    kept.push(line);
    i++;
  }
  // a fence or tag only half-typed at the very end of a streaming answer
  let cut = false;
  if (kept.length) {
    const trimmed = trimPartialOpener(kept[kept.length - 1]);
    if (trimmed !== null) {
      kept[kept.length - 1] = trimmed;
      cut = true;
    }
  }
  const joined = kept.join('\n');
  if (!blocks.length && !cut && joined === text) return { text, blocks };
  return { text: joined.replace(/\n{3,}/g, '\n\n').trimEnd(), blocks };
}

/** The line without a fence or tag opener that is only half-typed at its end, or null when there is none. */
function trimPartialOpener(line: string): string | null {
  const t = line.trim().toLowerCase();
  if (t.length >= 4 && '```a2ui'.startsWith(t)) return '';
  const tagStart = line.lastIndexOf('<');
  if (tagStart >= 0) {
    const tail = line.slice(tagStart).toLowerCase();
    if (tail.length >= 3 && TAG_OPEN.startsWith(tail)) return line.slice(0, tagStart).trimEnd();
  }
  return null;
}

function toBlock(src: string): unknown[] {
  const { messages, error } = parseMessagesText(src);
  if (error && !messages.length) return [src];
  return messages;
}
