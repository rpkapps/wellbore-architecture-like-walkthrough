import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AssistantTool, ToolContext, ToolOutput } from '../../src/assistant/core/types';
import { ActionRegistry, defineAction } from '../../src/actions/registry';
import { loadVolve, type FieldModel } from '../../src/data/dataset';
import { dataTools, MAX_ROWS } from '../../src/assistant-host/dataTools';
import { linkInput, parseAppLink } from '../../src/assistant-host/links';
import { onLink } from '../../src/assistant-host/host';
import { actionNeedsApproval, appTools } from '../../src/assistant-host/tools';
import { findWell, parseIsoDate, resolveCurve } from '../../src/assistant-host/wells';
import type { App } from '../../src/ui/app';

// serve public/ through fetch so the real loader runs unchanged
globalThis.fetch = (async (url: string) => {
  const path = String(url).replace(/^\.\//, 'public/');
  const body = readFileSync(path, 'utf8');
  return { ok: true, status: 200, text: async () => body } as Response;
}) as typeof fetch;

let field: FieldModel;
let tools: Map<string, AssistantTool>;
beforeAll(async () => {
  field = await loadVolve('./data/volve/');
  tools = new Map(dataTools({ field, activeWell: () => field.primary, extraWellsOn: () => false }).map((t) => [t.name, t]));
}, 60000);

const ctx: ToolContext = { signal: new AbortController().signal, toolCallId: 't1', datasets: new Map() };
const call = async (name: string, args: unknown) => (await tools.get(name)!.execute(args, ctx)) as ToolOutput & Record<string, unknown>;

describe('finding wells and curves', () => {
  it('finds a well by id, name or a loose spelling, and lists the wells otherwise', () => {
    expect(findWell(field, 'F-11B').id).toBe('F-11B');
    expect(findWell(field, '15/9-F-11 B').id).toBe('F-11B');
    expect(findWell(field, 'f12').id).toBe('F-12');
    expect(() => findWell(field, 'F-99')).toThrow(/F-11B \(15\/9-F-11 B\)/);
  });

  it('resolves mnemonics, standard aliases, words and interpretation curves', async () => {
    const w = field.primary;
    await field.ensureLoaded(w);
    expect(resolveCurve(w, 'gr').key).toBe('GR');
    expect(resolveCurve(w, 'density').key).toBe('RHOB');
    expect(resolveCurve(w, 'RDEEP').unit).toBe('Ω·m');
    expect(resolveCurve(w, 'porosity')).toMatchObject({ key: 'PHIE', source: 'interpretation', provenance: 'calculated' });
    expect(() => resolveCurve(w, 'XYZ')).toThrow(/Curves: .*GR/);
  });

  it('reads ISO dates as the start or the end of the period', () => {
    expect(parseIsoDate('2012')).toBe(Date.UTC(2012, 0, 1));
    expect(parseIsoDate('2012-02', true)).toBe(Date.UTC(2012, 1, 29));
    expect(() => parseIsoDate('March 2012')).toThrow();
  });
});

describe('data tools on the real Volve files', () => {
  it('describes every tool with an object schema', () => {
    for (const t of tools.values()) {
      expect(t.parameters.type).toBe('object');
      expect(t.parameters.$schema).toBeUndefined();
      expect(t.kind).toBe('read');
    }
  });

  it('gives the field overview with every well', async () => {
    const r = await call('data.field_overview', {});
    expect(r.datasets![0].rows.length).toBe(field.wells.length);
    expect((r.content as { activeWell: { id: string } }).activeWell.id).toBe('F-11B');
  });

  it('samples logs under the row cap, with TVDSS, zones and the tops in range', async () => {
    const r = await call('data.log_samples', { well: 'F-11 A', curves: ['GR', 'RDEEP', 'RHOB'], includeInterpretation: true });
    const ds = r.datasets![0];
    expect(ds.rows.length).toBeLessThanOrEqual(MAX_ROWS + 1);
    expect(ds.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['md', 'tvdss', 'zone', 'GR', 'RHOB', 'PHIE', 'SW', 'PAY']));
    const mid = ds.rows[Math.floor(ds.rows.length / 2)];
    expect(mid.tvdss as number).toBeLessThan(mid.md as number);
    expect((r.content as { tops: unknown[] }).tops.length).toBeGreaterThan(3);
  });

  it('rejects unknown curves and bad arguments with a helpful error', async () => {
    await expect(call('data.log_samples', { well: 'F-12', curves: ['NOPE'] })).rejects.toThrow(/Curves:/);
    await expect(call('data.log_samples', { well: 'F-12' })).rejects.toThrow(/Invalid arguments/);
  });

  it('summarises zones: the Hugin carries pay in F-11 B', async () => {
    const r = await call('data.zone_summary', { well: 'F-11B' });
    const hugin = r.datasets![0].rows.find((x) => x.formation === 'hugin')!;
    expect(hugin.payM as number).toBeGreaterThan(50);
    expect(hugin.phiAvg as number).toBeGreaterThan(0.1);
    expect(r.content).toHaveProperty('rows');
  });

  it('lists pay intervals and curve statistics by zone', async () => {
    const p = await call('data.pay_intervals', { well: 'F-11B' });
    expect((p.content as { intervals: number }).intervals).toBeGreaterThan(0);
    const s = await call('data.curve_stats', { well: 'F-11B', curves: ['GR'], byZone: true });
    const row = s.datasets![0].rows[0];
    expect(row.p10 as number).toBeLessThanOrEqual(row.p90 as number);
  });

  it('gives monthly production of one well with cumulative totals, and of all wells side by side', async () => {
    const one = await call('data.production_history', { well: 'F-12', fields: ['oil', 'watercut'] });
    const cum = (one.content as { cumulative: { oilSm3: number }[] }).cumulative[0].oilSm3;
    expect(cum).toBeGreaterThan(4e6);
    expect(one.datasets![0].rows[0].date).toMatch(/^\d{4}-\d{2}$/);
    const all = await call('data.production_history', { fields: ['oil'], from: '2010', to: '2010-12', rates: true });
    const cols = all.datasets![0].columns.map((c) => c.key);
    expect(cols).toContain('F12_oil');
    expect(all.datasets![0].columns.find((c) => c.key === 'F12_oil')!.unit).toBe('Sm3/d');
    expect(all.datasets![0].rows.length).toBe(12);
  });

  it('gives tops of every well, the trajectory and values at a depth', async () => {
    const tops = await call('data.tops', {});
    expect(tops.datasets![0].rows.some((r) => r.well === 'F-12' && r.formation === 'hugin')).toBe(true);
    const traj = await call('data.trajectory', { well: 'F-11B' });
    expect(traj.datasets![0].rows.length).toBeLessThanOrEqual(2001);
    const v = await call('data.value_at', { well: 'F-11B', md: 3300, curves: ['GR', 'PHIE'] });
    expect(v).toMatchObject({ well: 'F-11B', md: 3300 });
    expect((v as unknown as { values: Record<string, string | null> }).values.GR).toMatch(/API/);
  });

  it('compares a curve across wells on a TVDSS grid', async () => {
    const r = await call('data.compare_wells', { wells: ['F-11A', 'F-12'], curve: 'GR', fromTvdss: 2700, toTvdss: 3100 });
    const ds = r.datasets![0];
    expect(ds.columns.map((c) => c.key)).toEqual(['tvdss', 'F11A', 'F12']);
    expect(ds.rows.some((x) => x.F11A !== null && x.F12 !== null)).toBe(true);
  });

  it('estimates the oil–water contact when the overlay is off', async () => {
    const r = await call('data.contacts', {});
    const d = (r.content as { depthTvdss: number }).depthTvdss;
    expect(d).toBeGreaterThan(2800);
    expect(d).toBeLessThan(3300);
  });
});

describe('the app’s actions as tools', () => {
  it('maps actions to tools: schema, read/write, approval, choices, and errors thrown', async () => {
    const state = { md: 0 };
    const reg = new ActionRegistry<typeof state>(state);
    reg.register(
      defineAction({ id: 'app.state', title: 'State', description: 'Reads.', category: 'View', hidden: true, run: (c) => ({ md: c.md }) }),
      defineAction({
        id: 'nav.go_to_depth',
        title: 'Go to depth',
        description: 'Travels.',
        category: 'Navigate',
        where: 'Timeline',
        input: z.object({ md: z.number().min(0) }),
        run: (c, i) => ((c.md = i.md), { md: c.md }),
      }),
      defineAction({ id: 'panels.show', title: 'Show panel', description: 'Opens a panel.', category: 'Panels', input: z.object({ panel: z.string() }), choices: () => [{ label: 'Well logs', input: { panel: 'logs' } }], run: () => null }),
      defineAction({ id: 'workspace.delete', title: 'Delete', description: 'Removes.', category: 'Workspace', needsApproval: true, input: z.object({ id: z.string() }), run: () => null }),
      defineAction({ id: 'assistant.toggle', title: 'Assistant', description: 'Opens.', category: 'Panels', run: () => null }),
      defineAction({ id: 'app.fullscreen', title: 'Full screen', description: '.', category: 'View', run: () => null }),
    );
    const app = { actions: reg, field, engine: undefined, flags: undefined, feature: () => undefined, workspace: { isShown: () => false } } as unknown as App;
    const list = appTools(app);
    const by = new Map(list.map((t) => [t.name, t]));
    expect(by.has('assistant.toggle')).toBe(false);
    expect(by.has('app.fullscreen')).toBe(false);
    expect(by.get('app.state')!.kind).toBe('read');
    const go = by.get('nav.go_to_depth')!;
    expect(go.kind).toBe('write');
    expect(go.description).toContain('UI: Timeline');
    expect(go.parameters).toMatchObject({ type: 'object', properties: { md: { type: 'number' } } });
    expect(by.get('panels.show')!.description).toContain('panel: logs (Well logs)');
    expect(by.get('workspace.delete')!.needsApproval).toBe(true);
    expect(await go.execute({ md: 3200 }, ctx)).toEqual({ md: 3200 });
    await expect(go.execute({ md: -1 }, ctx)).rejects.toThrow(/Invalid input/);
    expect(by.has('data.log_samples') && by.has('ui.selection_details')).toBe(true);
  });
});

describe('app links', () => {
  it('parses app:// links and their inputs', () => {
    expect(parseAppLink('app://depth/3250?well=F-12')).toEqual({ kind: 'depth', target: '3250', query: 'well=F-12' });
    expect(linkInput('well=F-12&on=true&md=10')).toEqual({ well: 'F-12', on: true, md: 10 });
    const q = encodeURIComponent(JSON.stringify({ mode: 'hydrocarbon' }));
    const l = parseAppLink(`app://action/view.color_by?${q}`)!;
    expect(l.target).toBe('view.color_by');
    expect(linkInput(l.query)).toEqual({ mode: 'hydrocarbon' });
    expect(parseAppLink('https://example.com')).toBeNull();
  });
});

describe('approval of app actions', () => {
  it('an app:// link refuses every action the assistant would ask about, including the always-ask ones', async () => {
    const ran: string[] = [];
    const reg = new ActionRegistry<object>({});
    const action = (id: string, needsApproval?: boolean) =>
      defineAction({ id, title: id, description: '.', category: 'Workspace', needsApproval, run: () => void ran.push(id) });
    reg.register(action('workspace.reset'), action('data.connect'), action('workspace.delete', true), action('view.reset_camera'));
    const toast = vi.fn();
    const app = { actions: reg, toast } as unknown as App;
    const tools = new Map(appTools({ ...app, field, engine: undefined, flags: undefined, feature: () => undefined, workspace: { isShown: () => false } } as unknown as App).map((t) => [t.name, t]));
    for (const id of ['workspace.reset', 'data.connect', 'workspace.delete']) {
      expect(actionNeedsApproval(reg.get(id)!)).toBe(true);
      expect(tools.get(id)!.needsApproval).toBe(true);
      await onLink(app, `app://action/${id}`);
    }
    expect(ran).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(3);
    expect(toast.mock.calls[0]).toEqual([expect.stringContaining('ask the assistant'), 'error']);
    expect(actionNeedsApproval(reg.get('view.reset_camera')!)).toBe(false);
    await onLink(app, 'app://action/view.reset_camera');
    expect(ran).toEqual(['view.reset_camera']);
  });
});
