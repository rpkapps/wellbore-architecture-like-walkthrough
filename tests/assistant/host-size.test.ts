import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantTool, ToolContext } from '../../src/assistant/core/types';
import { ActionRegistry } from '../../src/actions/registry';
import { appActions } from '../../src/actions/appActions';
import { loadVolve, type FieldModel } from '../../src/data/dataset';
import { appTools } from '../../src/assistant-host/tools';
import { FEATURES } from '../../src/features/registry';
import { buildChapters } from '../../src/ui/tour';
import type { App } from '../../src/ui/app';
import { Workspace } from '../../src/ui/workspace/layout';

// serve public/ through fetch so the real loader runs unchanged
globalThis.fetch = (async (url: string) => {
  const path = String(url).replace(/^\.\//, 'public/');
  const body = readFileSync(path, 'utf8');
  return { ok: true, status: 200, text: async () => body } as Response;
}) as typeof fetch;

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
afterAll(() => vi.unstubAllGlobals());

/**
 * The JSON of every tool BoreWalk offered before the choices were compacted,
 * the titles dropped where they add nothing and the schemas shared (this
 * same set-up: the real actions and Volve files, the default features).
 */
const BEFORE = 40_972;

let tools: AssistantTool[];
beforeAll(async () => {
  const field: FieldModel = await loadVolve('./data/volve/');
  const ws = new Workspace();
  ws.open('assistant');
  // the app's state the actions' choices read, as it is after start-up
  const partial = {
    field,
    engine: {
      activeWell: field.primary,
      rig: { mode: 'guided', guidedView: 'chase', exploreView: 'orbit', mdMax: field.primary.tdMD, playing: false },
      mode: 'resistivity',
      geology: { isolatedId: null, state: new Map() },
    },
    workspace: ws,
    flags: { on: (id: string) => !!FEATURES.find((f) => f.id === id)?.default },
    feature: () => undefined,
    selectableWells: () => field.wells.filter((w) => !w.extra),
    chapters: buildChapters(field.primary, field),
    chapter: { value: null },
    tools: { value: [] },
    hub: { connections: { value: [] } },
    optionalModes: { value: new Set() },
    display: { labels: true, otherWells: true, sea: true, contours: false },
    wellbore: { casing: true, fractures: false, markers: true },
    selection: { value: null },
    inspector: { value: null },
  };
  const reg = new ActionRegistry<App>(partial as unknown as App);
  reg.register(...appActions());
  tools = appTools(Object.assign(partial, { actions: reg }) as unknown as App);
}, 60000);

/** What the tools cost a request: names, descriptions and schemas as JSON. */
const toolsJson = (list: AssistantTool[]) => JSON.stringify(list.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe('the tool list sent to the model', () => {
  it('marks the tools the assistant needs most as core', () => {
    const core = tools.filter((t) => t.core).map((t) => t.name);
    for (const id of ['app.state', 'ui.selection_details', 'nav.go_to_depth', 'nav.select_well', 'view.color_by', 'scene.isolate', 'selection.set', 'panels.reveal', 'views.logs', 'features.set', 'interp.set_parameter'])
      expect(core).toContain(id);
    // every data read
    for (const t of tools) if (t.kind === 'read' && t.name.startsWith('data.')) expect(t.core, t.name).toBe(true);
    for (const id of ['prefs.theme', 'workspace.delete', 'panels.place', 'data.replay']) expect(tool(id).core, id).toBeUndefined();
  });

  it('is at least a sixth smaller than before, and no description runs long', () => {
    expect(toolsJson(tools).length).toBeLessThan(BEFORE * (5 / 6));
    for (const t of tools) expect(t.description.length, t.name).toBeLessThanOrEqual(600);
  });

  it('lists at most 12 choices by id, and tells a call that misses every one', async () => {
    const reveal = tool('panels.reveal').description;
    expect(reveal).toMatch(/panel: scene \(current\), properties/);
    expect(reveal).toContain('logs (Well logs)');
    expect(reveal).toMatch(/; \+\d+ more\.$/);
    // one entry per panel, not one per placement
    expect(tool('panels.place').description).toMatch(/panel: scene, properties, interpretation, logs \(Well logs\), assistant\.$/);
    expect(tool('nav.select_well').description).toContain('F-11B (15/9-F-11 B, current)');
    expect(tool('nav.chapter').description).toMatch(/index: 0 \(Maersk Inspirer/);
    const ctx: ToolContext = { signal: new AbortController().signal, toolCallId: 't', datasets: new Map() };
    await expect(tool('panels.reveal').execute({ panel: 'nope' }, ctx)).rejects.toThrow(/No panel "nope"\. panel: .*simulation/);
  });

  it('sends a sub-schema a core tool spells out once', () => {
    expect(tool('selection.properties').parameters).toMatchObject({ properties: { selection: { type: 'object', description: 'As `selection` of selection.set' } } });
    expect(tool('scene.inspect').parameters).toMatchObject({ properties: { formation: { type: 'string', description: 'As `formation` of scene.formation' } } });
    expect(tool('scene.formation').parameters).toMatchObject({ properties: { formation: { enum: expect.arrayContaining(['hugin']) } } });
    expect(JSON.stringify(tools.map((t) => t.parameters))).not.toContain('9007199254740991');
  });
});
