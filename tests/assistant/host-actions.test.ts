import { describe, expect, it, vi } from 'vitest';
import { ActionRegistry } from '../../src/actions/registry';
import { createFakeController } from '../../src/assistant/ui/dev/fakeController';
import type { App } from '../../src/ui/app';

const h = vi.hoisted(() => ({ opened: 0, controller: null as unknown }));

// the chunk is not loaded: the controller is a fake, opening the panel is counted
vi.mock('../../src/assistant-host/lazy', () => ({
  openAssistant: () => void h.opened++,
  closeAssistant: () => undefined,
  assistantShown: () => false,
  loadAssistant: async () => ({ ensureAssistant: () => h.controller }),
}));

const { assistantActions } = await import('../../src/assistant-host/actions');

function setUp() {
  const controller = createFakeController({ scenario: 'empty' });
  const compose = vi.spyOn(controller, 'compose');
  const send = vi.spyOn(controller, 'send');
  h.controller = controller;
  h.opened = 0;
  const select = vi.fn();
  const reg = new ActionRegistry<App>({ select } as unknown as App);
  reg.register(...assistantActions());
  return { reg, controller, compose, send, select };
}

describe('the assistant’s own actions', () => {
  it('“Ask about this” with a prompt puts it in the message box, without sending', async () => {
    const { reg, controller, compose, send, select } = setUp();
    const r = await reg.run('assistant.ask_about', { selection: { kind: 'formation', id: 'hugin' }, prompt: '  What is this formation?  ' });
    expect(r.ok).toBe(true);
    expect(select).toHaveBeenCalledWith({ kind: 'formation', id: 'hugin' });
    expect(compose).toHaveBeenCalledWith('What is this formation?');
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot().draft).toMatchObject({ text: 'What is this formation?' });
    expect(h.opened).toBe(1);
  });

  it('“Ask about this” without a prompt only opens the panel (and asks for the focus)', async () => {
    const { reg, compose, send } = setUp();
    await reg.run('assistant.ask_about', {});
    expect(h.opened).toBe(1);
    expect(compose).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('“Ask the assistant” still sends', async () => {
    const { reg, compose, send } = setUp();
    await reg.run('assistant.ask', { prompt: 'Where is the best pay?' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Where is the best pay?' }));
    expect(compose).not.toHaveBeenCalled();
  });
});
