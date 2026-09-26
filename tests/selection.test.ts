import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '../src/actions/registry';
import { depthOf, formationOf, sameSelection, selectionInput, SelectionSchema, type Selection } from '../src/ui/selection';

interface Ctx {
  hidden: Set<string>;
  isolated: string | null;
  md: number;
  active: string;
}

const make = () => {
  const ctx: Ctx = { hidden: new Set(), isolated: null, md: 0, active: 'f11b' };
  const reg = new ActionRegistry(ctx).register(
    // the convention: the selected id under the kind's name
    defineAction<Ctx, z.ZodType>({
      id: 'scene.hide',
      title: 'Hide formation',
      description: 'Hides a formation.',
      category: 'Scene',
      input: z.object({ formation: z.enum(['hugin', 'draupne']) }),
      appliesTo: ['formation'],
      run: (c, i) => void c.hidden.add((i as { formation: string }).formation),
    }),
    // a toggle that maps the selection to its own input and label
    defineAction<Ctx, z.ZodType>({
      id: 'scene.isolate',
      title: 'Isolate formation',
      description: 'Ghosts the other formations.',
      category: 'Scene',
      input: z.object({ formation: z.string().nullable() }),
      appliesTo: ['formation', 'pick'],
      onSelection: (sel, c) => ({ input: { formation: c.isolated === sel.id ? null : sel.id }, label: 'Isolate', checked: c.isolated === sel.id }),
      run: (c, i) => void (c.isolated = (i as { formation: string | null }).formation),
    }),
    // declines some objects
    defineAction<Ctx, z.ZodType>({
      id: 'nav.go_to_depth',
      title: 'Go to depth',
      description: 'Travels to a depth.',
      category: 'Navigate',
      input: z.object({ md: z.number().min(0) }),
      appliesTo: ['well', 'pick'],
      onSelection: (sel, c) => (sel.md !== undefined && sel.well === c.active ? { input: { md: sel.md } } : null),
      run: (c, i) => void (c.md = (i as { md: number }).md),
    }),
    // no input: runs on whatever it is offered for
    defineAction<Ctx>({ id: 'panels.properties', title: 'Show properties', description: 'Shows Properties.', category: 'Panels', appliesTo: ['formation', 'well'], run: () => 'shown' }),
    defineAction<Ctx>({ id: 'view.off', title: 'Unavailable', description: 'Never available.', category: 'View', appliesTo: ['formation'], enabled: () => false, run: () => 1 }),
    defineAction<Ctx>({ id: 'view.reset', title: 'Reset', description: 'Not about a selection.', category: 'View', run: () => 1 }),
  );
  return { ctx, reg };
};

describe('actionsFor', () => {
  it('lists the enabled actions that apply to the selection kind, in registration order', () => {
    const { reg } = make();
    const ids = reg.actionsFor({ kind: 'formation', id: 'hugin' }).map((e) => e.action.id);
    expect(ids).toEqual(['scene.hide', 'scene.isolate', 'panels.properties']);
    expect(reg.actionsFor(null)).toEqual([]);
    expect(reg.actionsFor({ kind: 'contact', id: 'owc' })).toEqual([]);
  });

  it('fills in the selected id under the kind name by default', () => {
    const { reg } = make();
    const hide = reg.actionsFor({ kind: 'formation', id: 'hugin' }).find((e) => e.action.id === 'scene.hide')!;
    expect(hide.input).toEqual({ formation: 'hugin' });
    expect(hide.label).toBe('Hide formation');
  });

  it('leaves out actions whose filled-in input fails their schema', () => {
    const { reg } = make();
    expect(reg.actionsFor({ kind: 'formation', id: 'utsira' }).map((e) => e.action.id)).not.toContain('scene.hide');
  });

  it('uses onSelection for the input, label and toggle state, and skips objects it declines', async () => {
    const { ctx, reg } = make();
    const iso = () => reg.actionsFor({ kind: 'pick', id: 'hugin', well: 'f11b', md: 3100 }).find((e) => e.action.id === 'scene.isolate')!;
    expect(iso()).toMatchObject({ label: 'Isolate', checked: false, input: { formation: 'hugin' } });
    expect(await iso().run()).toEqual({ ok: true, result: null });
    expect(ctx.isolated).toBe('hugin');
    expect(iso()).toMatchObject({ checked: true, input: { formation: null } });

    const go = (sel: Selection) => reg.actionsFor(sel).find((e) => e.action.id === 'nav.go_to_depth');
    expect(go({ kind: 'well', id: 'f11b', well: 'f11b', md: 3200 })?.input).toEqual({ md: 3200 });
    expect(go({ kind: 'well', id: 'f11b' })).toBeUndefined();
    expect(go({ kind: 'well', id: 'f1', well: 'f1', md: 3200 })).toBeUndefined();
  });

  it('runs an entry through the registry', async () => {
    const { ctx, reg } = make();
    const seen: string[] = [];
    reg.onRun((id) => seen.push(id));
    const hide = reg.actionsFor({ kind: 'formation', id: 'draupne' })[0];
    await hide.run();
    expect(ctx.hidden.has('draupne')).toBe(true);
    expect(seen).toEqual(['scene.hide']);
    const props = reg.actionsFor({ kind: 'well', id: 'f11b' }).find((e) => e.action.id === 'panels.properties')!;
    expect(props.input).toBeUndefined();
    expect(await props.run()).toEqual({ ok: true, result: 'shown' });
  });

  it('describes the kinds an action applies to in its tool description', () => {
    const { reg } = make();
    expect(reg.describe().find((d) => d.name === 'scene.isolate')).toMatchObject({ appliesTo: ['formation', 'pick'] });
    expect(reg.describe().find((d) => d.name === 'view.reset')).not.toHaveProperty('appliesTo');
  });
});

describe('selection helpers', () => {
  it('compares selections by what they name', () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection({ kind: 'formation', id: 'hugin' }, null)).toBe(false);
    expect(sameSelection({ kind: 'formation', id: 'hugin' }, { kind: 'formation', id: 'hugin' })).toBe(true);
    expect(sameSelection({ kind: 'formation', id: 'hugin' }, { kind: 'pick', id: 'hugin' })).toBe(false);
    expect(sameSelection({ kind: 'well', id: 'a', well: 'a', md: 1 }, { kind: 'well', id: 'a', well: 'a', md: 2 })).toBe(false);
    expect(sameSelection({ kind: 'well', id: 'a', part: { type: 'casing', index: 1 } }, { kind: 'well', id: 'a', part: { type: 'casing', index: 1 } })).toBe(true);
  });

  it('derives the default input, the formation and the depth', () => {
    expect(selectionInput({ kind: 'well', id: 'f11b' })).toEqual({ well: 'f11b' });
    expect(formationOf({ kind: 'pick', id: 'hugin', md: 3000 })).toBe('hugin');
    expect(formationOf({ kind: 'well', id: 'hugin' })).toBeNull();
    expect(depthOf({ kind: 'interval', id: 'pay', top: 3000, base: 3010 })).toBe(3005);
    expect(depthOf({ kind: 'formation', id: 'hugin' })).toBeNull();
  });

  it('validates a selection sent as tool input', () => {
    expect(SelectionSchema.safeParse({ kind: 'formation', id: 'hugin' }).success).toBe(true);
    expect(SelectionSchema.safeParse({ kind: 'layer', id: 'x' }).success).toBe(false);
    expect(SelectionSchema.safeParse({ kind: 'well', id: '' }).success).toBe(false);
  });
});
