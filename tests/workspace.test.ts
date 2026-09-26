import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locate, normalise, openPanels, PRESETS, Workspace, type Layout } from '../src/ui/workspace/layout';

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
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'interpretation', 'features']);
    expect(ws.value.right.stacks[0].panels).toEqual(['logs']);
  });

  it('moves a panel between a sidebar\'s slots, never beyond two, and hides an empty bottom slot', () => {
    const ws = fresh();
    ws.dock('interpretation', 'left', 'bottom');
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'features'], ['properties', 'interpretation']]);
    ws.dock('properties', 'left', 'top');
    ws.dock('interpretation', 'left', 'top');
    // the bottom slot emptied: the top one fills the sidebar
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'features', 'properties', 'interpretation']]);
    // a bottom slot is made again when asked for
    ws.dock('scene', 'left', 'bottom');
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['features', 'properties', 'interpretation'], ['scene']]);
    // the bottom panel has a single slot
    ws.dock('logs', 'bottom', 'bottom');
    ws.dock('features', 'bottom', 'bottom');
    expect(ws.value.bottom.stacks.map((x) => x.panels)).toEqual([['logs', 'features']]);
    expect(ws.value.right.stacks).toHaveLength(0);
  });

  it('undocks a panel and docks it back to the slot and tab it came from', () => {
    const ws = fresh();
    ws.undock('interpretation', { x: 10, y: 20, w: 300, h: 200 });
    expect(locate(ws.value, 'interpretation')).toMatchObject({ kind: 'float', win: { x: 10, y: 20, w: 300, h: 200 } });
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'features']);
    ws.setFloat(ws.value.floating[0].id, { x: 50, y: 60 });
    ws.dockBack('interpretation');
    expect(ws.value.floating).toHaveLength(0);
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'interpretation', 'features'], ['properties']]);
    // undocked again, it floats where it was last
    ws.undock('interpretation', { x: 0, y: 0, w: 400, h: 400 });
    expect(ws.value.floating[0]).toMatchObject({ x: 50, y: 60, w: 300, h: 200 });
  });

  it('recreates the slot a floating panel came from when it has gone', () => {
    const ws = fresh();
    // the only panel of the bottom slot: the slot hides while it floats, and comes back
    ws.undock('properties', { x: 10, y: 20, w: 300, h: 200 });
    expect(ws.value.left.stacks).toHaveLength(1);
    ws.dockBack('properties');
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'interpretation', 'features'], ['properties']]);
    // the whole top slot floats away: it comes back above the bottom one
    const top = ws.value.left.stacks[0].id;
    for (const p of ['scene', 'interpretation', 'features']) ws.undock(p, { x: 10, y: 20, w: 300, h: 200 });
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['properties']]);
    // docked back in the reverse order, each finds its tab
    ws.dockBackWindow(ws.value.floating.find((f) => f.panels.includes('features'))!.id);
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['features'], ['properties']]);
    expect(ws.value.left.stacks[0].id).toBe(top);
    ws.dockBack('interpretation');
    ws.dockBack('scene');
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'interpretation', 'features'], ['properties']]);
  });

  it('reorders tabs within a group', () => {
    const ws = fresh();
    const s = ws.value.left.stacks[0].id;
    ws.move('scene', { stack: s, index: 3 });
    expect(ws.value.left.stacks[0].panels).toEqual(['interpretation', 'features', 'scene']);
    ws.move('scene', { stack: s, index: 0 });
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'interpretation', 'features']);
  });

  it('reopens a closed panel where it was', () => {
    const ws = fresh();
    ws.dock('features', 'bottom');
    ws.close('features');
    expect(openPanels(ws.value)).not.toContain('features');
    ws.open('features');
    expect(locate(ws.value, 'features')).toMatchObject({ kind: 'dock', zone: 'bottom' });
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
    ws.dock('logs', 'bottom');
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
    ws.dock('logs', 'bottom');
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
    ws.dock('logs', 'bottom');
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
    expect(ws.value.left.stacks[0].panels).toEqual(['scene', 'interpretation', 'features']);
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

describe('fixed regions: migration of freely docked layouts', () => {
  const stack = (id: string, ...panels: string[]) => ({ id, panels, active: panels[panels.length - 1], weight: 1 });
  /** a layout of the free-docking version: four groups on the left, two in the bottom column, a floating window */
  const old = () => ({
    v: 1,
    left: { size: 300, collapsed: false, stacks: [stack('a', 'scene'), stack('b', 'interpretation'), stack('c', 'features'), stack('d', 'properties')] },
    right: { size: 400, collapsed: false, stacks: [stack('e', 'logs')] },
    bottom: { size: 260, collapsed: false, stacks: [stack('f', 'crossplot'), stack('g', 'geosteer', 'section')] },
    floating: [{ id: 'w', panels: ['mapview'], active: 'mapview', x: 10, y: 20, w: 300, h: 200 }],
  });

  it("merges groups beyond a region's slots into its last slot as tabs, keeping windows floating with a home", () => {
    const L = normalise(old());
    expect(L.v).toBe(2);
    expect(L.left.stacks.map((s) => s.panels)).toEqual([['scene'], ['interpretation', 'features', 'properties']]);
    expect(L.left.stacks[1].active).toBe('interpretation');
    expect(L.bottom.stacks.map((s) => s.panels)).toEqual([['crossplot', 'geosteer', 'section']]);
    expect(L.floating[0].home?.mapview).toMatchObject({ zone: 'bottom', slot: 'top' });
    // idempotent
    expect(normalise(L)).toEqual(L);
  });

  it('normalises the stored live layouts and the saved workspaces as they load', () => {
    store.set('bw.workspace.v2', JSON.stringify({ v: 2, active: 'walkthrough', layouts: { walkthrough: old() } }));
    store.set('bw.workspaces.v2', JSON.stringify([{ id: 'w1', name: 'Mine', layout: old() }]));
    const ws = new Workspace();
    expect(ws.value.left.stacks).toHaveLength(2);
    expect(ws.value.bottom.stacks).toHaveLength(1);
    // a migrated floating window docks back to its panel's default place
    ws.dockBack('mapview');
    expect(locate(ws.value, 'mapview')).toMatchObject({ kind: 'dock', zone: 'bottom' });
    ws.switchTo('w1', all);
    expect(ws.value.left.stacks.map((s) => s.panels)).toEqual([['scene'], ['interpretation', 'features', 'properties']]);
    ws.reset('w1', all);
    expect(ws.value.left.stacks).toHaveLength(2);
    expect(JSON.parse(store.get('bw.workspace.v2')!).layouts.walkthrough.v).toBe(2);
  });
});

describe('layout undo', () => {
  it('takes back recorded changes, last first, and announces the labelled ones', () => {
    const ws = fresh();
    const start = ws.value;
    const seen: string[] = [];
    ws.changes.subscribe(() => seen.push(ws.changes.value!.label));
    expect(ws.change('Logs moved', () => ws.dock('logs', 'bottom'))).toBe(true);
    // a drag is recorded without an announcement
    expect(ws.change(null, () => ws.setSize('left', 400))).toBe(true);
    // nothing changed: nothing recorded
    expect(ws.change('Nothing', () => ws.activate('scene'))).toBe(false);
    expect(seen).toEqual(['Logs moved']);
    expect(ws.undo()).toBe(true);
    expect(ws.value.left.size).toBe(300);
    expect(locate(ws.value, 'logs')).toMatchObject({ zone: 'bottom' });
    expect(ws.undo()).toBe(true);
    expect(ws.value).toEqual(start);
    expect(ws.undo()).toBe(false);
  });

  it("undoes a toast's change and those after it, and keeps each workspace's changes apart", () => {
    const ws = fresh();
    ws.change('Logs moved', () => ws.dock('logs', 'bottom'));
    const n = ws.changes.value!.n;
    ws.change('Scene undocked', () => ws.undock('scene', { x: 0, y: 0, w: 300, h: 300 }));
    ws.switchTo('geosteering', all);
    expect(ws.canUndo()).toBe(false);
    ws.switchTo('walkthrough', all);
    expect(ws.canUndo()).toBe(true);
    ws.undo(n);
    expect(locate(ws.value, 'logs')).toMatchObject({ zone: 'right' });
    expect(locate(ws.value, 'scene')).toMatchObject({ kind: 'dock', zone: 'left' });
    expect(ws.canUndo()).toBe(false);
  });

  it('keeps the last 20 changes', () => {
    const ws = fresh();
    for (let i = 0; i < 25; i++) ws.change(null, () => ws.setSize('left', 300 + i + 1));
    let k = 0;
    while (ws.undo()) k++;
    expect(k).toBe(20);
    expect(ws.value.left.size).toBe(305);
  });
});
