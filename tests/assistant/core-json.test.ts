import { describe, expect, it } from 'vitest';
import { parsePartialJson, safeJsonStringify } from '../../src/assistant/core/json';
import { buildToolNameMap, sanitizeToolName } from '../../src/assistant/core/toolNames';
import { uiMessagesFromArgs } from '../../src/assistant/core/agent';

describe('parsePartialJson', () => {
  it('parses complete JSON as is', () => {
    expect(parsePartialJson('{"a":[1,2,{"b":null}]}')).toEqual({ a: [1, 2, { b: null }] });
  });

  it('closes open strings, arrays and objects', () => {
    expect(parsePartialJson('{"messages": [{"id": "root", "text": "Hel')).toEqual({ messages: [{ id: 'root', text: 'Hel' }] });
    expect(parsePartialJson('[1, 2, [3, 4')).toEqual([1, 2, [3]]);
  });

  it('drops a key without its value, a trailing comma, and unfinished numbers or literals', () => {
    expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a": 1,')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a": 12')).toEqual({});
    expect(parsePartialJson('{"a": 12, "b": tr')).toEqual({ a: 12 });
    expect(parsePartialJson('{"a": true')).toEqual({ a: true });
    expect(parsePartialJson('[1.5e')).toEqual([]);
  });

  it('handles escapes, including ones cut in half', () => {
    expect(parsePartialJson('{"t": "a\\"b\\n')).toEqual({ t: 'a"b\n' });
    expect(parsePartialJson('{"t": "x\\')).toEqual({ t: 'x' });
    expect(parsePartialJson('{"t": "\\u00e9\\u00')).toEqual({ t: 'é' });
  });

  it('returns undefined when nothing usable arrived or the text is not JSON', () => {
    expect(parsePartialJson('')).toBeUndefined();
    expect(parsePartialJson('   ')).toBeUndefined();
    expect(parsePartialJson('hello')).toBeUndefined();
    expect(parsePartialJson('{"a": 1} trailing')).toBeUndefined();
    expect(parsePartialJson('{a: 1}')).toBeUndefined();
  });

  it('recovers every intermediate state of a streamed document without throwing', () => {
    const full = JSON.stringify({ messages: [{ version: 'v0.9', createSurface: { surfaceId: 's1' } }, { updateComponents: { components: [{ id: 'root', component: 'Text', text: 'Hi “there”' }] } }] });
    for (let i = 1; i <= full.length; i++) {
      const v = parsePartialJson(full.slice(0, i));
      if (v !== undefined) expect(typeof v).toBe('object');
    }
    expect(parsePartialJson(full)).toEqual(JSON.parse(full));
  });
});

describe('safeJsonStringify', () => {
  it('survives cycles, bigints and non-finite numbers, and truncates', () => {
    const a: Record<string, unknown> = { n: 10n, inf: Infinity, f: () => 1 };
    a.self = a;
    expect(safeJsonStringify(a)).toBe('{"n":"10","inf":null,"self":"[circular]"}');
    const long = safeJsonStringify('x'.repeat(500), 100);
    expect(long.length).toBeLessThan(120);
    expect(long).toContain('truncated');
  });
});

describe('tool names', () => {
  it('sanitises to the provider pattern', () => {
    expect(sanitizeToolName('view.color_by')).toBe('view__color_by');
    expect(sanitizeToolName('nav/go to depth!')).toBe('nav_go_to_depth_');
    expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64);
    expect(sanitizeToolName('')).toBe('tool');
  });

  it('maps both ways, dedupes collisions, and accepts the kit name back', () => {
    const map = buildToolNameMap(['view.color_by', 'view__color_by', 'view:color_by', 'render_ui']);
    expect(map.toWire('view.color_by')).toBe('view__color_by');
    expect(map.toWire('view__color_by')).toBe('view__color_by_2');
    expect(map.toWire('view:color_by')).toBe('view_color_by');
    expect(map.toKit('view__color_by')).toBe('view.color_by');
    expect(map.toKit('view__color_by_2')).toBe('view__color_by');
    expect(map.toKit('view.color_by')).toBe('view.color_by');
    expect(map.toKit('render_ui')).toBe('render_ui');
    expect(map.toKit('nope')).toBeUndefined();
    for (const n of ['view.color_by', 'view__color_by', 'view:color_by']) expect(map.toWire(n)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('render_ui arguments', () => {
  it('reads messages, an a2ui_json string (array or JSONL), and partial JSON', () => {
    expect(uiMessagesFromArgs({ messages: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(uiMessagesFromArgs({ a2ui_json: '[{"a":1},{"b":' })).toEqual([{ a: 1 }, {}]);
    expect(uiMessagesFromArgs({ a2ui_json: '{"a":1}\n{"b":2}' })).toEqual([{ a: 1 }, { b: 2 }]);
    expect(uiMessagesFromArgs({ messages: '[{"x":true}]' })).toEqual([{ x: true }]);
    expect(uiMessagesFromArgs({})).toBeUndefined();
    expect(uiMessagesFromArgs(null)).toBeUndefined();
  });
});
