import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locate, openPanels, PRESETS, Workspace, type Layout } from '../src/ui/workspace/layout';

/** An in-memory localStorage: each test starts empty, and a second Workspace reads what the first saved. */
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

const all = () => true;

const fresh = () => {
  const ws = new Workspace();
  ws.preset('walkthrough', () => true);
  return ws;
};

describe('workspace layout', () => {
  it('starts from the walkthrough preset', () => {
    const ws = fresh();
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'interpretation']);
    expect(ws.value.right.stacks[0].panels).toEqual(['logs']);
  });

  it('moves a tab into a new group below another and cleans up empty groups', () => {
    const ws = fresh();
    const s = ws.value.left.stacks[0].id;
    ws.move('interpretation', { kind: 'split', zone: 'left', stack: s, where: 'after' });
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene'], ['interpretation'], ['properties']]);
    ws.move('interpretation', { kind: 'tab', stack: s, index: 0 });
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['interpretation', 'scene'], ['properties']]);
  });

  it('floats a panel and docks it back to a column', () => {
    const ws = fresh();
    ws.move('logs', { kind: 'float', x: 10, y: 20, w: 300, h: 200 });
    expect(ws.value.right.stacks).toHaveLength(0);
    expect(locate(ws.value, 'logs')?.kind).toBe('float');
    ws.dock('logs', 'bottom');
    expect(ws.value.floating).toHaveLength(0);
    expect(ws.value.bottom.stacks[0].panels).toEqual(['logs']);
  });

  it('reopens a closed panel where it was', () => {
    const ws = fresh();
    ws.move('interpretation', { kind: 'zone', zone: 'bottom' });
    ws.close('interpretation');
    expect(openPanels(ws.value)).not.toContain('interpretation');
    ws.open('interpretation');
    expect(locate(ws.value, 'interpretation')).toMatchObject({ kind: 'dock', zone: 'bottom' });
  });

  it('reorders tabs within a group', () => {
    const ws = fresh();
    const s = ws.value.left.stacks[0].id;
    ws.move('scene', { kind: 'tab', stack: s, index: 3 });
    expect(ws.value.left.stacks[0].panels).toEqual(['interpretation', 'scene']);
  });

  it('clamps column sizes and folds columns', () => {
    const ws = fresh();
    ws.setSize('left', 5);
    expect(ws.value.left.size).toBe(220);
    expect(ws.toggleZone('left')).toBe(true);
    expect(ws.value.left.collapsed).toBe(true);
    ws.activate('scene');
    expect(ws.value.left.collapsed).toBe(false);
  });

  it('applies a preset without panels that do not exist and keeps open tool windows', () => {
    const ws = fresh();
    ws.open('mapview');
    ws.preset('geosteering', (id) => id !== 'section');
    const open = openPanels(ws.value);
    expect(open).toContain('mapview');
    expect(open).not.toContain('section');
    expect(ws.value.bottom.stacks[0].panels).toEqual(expect.arrayContaining(['geosteer', 'correlation']));
  });

  it('saves, renames, switches to and deletes named workspaces', () => {
    const ws = fresh();
    ws.move('logs', { kind: 'zone', zone: 'bottom' });
    const id = ws.saveAs('Logs below');
    expect(ws.saved.value.map((w) => w.name)).toContain('Logs below');
    expect(ws.current.value).toBe(id);
    // the same name replaces rather than duplicates
    expect(ws.saveAs('logs below')).toBe(id);
    expect(ws.saved.value.filter((w) => w.id === id)).toHaveLength(1);
    ws.rename(id, 'Bottom logs');
    expect(ws.info(id)?.name).toBe('Bottom logs');
    ws.switchTo('walkthrough', all);
    ws.switchTo(id, all);
    expect(ws.value.bottom.stacks[0].panels).toEqual(['logs']);
    ws.remove(id);
    expect(ws.saved.value.find((w) => w.id === id)).toBeUndefined();
    // deleting the active workspace goes back to Walkthrough
    expect(ws.current.value).toBe('walkthrough');
  });
});

describe('workspaces', () => {
  it('keeps a live layout per workspace', () => {
    const ws = fresh();
    ws.move('logs', { kind: 'zone', zone: 'bottom' });
    ws.switchTo('geosteering', all);
    // entered for the first time: its preset
    expect(ws.value.bottom.stacks[0].panels).toEqual(['geosteer', 'correlation', 'section']);
    expect(ws.value.right.stacks[0].panels).toEqual(['logs']);
    ws.setSize('right', 600);
    ws.switchTo('walkthrough', all);
    // Walkthrough as it was left, without Geosteering's windows or size
    expect(locate(ws.value, 'logs')).toMatchObject({ kind: 'dock', zone: 'bottom' });
    expect(ws.value.right.size).toBe(400);
    ws.switchTo('geosteering', all);
    expect(ws.value.right.size).toBe(600);
  });

  it('carries open tool windows along, but not the app panels of the workspace left', () => {
    const ws = fresh();
    ws.open('mapview');
    ws.open('sources');
    ws.switchTo('petrophysics', all);
    const open = openPanels(ws.value);
    expect(open).toContain('mapview');
    expect(open).not.toContain('sources');
  });

  it('resets a workspace to its preset, or a user one to the layout it was made with', () => {
    const ws = fresh();
    ws.switchTo('petrophysics', all);
    ws.close('crossplot');
    ws.setSize('left', 500);
    ws.reset('petrophysics', all);
    expect(ws.value.left.size).toBe(320);
    expect(openPanels(ws.value)).toContain('crossplot');

    // a workspace that is not active resets the next time it is entered
    ws.setSize('left', 450);
    ws.switchTo('walkthrough', all);
    ws.reset('petrophysics', all);
    ws.switchTo('petrophysics', all);
    expect(ws.value.left.size).toBe(320);

    ws.setSize('left', 360);
    const mine = ws.duplicate('petrophysics');
    ws.switchTo(mine, all);
    ws.setSize('left', 700);
    ws.reset(mine, all);
    expect(ws.value.left.size).toBe(360);
  });

  it('duplicates with a unique name and the task context, and protects the built-in ones', () => {
    const ws = fresh();
    const a = ws.duplicate('petrophysics');
    const b = ws.duplicate('petrophysics');
    expect(ws.info(a)).toMatchObject({ name: 'Petrophysics copy', builtin: false, context: { colour: 'hydrocarbon' } });
    expect(ws.info(b)?.name).toBe('Petrophysics copy 2');
    expect(ws.info('geosteering')?.context).toEqual({ nav: 'guided', guidedView: 'chase' });
    expect(ws.info('walkthrough')?.context).toBeUndefined();
    ws.rename('walkthrough', 'Mine');
    ws.remove('walkthrough');
    expect(ws.info('walkthrough')?.name).toBe('Walkthrough');
    expect(ws.list().map((w) => w.id)).toEqual(['walkthrough', 'petrophysics', 'geosteering', a, b]);
  });

  it('cycles through the tabs, wrapping round', () => {
    const ws = fresh();
    expect(ws.neighbour(1)).toBe('petrophysics');
    expect(ws.neighbour(-1)).toBe('geosteering');
    const mine = ws.duplicate('walkthrough', 'Mine');
    expect(ws.neighbour(-1)).toBe(mine);
    ws.switchTo(mine, all);
    expect(ws.neighbour(1)).toBe('walkthrough');
  });

  it('remembers every layout and the active workspace across reloads', () => {
    const ws = fresh();
    ws.move('logs', { kind: 'zone', zone: 'bottom' });
    ws.switchTo('geosteering', all);
    ws.setSize('bottom', 400);
    const again = new Workspace();
    expect(again.current.value).toBe('geosteering');
    expect(again.value.bottom.size).toBe(400);
    again.switchTo('walkthrough', all);
    expect(locate(again.value, 'logs')).toMatchObject({ kind: 'dock', zone: 'bottom' });
  });

  it('migrates the single layout and the saved list of earlier versions', () => {
    const old: Layout = PRESETS[0].build();
    old.right.size = 555;
    const mine: Layout = PRESETS[1].build();
    store.set('bw.workspace.v1', JSON.stringify(old));
    store.set('bw.workspaces.v2', JSON.stringify([{ id: 'w1', name: 'Mine', layout: mine }, { id: 'bad', name: 'Broken', layout: { v: 9 } }]));
    const ws = new Workspace();
    // the layout you had carries on as the Walkthrough's
    expect(ws.current.value).toBe('walkthrough');
    expect(ws.value.right.size).toBe(555);
    // saved workspaces become tabs; unreadable ones are dropped
    expect(ws.list().map((w) => w.name)).toEqual(['Walkthrough', 'Petrophysics', 'Geosteering', 'Mine']);
    ws.switchTo('w1', all);
    expect(ws.value.right.size).toBe(520);
    expect(store.has('bw.workspace.v1')).toBe(false);
    expect(JSON.parse(store.get('bw.workspace.v2')!).active).toBe('w1');
  });

  it('keeps the id of the oldest single custom workspace once migrated', () => {
    store.set('bw.workspace.custom.v1', JSON.stringify(PRESETS[2].build()));
    const id = new Workspace().saved.value[0]?.id;
    expect(new Workspace().info(id)?.name).toBe('My workspace');
  });

  it('falls back to the presets when the stored state is unreadable', () => {
    store.set('bw.workspace.v2', '{not json');
    store.set('bw.workspaces.v2', '"nope"');
    let ws = new Workspace();
    expect(ws.current.value).toBe('walkthrough');
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'interpretation']);
    expect(ws.saved.value).toEqual([]);

    // an unknown active workspace and broken layouts
    store.set('bw.workspace.v2', JSON.stringify({ v: 2, active: 'gone', layouts: { walkthrough: { v: 1 }, geosteering: null } }));
    ws = new Workspace();
    expect(ws.current.value).toBe('walkthrough');
    expect(ws.value.right.stacks[0].panels).toEqual(['logs']);
    ws.switchTo('geosteering', all);
    expect(ws.value.bottom.stacks[0].panels).toEqual(['geosteer', 'correlation', 'section']);
  });
});
