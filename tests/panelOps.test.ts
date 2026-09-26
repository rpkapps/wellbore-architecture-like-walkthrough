import { describe, expect, it } from 'vitest';
import { locate, Workspace } from '../src/ui/workspace/layout';
import { atDefault, closePanel, groupOf, maximised, openIn, place, placementLabel, placements, reveal, toggleMaximised } from '../src/ui/workspace/ops';

const fresh = () => {
  const ws = new Workspace();
  ws.preset('walkthrough', () => true);
  return ws;
};

describe('panel operations (rail, group menus, actions)', () => {
  it('resets a moved panel to its default column, as a tab of its first group', () => {
    const ws = fresh();
    place(ws, { id: 'interpretation' }, 'right');
    expect(locate(ws.value, 'interpretation')).toMatchObject({ kind: 'dock', zone: 'right' });
    expect(atDefault(ws, 'interpretation')).toBe(false);
    place(ws, { id: 'interpretation' }, 'default');
    expect(ws.value.left.stacks.map((s) => s.panels)).toEqual([['scene', 'interpretation'], ['properties']]);
    expect(atDefault(ws, 'interpretation')).toBe(true);
  });

  it('resets Properties to the bottom slot of the left sidebar, where the workspace puts it', () => {
    const ws = fresh();
    place(ws, { id: 'properties' }, 'right');
    expect(ws.value.left.stacks).toHaveLength(1);
    place(ws, { id: 'properties' }, 'default');
    expect(ws.value.left.stacks.map((s) => s.panels)).toEqual([['scene', 'interpretation'], ['properties']]);
    expect(atDefault(ws, 'properties')).toBe(true);
  });

  it('offers the other slot of its own sidebar, the other regions and undock; a floating panel docks back', () => {
    const ws = fresh();
    expect(placements(ws, 'scene', true)).toEqual(['left-bottom', 'right', 'bottom', 'float']);
    expect(placements(ws, 'properties', true)).toEqual(['left', 'right', 'bottom', 'float']);
    expect(placementLabel(ws, 'scene', 'left-bottom')).toBe('Move to bottom of left sidebar');
    expect(placementLabel(ws, 'properties', 'left')).toBe('Move to top of left sidebar');
    expect(placementLabel(ws, 'logs', 'left')).toBe('Move to left sidebar');
    expect(placementLabel(ws, 'logs', 'bottom')).toBe('Move to bottom panel');
    // the palette lists every slot
    expect(placements(ws, 'logs')).toEqual(['left', 'left-bottom', 'right-bottom', 'bottom', 'float']);
    place(ws, { id: 'logs', title: 'Well logs' }, 'float');
    expect(placements(ws, 'logs', true)).toEqual(['dock', 'left', 'right', 'bottom']);
    place(ws, { id: 'logs' }, 'dock');
    expect(locate(ws.value, 'logs')).toMatchObject({ kind: 'dock', zone: 'right' });
  });

  it('announces menu changes for Undo; the rail closes quietly', () => {
    const ws = fresh();
    const seen: string[] = [];
    ws.changes.subscribe(() => seen.push(ws.changes.value!.label));
    place(ws, { id: 'logs', title: 'Well logs' }, 'right-bottom');
    place(ws, { id: 'scene', title: 'Scene' }, 'float');
    place(ws, { id: 'scene', title: 'Scene' }, 'dock');
    closePanel(ws, { id: 'scene', title: 'Scene' });
    closePanel(ws, { id: 'interpretation', title: 'Interpretation' }, false);
    expect(seen).toEqual(['Well logs moved to the bottom of the right sidebar', 'Scene undocked', 'Scene docked back', 'Scene closed']);
    ws.undo();
    expect(ws.isOpen('interpretation')).toBe(true);
    ws.undo();
    expect(ws.isOpen('scene')).toBe(true);
  });

  it('floats, then docks, a closed panel after opening it', () => {
    const ws = fresh();
    closePanel(ws, { id: 'scene' });
    expect(ws.isOpen('scene')).toBe(false);
    place(ws, { id: 'scene' }, 'float');
    expect(locate(ws.value, 'scene')?.kind).toBe('float');
    place(ws, { id: 'scene' }, 'bottom');
    expect(locate(ws.value, 'scene')).toMatchObject({ kind: 'dock', zone: 'bottom' });
  });

  it('opens a panel as a tab of the chosen group ("+ Add view")', () => {
    const ws = fresh();
    const logs = ws.value.right.stacks[0].id;
    openIn(ws, { id: 'live' }, logs);
    expect(ws.value.right.stacks[0].panels).toEqual(['logs', 'live']);
    expect(ws.value.right.stacks[0].active).toBe('live');
  });

  it('reveals a panel in a folded column and shows the panels again', () => {
    const ws = fresh();
    ws.setCollapsed('left', true);
    ws.hidden.set(true);
    reveal(ws, { id: 'interpretation' });
    expect(ws.hidden.value).toBe(false);
    expect(ws.value.left.collapsed).toBe(false);
    expect(ws.isShown('interpretation')).toBe(true);
  });

  it('opens a tool window through its feature, never straight into the layout', () => {
    const ws = fresh();
    let visible = false;
    const tool = {
      get visible() {
        return visible;
      },
      show: () => void 0,
      close: () => void 0,
    };
    // the feature is off: nothing shows the window, so the layout stays as it was
    reveal(ws, { id: 'crossplot', tool: tool as never, open: () => void 0 });
    expect(ws.isOpen('crossplot')).toBe(false);
    // the feature turns on and shows its window
    reveal(ws, { id: 'crossplot', tool: tool as never, open: () => void (visible = true) });
    expect(ws.isOpen('crossplot')).toBe(true);
  });

  it('maximises a group and restores it', () => {
    const ws = fresh();
    const g = groupOf(ws, 'logs');
    toggleMaximised(g);
    expect(maximised.value).toBe(g);
    toggleMaximised(g);
    expect(maximised.value).toBe(null);
  });
});
