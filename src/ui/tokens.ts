/**
 * Tecton theme values for the 2D canvases (log tracks, strips, charts), which
 * cannot use CSS. Read from the document once the stylesheet is applied.
 */
const cache = new Map<string, string>();

/** Forget cached values (the accent or density changed). */
export function clearCssVarCache() {
  cache.clear();
}

export function cssVar(name: string, fallback = '#888'): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) cache.set(name, v);
  }
  return v || fallback;
}

/** Is the light theme on? (canvases pick their washes from it) */
export const isLight = () => typeof document !== 'undefined' && !document.documentElement.classList.contains('dark');

/**
 * A faint wash or hairline for canvases: white at `a` on the dark theme, black
 * (a little stronger, it reads weaker) on the light one.
 */
export function wash(a: number): string {
  return isLight() ? `rgba(0,0,0,${Math.min(1, a * 1.4).toFixed(3)})` : `rgba(255,255,255,${a})`;
}

/** Semantic colours and fonts the canvas renderers share. */
export const ink = {
  get text() {
    return cssVar('--foreground', '#e7ecf1');
  },
  get muted() {
    return cssVar('--muted-foreground', '#a3aeb9');
  },
  get faint() {
    return cssVar('--tecton-palette-gray-460', '#6d7986');
  },
  get grid() {
    return cssVar('--border', 'rgba(255,255,255,0.08)');
  },
  get primary() {
    return cssVar('--primary', '#7fe3ff');
  },
  get card() {
    return cssVar('--card', '#101418');
  },
};

export const font = {
  sans: (size: number, weight = 500) => `${weight} ${size}px Figtree, ui-sans-serif, system-ui, sans-serif`,
  mono: (size: number, weight = 500) => `${weight} ${size}px "IBM Plex Mono", ui-monospace, monospace`,
};
