/*
 * JSON helpers for streamed tool arguments and for what the model is shown.
 */

class Incomplete extends Error {}
class Invalid extends Error {}

/**
 * Parses JSON that may be cut off mid-stream (`{"a": [1, 2, {"b": "hel`),
 * closing what is open: an unfinished string keeps what arrived, an
 * unfinished number or literal is dropped, as is a key without its value.
 * Returns undefined when nothing usable arrived yet or the text is not JSON.
 */
export function parsePartialJson(text: string): unknown {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* parse tolerantly below */
  }
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const DROP = Symbol('drop');

  const str = (): { value: string; complete: boolean } => {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return { value: out, complete: true };
      }
      if (c === '\\') {
        if (i + 1 >= n) {
          i = n;
          return { value: out, complete: false };
        }
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4 && i + 2 + hex.length >= n) {
            i = n;
            return { value: out, complete: false };
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Invalid();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (!(e in map)) throw new Invalid();
        out += map[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { value: out, complete: false };
  };

  const value = (): unknown => {
    ws();
    if (i >= n) throw new Incomplete();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (i >= n) return obj;
        if (text[i] === '}') {
          i++;
          return obj;
        }
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== '"') throw new Invalid();
        const key = str();
        if (!key.complete) return obj;
        ws();
        if (i >= n) return obj;
        if (text[i] !== ':') throw new Invalid();
        i++;
        ws();
        if (i >= n) return obj;
        let v: unknown;
        try {
          v = value();
        } catch (e) {
          if (e instanceof Incomplete) return obj;
          throw e;
        }
        if (v !== DROP) obj[key.value] = v;
        if (i >= n) return obj;
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (i >= n) return arr;
        if (text[i] === ']') {
          i++;
          return arr;
        }
        if (text[i] === ',') {
          i++;
          continue;
        }
        let v: unknown;
        try {
          v = value();
        } catch (e) {
          if (e instanceof Incomplete) return arr;
          throw e;
        }
        if (v !== DROP) arr.push(v);
        if (i >= n) return arr;
      }
    }
    if (c === '"') return str().value;
    const rest = text.slice(i, i + 64);
    const word = /^(?:true|false|null)/.exec(rest);
    if (word) {
      i += word[0].length;
      return JSON.parse(word[0]);
    }
    const numLike = /^-?\d*(?:\.\d*)?(?:[eE][+-]?\d*)?/.exec(rest)?.[0] ?? '';
    if (numLike && numLike !== '.') {
      const end = i + numLike.length;
      // a number running to the end of the text may be cut short: drop it
      if (end >= n) {
        i = n;
        return DROP;
      }
      if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numLike)) throw new Invalid();
      i = end;
      return Number(numLike);
    }
    // a prefix of a literal at the very end
    if (/^(?:t(?:r(?:u)?)?|f(?:a(?:l(?:s)?)?)?|n(?:u(?:l)?)?)$/.test(text.slice(i))) {
      i = n;
      return DROP;
    }
    throw new Invalid();
  };

  try {
    const v = value();
    ws();
    if (i < n) return undefined; // trailing garbage
    return v === DROP ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * JSON.stringify that never throws (cycles become "[circular]", bigints
 * strings, functions dropped) and cuts the result at `maxChars` with a note.
 */
export function safeJsonStringify(value: unknown, maxChars = Infinity, indent?: number): string {
  const seen = new WeakSet<object>();
  let s: string;
  try {
    s =
      JSON.stringify(
        value,
        (_k, v: unknown) => {
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'function' || typeof v === 'symbol') return undefined;
          if (typeof v === 'number' && !Number.isFinite(v)) return null;
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          return v;
        },
        indent,
      ) ?? 'null';
  } catch {
    s = JSON.stringify(String(value));
  }
  if (s.length <= maxChars) return s;
  const cut = Math.max(0, maxChars - 60);
  return `${s.slice(0, cut)}… [truncated: ${s.length - cut} more characters]`;
}
