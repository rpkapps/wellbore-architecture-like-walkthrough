/**
 * A small, safe formula language for derived channels and row filters:
 *
 *   (GR - 20) / (130 - 20)          RT / RXO            ROPA > 0 && WOBA < 30
 *   clamp([Bit depth] * 0.3048, 0, 9000)                if(SPPA > 250, 1, 0)
 *
 * Numbers, channel names (bare, or in [brackets] / `backticks` when they have
 * spaces or dots), + - * / % ^, comparisons, && || !, `a ? b : c` and a fixed
 * set of maths functions. It is parsed once into a tree of closures: there is
 * no `eval`, no property access and no way to reach anything but the row's
 * numbers.
 */
export type Row = (name: string) => number;
type Node = (row: Row) => number;

const FUNCS: Record<string, { n: [number, number]; f: (...a: number[]) => number }> = {
  abs: { n: [1, 1], f: Math.abs },
  sqrt: { n: [1, 1], f: Math.sqrt },
  exp: { n: [1, 1], f: Math.exp },
  ln: { n: [1, 1], f: Math.log },
  log: { n: [1, 2], f: (a, b) => (b === undefined ? Math.log(a) : Math.log(a) / Math.log(b)) },
  log10: { n: [1, 1], f: Math.log10 },
  pow: { n: [2, 2], f: Math.pow },
  min: { n: [1, 16], f: (...a) => (a.some(Number.isNaN) ? NaN : Math.min(...a)) },
  max: { n: [1, 16], f: (...a) => (a.some(Number.isNaN) ? NaN : Math.max(...a)) },
  clamp: { n: [3, 3], f: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  round: { n: [1, 2], f: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  floor: { n: [1, 1], f: Math.floor },
  ceil: { n: [1, 1], f: Math.ceil },
  sin: { n: [1, 1], f: (x) => Math.sin((x * Math.PI) / 180) },
  cos: { n: [1, 1], f: (x) => Math.cos((x * Math.PI) / 180) },
  tan: { n: [1, 1], f: (x) => Math.tan((x * Math.PI) / 180) },
  if: { n: [3, 3], f: (c, a, b) => (c ? a : b) },
  isnan: { n: [1, 1], f: (x) => +Number.isNaN(x) },
  coalesce: { n: [1, 16], f: (...a) => a.find((x) => !Number.isNaN(x)) ?? NaN },
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, nan: NaN, true: 1, false: 0 };

export class ExprError extends Error {}

interface Tok {
  t: 'num' | 'id' | 'op' | 'end';
  v: string;
  at: number;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}" at ${i + 1}`);
      out.push({ t: 'num', v: m[0], at });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], at });
      i += m[0].length;
    } else if (c === '[' || c === '`') {
      const close = c === '[' ? ']' : '`';
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new ExprError(`Unclosed ${c} at ${i + 1}`);
      out.push({ t: 'id', v: src.slice(i + 1, j), at });
      i = j + 1;
    } else {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
        out.push({ t: 'op', v: two, at });
        i += 2;
      } else if ('+-*/%^()<>!?:,'.includes(c)) {
        out.push({ t: 'op', v: c, at });
        i++;
      } else throw new ExprError(`Unexpected "${c}" at ${i + 1}`);
    }
  }
  out.push({ t: 'end', v: '', at: src.length });
  return out;
}

export interface Compiled {
  eval: (row: Row) => number;
  /** the channel names the formula reads */
  inputs: string[];
}

export function compile(src: string): Compiled {
  if (src.length > 2000) throw new ExprError('Formula is too long.');
  const toks = lex(src);
  let p = 0;
  const inputs = new Set<string>();
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (v !== undefined && t.v !== v) throw new ExprError(`Expected "${v}" at ${t.at + 1}${t.t === 'end' ? ' (end of formula)' : ''}`);
    p++;
    return t;
  };
  let depth = 0;

  const ternary = (): Node => {
    const c = or();
    if (peek().v !== '?') return c;
    eat('?');
    const a = ternary();
    eat(':');
    const b = ternary();
    return (r) => (c(r) ? a(r) : b(r));
  };
  const bin = (next: () => Node, ops: Record<string, (a: number, b: number) => number>) => (): Node => {
    let left = next();
    while (peek().t === 'op' && ops[peek().v]) {
      const f = ops[eat().v];
      const l = left;
      const r = next();
      left = (row) => f(l(row), r(row));
    }
    return left;
  };
  const unary = (): Node => {
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      eat();
      const x = unary();
      return t.v === '-' ? (r) => -x(r) : t.v === '!' ? (r) => +!x(r) : x;
    }
    return power();
  };
  const power = (): Node => {
    const b = atom();
    if (peek().v !== '^') return b;
    eat('^');
    const e = unary(); // right-associative, binds tighter than unary minus on the left
    return (r) => b(r) ** e(r);
  };
  const atom = (): Node => {
    if (++depth > 200) throw new ExprError('Formula is nested too deeply.');
    try {
      const t = eat();
      if (t.t === 'num') {
        const v = Number(t.v);
        return () => v;
      }
      if (t.t === 'op' && t.v === '(') {
        const x = ternary();
        eat(')');
        return x;
      }
      if (t.t === 'id') {
        if (peek().v === '(' && FUNCS[t.v.toLowerCase()]) {
          const fn = FUNCS[t.v.toLowerCase()];
          eat('(');
          const args: Node[] = [];
          if (peek().v !== ')')
            for (;;) {
              args.push(ternary());
              if (peek().v !== ',') break;
              eat(',');
            }
          eat(')');
          if (args.length < fn.n[0] || args.length > fn.n[1]) throw new ExprError(`${t.v}() takes ${fn.n[0] === fn.n[1] ? fn.n[0] : `${fn.n[0]}–${fn.n[1]}`} arguments`);
          return (r) => fn.f(...args.map((a) => a(r)));
        }
        const k = t.v.toLowerCase();
        if (k in CONSTS && !/[\s.]/.test(t.v)) {
          const v = CONSTS[k];
          return () => v;
        }
        const name = t.v;
        inputs.add(name);
        return (r) => r(name);
      }
      throw new ExprError(t.t === 'end' ? 'The formula ends too early.' : `Unexpected "${t.v}" at ${t.at + 1}`);
    } finally {
      depth--;
    }
  };
  const mul = bin(unary, { '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b });
  const add = bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const cmp = bin(add, { '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b) });
  const eq = bin(cmp, { '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const and = bin(eq, { '&&': (a, b) => +(!!a && !!b) });
  const or = bin(and, { '||': (a, b) => +(!!a || !!b) });

  const root = ternary();
  if (peek().t !== 'end') throw new ExprError(`Unexpected "${peek().v}" at ${peek().at + 1}`);
  return { eval: root, inputs: [...inputs] };
}
