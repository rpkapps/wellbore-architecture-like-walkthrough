import { describe, expect, it } from 'vitest';
import { applyMessages, normalizeMessages, parseMessagesText, DATA_CATALOG_ID } from '../../src/assistant/a2ui';
import { evaluateCall, formatTemplate, resolveValue } from '../../src/assistant/a2ui/functions';
import { getAt, removeAt, resolvePath, setAt } from '../../src/assistant/a2ui/pointer';

const create = (surfaceId = 's', catalogId = DATA_CATALOG_ID) => ({ version: 'v0.9', createSurface: { surfaceId, catalogId } });
const comps = (components: unknown[], surfaceId = 's') => ({ version: 'v0.9', updateComponents: { surfaceId, components } });
const data = (path: string | undefined, value: unknown, surfaceId = 's') => ({ version: 'v0.9', updateDataModel: { surfaceId, ...(path ? { path } : {}), ...(value === undefined ? {} : { value }) } });

describe('JSON pointer', () => {
  it('reads, escapes and resolves relative paths', () => {
    const m = { a: { 'b/c': [10, { d: 'x' }] } };
    expect(getAt(m, '/a/b~1c/1/d')).toBe('x');
    expect(getAt(m, '/a/missing/0')).toBeUndefined();
    expect(getAt(m, '/')).toBe(m);
    expect(resolvePath('name', '/items/3')).toBe('/items/3/name');
    expect(resolvePath('./name', '/items/3')).toBe('/items/3/name');
    expect(resolvePath('/abs', '/items/3')).toBe('/abs');
    expect(resolvePath('name')).toBe('/name');
  });

  it('writes immutably with structural sharing and creates containers', () => {
    const m = { keep: { x: 1 }, list: [1, 2] };
    const next = setAt(m, '/form/email', 'a@b.c') as Record<string, unknown>;
    expect(next).not.toBe(m);
    expect(next.keep).toBe(m.keep);
    expect(getAt(next, '/form/email')).toBe('a@b.c');
    expect(getAt(setAt({}, '/rows/0/v', 3), '/rows')).toEqual([{ v: 3 }]);
    expect(setAt(m, '/', 5)).toBe(5);
    expect(getAt(removeAt(m, '/keep'), '/keep')).toBeUndefined();
    // removing an array element keeps the length
    expect(getAt(removeAt(m, '/list/0'), '/list')).toEqual([undefined, 2]);
    expect(m.list).toEqual([1, 2]);
  });
});

describe('applyMessages', () => {
  it('builds the adjacency list, resolves the root and applies data', () => {
    const [s] = applyMessages(null, [create(), comps([{ id: 'root', component: 'Column', children: ['t'] }, { id: 't', component: 'Text', text: { path: '/title' } }]), data('/title', 'Hi')]);
    expect(s.id).toBe('s');
    expect(s.rootId).toBe('root');
    expect(Object.keys(s.components)).toEqual(['root', 't']);
    expect(s.dataModel).toEqual({ title: 'Hi' });
  });

  it('handles several surfaces, deleteSurface and a whole-model replace', () => {
    const out = applyMessages(null, [create('a'), create('b'), comps([{ id: 'root', component: 'Text', text: 'A' }], 'a'), data(undefined, { x: 1 }, 'b'), { version: 'v0.9', deleteSurface: { surfaceId: 'a' } }]);
    expect(out.map((s) => s.id)).toEqual(['b']);
    expect(out[0].dataModel).toEqual({ x: 1 });
  });

  it('is incremental: applying on a previous state keeps untouched surfaces', () => {
    const first = applyMessages(null, [create('a'), comps([{ id: 'root', component: 'Text', text: 'A' }], 'a'), create('b')]);
    const second = applyMessages(first, [comps([{ id: 'root', component: 'Text', text: 'B' }], 'b')]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].components.root.text).toBe('B');
    expect(first[1].components.root).toBeUndefined();
  });

  it('removes a key when updateDataModel has no value', () => {
    const [s] = applyMessages(null, [create(), data('/a', 1), data('/b', 2), data('/a', undefined)]);
    expect(s.dataModel).toEqual({ b: 2 });
  });

  it('lets the last definition of a duplicate id win', () => {
    const [s] = applyMessages(null, [create(), comps([{ id: 'root', component: 'Text', text: 'one' }, { id: 'root', component: 'Text', text: 'two' }])]);
    expect(s.components.root.text).toBe('two');
  });

  it('tolerates a missing version, JSON strings, wrappers and junk', () => {
    const stream = JSON.stringify({ messages: [{ createSurface: { surfaceId: 's', catalogId: 'x' } }, null, 42, { updateComponents: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'ok' }, 'junk', { id: 'x' }] } }] });
    const [s] = applyMessages(null, [stream]);
    expect(s.rootId).toBe('root');
    expect(Object.keys(s.components)).toEqual(['root']);
  });

  it('keeps unknown component types (the renderer shows a note) and survives cycles', () => {
    const [s] = applyMessages(null, [create(), comps([{ id: 'root', component: 'Column', children: ['a'] }, { id: 'a', component: 'Column', children: ['root', 'z'] }, { id: 'z', component: 'Sparkles' }])]);
    expect(s.components.z.component).toBe('Sparkles');
    expect(s.rootId).toBe('root');
  });

  it('while streaming, skips incomplete components and marks the tail pending', () => {
    const msgs = [
      create(),
      comps([
        { id: 'root', component: 'Column', children: ['t', 'c', 'x'] },
        { id: 't', component: 'Text' },
        { id: 'c', component: 'Chart', kind: 'line', dataset: 'ds_1', x: 'md', series: [{ column: 'g' }] },
      ]),
    ];
    const [s] = applyMessages(null, msgs, { streaming: true });
    expect(s.components.t).toBeUndefined();
    expect(s.pending).toEqual(['c']);
    // a half-streamed type name at the tail is left out, not shown as unsupported
    const [s2] = applyMessages(null, [create(), comps([{ id: 'root', component: 'Column', children: [] }, { id: 'q', component: 'Cha' }])], { streaming: true });
    expect(s2.components.q).toBeUndefined();
    // without a root yet, nothing renders while streaming
    const [s3] = applyMessages(null, [create(), comps([{ id: 'a', component: 'Text', text: 'x' }])], { streaming: true });
    expect(s3.rootId).toBeNull();
  });

  it('falls back to the first unreferenced component once the stream is complete', () => {
    const [s] = applyMessages(null, [create(), comps([{ id: 'child', component: 'Text', text: 'x' }, { id: 'main', component: 'Column', children: ['child'] }])]);
    expect(s.rootId).toBe('main');
  });

  it('creates a surface implicitly when updates come first', () => {
    const [s] = applyMessages(null, [comps([{ id: 'root', component: 'Text', text: 'x' }])]);
    expect(s.catalogId).toBe(DATA_CATALOG_ID);
    expect(s.rootId).toBe('root');
  });
});

describe('v0.8 conversion', () => {
  const v08 = [
    {
      surfaceUpdate: {
        surfaceId: 'main',
        components: [
          { id: 'top', component: { Column: { children: { explicitList: ['t', 'l', 'b'] }, distribution: 'spaceBetween' } } },
          { id: 't', weight: 1, component: { Text: { text: { literalString: 'Hi' }, usageHint: 'h1' } } },
          { id: 'l', component: { List: { children: { template: { componentId: 'row', dataBinding: '/items' } } } } },
          { id: 'row', component: { Text: { text: { path: 'name' } } } },
          { id: 'b', component: { Button: { child: 't', primary: true, action: { name: 'go', context: [{ key: 'id', value: { literalString: '7' } }] } } } },
          { id: 'm', component: { MultipleChoice: { selections: { path: '/sel' }, options: [], maxAllowedSelections: 1, variant: 'chips' } } },
        ],
      },
    },
    { dataModelUpdate: { surfaceId: 'main', contents: [{ key: 'items', valueArray: [{ name: 'a' }] }, { key: 'user', valueMap: [{ key: 'age', valueNumber: 3 }] }] } },
    { beginRendering: { surfaceId: 'main', root: 'top' } },
  ];

  it('converts messages, components, values and data', () => {
    const out = normalizeMessages(v08) as Record<string, Record<string, unknown>>[];
    expect(out[0].updateComponents).toBeDefined();
    const [s] = applyMessages(null, v08);
    expect(s.rootId).toBe('top');
    expect(s.components.top).toMatchObject({ component: 'Column', children: ['t', 'l', 'b'], justify: 'spaceBetween' });
    expect(s.components.t).toMatchObject({ component: 'Text', text: 'Hi', variant: 'h1', weight: 1 });
    expect(s.components.l.children).toEqual({ componentId: 'row', path: '/items' });
    expect(s.components.b).toMatchObject({ variant: 'primary', action: { event: { name: 'go', context: { id: '7' } } } });
    expect(s.components.m).toMatchObject({ component: 'ChoicePicker', value: { path: '/sel' }, variant: 'mutuallyExclusive', displayStyle: 'chips' });
    expect(s.dataModel).toEqual({ items: [{ name: 'a' }], user: { age: 3 } });
  });
});

describe('parseMessagesText', () => {
  it('reads arrays, single objects and JSONL', () => {
    expect(parseMessagesText('[{"a":1},{"b":2}]').messages).toHaveLength(2);
    expect(parseMessagesText('{"a":1}').messages).toHaveLength(1);
    expect(parseMessagesText('{"a":1}\n\n{"b":2}\n').messages).toHaveLength(2);
    expect(parseMessagesText('{"a":').error).toBeTruthy();
  });
});

describe('functions and bindings', () => {
  const ctx = { model: { user: { first: 'Ada', n: 3 }, items: [{ name: 'x' }], now: '2025-12-15T12:00:00Z', ok: true, empty: '' }, scope: '/' };

  it('resolves literals, bindings and relative bindings', () => {
    expect(resolveValue('lit', ctx)).toBe('lit');
    expect(resolveValue({ path: '/user/first' }, ctx)).toBe('Ada');
    expect(resolveValue({ path: 'name' }, { ...ctx, scope: '/items/0' })).toBe('x');
  });

  it('interpolates formatString, including nested calls and escapes', () => {
    expect(formatTemplate('Hello, ${/user/first}! (${/user/n})', ctx)).toBe('Hello, Ada! (3)');
    expect(formatTemplate('\\${/user/first}', ctx)).toBe('${/user/first}');
    expect(formatTemplate("Year ${formatDate(value: ${/now}, format: 'yyyy')}", ctx)).toBe('Year 2025');
    expect(formatTemplate('${pluralize(value: ${/user/n}, one: \'item\', other: \'items\')}', ctx)).toBe('items');
    expect(formatTemplate('${unknownFn(a: 1)} done', ctx)).toBe(' done');
  });

  it('evaluates the validation and logic functions', () => {
    expect(evaluateCall({ call: 'required', args: { value: { path: '/empty' } } }, ctx)).toBe(false);
    expect(evaluateCall({ call: 'email', args: { value: 'a@b.co' } }, ctx)).toBe(true);
    expect(evaluateCall({ call: 'regex', args: { value: '12345', pattern: '^[0-9]{5}$' } }, ctx)).toBe(true);
    expect(evaluateCall({ call: 'length', args: { value: 'abc', min: 4 } }, ctx)).toBe(false);
    expect(evaluateCall({ call: 'numeric', args: { value: '7', max: 5 } }, ctx)).toBe(false);
    expect(
      evaluateCall({ call: 'and', args: { values: [{ path: '/ok' }, { call: 'or', args: { values: [false, { call: 'required', args: { value: { path: '/user/first' } } }] } }] } }, ctx),
    ).toBe(true);
    expect(evaluateCall({ call: 'not', args: { value: { path: '/ok' } } }, ctx)).toBe(false);
    expect(evaluateCall({ call: 'nope' }, ctx)).toBeUndefined();
  });

  it('formats numbers and currencies', () => {
    expect(evaluateCall({ call: 'formatNumber', args: { value: 1234.5, decimals: 1 } }, ctx)).toMatch(/1.?234\.5/);
    expect(evaluateCall({ call: 'formatNumber', args: { value: 'abc' } }, ctx)).toBe('');
    expect(evaluateCall({ call: 'formatCurrency', args: { value: 3, currency: 'usd' } }, ctx)).toMatch(/3\.00/);
  });
});
