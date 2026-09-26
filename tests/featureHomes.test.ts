import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closesWithWindow,
  FEATURES,
  FeatureFlags,
  featuresAt,
  GRAPHICS_IDS,
  GRAPHICS_PRESETS,
  graphicsQuality,
  setGraphicsQuality,
  windowClosed,
  type FeatureId,
  type GraphicsId,
} from '../src/features/registry';
import { DOCK_PANELS, openPanels, Workspace, type Layout } from '../src/ui/workspace/layout';

/** An in-memory localStorage: each test starts empty. */
function stubStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  });
  return m;
}

let store: Map<string, string>;
beforeEach(() => {
  store = stubStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where each feature lives', () => {
  it('gives every feature a home, as the Features panel is gone', () => {
    expect(featuresAt('view').map((f) => f.id)).toEqual(['section', 'correlation', 'crossplot', 'cylinder', 'simulation', 'mapview']);
    expect(featuresAt('overlay').map((f) => f.id)).toEqual(['geosteer', 'curtain', 'owc', 'uncertainty', 'anticollision']);
    expect(featuresAt('graphics').map((f) => f.id)).toEqual(GRAPHICS_IDS);
    expect(featuresAt('tool').map((f) => f.id)).toEqual(['measure', 'views', 'snapshot']);
    expect(FEATURES.every((f) => f.home)).toBe(true);
  });
});

describe('closing a view’s window', () => {
  it('turns a window-only feature off, so it stops computing', () => {
    const flags = new FeatureFlags(false, '?features=crossplot,geosteer');
    const hide = vi.fn();
    for (const id of ['section', 'correlation', 'crossplot', 'cylinder', 'mapview', 'simulation'] as FeatureId[]) expect(closesWithWindow(id)).toBe(true);
    windowClosed(flags, 'crossplot', hide);
    expect(flags.on('crossplot')).toBe(false);
    expect(hide).not.toHaveBeenCalled();
  });

  it('only hides the geosteering window: its band in 3D stays until its eye hides it', () => {
    const flags = new FeatureFlags(false, '?features=geosteer');
    const hide = vi.fn();
    expect(closesWithWindow('geosteer')).toBe(false);
    windowClosed(flags, 'geosteer', hide);
    expect(flags.on('geosteer')).toBe(true);
    expect(hide).toHaveBeenCalledOnce();
  });
});

describe('graphics quality', () => {
  const on = (flags: FeatureFlags) => (id: GraphicsId) => flags.on(id);

  it('maps Low, Medium and High to the four GPU switches', () => {
    expect(GRAPHICS_PRESETS.low).toEqual({ textures: false, shadows: false, tunnelFx: false, seaFx: false });
    expect(GRAPHICS_PRESETS.medium).toEqual({ textures: true, shadows: false, tunnelFx: false, seaFx: true });
    expect(GRAPHICS_PRESETS.high).toEqual({ textures: true, shadows: true, tunnelFx: true, seaFx: true });
    const flags = new FeatureFlags(false, '');
    for (const q of ['low', 'medium', 'high'] as const) {
      setGraphicsQuality(flags, q);
      expect(graphicsQuality(on(flags))).toBe(q);
    }
    flags.set('shadows', true);
    flags.set('textures', false);
    expect(graphicsQuality(on(flags))).toBe('custom');
  });

  it('starts at High, and at Low in the low-quality mode (?q=low)', () => {
    expect(graphicsQuality(on(new FeatureFlags(false, '')))).toBe('high');
    expect(graphicsQuality(on(new FeatureFlags(true, '')))).toBe('low');
  });
});

describe('features without a switch', () => {
  it('come back on although the old Features panel stored them off; the URL still decides', () => {
    store.set('vwt.features.v1', JSON.stringify({ measure: false, rop: false, curtain: false }));
    const flags = new FeatureFlags(false, '');
    expect(flags.on('measure')).toBe(true);
    expect(flags.on('rop')).toBe(true);
    // an overlay keeps its stored state: its eye can turn it back on
    expect(flags.on('curtain')).toBe(false);
    expect(new FeatureFlags(false, '?features=none').on('measure')).toBe(false);
  });
});

describe('a stored layout naming the retired Features panel', () => {
  it('loads, and drops the panel as the layout is applied', () => {
    expect(DOCK_PANELS.has('features')).toBe(false);
    const L: Layout = {
      v: 2,
      left: { size: 300, collapsed: false, stacks: [{ id: 's1', panels: ['scene', 'features'], active: 'features', weight: 1 }] },
      right: { size: 400, collapsed: false, stacks: [] },
      bottom: { size: 260, collapsed: false, stacks: [] },
      floating: [],
    };
    store.set('bw.workspace.v2', JSON.stringify({ v: 2, active: 'walkthrough', layouts: { walkthrough: L } }));
    const ws = new Workspace();
    expect(ws.value.left.stacks[0].panels).toContain('features');
    // what the app does once it knows its panels (app.hasPanel: the dock panels and open tool windows)
    ws.apply(ws.value, (id) => DOCK_PANELS.has(id));
    expect(openPanels(ws.value)).not.toContain('features');
    expect(ws.value.left.stacks[0]).toMatchObject({ panels: ['scene'], active: 'scene' });
  });
});
