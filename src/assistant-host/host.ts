import type { AssistantHost, Json } from '../assistant/core/types';
import { FEATURES } from '../features/registry';
import type { App } from '../ui/app';
import { prefs } from '../ui/prefs';
import { openPanels } from '../ui/workspace/layout';
import { contextItems, subscribeContext } from './context';
import { renderIcon } from './icons';
import { borewalkInstructions } from './instructions';
import { suggestions } from './suggestions';
import { actionNeedsApproval, appTools } from './tools';
import { linkInput, parseAppLink } from './links';
import { findWell, round } from './wells';

/**
 * BoreWalk as an assistant host: its knowledge, tools, context chips,
 * suggestions, a picture of the 3D view and the `app://` links answers may
 * contain. Everything here is read on demand; nothing runs while the panel is
 * closed.
 */
export function borewalkHost(app: App): AssistantHost {
  return {
    appName: 'BoreWalk',
    storageKey: 'borewalk',
    instructions: () => borewalkInstructions(app),
    tools: () => appTools(app),
    context: () => contextItems(app),
    subscribeContext: (onChange) => subscribeContext(app, onChange),
    snapshot: () => snapshot(app),
    suggestions: () => suggestions(app),
    captureView: () => captureView(app),
    renderIcon,
    onLink: (href) => void onLink(app, href),
  };
}

/** A short live picture of the app for every step's system prompt: what is open, where the camera is, what is selected. */
export function snapshot(app: App): Json {
  const e = app.engine;
  if (!e) return { loading: true };
  const w = e.activeWell;
  const p = app.pose.value;
  const rig = e.rig;
  const sel = app.selection.value;
  const m = app.marking.value;
  const ws = app.workspace;
  return {
    openWell: { id: w.id, name: w.name, tdMd: round(rig.mdMax, 0) },
    camera: { md: round(p.md, 0), tvdss: round(p.tvdss, 0), inclination: round(p.inc, 0), zone: p.zone, ...(p.section ? { section: p.section } : {}) },
    navigation: rig.mode === 'guided' ? `guided, ${rig.guidedView} camera${rig.playing ? ', playing' : ''}` : `explore, ${rig.exploreView}`,
    colourBy: e.mode,
    ...(e.geology.isolatedId ? { isolatedFormation: e.geology.isolatedId } : {}),
    selection: sel ? { kind: sel.kind, id: sel.id, name: app.inspector.value?.title ?? null, ...(sel.md !== undefined ? { md: round(sel.md, 1) } : {}) } : null,
    ...(m ? { marking: `${m.intervals.length} intervals in ${m.well} (${m.source})` } : {}),
    panelsShown: ws.hidden.value ? 'all hidden (Tab)' : openPanels(ws.value).filter((id) => ws.isShown(id)),
    workspace: ws.current.value,
    featuresOn: FEATURES.filter((f) => app.flags.on(f.id) && f.home !== 'graphics').map((f) => f.id),
    theme: prefs.value.theme,
    ...(app.loadingWell.value ? { loadingWell: app.loadingWell.value } : {}),
  };
}

/** Longest side of a captured view, px. */
const CAPTURE_MAX = 1280;

/**
 * The 3D view as a JPEG for vision models: one frame rendered and copied in
 * the same task (the drawing buffer is not preserved between frames), scaled
 * to at most 1,280 px wide.
 */
export async function captureView(app: App): Promise<{ mediaType: string; data: string } | null> {
  const e = app.engine;
  if (!e) return null;
  const src = e.renderer.domElement;
  if (!src.width || !src.height) return null;
  const k = Math.min(1, CAPTURE_MAX / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  const g = c.getContext('2d');
  if (!g) return null;
  e.renderFrame();
  g.drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', data: btoa(bin) };
}

/**
 * A pressed `app://` link. `action/<id>?<json>` runs an action (not one that
 * changes the person's data: the assistant asks for those), `depth/<md>`
 * travels there (`?well=<id>` opens that well first), `well/<id>` opens and
 * selects a well, `formation/<id>` selects a formation, `panel/<id>` brings a
 * panel into view. Failures show as a toast.
 */
export async function onLink(app: App, href: string): Promise<void> {
  const link = parseAppLink(href);
  if (!link) return;
  const fail = (msg: string) => app.toast(msg, 'error');
  const run = async (id: string, input?: unknown) => {
    const r = await app.actions.run(id, input);
    if (!r.ok) fail(r.error);
    return r.ok;
  };
  try {
    switch (link.kind) {
      case 'action': {
        const a = app.actions.get(link.target);
        if (!a || a.id.startsWith('assistant.')) return fail(`No action "${link.target}".`);
        if (actionNeedsApproval(a)) return fail(`“${a.title}” changes your data: ask the assistant to do it, and it will ask you first.`);
        await run(a.id, linkInput(link.query) ?? (a.input ? {} : undefined));
        return;
      }
      case 'depth': {
        const md = parseFloat(link.target);
        if (!Number.isFinite(md)) return fail(`"${link.target}" is not a depth.`);
        const q = linkInput(link.query);
        if (q?.well) {
          const w = findWell(app.field, String(q.well));
          if (w.id !== app.engine.activeWell.id) await app.loadWellAsync(w.id);
        }
        await run('nav.go_to_depth', { md });
        return;
      }
      case 'well': {
        const w = findWell(app.field, link.target);
        if (w.id !== app.engine.activeWell.id && !(await run('nav.select_well', { id: w.id }))) return;
        app.select({ kind: 'well', id: w.id });
        return;
      }
      case 'formation':
        await run('selection.set', { selection: { kind: 'formation', id: link.target.toLowerCase() } });
        return;
      case 'panel':
        await run('panels.reveal', { panel: link.target });
        return;
      default:
        fail(`Unknown link ${href}.`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
