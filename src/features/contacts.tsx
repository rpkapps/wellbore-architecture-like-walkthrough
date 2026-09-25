import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { combineContacts, contactEvidence, type ContactEstimate, type ContactEvidence } from '../data/contacts';
import type { Well } from '../data/dataset';
import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@tecton/react/components/item';
import { Spinner } from '@tecton/react/components/spinner';
import type { App } from '../ui/app';
import { Note, SliderField, SwitchField } from '../ui/controls';
import { fmt } from '../ui/dom';
import { ProvBadge } from '../ui/prov';
import { Rev, SCENE } from '../ui/signal';
import type { FeatureModule } from './registry';

/**
 * Oil–water contact from the logs: per-well contact brackets (deepest oil /
 * shallowest water in clean sand, from the live Sw calculation) drawn as
 * discs at each well, plus an optional field-wide plane at the median.
 */
export class ContactsFeature implements FeatureModule {
  readonly id = 'owc' as const;
  readonly rev = new Rev(SCENE);
  estimate: ContactEstimate | null = null;
  private group = new THREE.Group();
  private plane?: THREE.Mesh;
  private showPlane = true;
  private override: number | null = null;
  private busy = false;
  private offBox?: () => void;

  constructor(private app: App) {
    this.group.name = 'contacts';
  }

  /** Contact depth used for the field plane (TVDSS), or null. */
  get planeDepth(): number | null {
    return this.override ?? this.estimate?.depth ?? null;
  }

  wellContact(name: string): ContactEvidence | undefined {
    return this.estimate?.evidence.find((e) => e.well === name);
  }

  enable() {
    this.app.engine.scene.add(this.group);
    const fn = () => this.buildPlane();
    this.app.engine.boxListeners.push(fn);
    this.offBox = () => (this.app.engine.boxListeners = this.app.engine.boxListeners.filter((f) => f !== fn));
    void this.recompute();
  }

  disable() {
    this.app.engine.scene.remove(this.group);
    this.offBox?.();
    this.clear();
  }

  onWell() {
    void this.recompute();
  }

  frame() {
    // per-well labels are for the field view; they would clutter close-ups
    const e = this.app.engine;
    const far = e.rig.mode === 'explore';
    for (const o of this.group.children)
      if (o instanceof CSS2DObject) {
        const d = o.position.distanceTo(e.camera.position);
        o.visible = far && d > 300 && d < 1600;
      }
  }

  settings() {
    const est = this.estimate;
    if (!est)
      return this.busy ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Computing the contact</EmptyTitle>
            <EmptyDescription>Loading logged wells and computing…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No contact evidence</EmptyTitle>
            <EmptyDescription>No contact evidence in the loaded wells.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    return (
      <>
        <SwitchField
          label="Field-wide plane"
          isSelected={this.showPlane}
          onChange={(v) => {
            this.showPlane = v;
            this.buildPlane();
            this.rev.bump();
          }}
        />
        <SliderField
          label="Field plane depth"
          minValue={2700}
          maxValue={3300}
          step={1}
          value={Math.round(this.planeDepth ?? est.depth)}
          format={(v) => `${v.toFixed(0)} m TVDSS${this.override !== null ? ' · user' : ''}`}
          onChange={(v) => {
            this.override = v;
            this.buildPlane();
            this.rev.bump();
          }}
        />
        <div>
          <Button
            variant="ghost"
            size="xs"
            onPress={() => {
              this.override = null;
              this.buildPlane();
              this.rev.bump();
            }}
          >
            Reset to calculated
          </Button>
        </div>
        <Note>
          <ProvBadge prov="calculated" /> {est.basis}. Depths in m TVDSS.
        </Note>
        <ItemGroup aria-label="Contact evidence per well" className="gap-0">
          {est.evidence.map((e) => {
            const conflict = est.conflicts.includes(e.well);
            return (
              <Item key={e.well} size="xs" role="listitem" className="flex-nowrap">
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    {e.well.replace('15/9-', '')}
                    {conflict && <Badge variant="warning">Differs</Badge>}
                  </ItemTitle>
                  <ItemDescription>
                    <span className="font-mono">
                      {e.odt !== null ? `oil ↓ ${fmt.n(e.odt, 0)}` : '—'} · {e.wut !== null ? `water ↑ ${fmt.n(e.wut, 0)}` : '—'}
                    </span>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {e.odt !== null && e.wut !== null ? (
                    <span className="font-mono text-xs whitespace-nowrap text-foreground">
                      OWC ≈ {fmt.n((e.odt + e.wut) / 2, 0)} ±{fmt.n((e.wut - e.odt) / 2, 1)}
                    </span>
                  ) : (
                    <span className="text-right text-xs text-muted-foreground">{e.samples < 10 ? 'too few clean-sand samples' : 'one-sided'}</span>
                  )}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        <Note>{est.method}. Wells logged years apart, in different fault blocks, can see different contacts; production moves contacts upward over time.</Note>
      </>
    );
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      if (c instanceof CSS2DObject) c.element.remove();
    }
    this.plane = undefined;
  }

  private wells(): Well[] {
    const extra = this.app.flags.on('extraWells');
    return this.app.field.wells.filter((w) => w.lasFile && (!w.extra || extra));
  }

  async recompute() {
    if (this.busy) return;
    this.busy = true;
    this.rev.bump();
    try {
      const f = this.app.field;
      const list = this.wells();
      for (const w of list) if (!w.loaded) await f.ensureLoaded(w);
      if (!this.app.flags.on('owc')) return;
      const ev = list.filter((w) => w.logs && w.petro).map((w) => contactEvidence(w.name, w.logs!, w.petro!, w.zones, w.trajectory, f.meta.datumElevation));
      this.estimate = combineContacts(ev);
      this.build();
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = false;
      this.rev.bump();
    }
  }

  private build() {
    this.clear();
    const est = this.estimate;
    if (!est) return;
    const e = this.app.engine;
    const f = this.app.field;
    const dz = f.meta.datumElevation;
    for (const w of this.wells()) {
      const ev = est.evidence.find((x) => x.well === w.name);
      if (!ev || (ev.odt === null && ev.wut === null)) continue;
      const conflict = est.conflicts.includes(w.name);
      const t = w.trajectory;
      const pos = (tvdss: number) => {
        let md = t.mdAtTVD(tvdss + dz);
        if (!Number.isFinite(md)) md = t.mdEnd;
        const p = t.at(md);
        return e.coords.toScene(p.ns, p.ew, tvdss + dz);
      };
      if (ev.odt !== null && ev.wut !== null) {
        const mid = (ev.odt + ev.wut) / 2;
        const c = pos(mid);
        const gap = Math.max(0.6, ev.wut - ev.odt);
        // contact disc + a translucent drum spanning the oil-down-to / water-up-to bracket
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(160, 64).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: conflict ? 0x9fb4ff : 0x4fb3ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
        );
        disc.position.copy(c);
        disc.renderOrder = 50;
        const ring = new THREE.Mesh(new THREE.RingGeometry(157, 160, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xbfe6ff, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
        ring.position.copy(c);
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(160, 160, gap, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0x4fb3ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
        drum.position.copy(c);
        disc.userData = ring.userData = drum.userData = { kind: 'owc', well: w.name };
        this.group.add(disc, ring, drum);
        this.label(c, `<b>${w.name.replace('15/9-', '')} OWC ${fmt.n(mid, 0)} ±${fmt.n(gap / 2, 0)} m</b>`);
      } else {
        const d = (ev.odt ?? ev.wut)!;
        const c = pos(d);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(14, 30, 24), new THREE.MeshBasicMaterial({ color: ev.odt !== null ? 0xffb547 : 0x4fb3ff, transparent: true, opacity: 0.85 }));
        cone.position.copy(c);
        if (ev.odt !== null) cone.rotation.x = Math.PI; // oil down to: points down
        this.group.add(cone);
        this.label(c, `<b>${w.name.replace('15/9-', '')} ${ev.odt !== null ? 'oil down to' : 'water up to'} ${fmt.n(d, 0)} m</b>`);
      }
    }
    this.buildPlane();
  }

  private label(p: THREE.Vector3, html: string) {
    const el = document.createElement('div');
    el.className = 'label3d owc';
    el.innerHTML = html;
    const o = new CSS2DObject(el);
    o.position.copy(p).add(new THREE.Vector3(0, 6, 0));
    this.group.add(o);
  }

  private buildPlane() {
    if (this.plane) {
      this.group.remove(this.plane);
      this.plane.geometry.dispose();
      this.plane.children.forEach((c) => {
        if (c instanceof CSS2DObject) c.element.remove();
      });
      this.plane = undefined;
    }
    const d = this.planeDepth;
    if (!this.showPlane || d === null || !this.estimate) return;
    const b = this.app.engine.geology.box;
    const w = b.xMax - b.xMin;
    const n = b.nMax - b.nMin;
    const g = new THREE.PlaneGeometry(w, n).rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uSize: { value: new THREE.Vector2(w, n) } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec2 uSize; varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = vUv * uSize;
  vec2 gd = abs(fract(p / 100.0 - 0.5) - 0.5) * 100.0;
  float grid = 1.0 - smoothstep(0.0, 2.5, min(gd.x, gd.y));
  vec2 e = min(vUv, 1.0 - vUv) * uSize;
  float edge = 1.0 - smoothstep(0.0, 6.0, min(e.x, e.y));
  gl_FragColor = vec4(0.3, 0.68, 1.0, 0.05 + grid * 0.1 + edge * 0.45);
}`,
    });
    this.plane = new THREE.Mesh(g, mat);
    this.plane.position.set((b.xMin + b.xMax) / 2, -d, -(b.nMin + b.nMax) / 2);
    this.plane.renderOrder = 49;
    const el = document.createElement('div');
    el.className = 'label3d owc field';
    const est = this.estimate;
    el.innerHTML =
      this.override !== null
        ? `<b>Contact plane ${fmt.n(d, 0)} m TVDSS</b><span>set by user</span>`
        : `<b>Oil–water contact ≈ ${fmt.n(d, 0)} m TVDSS</b><span>${est.conflicts.length ? `median of well contacts · wells differ by up to ±${fmt.n(est.plusMinus, 0)} m` : `±${fmt.n(est.plusMinus, 1)} m · all wells agree`} · calculated</span>`;
    const o = new CSS2DObject(el);
    o.position.set(-w / 2 + 40, 0, n / 2 - 40);
    this.plane.add(o);
    this.group.add(this.plane);
  }
}
