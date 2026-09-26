import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepChatInView } from '../../src/assistant-host/tools';
import type { App } from '../../src/ui/app';
import { DOCK_PANELS, locate, Workspace } from '../../src/ui/workspace/layout';

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

const available = (id: string) => DOCK_PANELS.has(id);

describe('the assistant panel', () => {
  it('opens as a tab of the right sidebar, beside Well logs', () => {
    const ws = new Workspace();
    ws.open('assistant');
    expect(locate(ws.value, 'assistant')).toMatchObject({ kind: 'dock', zone: 'right' });
    expect(ws.value.right.stacks[0].panels).toEqual(['logs', 'assistant']);
    expect(ws.isShown('assistant')).toBe(true);
  });

  it('goes along to another workspace, and stays closed there once closed', () => {
    const ws = new Workspace();
    ws.open('assistant');
    ws.switchTo('petrophysics', available);
    expect(ws.isOpen('assistant')).toBe(true);
    expect(locate(ws.value, 'assistant')).toMatchObject({ zone: 'right' });
    ws.close('assistant');
    // walkthrough's own layout still names it, but it is closed now
    ws.switchTo('walkthrough', available);
    expect(ws.isOpen('assistant')).toBe(false);
    expect(ws.isOpen('logs')).toBe(true);
  });

  it('keeps the chat in view when a tool brings a panel of its group to the front', async () => {
    const ws = new Workspace();
    ws.open('assistant');
    const app = { workspace: ws } as unknown as App;
    await keepChatInView(app, async () => ws.open('logs'));
    expect(ws.isShown('assistant')).toBe(true);
    expect(ws.isShown('logs')).toBe(true);
    expect(locate(ws.value, 'assistant')).toMatchObject({ zone: 'right', index: 0 });
    expect(locate(ws.value, 'logs')).toMatchObject({ zone: 'right', index: 1 });
  });

  it('leaves the layout alone when the chat was not showing', async () => {
    const ws = new Workspace();
    const app = { workspace: ws } as unknown as App;
    await keepChatInView(app, async () => ws.open('logs'));
    expect(ws.isOpen('assistant')).toBe(false);
    expect(ws.value.right.stacks).toHaveLength(1);
  });
});
