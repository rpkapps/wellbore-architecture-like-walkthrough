/*
 * Dynamic values: literals, `{path}` bindings and the basic catalog's
 * client-side functions (validation, formatting, logic). Unknown functions
 * resolve to undefined rather than throwing, so a model that invents one
 * degrades to an empty value instead of a broken surface.
 */
import { getAt, resolvePath } from './pointer';
import type { DataBinding, FunctionCall } from './types';

/** Where a value is resolved: the surface's data model and the template item's absolute path. */
export interface EvalContext {
  model: unknown;
  /** `/` outside templates, `/items/3` inside the fourth item of a template over `/items` */
  scope: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `{ "path": "…" }` and nothing that makes it a function call. */
export function isBinding(v: unknown): v is DataBinding {
  return isRec(v) && typeof v.path === 'string' && !('call' in v);
}

/** `{ "call": "name", "args": {…} }`. */
export function isFunctionCall(v: unknown): v is FunctionCall {
  return isRec(v) && typeof v.call === 'string';
}

/** The basic catalog's functions this kit evaluates. */
export const BASIC_FUNCTIONS = [
  'required',
  'regex',
  'length',
  'numeric',
  'email',
  'formatString',
  'formatNumber',
  'formatCurrency',
  'formatDate',
  'pluralize',
  'openUrl',
  'and',
  'or',
  'not',
] as const;
const FUNCTION_SET = new Set<string>(BASIC_FUNCTIONS);

/** Resolves a dynamic value to a plain one. */
export function resolveValue(v: unknown, ctx: EvalContext): unknown {
  if (isBinding(v)) return getAt(ctx.model, resolvePath(v.path, ctx.scope));
  if (isFunctionCall(v)) return evaluateCall(v, ctx);
  return v;
}

/** The spec's string conversion: null/undefined → '', objects → JSON. */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** Resolves then converts to a string. */
export function resolveText(v: unknown, ctx: EvalContext): string {
  return toText(resolveValue(v, ctx));
}

const toNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Evaluates a function call; unknown functions return undefined. */
export function evaluateCall(fc: FunctionCall, ctx: EvalContext): unknown {
  const rawArgs = isRec(fc.args) ? fc.args : {};
  const arg = (name: string) => resolveArg(rawArgs[name], ctx);
  switch (fc.call) {
    case 'required': {
      const v = arg('value');
      return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
    }
    case 'regex': {
      try {
        return new RegExp(String(arg('pattern') ?? '')).test(toText(arg('value')));
      } catch {
        return false;
      }
    }
    case 'length': {
      const n = toText(arg('value')).length;
      const min = arg('min');
      const max = arg('max');
      return (typeof min !== 'number' || n >= min) && (typeof max !== 'number' || n <= max);
    }
    case 'numeric': {
      const n = toNumber(arg('value'));
      if (Number.isNaN(n)) return false;
      const min = arg('min');
      const max = arg('max');
      return (typeof min !== 'number' || n >= min) && (typeof max !== 'number' || n <= max);
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toText(arg('value')));
    case 'formatString':
      return formatTemplate(toText(arg('value')), ctx);
    case 'formatNumber': {
      const n = toNumber(arg('value'));
      if (Number.isNaN(n)) return '';
      const decimals = arg('decimals');
      const d = typeof decimals === 'number' ? Math.max(0, Math.min(20, decimals)) : undefined;
      return new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d ?? 3, useGrouping: arg('grouping') !== false }).format(n);
    }
    case 'formatCurrency': {
      const n = toNumber(arg('value'));
      if (Number.isNaN(n)) return '';
      const decimals = arg('decimals');
      const d = typeof decimals === 'number' ? Math.max(0, Math.min(20, decimals)) : 2;
      const currency = String(arg('currency') ?? 'USD').toUpperCase();
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: arg('grouping') !== false }).format(n);
      } catch {
        return `${currency} ${n.toFixed(d)}`;
      }
    }
    case 'formatDate':
      return formatDatePattern(arg('value'), String(arg('format') ?? 'yyyy-MM-dd'));
    case 'pluralize': {
      const n = toNumber(arg('value'));
      const forms: Rec = {};
      for (const k of ['zero', 'one', 'two', 'few', 'many', 'other']) forms[k] = arg(k);
      let cat: string;
      if (n === 0 && forms.zero !== undefined) cat = 'zero';
      else if (n === 1 && forms.one !== undefined) cat = 'one';
      else if (n === 2 && forms.two !== undefined) cat = 'two';
      else cat = new Intl.PluralRules().select(n);
      return toText(forms[cat] ?? forms.other);
    }
    case 'and': {
      const values = arg('values');
      return Array.isArray(values) ? values.every((x) => !!resolveArg(x, ctx)) : false;
    }
    case 'or': {
      const values = arg('values');
      return Array.isArray(values) ? values.some((x) => !!resolveArg(x, ctx)) : false;
    }
    case 'not':
      return !arg('value');
    case 'openUrl':
      return undefined;
    default:
      return undefined;
  }
}

function resolveArg(v: unknown, ctx: EvalContext): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveArg(x, ctx));
  return resolveValue(v, ctx);
}

/** A function call the kit knows (the rest are ignored). */
export function isKnownFunction(name: string): boolean {
  return FUNCTION_SET.has(name);
}

/** Opens an http(s) URL in a new tab (`openUrl`); anything else is ignored. */
export function openUrl(url: unknown): void {
  if (typeof url !== 'string' || typeof window === 'undefined') return;
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') window.open(u.href, '_blank', 'noopener,noreferrer');
  } catch {
    /* not a URL */
  }
}

// ------------------------------------------------------------------ formatString

/**
 * Interpolates `${/abs/path}`, `${relative/path}` and
 * `${fn(arg: 'lit', other: ${/path})}` expressions; `\${` is a literal `${`.
 */
export function formatTemplate(template: string, ctx: EvalContext): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (template[i] === '\\' && template.startsWith('${', i + 1)) {
      out += '${';
      i += 3;
      continue;
    }
    if (template.startsWith('${', i)) {
      const parsed = parseExpression(template, i + 2);
      if (parsed) {
        out += toText(evalExpr(parsed.expr, ctx));
        i = parsed.end;
        continue;
      }
    }
    out += template[i];
    i++;
  }
  return out;
}

type Expr = { kind: 'path'; path: string } | { kind: 'lit'; value: unknown } | { kind: 'call'; name: string; args: Record<string, Expr> };

function evalExpr(e: Expr, ctx: EvalContext): unknown {
  if (e.kind === 'lit') return e.value;
  if (e.kind === 'path') return getAt(ctx.model, resolvePath(e.path, ctx.scope));
  // evaluate args eagerly into literal values so evaluateCall sees plain data
  const plain: Rec = {};
  for (const [k, v] of Object.entries(e.args)) plain[k] = evalExpr(v, ctx);
  return evaluateCall({ call: e.name, args: plain }, ctx);
}

/** Parses the body of a `${…}` starting at `start`; returns the expression and the index after the closing `}`. */
function parseExpression(s: string, start: number): { expr: Expr; end: number } | null {
  let i = start;
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const parseValue = (): Expr | null => {
    skip();
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      let str = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        str += s[j];
        j++;
      }
      if (j >= s.length) return null;
      i = j + 1;
      return { kind: 'lit', value: str };
    }
    if (s.startsWith('${', i)) {
      const inner = parseExpression(s, i + 2);
      if (!inner) return null;
      i = inner.end;
      return inner.expr;
    }
    const m = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return { kind: 'lit', value: JSON.parse(m[0]) };
    }
    // a bare path or a nested call
    return parseBody(')');
  };
  const parseBody = (terminator: string): Expr | null => {
    skip();
    const m = /^([A-Za-z_][\w]*)\s*\(/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      const args: Record<string, Expr> = {};
      skip();
      while (i < s.length && s[i] !== ')') {
        skip();
        const km = /^([A-Za-z_][\w]*)\s*:/.exec(s.slice(i));
        if (!km) return null;
        i += km[0].length;
        const v = parseValue();
        if (!v) return null;
        args[km[1]] = v;
        skip();
        if (s[i] === ',') i++;
        skip();
      }
      if (s[i] !== ')') return null;
      i++;
      return { kind: 'call', name: m[1], args };
    }
    let j = i;
    while (j < s.length && s[j] !== '}' && s[j] !== terminator && s[j] !== ',') j++;
    const path = s.slice(i, j).trim();
    if (!path) return null;
    i = j;
    return { kind: 'path', path };
  };
  const expr = parseBody('}');
  if (!expr) return null;
  skip();
  if (s[i] !== '}') return null;
  return { expr, end: i + 1 };
}

// ------------------------------------------------------------------ formatDate

const DATE_TOKENS = /yyyy|yy|YYYY|MMMM|MMM|MM|M|EEEE|EEE|E|dd|d|HH|H|hh|h|mm|ss|a|'[^']*'/g;

/** Parses epoch milliseconds, ISO strings and Date objects. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Formats a date with TR35-style tokens (`yyyy-MM-dd`, `EEEE, MMMM d`, `h:mm a`), in local time. */
export function formatDatePattern(value: unknown, pattern: string): string {
  const d = toDate(value);
  if (!d) return '';
  if (pattern === 'ISO') return d.toISOString();
  const long = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, opts).format(d);
  const h = d.getHours();
  return pattern.replace(DATE_TOKENS, (t) => {
    switch (t) {
      case 'yyyy':
      case 'YYYY':
        return String(d.getFullYear());
      case 'yy':
        return String(d.getFullYear()).slice(-2);
      case 'MMMM':
        return long({ month: 'long' });
      case 'MMM':
        return long({ month: 'short' });
      case 'MM':
        return String(d.getMonth() + 1).padStart(2, '0');
      case 'M':
        return String(d.getMonth() + 1);
      case 'EEEE':
        return long({ weekday: 'long' });
      case 'EEE':
      case 'E':
        return long({ weekday: 'short' });
      case 'dd':
        return String(d.getDate()).padStart(2, '0');
      case 'd':
        return String(d.getDate());
      case 'HH':
        return String(h).padStart(2, '0');
      case 'H':
        return String(h);
      case 'hh':
        return String(h % 12 || 12).padStart(2, '0');
      case 'h':
        return String(h % 12 || 12);
      case 'mm':
        return String(d.getMinutes()).padStart(2, '0');
      case 'ss':
        return String(d.getSeconds()).padStart(2, '0');
      case 'a':
        return h < 12 ? 'AM' : 'PM';
      default:
        return t.startsWith("'") ? t.slice(1, -1) : t;
    }
  });
}
