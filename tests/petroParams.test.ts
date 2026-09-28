import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, PARAM_RANGES, paramProblem } from '../src/data/petro';

describe('interpretation parameter limits', () => {
  it('accepts the defaults and values inside the ranges', () => {
    for (const [key, [lo, hi]] of Object.entries(PARAM_RANGES) as [keyof typeof PARAM_RANGES, [number, number]][]) {
      expect(paramProblem(DEFAULT_PARAMS, key, DEFAULT_PARAMS[key])).toBeNull();
      if (key !== 'grClean' && key !== 'grShale') {
        expect(paramProblem(DEFAULT_PARAMS, key, lo)).toBeNull();
        expect(paramProblem(DEFAULT_PARAMS, key, hi)).toBeNull();
      }
    }
  });

  it('refuses values the equations break on', () => {
    expect(paramProblem(DEFAULT_PARAMS, 'm', 0)).toMatch(/between 1.5 and 2.6/);
    expect(paramProblem(DEFAULT_PARAMS, 'rw', 0)).toMatch(/between/);
    expect(paramProblem(DEFAULT_PARAMS, 'cutSw', NaN)).toMatch(/finite/);
    expect(paramProblem(DEFAULT_PARAMS, 'rw', Infinity)).toMatch(/finite/);
    expect(paramProblem({ ...DEFAULT_PARAMS, grShale: 60 }, 'grClean', 70)).toMatch(/below grShale/);
    expect(paramProblem({ ...DEFAULT_PARAMS, grClean: 70 }, 'grShale', 60)).toMatch(/above grClean/);
  });
});
