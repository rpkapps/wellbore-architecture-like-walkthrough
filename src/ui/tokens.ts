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

/** The chrome's root text size in px (the density setting: 14, 15 or 17), from the cached `--ui-root`. */
export function uiRoot(): number {
  return parseFloat(cssVar('--ui-root', '15px')) || 15;
}

/**
 * How much canvas and SVG text grows with the density setting: 1 at a 14 px
 * root (Compact), 15/14 at Default, 17/14 at Roomy. Sizes in the drawing code
 * are written for Compact; lengths that hold text (header rows, gutters) scale too.
 */
export function textScale(): number {
  return uiRoot() / 14;
}

/**
 * A text size of the drawing code in CSS px at the current density. Nothing
 * draws below 9.5 px at Compact (10.2 px at Default) however small it was written.
 */
export function textPx(size: number): number {
  return scaledPx(size, textScale());
}

/** `textPx` at a given text scale (React code that knows the density without reading the document). */
export function scaledPx(size: number, k: number): number {
  return Math.round(Math.max(size, 9.5) * k * 10) / 10;
}

/** A length that holds text (a row, a gutter), scaled like the text in it, in whole px. */
export function textLen(px: number): number {
  return Math.round(px * textScale());
}

/** Canvas fonts at an exact size, for pictures with a layout of their own (the snapshot export). */
export const fixedFont = {
  sans: (size: number, weight = 500) => `${weight} ${size}px Figtree, ui-sans-serif, system-ui, sans-serif`,
  mono: (size: number, weight = 500) => `${weight} ${size}px "IBM Plex Mono", ui-monospace, monospace`,
};

/** Canvas fonts that follow the density setting (see `textPx`). */
export const font = {
  sans: (size: number, weight = 500) => fixedFont.sans(textPx(size), weight),
  mono: (size: number, weight = 500) => fixedFont.mono(textPx(size), weight),
};
