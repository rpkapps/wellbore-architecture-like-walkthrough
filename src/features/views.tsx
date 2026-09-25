import { Button } from '@tecton/react/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Input } from '@tecton/react/components/input';
import { Progress } from '@tecton/react/components/progress';
import { ScrollArea } from '@tecton/react/components/scroll-area';
import { Panel, PanelContent } from '@tecton/react/tecton/panel';
import { BookmarkIcon, BookmarkPlusIcon, CameraIcon, PlayIcon, PresentationIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import type { GuidedView, NavMode } from '../scene/cameraRig';
import type { PropertyMode } from '../scene/wellbore';
import type { SectionBox } from '../scene/geology';
import type { App } from '../ui/app';
import { CompactSelect, Note } from '../ui/controls';
import { ToolWindow } from '../ui/toolWindow';
import { IconButton } from '../ui/icon-button';
import { Rev } from '../ui/signal';
import { SortableList } from '../ui/sortable';
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
  /** bump when the list of views changes (Features panel settings) */
  readonly rev = new Rev();
  private panel: ToolWindow;
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
    this.panel = new ToolWindow({
      id: 'views',
      title: 'Saved views',
      onClose: () => this.panel.hide(),
      body: () => this.renderBody(),
    });
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
    this.app.addTool({ id: 'views', label: 'Saved views', icon: <BookmarkIcon />, onAction: () => this.panel.toggle() });
  }

  disable() {
    this.app.removeTool('views');
    this.panel.hide();
    this.stop();
  }

  settings() {
    return (
      <>
        <Note>
          {this.views.length} saved view{this.views.length === 1 ? '' : 's'}. Open with the bookmark button in the top bar. During a presentation: → / Space next, ← previous, Esc exits.
        </Note>
        <div>
          <Button variant="ghost" size="sm" onPress={() => this.panel.show()}>
            Open saved views
          </Button>
        </div>
      </>
    );
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.views));
    } catch {
      /* ignore */
    }
  }

  /** The list changed: store it and re-render the panel and the settings. */
  private changed() {
    this.persist();
    this.render();
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
    this.changed();
  }

  private clearAll() {
    this.views = [];
    this.changed();
  }

  async apply(v: SavedView, dur = 2.4) {
    const app = this.app;
    const e = app.engine;
    if (e.activeWell.id !== v.wellId && app.field.wells.some((w) => w.id === v.wellId)) await app.loadWellAsync(v.wellId);
    app.setBox(v.box, true);
    for (const [id, vis, op] of v.layers) e.geology.setLayer(id, { visible: vis, opacity: op });
    app.sceneRev.bump();
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
    const glass: Record<string, number> = {
      nordland: 0.2,
      utsira: 0.22,
      hordaland: 0.14,
      ty: 0.18,
      ekofisk: 0.3,
      hod: 0.26,
      draupne: 0.55,
      heather: 0.5,
      hugin: 0.92,
      sleipner: 0.75,
      skagerrak: 0.8,
      smithbank: 0.85,
    };
    const hug = w.zones.find((z) => z.formationId === 'hugin');
    const land = hug ? hug.topMD : w.tdMD * 0.7;
    const base = { wellId: w.id, guidedView: 'chase' as GuidedView, exploreView: 'orbit' as const, box, mode: 'resistivity' as PropertyMode };
    const mk = (p: Partial<SavedView>): SavedView => ({
      id: Math.random().toString(36).slice(2, 9),
      caption: '',
      nav: 'explore',
      md: land,
      pos: o.pos.toArray() as [number, number, number],
      target: o.target.toArray() as [number, number, number],
      layers: layers((id) => glass[id] ?? 1),
      ...base,
      ...p,
    });
    this.views.push(
      mk({ caption: `The ${app.field.meta.name} field: ${app.field.wells.length} detailed wellbores beneath a jack-up in ${app.field.meta.waterDepth.toFixed(0)} m of water`, md: 0 }),
      mk({ caption: 'The platform and the conductor entering the seabed', md: 120, pos: [-160, 70, 190], target: [0, -40, 0] }),
      mk({ caption: `${w.name}: landing in the Hugin reservoir — measured resistivity`, nav: 'guided', guidedView: 'chase', md: land - 40 }),
      mk({ caption: 'Inside the hole across the reservoir — interpreted hydrocarbons (calculated)', nav: 'guided', guidedView: 'tunnel', md: land + 30, mode: 'hydrocarbon' }),
      mk({
        caption: 'Reservoir focus: the Hugin sandstone with the overburden removed',
        md: land,
        box: { ...box, stripTo: 2750 },
        layers: layers(
          (id) => (id === 'hugin' ? 0.85 : 0.25),
          (id) => ['draupne', 'heather', 'hugin', 'sleipner'].includes(id),
        ),
        mode: 'hydrocarbon',
        pos: [o.target.x - 900, -2300, o.target.z + 1100],
        target: [o.target.x + 300, -2900, o.target.z],
      }),
    );
    this.changed();
  }

  private render() {
    this.panel.rev.bump();
    this.rev.bump();
  }

  private renderBody() {
    const n = this.views.length;
    const num = (i: number) => String(i + 1).padStart(2, '0');
    return (
      <>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="sm" onPress={() => this.save()}>
            <BookmarkPlusIcon data-icon="inline-start" />
            Save current view
          </Button>
          <Button variant="ghost" size="sm" onPress={() => this.present(0)}>
            <PresentationIcon data-icon="inline-start" />
            Present
          </Button>
          <CompactSelect
            label="Seconds per view"
            value={String(this.dwell)}
            onChange={(v) => {
              this.dwell = +v;
              this.panel.rev.bump();
            }}
            options={[5, 9, 15, 25].map((s) => ({ id: String(s), label: `${s} s / view` }))}
          />
        </div>
        <ScrollArea className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {n === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookmarkIcon />
                </EmptyMedia>
                <EmptyTitle>No saved views yet</EmptyTitle>
                <EmptyDescription>Frame something and press “Save current view”, or add the starter tour.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SortableList
              label="Saved views"
              items={this.views}
              itemLabel={(v) => v.caption || 'Untitled view'}
              deps={[this.views.length, this.rev.value]}
              onReorder={(ids) => {
                this.views = ids.map((id) => this.views.find((v) => v.id === id)!);
                this.changed();
              }}
            >
              {(v, i) => (
                <>
                  <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">{num(i)}</span>
                  <Input
                    aria-label={`Caption of view ${num(i)}, shown in the presentation`}
                    variant="filled"
                    className="h-7 min-w-0 flex-1"
                    defaultValue={v.caption}
                    onChange={(e) => {
                      v.caption = e.target.value;
                      this.persist();
                    }}
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton label={`Go to view ${num(i)}`} size="icon-xs" onPress={() => void this.apply(v)}>
                      <PlayIcon />
                    </IconButton>
                    <IconButton
                      label={`Replace view ${num(i)} with the current view`}
                      size="icon-xs"
                      onPress={() => {
                        this.views[i] = { ...this.capture(v.caption), id: v.id };
                        this.changed();
                      }}
                    >
                      <CameraIcon />
                    </IconButton>
                    <IconButton
                      label={`Delete view ${num(i)}`}
                      size="icon-xs"
                      onPress={() => {
                        this.views.splice(i, 1);
                        this.changed();
                      }}
                    >
                      <Trash2Icon />
                    </IconButton>
                  </div>
                </>
              )}
            </SortableList>
          )}
        </ScrollArea>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="sm" onPress={() => this.starter()}>
            Add starter tour
          </Button>
          <Button variant="ghost" size="sm" isDisabled={n === 0} onPress={() => this.clearAll()}>
            Remove all
          </Button>
        </div>
      </>
    );
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
    this.panel.hide();
    const v = this.views[this.idx];
    const step = `${String(this.idx + 1).padStart(2, '0')} / ${String(this.views.length).padStart(2, '0')}`;
    this.app.presentation.set(<PresentCaption key={`${this.idx}-${v.id}-${Date.now()}`} step={step} caption={v.caption} dwell={this.dwell} />);
    void this.apply(v, 3);
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.present(this.idx + 1), this.dwell * 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.presenting = false;
    this.app.presentation.set(null);
  }
}

/** The presentation caption over the full-window 3D view: step, caption, time left on this view and the keys. */
function PresentCaption({ step, caption, dwell }: { step: string; caption: string; dwell: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const s = (performance.now() - t0) / 1000;
      setElapsed(Math.min(dwell, s));
      if (s < dwell) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dwell]);
  return (
    <Panel variant="elevated" size="lg" className="w-full">
      <PanelContent className="flex flex-col gap-3">
        <span className="font-mono text-xs tracking-widest text-primary">{step}</span>
        <p className="text-xl leading-snug font-semibold text-balance text-foreground">{caption}</p>
        <Progress aria-label="Time until the next view" value={elapsed} maxValue={dwell} className="w-full" />
        <span className="font-mono text-xs text-muted-foreground">← → navigate · Esc exit</span>
      </PanelContent>
    </Panel>
  );
}
