import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '../src/actions/registry';
import { clientTools } from '../src/actions/tanstack';

interface Ctx {
  md: number;
  mode: string;
}

const make = () => {
  const ctx: Ctx = { md: 0, mode: 'resistivity' };
  const reg = new ActionRegistry(ctx).register(
    defineAction<Ctx, z.ZodType>({
      id: 'nav.go_to_depth',
      title: 'Go to depth',
      description: 'Moves to a measured depth.',
      category: 'Navigate',
      input: z.object({ md: z.number().min(0) }),
      run: (c, i) => {
        c.md = (i as { md: number }).md;
        return { md: c.md };
      },
    }),
    defineAction<Ctx>({ id: 'view.reset', title: 'Reset', description: 'Resets the view.', category: 'View', needsApproval: true, run: (c) => void (c.mode = 'resistivity') }),
    defineAction<Ctx>({ id: 'view.off', title: 'Unavailable', description: 'Never available.', category: 'View', enabled: () => false, run: () => 1 }),
  );
  return { ctx, reg };
};

describe('action registry', () => {
  it('runs an action with validated input and returns its result', async () => {
    const { ctx, reg } = make();
    expect(await reg.run('nav.go_to_depth', { md: 3200 })).toEqual({ ok: true, result: { md: 3200 } });
    expect(ctx.md).toBe(3200);
  });

  it('reports bad input, unknown and unavailable actions as values', async () => {
    const { ctx, reg } = make();
    const bad = await reg.run('nav.go_to_depth', { md: -5 });
    expect(bad.ok).toBe(false);
    expect(ctx.md).toBe(0);
    expect((await reg.run('nope')).ok).toBe(false);
    expect((await reg.run('view.off')).ok).toBe(false);
  });

  it('rejects ids that are not valid tool names and duplicate ids', () => {
    expect(() => defineAction<Ctx>({ id: 'has space', title: '', description: '', category: 'View', run: () => 0 })).toThrow();
    const { reg } = make();
    expect(() => reg.register(reg.get('view.reset')!)).toThrow();
  });

  it('describes actions as JSON Schema tools', () => {
    const { reg } = make();
    const t = reg.describe().find((d) => d.name === 'nav.go_to_depth')!;
    expect(t.input_schema).toMatchObject({ type: 'object', properties: { md: { type: 'number' } }, required: ['md'] });
    expect(reg.describe().find((d) => d.name === 'view.reset')?.needsApproval).toBe(true);
  });

  it('turns actions into TanStack AI client tools that run through the registry', async () => {
    const { ctx, reg } = make();
    const tools = clientTools(reg);
    const go = tools.find((t) => t.name === 'nav.go_to_depth')!;
    expect(go.__toolSide).toBe('client');
    expect(tools.find((t) => t.name === 'view.reset')?.needsApproval).toBe(true);
    expect(await go.execute!({ md: 100 })).toEqual({ ok: true, result: { md: 100 } });
    expect(ctx.md).toBe(100);
  });
});
