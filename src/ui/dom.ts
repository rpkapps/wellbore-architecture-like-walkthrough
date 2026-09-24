type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Tiny hyperscript helper. Strings starting with '<' are inserted as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.style.cssText = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string') {
      if (c.trimStart().startsWith('<')) el.insertAdjacentHTML('beforeend', c);
      else el.appendChild(document.createTextNode(c));
    } else el.appendChild(c);
  }
  return el;
}

export function setRangeFill(input: HTMLInputElement) {
  const min = +input.min || 0;
  const max = +input.max || 100;
  const p = ((+input.value - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}): { el: HTMLElement; input: HTMLInputElement; set: (v: number) => void } {
  const val = h('span', { class: 'val' });
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value });
  const fmt = opts.format ?? ((v: number) => String(v));
  const update = () => {
    val.textContent = fmt(+input.value);
    setRangeFill(input);
  };
  input.addEventListener('input', () => {
    update();
    opts.onInput(+input.value);
  });
  update();
  const el = h('div', { class: 'slider-row' }, h('label', {}, opts.label), val, input);
  return {
    el,
    input,
    set: (v: number) => {
      input.value = String(v);
      update();
    },
  };
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, extra?: Node): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'row' }, h('label', {}, label, extra ?? ''), h('label', { class: 'switch' }, input, h('span')));
}

export function chip(kind: string, text?: string): string {
  const labels: Record<string, string> = {
    measured: 'Measured',
    calculated: 'Calculated',
    interpreted: 'Operator interp.',
    reconstructed: 'Reconstructed',
    definitive: 'Definitive',
    schematic: 'Schematic',
    user: 'Uploaded',
  };
  return `<span class="chip ${kind}">${text ?? labels[kind] ?? kind}</span>`;
}

export const fmt = {
  n: (v: number, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'),
  pct: (v: number, d = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—'),
  big: (v: number) => {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)} G`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(1)} k`;
    return v.toFixed(0);
  },
  res: (v: number) => (!Number.isFinite(v) ? '—' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)),
};

export function download(name: string, text: string, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}
