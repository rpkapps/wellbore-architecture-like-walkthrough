/** A short random id (`prefix_` + 10 base-36 characters), from `crypto` when the platform has it. */
export function newId(prefix = ''): string {
  let s = '';
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(10));
    for (const b of bytes) s += (b % 36).toString(36);
  } else {
    for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
  }
  return prefix ? `${prefix}_${s}` : s;
}
