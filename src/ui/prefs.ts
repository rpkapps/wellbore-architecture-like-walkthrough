import { Signal, useSignalPart } from './signal';
import { clearCssVarCache } from './tokens';

/**
 * Personal settings: how the chrome looks and moves. Stored per browser and
 * applied as CSS variables on the document, so a change costs no render.
 */
export type Density = 'compact' | 'default' | 'comfortable';
export type Accent = 'orchid' | 'azure' | 'blue' | 'green' | 'yellow' | 'pink' | 'saffron';
export type LabelDensity = 'all' | 'near' | 'few';
export type Theme = 'dark' | 'light' | 'system';

export interface Prefs {
  theme: Theme;
  density: Density;
  accent: Accent;
  /** 0.55 … 1: panels over the 3D view */
  panelOpacity: number;
  /** px of background blur behind translucent panels */
  panelBlur: number;
  /** overlays over the 3D view start as one-line chips */
  overlaysCollapsed: boolean;
  labels: boolean;
  labelDensity: LabelDensity;
  reduceMotion: boolean;
  /** the contextual task bar next to the selected object (its likely next steps) */
  taskBar: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  density: 'default',
  accent: 'orchid',
  panelOpacity: 1,
  panelBlur: 0,
  overlaysCollapsed: false,
  labels: true,
  labelDensity: 'near',
  reduceMotion: false,
  taskBar: true,
};

export const DENSITY_ROOT: Record<Density, number> = { compact: 14, default: 15, comfortable: 17 };

/**
 * The density's text scale for SVG text and the lengths around it in React
 * (1 at Compact; canvases use `textScale` in tokens.ts). Re-renders only when
 * the density changes, not on every opacity or blur scrub.
 */
export function useTextScale(): number {
  return DENSITY_ROOT[useSignalPart(prefs, (p) => p.density)] / 14;
}

/** Palette step of each accent family that reads well on the dark theme. */
export const ACCENTS: { id: Accent; label: string; step: string }[] = [
  { id: 'orchid', label: 'Violet', step: 'orchid-460' },
  { id: 'azure', label: 'Teal', step: 'azure-560' },
  { id: 'blue', label: 'Blue', step: 'blue-460' },
  { id: 'green', label: 'Green', step: 'green-560' },
  { id: 'yellow', label: 'Amber', step: 'yellow-830' },
  { id: 'pink', label: 'Coral', step: 'pink-460' },
  { id: 'saffron', label: 'Copper', step: 'saffron-560' },
];

const KEY = 'bw.prefs.v1';

function load(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export const prefs = new Signal<Prefs>(load());

export function setPrefs(p: Partial<Prefs>) {
  prefs.set({ ...prefs.value, ...p });
}

const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** The theme in effect ('system' resolved). */
export function resolvedTheme(p: Prefs = prefs.value): 'dark' | 'light' {
  return p.theme === 'system' ? (systemDark?.matches === false ? 'light' : 'dark') : p.theme;
}

/**
 * Bumped when the resolved theme, the accent or the density changes: canvases
 * redraw with the new colours and text sizes, and the 3D labels are placed again.
 */
export const themeRev = new Signal(0);
let lastLook: string | null = null;

/** Write the settings to the document (called on load and on every change). */
export function applyPrefs(p: Prefs = prefs.value) {
  if (typeof document === 'undefined') return;
  const r = document.documentElement;
  const theme = resolvedTheme(p);
  r.classList.toggle('dark', theme === 'dark');
  r.classList.toggle('light', theme === 'light');
  r.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1d1c1f' : '#ffffff');
  r.style.setProperty('--ui-root', `${DENSITY_ROOT[p.density]}px`);
  r.style.setProperty('--ui-accent', `var(--tecton-palette-${ACCENTS.find((a) => a.id === p.accent)?.step ?? 'orchid-460'})`);
  r.style.setProperty('--panel-alpha', String(p.panelOpacity));
  r.style.setProperty('--panel-blur', `${p.panelBlur}px`);
  // a backdrop filter costs a render pass over the 3D view even at blur(0): only set one when there is a blur
  r.toggleAttribute('data-panel-blur', p.panelBlur > 0);
  r.toggleAttribute('data-reduce-motion', p.reduceMotion);
  clearCssVarCache();
  const look = `${theme} ${p.accent} ${p.density}`;
  if (look !== lastLook) {
    const first = lastLook === null;
    lastLook = look;
    if (!first) themeRev.set(themeRev.value + 1);
  }
}

systemDark?.addEventListener('change', () => prefs.value.theme === 'system' && applyPrefs());

prefs.subscribe(() => {
  applyPrefs();
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.value));
  } catch {
    /* storage blocked: the settings last for this session */
  }
});
applyPrefs();

const OVERLAYS = ['legend', 'inspector', 'narrative'];

/** bumped by "collapse / expand all": every overlay adopts `overlayState.collapsed` */
export const overlayBroadcast = new Signal(0);
export const overlayState = { collapsed: false };

export function setAllOverlays(collapsed: boolean) {
  for (const id of OVERLAYS) {
    try {
      localStorage.setItem(`bw.overlay.${id}`, collapsed ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }
  overlayState.collapsed = collapsed;
  overlayBroadcast.set(overlayBroadcast.value + 1);
}
