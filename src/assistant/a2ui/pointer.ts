/*
 * JSON Pointer (RFC 6901) reads and immutable writes over a surface's data
 * model, plus A2UI's one deviation: a path without a leading `/` is relative
 * to the current template item (`name` inside the item at `/items/3` is
 * `/items/3/name`). Writes share structure, so untouched subtrees keep their
 * identity and memoised views bound to them do not re-render.
 */

/** Splits a pointer into unescaped tokens (`/a~1b/0` → `['a/b', '0']`); `''` and `/` are the root. */
export function parsePointer(pointer: string): string[] {
  if (!pointer || pointer === '/') return [];
  const body = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  return body.split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Joins tokens back into an absolute pointer. */
export function formatPointer(tokens: readonly (string | number)[]): string {
  return tokens.length ? '/' + tokens.map((t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '/';
}

/** Resolves a binding path against a template scope (an absolute pointer, `/` outside templates). */
export function resolvePath(path: string, scope = '/'): string {
  if (path.startsWith('/')) return path;
  let rel = path.trim();
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (rel === '' || rel === '.') return scope || '/';
  const base = !scope || scope === '/' ? '' : scope.replace(/\/$/, '');
  return `${base}/${rel}`;
}

/** Reads the value at `pointer`, or undefined when any step is missing. */
export function getAt(model: unknown, pointer: string): unknown {
  let cur: unknown = model;
  for (const token of parsePointer(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const i = token === '-' ? cur.length : Number(token);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else {
      cur = (cur as Record<string, unknown>)[token];
    }
  }
  return cur;
}

const isIndex = (token: string) => /^(0|[1-9]\d*)$/.test(token) || token === '-';

function setIn(node: unknown, tokens: string[], i: number, value: unknown, remove: boolean): unknown {
  if (i === tokens.length) return value;
  const token = tokens[i];
  if (Array.isArray(node)) {
    const idx = token === '-' ? node.length : Number(token);
    if (!Number.isInteger(idx) || idx < 0) return node;
    const copy = node.slice();
    if (remove && i === tokens.length - 1) {
      // the spec keeps the array's length: the element becomes undefined
      if (idx < copy.length) copy[idx] = undefined;
      return copy;
    }
    copy[idx] = setIn(node[idx], tokens, i + 1, value, remove);
    return copy;
  }
  const obj = node !== null && typeof node === 'object' ? (node as Record<string, unknown>) : undefined;
  if (remove && i === tokens.length - 1) {
    if (!obj || !(token in obj)) return node;
    const { [token]: _gone, ...rest } = obj;
    void _gone;
    return rest;
  }
  if (!obj && remove) return node;
  // create intermediate containers: an array when the next token is an index
  const child = obj ? obj[token] : undefined;
  const nextChild = child === undefined && i + 1 < tokens.length && isIndex(tokens[i + 1]) ? [] : child;
  return { ...(obj ?? {}), [token]: setIn(nextChild, tokens, i + 1, value, remove) };
}

/** Returns a copy of `model` with `value` at `pointer` (intermediate objects created); `/` replaces the model. */
export function setAt(model: unknown, pointer: string, value: unknown): unknown {
  return setIn(model, parsePointer(pointer), 0, value, false);
}

/** Returns a copy of `model` without the key at `pointer` (an array element becomes undefined). */
export function removeAt(model: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  if (!tokens.length) return {};
  return setIn(model, tokens, 0, undefined, true);
}
