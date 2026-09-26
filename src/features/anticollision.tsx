import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@tecton/react/components/item';
import {
  AC_COLOR,
  AC_LABEL,
  AC_STEP,
  CAUTION_CHOICES,
  SF_CAUTION,
  SF_COLLISION,
  antiCollision,
  fieldWellbores,
  nearestAt,
  separationAt,
  type AcOffset,
  type AcScan,
  type AcStatus,
  type AcWell,
} from '../data/anticollision';
import { DEFAULT_ERROR_MODEL } from '../data/uncertainty';
import type { App } from '../ui/app';
import { Note, SelectField } from '../ui/controls';
import { fmt } from '../ui/dom';
import type { InspectorRow } from '../ui/inspect';
import { Rev, SCENE } from '../ui/signal';
import { mdNear } from './identify';
import type { FeatureModule } from './registry';

/** A close approach drawn in 3D: the line from the active well to the offset well, for a click on it. */
interface Connector {
  a: THREE.Vector3;
  b: THREE.Vector3;
  md: number;
  offMD: number;
  dist: number;
  sf: number;
  status: AcStatus;
  name: string;
}

export const BADGE: Record<AcStatus, 'destructive' | 'warning' | 'success' | 'secondary'> = {
  collision: 'destructive',
  caution: 'warning',
  clear: 'success',
  shared: 'secondary',
};

/** Rows the offset list shows before "Show all". */
const LIST_ROWS = 8;

export const short = (name: string) => name.replace(/^15\/9-/, '');

/**
 * Well anti-collision: the active well against every other wellbore of the
 * field (`data/anticollision.ts`). While on, each offset well that comes
 * within the caution threshold gets a line from the active well to its
 * closest point at every close approach, coloured by separation factor, a
 * label at the closest one, and the stretches of the active well below the
 * threshold are marked along the hole.
 */
export class AntiCollisionFeature implements FeatureModule {
  readonly id = 'anticollision' as const;
  readonly rev = new Rev(SCENE);
  sigma = 2;
  caution = SF_CAUTION;
  scan: AcScan | null = null;
  private wells: AcWell[] = [];
  private ref: AcWell | null = null;
  private cache = new WeakMap<object, AcWell>();
  private scanKey = '';
  private connectors: Connector[] = [];
  private showAll = false;
  private group = new THREE.Group();

  /**
   * Bumped when the ellipse size or the caution threshold changes: the
   * travelling cylinder shares them with this overlay, and reads them whether
   * or not the overlay is on.
   */
  readonly options = new Rev();

  constructor(private app: App) {
    this.group.name = 'anticollision';
    // a click on it selects the overlay (its details and settings in Properties)
    this.group.userData = { kind: 'feature', featureId: this.id };
    app.engine.pickables.add(this.group);
  }

  enable() {
    this.app.engine.scene.add(this.group);
    this.rebuild();
  }

  disable() {
    this.app.engine.scene.remove(this.group);
    this.clear();
    // a hidden overlay computes nothing: forget the scan (the prepared wellbores stay cached)
    this.scan = null;
    this.scanKey = '';
  }

  onWell() {
    this.rebuild();
  }

  frame() {
    // labels are for the field and the approach views; up close they would cover the hole
    const cam = this.app.engine.camera.position;
    for (const o of this.group.children)
      if (o instanceof CSS2DObject) {
        const d = o.position.distanceTo(cam);
        o.visible = d > 60 && d < 4000;
      }
  }

  // ------------------------------------------------------------------ analysis
  /** Set the ellipse size (k) and / or the caution threshold (SF), for this overlay and the travelling cylinder. */
  setOptions(o: { sigma?: number; caution?: number }) {
    const sigma = o.sigma ?? this.sigma;
    const caution = o.caution ?? this.caution;
    if (sigma === this.sigma && caution === this.caution) return;
    this.sigma = sigma;
    this.caution = caution;
    this.options.bump();
    // a hidden overlay computes nothing: its settings only show the new values
    if (this.app.flags.on(this.id)) this.rebuild();
    else this.rev.bump();
  }

  /** Every wellbore of the field, prepared for the scan (kept between calls): the overlay's and the travelling cylinder's. */
  fieldWells(): AcWell[] {
    const f = this.app.field;
    return fieldWellbores(f.wells, f.context, { picksFor: (n) => f.topsForWell(n), cache: this.cache });
  }

  /** Scan the active well again when it, its trajectory or a setting changed. */
  private compute() {
    const e = this.app.engine;
    const w = e.activeWell;
    if (!w) {
      this.scan = null;
      this.ref = null;
      return;
    }
    const f = this.app.field;
    this.wells = this.fieldWells();
    const ref = this.wells.find((a) => a.key === w.id) ?? null;
    const key = `${w.id}|${this.sigma}|${this.caution}|${f.wells.length}`;
    if (ref === this.ref && key === this.scanKey && this.scan) return;
    this.ref = ref;
    this.scanKey = key;
    if (!ref) {
      this.scan = null;
      return;
    }
    // from the seabed: above it the wells stand in their conductors in the platform's slot guides
    const seabed = ref.traj.mdAtTVD(f.meta.datumElevation + f.meta.waterDepth);
    this.scan = antiCollision(ref, this.wells, { sigma: this.sigma, caution: this.caution, every: AC_STEP, fromMD: Number.isFinite(seabed) ? seabed : undefined });
  }

  /** The offsets that need a look (below the caution threshold outside a shared hole). */
  private flagged(): AcOffset[] {
    return this.scan?.offsets.filter((o) => o.intervals.length > 0) ?? [];
  }

  // ------------------------------------------------------------------ Properties
  identify(point: { x: number; y: number; z: number }): InspectorRow[] {
    const s = this.scan;
    const ref = this.ref;
    if (!s || !ref) return [];
    const k = this.sigma;
    // on a close-approach line: that approach
    const p = new THREE.Vector3(point.x, point.y, point.z);
    const seg = new THREE.Line3();
    const q = new THREE.Vector3();
    let hit: Connector | null = null;
    let best = 3;
    for (const c of this.connectors) {
      seg.set(c.a, c.b);
      const d = seg.closestPointToPoint(p, true, q).distanceTo(p);
      if (d < best) {
        best = d;
        hit = c;
      }
    }
    if (hit)
      return [
        { h: 'Close approach' },
        ['Depth', `${fmt.n(hit.md, 1)} m MD`, 'measured'],
        ['Other well', hit.name, ''],
        ['Its depth', `${fmt.n(hit.offMD, 1)} m MD`, 'measured'],
        ['Centre to centre', `${fmt.n(hit.dist, 1)} m`, 'calculated'],
        [`Separation factor (${k}σ)`, fmt.n(hit.sf, 2), 'calculated'],
        ['Status', AC_LABEL[hit.status], 'calculated'],
      ];
    const md = mdNear(this.app, point);
    if (md === null) return [];
    const rows: InspectorRow[] = [{ h: 'Where you clicked' }, ['Depth', `${fmt.n(md, 1)} m MD`, 'measured']];
    if (md < s.fromMD) return [...rows, ['Status', 'above the seabed: not scanned (conductors in the slot guides)', '']];
    const n = nearestAt(s, ref, this.wells, md);
    if (!n) return rows;
    return [
      ...rows,
      ['Nearest well', n.well.name, n.well.traj.status === 'reconstructed' ? 'reconstructed' : 'measured'],
      ['Its depth', `${fmt.n(n.offMD, 1)} m MD`, 'measured'],
      ['Centre to centre', `${fmt.n(n.dist, 1)} m`, 'calculated'],
      [`Separation factor (${k}σ)`, n.status === 'shared' ? '— (same hole)' : fmt.n(n.sf, 2), 'calculated'],
      ['Status', AC_LABEL[n.status], 'calculated'],
    ];
  }

  settings() {
    const s = this.scan;
    const w = this.app.engine.activeWell;
    const m = DEFAULT_ERROR_MODEL;
    const rows = s?.offsets ?? [];
    const flagged = this.flagged();
    const nCol = flagged.filter((o) => o.status === 'collision').length;
    const nCau = flagged.length - nCol;
    const shown = this.showAll ? rows : rows.slice(0, Math.max(LIST_ROWS, flagged.length));
    return (
      <>
        <SelectField
          label="Ellipse size"
          value={String(this.sigma)}
          onChange={(v) => this.setOptions({ sigma: +v })}
          options={[1, 2, 3].map((k) => ({ id: String(k), label: `${k}σ (${k === 1 ? '68' : k === 2 ? '95' : '99.7'}% for a 1-D error)` }))}
        />
        <SelectField
          label="Caution below"
          value={String(this.caution)}
          onChange={(v) => this.setOptions({ caution: +v })}
          options={CAUTION_CHOICES.map((c) => ({ id: String(c), label: `SF ${c.toFixed(2)}` }))}
        />
        {!s || !w ? (
          <Note>The active well has no trajectory to scan.</Note>
        ) : (
          <>
            <Note>
              {w.name} against {rows.length} wellbores, every {s.every} m from the seabed ({fmt.n(s.fromMD, 0)} m MD) to TD:{' '}
              {flagged.length ? (
                <>
                  {nCol > 0 && <b style={{ color: AC_COLOR.collision }}>{nCol} collision risk</b>}
                  {nCol > 0 && nCau > 0 && ' · '}
                  {nCau > 0 && <b style={{ color: AC_COLOR.caution }}>{nCau} caution</b>}
                </>
              ) : (
                <b style={{ color: AC_COLOR.clear }}>all clear</b>
              )}
              . Separation factor at {s.sigma}σ; the button travels to the closest approach.
            </Note>
            <ItemGroup aria-label="Offset wellbores by separation factor" className="gap-0">
              {shown.map((o) => (
                <OffsetRow key={o.key} o={o} recon={this.wells.find((a) => a.key === o.key)?.traj.status === 'reconstructed'} onTravel={(md) => this.app.travelTo(md)} />
              ))}
            </ItemGroup>
            {rows.length > shown.length || this.showAll ? (
              <div>
                <Button
                  variant="ghost"
                  size="xs"
                  onPress={() => {
                    this.showAll = !this.showAll;
                    this.rev.bump();
                  }}
                >
                  {this.showAll ? 'Show the closest only' : `Show all ${rows.length} wellbores`}
                </Button>
              </div>
            ) : null}
          </>
        )}
        <Note>
          Simplified, not a full ISCWSA anti-collision scan: SF = centre-to-centre distance ÷ (kσ radius of this well + kσ radius of the other), the radius being the major semi-axis
          of the survey-uncertainty ellipse (σinc {m.sigInc}°, σazi {m.sigAzi}°, depth {m.sigDepth * 1000} ‰; wider where a path is reconstructed from picks). No hole or casing
          sizes, along-hole error or surface-position error; the closest point is found in 3D. Under {SF_COLLISION.toFixed(1)} the ellipses overlap. Hole shared with a parent or
          sidetrack above the kick-off is not counted. The 3D holes are drawn widened, so close wells can look as if they touch.
        </Note>
      </>
    );
  }

  // ------------------------------------------------------------------ 3D
  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      const mat = (c as THREE.Mesh).material as THREE.Material | undefined;
      mat?.dispose?.();
      if (c instanceof CSS2DObject) c.element.remove();
    }
    this.connectors = [];
  }

  rebuild() {
    this.clear();
    try {
      this.compute();
    } finally {
      this.rev.bump();
    }
    const e = this.app.engine;
    const s = this.scan;
    const ref = this.ref;
    const wb = e.wellbore;
    if (!s || !ref || !wb) return;
    const byKey = new Map(this.wells.map((a) => [a.key, a]));
    const col = new THREE.Color();
    // 1. the stretches of the active well below the caution threshold: a pair of coloured lines either side of the hole
    const hp: number[] = [];
    const hc: number[] = [];
    const up = new THREE.Vector3();
    const side = new THREE.Vector3();
    const edge = (md: number, sgn: number) => {
      const fr = wb.frameAt(Math.min(md, ref.traj.mdEnd));
      up.set(0, 1, 0).addScaledVector(fr.tan, -fr.tan.y);
      if (up.lengthSq() < 1e-4) up.copy(fr.nor);
      up.normalize();
      side.crossVectors(fr.tan, up).normalize();
      return fr.pos.clone().addScaledVector(side, sgn * (fr.radius * 1.5 + 1.5));
    };
    for (let i = 0; i < s.mds.length - 1; i++) {
      const sf = Math.min(s.worst[i], s.worst[i + 1]);
      if (!(sf < s.caution)) continue;
      col.set(AC_COLOR[sf < SF_COLLISION ? 'collision' : 'caution']);
      for (const sgn of [-1, 1]) {
        hp.push(...edge(s.mds[i], sgn).toArray(), ...edge(s.mds[i + 1], sgn).toArray());
        hc.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    }
    if (hp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, toneMapped: false }));
      l.renderOrder = 58;
      this.group.add(l);
    }
    // 2. a line from the active well to the other well at each close approach, and a label at the closest one of each well
    const cp: number[] = [];
    const cc: number[] = [];
    for (const o of this.flagged()) {
      const off = byKey.get(o.key);
      if (!off) continue;
      for (const iv of o.intervals) {
        const at = separationAt(ref, off, iv.md, s.sigma, s.caution);
        const pa = ref.traj.at(iv.md);
        const a = e.coords.toScene(pa.ns, pa.ew, pa.tvd);
        const b = e.coords.toScene(at.point.ns, at.point.ew, at.point.tvd);
        col.set(AC_COLOR[iv.status]);
        cp.push(...a.toArray(), ...b.toArray());
        cc.push(col.r, col.g, col.b, col.r, col.g, col.b);
        this.connectors.push({ a, b, md: iv.md, offMD: iv.offMD, dist: iv.dist, sf: iv.minSF, status: iv.status, name: o.name });
        if (iv.md !== o.md) continue;
        const el = document.createElement('div');
        el.className = `label3d ac ${iv.status}`;
        el.innerHTML = `<b>${o.name}</b><span>· ${fmt.n(o.dist, 0)} m · SF ${fmt.n(o.minSF, 2)}</span>`;
        const lab = new CSS2DObject(el);
        lab.position.copy(a).lerp(b, 0.5);
        this.group.add(lab);
      }
    }
    if (cp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
      // drawn over the (widened) tubes, which would otherwise hide a line of a few metres
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }));
      l.renderOrder = 60;
      this.group.add(l);
      // the end on the other well, as a dot
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(cp.filter((_, i) => i % 6 >= 3), 3));
      pg.setAttribute('color', new THREE.Float32BufferAttribute(cc.filter((_, i) => i % 6 >= 3), 3));
      const pts = new THREE.Points(pg, new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
      pts.renderOrder = 60;
      this.group.add(pts);
    }
    this.frame();
  }
}

/** One offset wellbore in the list: its lowest SF, where, and a button that travels there. */
function OffsetRow({ o, recon, onTravel }: { o: AcOffset; recon: boolean; onTravel: (md: number) => void }) {
  const where = Number.isFinite(o.md) ? `${fmt.n(o.dist, 1)} m at ${fmt.n(o.md, 0)} m MD` : 'no hole of its own below the kick-off';
  const shared = o.shared ? `shared hole to ${fmt.n(o.shared.to, 0)} m · ` : '';
  return (
    <Item size="xs" role="listitem" className="flex-nowrap">
      <ItemContent className="min-w-0">
        <ItemTitle className="truncate">{short(o.name)}</ItemTitle>
        <ItemDescription className="truncate">
          {o.intervals.length > 0 ? `${AC_LABEL[o.status]} · ` : ''}
          {shared}
          {where}
          {recon ? ' · path from picks' : ''}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={BADGE[o.status]}>{Number.isFinite(o.minSF) ? `SF ${o.minSF >= 100 ? '>99' : fmt.n(o.minSF, 2)}` : AC_LABEL.shared}</Badge>
        {Number.isFinite(o.md) && (
          <Button variant="ghost" size="xs" aria-label={`Travel to the closest approach to ${o.name}, ${fmt.n(o.md, 0)} m MD`} onPress={() => onTravel(o.md)}>
            Go
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
