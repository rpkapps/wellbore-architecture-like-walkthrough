import { describe, expect, it } from 'vitest';
import { locate, Workspace } from '../src/ui/workspace/layout';
import { atDefault, closePanel, groupOf, maximised, openIn, place, reveal, toggleMaximised } from '../src/ui/workspace/ops';

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
    expect(ws.value.left.stacks.map((s) => s.panels)).toEqual([['scene', 'features', 'interpretation']]);
    expect(atDefault(ws, 'interpretation')).toBe(true);
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
    reveal(ws, { id: 'features' });
    expect(ws.hidden.value).toBe(false);
    expect(ws.value.left.collapsed).toBe(false);
    expect(ws.isShown('features')).toBe(true);
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
