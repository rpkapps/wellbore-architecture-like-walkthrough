import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Separator } from '@tecton/react/components/separator';
import { Panel } from '@tecton/react/tecton/panel';
import { EllipsisIcon, XIcon } from 'lucide-react';
import { cloneElement, isValidElement, memo, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import * as THREE from 'three';
import type { SelectionEntry } from '../../actions/registry';
import type { App } from '../app';
import { IconButton, Tip } from '../icon-button';
import { prefs, setPrefs } from '../prefs';
import { depthOf, formationOf, type Selection } from '../selection';
import { useRev, useSignal, useSignalPart } from '../signal';
import { curate, placeNear, type Box } from '../taskbar';
import { actionItems, DROPDOWN } from './SelectionMenu';
import { SURFACE } from './overlay';

/** How long the camera must stay still before the bar comes back (ms). */
const SETTLE_MS = 260;

/**
 * The contextual task bar (Adobe's, ArcGIS Pro's contextual tabs): with
 * something selected, a small bar next to it offers the likely next steps,
 * each opening a view already set up for that object (a well's logs, a
 * correlation flattened on a formation's top), and ⋯ for the rest of its
 * actions. The steps come from the action registry (`appliesTo`), curated per
 * kind in `ui/taskbar.ts`, so the bar, the right-click menu and the palette
 * offer the same operations.
 *
 * It sits just above the selected point on screen, offset so it never covers
 * it, or docks above the viewport toolbar when the object has no place on
 * screen. It fades out while the camera moves or the walk plays, and comes
 * back where the object then is. Personalise can turn it off.
 */
export const TaskBar = memo(function TaskBar({ app }: { app: App }) {
  const sel = useSignal(app.selection);
  const on = useSignalPart(prefs, (p) => p.taskBar);
  if (!sel || !on) return null;
  return <Bar app={app} sel={sel} />;
});

function Bar({ app, sel }: { app: App; sel: Selection }) {
  const el = useRef<HTMLElement>(null);
  // what applies changes with the scene (an isolated formation, the open well) and after each step
  const rev = useRev(app.wellRev, app.sceneRev, app.viewRev);
  const [ran, setRan] = useState(0);
  const title = useSignal(app.inspector)?.title ?? sel.id;
  const { primary, rest } = useMemo(() => curate(sel.kind, app.actions.actionsFor(sel)), [app, sel, rev, ran]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = useRef(false);
  // placed again when the scene changes under it (another well opened: a formation's anchor moves)
  usePlacement(app, sel, el, menuOpen, rev);
  const run = (e: SelectionEntry<App>) =>
    void e.run().then((r) => {
      if (!r.ok) app.toast(r.error, 'error');
      setRan((n) => n + 1);
    });
  return (
    <Panel
      ref={el}
      variant="elevated"
      size="sm"
      role="toolbar"
      aria-label={`Next steps for ${title}`}
      // placed and shown by usePlacement, straight on the element (the camera moves every frame)
      style={{ opacity: 0, pointerEvents: 'none' }}
      className={`z-10 w-fit max-w-full transition-opacity duration-150 [:root[data-reduce-motion]_&]:transition-none ${SURFACE}`}
    >
      <div className="flex items-center gap-0.5 p-1">
        <span className="type-caption max-w-40 truncate pr-1 pl-1.5 font-medium text-foreground!">{title}</span>
        {primary.length > 0 && <Separator orientation="vertical" className="mx-0.5 h-4!" />}
        {primary.map(({ entry, label }) => (
          <Button key={entry.action.id} variant={entry.checked ? 'secondary' : 'ghost'} size="xs" aria-pressed={entry.checked} onPress={() => run(entry)}>
            {isValidElement(entry.action.icon) && cloneElement(entry.action.icon as ReactElement<{ 'data-icon'?: string }>, { 'data-icon': 'inline-start' })}
            {label}
          </Button>
        ))}
        <DropdownMenuTrigger onOpenChange={(open) => (menuOpen.current = open)}>
          <Tip label="More actions">
            <Button variant="ghost" size="icon-xs" aria-label="More actions">
              <EllipsisIcon />
            </Button>
          </Tip>
          <DropdownMenu aria-label={`More actions for ${title}`} placement="top end" className="w-max min-w-44">
            {rest.length > 0 && actionItems(rest, undefined, DROPDOWN)}
            {rest.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuItem
                id="hide-task-bar"
                onAction={() => {
                  setPrefs({ taskBar: false });
                  app.toast('Task bar hidden. Personalise brings it back.');
                }}
              >
                Hide the task bar
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenu>
        </DropdownMenuTrigger>
        <IconButton label="Clear selection (Esc)" size="icon-xs" placement="top" onPress={() => app.select(null)}>
          <XIcon />
        </IconButton>
      </div>
    </Panel>
  );
}

/**
 * Where the selection is in the scene: the clicked point, a depth along the
 * open well, where the open well crosses a formation. Null when it has no
 * one place (a scene layer, a well that is not open).
 */
function anchorOf(app: App, sel: Selection): THREE.Vector3 | null {
  const e = app.engine;
  const w = e.activeWell;
  const wb = e.wellbore;
  if (sel.point) return new THREE.Vector3(sel.point.x, sel.point.y, sel.point.z);
  if (!wb || (sel.well && sel.well !== w.id)) return null;
  const md = depthOf(sel);
  const at = (d: number) => wb.frameAt(Math.max(0, Math.min(d, e.rig.mdMax))).pos.clone();
  if (md !== null) return at(md);
  if (sel.kind === 'well') {
    if (sel.part?.type === 'casing' || sel.part?.type === 'cement') {
      const c = w.casing[sel.part.index];
      return c ? at(c.shoeMD) : null;
    }
    // the open well where the camera is along it
    return sel.id === w.id ? at(e.rig.md) : null;
  }
  const f = formationOf(sel);
  const z = f ? w.zones.find((q) => q.formationId === f) : undefined;
  return z ? at((z.topMD + z.baseMD) / 2) : null;
}

const rectOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/**
 * Keeps the bar next to the selection. Every frame it only compares the
 * camera with the last frame's; while it moves (or the walk plays, or a
 * pointer goes down on the view) the bar fades out, and once the view has
 * been still for a moment it is placed again, writing its position straight
 * to the element: no React render per frame.
 */
function usePlacement(app: App, sel: Selection, el: React.RefObject<HTMLElement | null>, menuOpen: React.RefObject<boolean>, rev: number) {
  useLayoutEffect(() => {
    const bar = el.current;
    const e = app.engine;
    if (!bar || !e) return;
    const view = new THREE.Matrix4();
    const proj = new THREE.Matrix4();
    let shown = false;
    // out of the stack's flow until it is placed, so the cards above the toolbar do not jump
    Object.assign(bar.style, { position: 'absolute', left: '0px', bottom: '0px', opacity: '0', pointerEvents: 'none' });
    const show = (v: boolean) => {
      if (v === shown) return;
      shown = v;
      bar.style.opacity = v ? '1' : '0';
      bar.style.pointerEvents = v ? 'auto' : 'none';
    };
    const place = () => {
      const col = bar.parentElement;
      const free = col?.parentElement;
      if (!col || !free) return;
      const anchor = anchorOf(app, sel);
      // the free area, less the stack at the bottom centre (toolbar, prompts, chapter card)
      const box = rectOf(free.getBoundingClientRect());
      for (const c of col.children) if (c !== bar && (c as HTMLElement).offsetHeight) box.bottom = Math.min(box.bottom, c.getBoundingClientRect().top - 4);
      let at: { left: number; top: number } | null = null;
      if (anchor) {
        const v = anchor.project(e.camera);
        if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
          const cv = e.renderer.domElement.getBoundingClientRect();
          at = placeNear({ x: cv.left + ((v.x + 1) / 2) * cv.width, y: cv.top + ((1 - v.y) / 2) * cv.height }, { w: bar.offsetWidth, h: bar.offsetHeight }, box);
        }
      }
      const s = bar.style;
      if (at) {
        // over the view, next to the object (positioned in the bottom stack, which is fixed at its foot)
        const c = col.getBoundingClientRect();
        s.position = 'absolute';
        s.left = `${at.left - c.left}px`;
        s.bottom = `${c.bottom - (at.top + bar.offsetHeight)}px`;
      } else {
        // docked in the stack, just above the toolbar
        s.position = s.left = s.bottom = '';
      }
    };
    const still = () => {
      const cam = e.camera;
      e.camera.updateMatrixWorld();
      if (cam.matrixWorld.equals(view) && cam.projectionMatrix.equals(proj)) return true;
      view.copy(cam.matrixWorld);
      proj.copy(cam.projectionMatrix);
      return false;
    };
    const busy = () => e.rig.playing || app.touring;
    // once the view has been still for a moment (a timer, so it does not wait for the next frame), the bar comes back
    let timer = 0;
    const settle = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!still() || busy()) return settle();
        place();
        show(true);
      }, SETTLE_MS);
    };
    const away = () => {
      if (menuOpen.current) return;
      show(false);
      settle();
    };
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!still() || (busy() && shown)) away();
    };
    const cv = e.renderer.domElement;
    // a press on the view starts an orbit or a pan: out of the way at once
    cv.addEventListener('pointerdown', away);
    still();
    // at once where it is, unless the view is on the move
    if (busy()) settle();
    else {
      place();
      show(true);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      cv.removeEventListener('pointerdown', away);
    };
  }, [app, sel, el, menuOpen, rev]);
}
