import { describe, expect, it } from 'vitest';
import { Rev, Signal } from '../src/ui/signal';

describe('Signal', () => {
  it('notifies subscribers only when the value changes', () => {
    const s = new Signal(1);
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s.set(1);
    expect(calls).toBe(0);
    s.set(2);
    s.update((v) => v + 1);
    expect(s.value).toBe(3);
    expect(calls).toBe(2);
    off();
    s.set(4);
    expect(calls).toBe(2);
  });

  it('lets a listener unsubscribe while being notified', () => {
    const s = new Signal('a');
    const seen: string[] = [];
    const off = s.subscribe(() => {
      seen.push('first');
      off();
    });
    s.subscribe(() => seen.push('second'));
    s.set('b');
    s.set('c');
    expect(seen).toEqual(['first', 'second', 'second']);
  });
});

describe('Rev', () => {
  it('counts bumps', () => {
    const r = new Rev();
    let calls = 0;
    r.subscribe(() => calls++);
    r.bump();
    r.bump();
    expect(r.value).toBe(2);
    expect(calls).toBe(2);
  });
});
