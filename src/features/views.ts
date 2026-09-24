import * as THREE from 'three';
import type { GuidedView, NavMode } from '../scene/cameraRig';
import type { PropertyMode } from '../scene/wellbore';
import type { SectionBox } from '../scene/geology';
import type { App } from '../ui/app';
import { h } from '../ui/dom';
import { FloatingPanel } from '../ui/floating';
import { I } from '../ui/icons';
import type { FeatureModule } from './registry';

export interface SavedView {
  id: string;
  caption: string;
  wellId: string;
  nav: NavMode;
  guidedView: GuidedView;
  exploreView: 'fly' | 'orbit';
  md: number;
  pos: [number, number, number];
  target: [number, number, number];
  mode: PropertyMode;
  box: SectionBox;
  layers: [string, boolean, number][];
}

const KEY = 'vwt.views.v1';

/** Bookmarks of camera + view state, and a full-screen captioned presentation. */
export class ViewsFeature implements FeatureModule {
  readonly id = 'views' as const;
  views: SavedView[] = [];
  private panel: FloatingPanel;
  private list = h('div', { class: 'views-list' });
  private btn: HTMLButtonElement;
  private stage = h('div', { class: 'present-stage hidden' });
  private presenting = false;
  private idx = 0;
  private timer: number | null = null;
  dwell = 9;

  constructor(private app: App) {
    try {
      this.views = JSON.parse(localStorage.getItem(KEY) ?? '[]') ?? [];
    } catch {
      this.views = [];
    }
    this.btn = h('button', { class: 'btn icon ghost', title: 'Saved views & presentation', html: I.bookmark }) as HTMLButtonElement;
    this.btn.onclick = () => (this.panel.visible ? this.panel.hide() : (this.panel.show(), this.render()));
    this.btn.style.display = 'none';
    app.toolSlot.append(this.btn);
    this.panel = new FloatingPanel({ id: 'views', title: 'Saved views', width: 340, height: 420, place: 'top-left', onClose: () => this.panel.hide() });
    const dwell = h('select', { class: 'select', title: 'Seconds per view' }) as HTMLSelectElement;
    for (const s of [5, 9, 15, 25]) dwell.append(h('option', { value: String(s) }, `${s} s / view`));
    dwell.value = String(this.dwell);
    dwell.onchange = () => (this.dwell = +dwell.value);
    this.panel.body.append(
      h(
        'div',
        { class: 'views-actions' },
        h('button', { class: 'btn primary', onclick: () => this.save() }, '+ Save current view'),
        h('button', { class: 'btn', html: `${I.film} Present`, onclick: () => this.present(0) }),
        dwell,
      ),
      this.list,
      h('div', { class: 'views-actions' }, h('button', { class: 'btn', onclick: () => this.starter() }, 'Add starter tour'), h('button', { class: 'btn', onclick: () => this.clearAll() }, 'Remove all')),
    );
    document.body.append(this.stage);
    window.addEventListener('keydown', (e) => {
      if (!this.presenting) return;
      if (e.key === 'Escape') this.stop();
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        this.present(this.idx + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.present(this.idx - 1);
    });
  }

  enable() {
    this.btn.style.display = '';
  }

  disable() {
    this.btn.style.display = 'none';
    this.panel.hide();
    this.stop();
  }

  settings() {
    return h('div', { class: 'feat-note' }, `${this.views.length} saved view${this.views.length === 1 ? '' : 's'}. Open with the bookmark button in the top bar. During a presentation: → / Space next, ← previous, Esc exits.`, h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn', onclick: () => (this.panel.show(), this.render()) }, 'Open saved views')));
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.views));
    } catch {
      /* ignore */
    }
  }

  capture(caption: string): SavedView {
    const e = this.app.engine;
    const rig = e.rig;
    const cam = e.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const target = rig.orbit.enabled ? rig.orbit.target.clone() : cam.position.clone().addScaledVector(dir, 200);
    return {
      id: Math.random().toString(36).slice(2, 9),
      caption,
      wellId: e.activeWell.id,
      nav: rig.mode,
      guidedView: rig.guidedView,
      exploreView: rig.exploreView,
      md: rig.md,
      pos: cam.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      mode: e.mode,
      box: { ...e.geology.box },
      layers: [...e.geology.state].map(([id, s]) => [id, s.visible, s.opacity]),
    };
  }

  private save() {
    const w = this.app.engine.activeWell;
    const z = w.zoneAt(this.app.engine.rig.md);
    this.views.push(this.capture(`${w.name} — ${z?.name ?? 'view'} at ${this.app.engine.rig.md.toFixed(0)} m MD`));
    this.persist();
    this.render();
  }

  private clearAll() {
    this.views = [];
    this.persist();
    this.render();
  }

  async apply(v: SavedView, dur = 2.4) {
    const app = this.app;
    const e = app.engine;
    if (e.activeWell.id !== v.wellId && app.field.wells.some((w) => w.id === v.wellId)) await app.loadWellAsync(v.wellId);
    app.onSectionPreset?.(v.box);
    for (const [id, vis, op] of v.layers) e.geology.setLayer(id, { visible: vis, opacity: op });
    app.left.sync();
    if (v.mode !== e.mode && (v.mode !== 'rop' || app.flags.on('rop'))) app.setProperty(v.mode);
    if (v.nav === 'guided') {
      app.setNav('guided');
      app.setGuidedView(v.guidedView);
      app.travelTo(v.md);
    } else {
      app.setNav('explore');
      e.rig.setExploreView(v.exploreView);
      e.rig.setMd(v.md);
      e.rig.flyTo(new THREE.Vector3(...v.pos), new THREE.Vector3(...v.target), dur);
    }
  }

  private starter() {
    const app = this.app;
    const e = app.engine;
    const w = e.activeWell;
    const o = e.overviewPose();
    const box = { ...e.geology.fullBox };
    const layers = (op: (id: string) => number, vis: (id: string) => boolean = () => true): [string, boolean, number][] => [...e.geology.state.keys()].map((id) => [id, vis(id), op(id)]);
    const glass: Record<string, number> = { nordland: 0.2, utsira: 0.22, hordaland: 0.14, ty: 0.18, ekofisk: 0.3, hod: 0.26, draupne: 0.55, heather: 0.5, hugin: 0.92, sleipner: 0.75, skagerrak: 0.8, smithbank: 0.85 };
    const hug = w.zones.find((z) => z.formationId === 'hugin');
    const land = hug ? hug.topMD : w.tdMD * 0.7;
    const base = { wellId: w.id, guidedView: 'chase' as GuidedView, exploreView: 'orbit' as const, box, mode: 'resistivity' as PropertyMode };
    const mk = (p: Partial<SavedView>): SavedView => ({ id: Math.random().toString(36).slice(2, 9), caption: '', nav: 'explore', md: land, pos: o.pos.toArray() as [number, number, number], target: o.target.toArray() as [number, number, number], layers: layers((id) => glass[id] ?? 1), ...base, ...p });
    this.views.push(
      mk({ caption: `The ${app.field.meta.name} field: ${app.field.wells.length} detailed wellbores beneath a jack-up in ${app.field.meta.waterDepth.toFixed(0)} m of water`, md: 0 }),
      mk({ caption: 'The platform and the conductor entering the seabed', md: 120, pos: [-160, 70, 190], target: [0, -40, 0] }),
      mk({ caption: `${w.name}: landing in the Hugin reservoir — measured resistivity`, nav: 'guided', guidedView: 'chase', md: land - 40 }),
      mk({ caption: 'Inside the hole across the reservoir — interpreted hydrocarbons (calculated)', nav: 'guided', guidedView: 'tunnel', md: land + 30, mode: 'hydrocarbon' }),
      mk({ caption: 'Reservoir focus: the Hugin sandstone with the overburden removed', md: land, box: { ...box, stripTo: 2750 }, layers: layers((id) => (id === 'hugin' ? 0.85 : 0.25), (id) => ['draupne', 'heather', 'hugin', 'sleipner'].includes(id)), mode: 'hydrocarbon', pos: [o.target.x - 900, -2300, o.target.z + 1100], target: [o.target.x + 300, -2900, o.target.z] }),
    );
    this.persist();
    this.render();
  }

  private render() {
    this.list.innerHTML = '';
    if (!this.views.length) {
      this.list.append(h('div', { class: 'feat-note', style: 'padding:10px' }, 'No saved views yet. Frame something and press “Save current view”, or add the starter tour.'));
      return;
    }
    this.views.forEach((v, i) => {
      const cap = h('input', { class: 'num', value: v.caption, title: 'Caption shown in the presentation' }) as HTMLInputElement;
      cap.style.width = '100%';
      cap.onchange = () => ((v.caption = cap.value), this.persist());
      const row = h(
        'div',
        { class: 'view-row' },
        h('span', { class: 'mono faint' }, String(i + 1).padStart(2, '0')),
        cap,
        h('button', { class: 'mini', title: 'Go to view', html: I.play, onclick: () => void this.apply(v) }),
        h('button', { class: 'mini', title: 'Move up', html: I.prev, onclick: () => this.move(i, -1) }),
        h('button', { class: 'mini', title: 'Replace with current view', html: I.camera, onclick: () => ((this.views[i] = { ...this.capture(v.caption), id: v.id }), this.persist()) }),
        h('button', { class: 'mini', title: 'Delete', html: I.trash, onclick: () => (this.views.splice(i, 1), this.persist(), this.render()) }),
      );
      this.list.append(row);
    });
  }

  private move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= this.views.length) return;
    [this.views[i], this.views[j]] = [this.views[j], this.views[i]];
    this.persist();
    this.render();
  }

  present(i: number) {
    if (!this.views.length) {
      this.starter();
    }
    if (i >= this.views.length) {
      this.stop();
      return;
    }
    this.idx = Math.max(0, i);
    this.presenting = true;
    document.body.classList.add('presenting');
    this.panel.hide();
    const v = this.views[this.idx];
    this.stage.classList.remove('hidden');
    this.stage.innerHTML = '';
    const bar = h('i');
    this.stage.append(
      h('div', { class: 'present-caption' }, h('div', { class: 'present-step' }, `${String(this.idx + 1).padStart(2, '0')} / ${String(this.views.length).padStart(2, '0')}`), h('div', { class: 'present-text' }, v.caption)),
      h('div', { class: 'present-bar' }, bar),
      h('div', { class: 'present-hint' }, '← → navigate · Esc exit'),
    );
    bar.style.animationDuration = `${this.dwell}s`;
    void this.apply(v, 3);
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.present(this.idx + 1), this.dwell * 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.presenting = false;
    document.body.classList.remove('presenting');
    this.stage.classList.add('hidden');
  }
}
