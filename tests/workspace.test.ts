import { describe, expect, it } from 'vitest';
import { locate, openPanels, Workspace } from '../src/ui/workspace/layout';

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

  it('moves a tab into a new group below another and cleans up empty groups', () => {
    const ws = fresh();
    const s = ws.value.left.stacks[0].id;
    ws.move('interpretation', { kind: 'split', zone: 'left', stack: s, where: 'after' });
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['scene', 'features'], ['interpretation']]);
    ws.move('interpretation', { kind: 'tab', stack: s, index: 0 });
    expect(ws.value.left.stacks.map((x) => x.panels)).toEqual([['interpretation', 'scene', 'features']]);
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
    ws.move('features', { kind: 'zone', zone: 'bottom' });
    ws.close('features');
    expect(openPanels(ws.value)).not.toContain('features');
    ws.open('features');
    expect(locate(ws.value, 'features')).toMatchObject({ kind: 'dock', zone: 'bottom' });
  });

  it('reorders tabs within a group', () => {
    const ws = fresh();
    const s = ws.value.left.stacks[0].id;
    ws.move('scene', { kind: 'tab', stack: s, index: 3 });
    expect(ws.value.left.stacks[0].panels).toEqual(['interpretation', 'features', 'scene']);
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
});
