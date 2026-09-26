import { describe, expect, it } from 'vitest';
import { extractA2UIFences, validateMessages } from '../../src/assistant/a2ui';

const msg = { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'x' } };

describe('extractA2UIFences', () => {
  it('leaves text without blocks untouched', () => {
    const text = 'Plain answer with ```js\ncode\n``` in it.';
    expect(extractA2UIFences(text)).toEqual({ text, blocks: [] });
    expect(extractA2UIFences('')).toEqual({ text: '', blocks: [] });
  });

  it('pulls out a fenced JSON array and keeps the surrounding text', () => {
    const text = `Here is the chart:\n\n\`\`\`a2ui\n${JSON.stringify([msg, msg])}\n\`\`\`\n\nThe peak is in 2009.`;
    const out = extractA2UIFences(text);
    expect(out.blocks).toEqual([[msg, msg]]);
    expect(out.text).toBe('Here is the chart:\n\nThe peak is in 2009.');
  });

  it('reads a single object and JSONL, and several blocks in order', () => {
    const text = `a\n\`\`\`a2ui\n${JSON.stringify(msg)}\n\`\`\`\nb\n\`\`\`A2UI-json\n${JSON.stringify(msg)}\n${JSON.stringify({ ...msg, version: 'v0.9.1' })}\n\`\`\`\nc`;
    const out = extractA2UIFences(text);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0]).toEqual([msg]);
    expect(out.blocks[1]).toHaveLength(2);
    expect(out.text).toBe('a\nb\nc');
  });

  it('pulls out <a2ui-json> tags, inline or on their own lines', () => {
    const out = extractA2UIFences(`Before <a2ui-json>${JSON.stringify([msg])}</a2ui-json> after\n<a2ui-json>\n${JSON.stringify(msg)}\n</a2ui-json>\nend`);
    expect(out.blocks).toEqual([[msg], [msg]]);
    expect(out.text).toContain('Before');
    expect(out.text).toContain('after');
    expect(out.text).toContain('end');
    expect(out.text).not.toContain('a2ui');
  });

  it('hides an unterminated block while streaming and returns no block for it', () => {
    const out = extractA2UIFences(`Working on it.\n\n\`\`\`a2ui\n[{"version":"v0.9","createSur`);
    expect(out).toEqual({ text: 'Working on it.', blocks: [] });
    const tag = extractA2UIFences('Done <a2ui-json>[{"ver');
    expect(tag).toEqual({ text: 'Done', blocks: [] });
  });

  it('hides a half-typed opener at the very end', () => {
    expect(extractA2UIFences('Look:\n```a2').text).toBe('Look:');
    expect(extractA2UIFences('Look: <a2ui-j').text).toBe('Look:');
    expect(extractA2UIFences('A code block:\n```').text).toBe('A code block:\n```');
  });

  it('keeps an unparseable block as its raw text, which the validator explains', () => {
    const out = extractA2UIFences('x\n```a2ui\n[{"version": }]\n```');
    expect(out.blocks).toEqual([['[{"version": }]']]);
    expect(validateMessages(out.blocks[0])[0]).toContain('does not parse');
  });
});
