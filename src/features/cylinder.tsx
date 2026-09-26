import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@tecton/react/components/item';
import type { ReactNode } from 'react';
import { AC_COLOR, CAUTION_CHOICES, antiCollision, wellFamily, type AcStatus, type AcWell } from '../data/anticollision';
import { TC_HALF, TC_RINGS, tcPlot, tcRadius, travellingCylinder, type TcOffset, type TcView } from '../data/cylinder';
import type { App } from '../ui/app';
import { CompactSelect } from '../ui/controls';
import { fmt } from '../ui/dom';
import { Live, Signal } from '../ui/signal';
import { CanvasBox, PanelCanvas, ToolWindow } from '../ui/toolWindow';
import { cssVar, font, ink, textLen, wash } from '../ui/tokens';
import { BADGE, short, type AntiCollisionFeature } from './anticollision';
import { type FeatureModule, windowClosed } from './registry';

/** Draw order: the clear wells first, the worst on top. */
const RANK: Record<AcStatus, number> = { shared: 0, clear: 1, caution: 2, collision: 3 };

const sfText = (sf: number) => (sf >= 100 ? '>99' : fmt.n(sf, 2));

/** What a click or hover can land on, in canvas px. */
interface Hits {
  dots: { x: number; y: number; key: string }[];
  labels: { x0: number; y0: number; x1: number; y1: number; key: string }[];
  paths: { key: string; pts: [number, number][] }[];
}

/**
 * Anti-collision travelling cylinder: looking down the active well at the
 * depth cursor, high side up, the other wellbores within 100 m projected onto
 * the plane across the hole (`data/cylinder.ts`), coloured by separation
 * factor, with the well's own k·σ uncertainty at the centre. The ellipse size
 * and caution threshold are the anti-collision overlay's (set from either);
 * the overlay itself need not be on.
 */
export class CylinderFeature implements FeatureModule {
  readonly id = 'cylinder' as const;
  private panel: ToolWindow;
  private view = new PanelCanvas({ draw: (g, W, H) => this.draw(g, W, H), visible: () => this.panel.visible });
  private tc: TcView | null = null;
  private ref: AcWell | null = null;
  private wells: AcWell[] = [];
  /** kick-offs shared with the reference, by offset key (for the reference `ref`) */
  private kickoffs = new Map<string, number | null>();
  private lastMd = NaN;
  /** the well under the pointer, and the one last clicked (drawn stronger) */
  private hover: string | null = null;
  private focus: string | null = null;
  private hits: Hits = { dots: [], labels: [], paths: [] };
  private side = new Signal<ReactNode>(null);
  private sideKey = '';
  private at = new Signal<ReactNode>('');
  private unsubOptions: (() => void) | null = null;

  constructor(private app: App) {
    // cached drawing: redraw when a colour or the text size changes
    app.paintRev.subscribe(() => this.view.invalidate());
    this.panel = new ToolWindow({
      id: 'cylinder',
      title: 'Anti-collision · travelling cylinder',
      badge: 'calculated',
      onClose: () => windowClosed(app.flags, 'cylinder', () => this.panel.hide()),
      header: () => {
        const ac = this.ac();
        return (
          <>
            <span className="type-caption truncate font-mono">
              <Live s={this.at} />
            </span>
            <span className="flex-1" />
            <CompactSelect
              label="Ellipse size"
              value={String(ac.sigma)}
              onChange={(v) => ac.setOptions({ sigma: +v })}
              options={[1, 2, 3].map((k) => ({ id: String(k), label: `${k}σ` }))}
            />
            <CompactSelect
              label="Caution threshold"
              value={String(ac.caution)}
              onChange={(v) => ac.setOptions({ caution: +v })}
              options={CAUTION_CHOICES.map((c) => ({ id: String(c), label: `Caution below SF ${c}` }))}
            />
          </>
        );
      },
      links: () => ({
        subject: app.engine.activeWell.name,
        followsWell: true,
        channels: [{ id: 'cursor', label: 'Follow the depth cursor', short: 'depth cursor', on: true }],
      }),
      body: () => (
        <div className="@container flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-2 @xl:flex-row">
            <CanvasBox
              view={this.view}
              aria-label="Travelling cylinder: the wells around the active well at the depth cursor, looking down the hole. Click a well to travel to its closest approach."
              onClick={(e) => this.click(e.nativeEvent.offsetX, e.nativeEvent.offsetY)}
              onPointerMove={(e) => this.pointer(e.nativeEvent.offsetX, e.nativeEvent.offsetY, e.currentTarget)}
              onPointerLeave={() => this.setHover(null)}
            />
            <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col gap-2 overflow-y-auto border-t border-border-subtle pt-2 @xl:max-h-none @xl:w-64 @xl:border-t-0 @xl:border-l @xl:pt-0 @xl:pl-3">
              <Live s={this.side} />
            </div>
          </div>
        </div>
      ),
    });
  }

  private ac(): AntiCollisionFeature {
    return this.app.feature<AntiCollisionFeature>('anticollision')!;
  }

  enable() {
    // σ and the caution threshold, shared with the overlay (which is created alongside this view)
    this.unsubOptions ??= this.ac().options.subscribe(() => {
      this.panel.rev.bump();
      if (this.app.flags.on(this.id)) this.update(true);
    });
    this.panel.show();
    this.onWell();
  }

  disable() {
    this.panel.hide();
    this.tc = null;
  }

  onWell() {
    // the wellbores (cached by trajectory) and the reference, again: a new well, or the field's list changed
    this.wells = this.ac().fieldWells();
    const ref = this.wells.find((a) => a.key === this.app.engine.activeWell.id) ?? null;
    if (ref !== this.ref) {
      this.kickoffs.clear();
      this.focus = null;
    }
    this.ref = ref;
    this.panel.rev.bump();
    this.update(true);
  }

  frame() {
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.25) return;
    this.update();
  }

  /** Project the wells at the depth cursor and redraw (only when the depth moved, or `force`). */
  private update(force = false) {
    const md = this.app.engine.rig.md;
    if (!force && Math.abs(md - this.lastMd) < 0.25) return;
    this.lastMd = md;
    const ac = this.ac();
    this.tc = this.ref ? travellingCylinder(this.ref, this.wells, md, { sigma: ac.sigma, caution: ac.caution, kickoffs: this.kickoffs }) : null;
    this.at.set(this.tc ? `at ${fmt.n(this.tc.md, 0)} m MD` : '');
    this.view.redraw();
    this.renderSide();
  }

  /** Where the well stands in its conductor above the seabed (the scan starts there). */
  private seabedMD(): number {
    const f = this.app.field;
    return this.ref ? this.ref.traj.mdAtTVD(f.meta.datumElevation + f.meta.waterDepth) : NaN;
  }

  /** Travel to the closest approach to an offset well along the whole active well (outside a shared hole). */
  private goTo(key: string) {
    const ref = this.ref;
    const off = this.wells.find((w) => w.key === key);
    if (!ref || !off) return;
    this.focus = key;
    const ac = this.ac();
    const seabed = this.seabedMD();
    const o = antiCollision(ref, [off], { sigma: ac.sigma, caution: ac.caution, fromMD: Number.isFinite(seabed) ? seabed : undefined }).offsets[0];
    this.view.invalidate();
    if (o && Number.isFinite(o.md)) this.app.travelTo(o.md);
  }

  // ------------------------------------------------------------------ pointer
  private hitAt(x: number, y: number): string | null {
    const h = this.hits;
    for (const l of h.labels) if (x >= l.x0 && x <= l.x1 && y >= l.y0 && y <= l.y1) return l.key;
    let best: string | null = null;
    let bd = 12 * 12;
    for (const d of h.dots) {
      const q = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (q < bd) {
        bd = q;
        best = d.key;
      }
    }
    if (best) return best;
    bd = 6 * 6;
    for (const p of h.paths)
      for (let i = 1; i < p.pts.length; i++) {
        const [ax, ay] = p.pts[i - 1];
        const [bx, by] = p.pts[i];
        const L = (bx - ax) ** 2 + (by - ay) ** 2;
        const u = L > 0 ? Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L)) : 0;
        const q = (ax + (bx - ax) * u - x) ** 2 + (ay + (by - ay) * u - y) ** 2;
        if (q < bd) {
          bd = q;
          best = p.key;
        }
      }
    return best;
  }

  private click(x: number, y: number) {
    const key = this.hitAt(x, y);
    if (key) this.goTo(key);
  }

  private pointer(x: number, y: number, el: HTMLElement) {
    const key = this.hitAt(x, y);
    el.style.cursor = key ? 'pointer' : '';
    this.setHover(key);
  }

  private setHover(key: string | null) {
    if (key === this.hover) return;
    this.hover = key;
    this.view.invalidate();
  }

  // ------------------------------------------------------------------ side list
  private renderSide() {
    const tc = this.tc;
    const w = this.app.engine.activeWell;
    if (!tc) {
      if (this.sideKey !== 'none') this.side.set(<p className="type-caption">{w.name} has no trajectory to look down.</p>);
      this.sideKey = 'none';
      return;
    }
    const seabed = this.seabedMD();
    const above = Number.isFinite(seabed) && tc.md < seabed;
    // re-render only when what the list shows changes (not on every frame of a flight)
    const key = [
      tc.refKey,
      Math.round(tc.md),
      tc.frame.inc.toFixed(1),
      Math.round(tc.frame.azi),
      tc.sigma,
      tc.caution,
      above,
      this.focus,
      ...tc.offsets.map((o) => `${o.key}:${o.dist.toFixed(1)}:${o.sf.toFixed(2)}:${o.status}`),
      ...tc.shared.map((o) => o.key),
    ].join('|');
    if (key === this.sideKey) return;
    this.sideKey = key;
    const hs = tc.frame.north ? 'north up (the hole is near vertical)' : 'high side up';
    this.side.set(
      <>
        <h3 className="type-section">Around the bit at {fmt.n(tc.md, 0)} m MD</h3>
        <p className="type-caption">
          Inc {fmt.n(tc.frame.inc, 1)}° · Azi {fmt.n(tc.frame.azi, 0)}° · looking down the hole, {hs}
        </p>
        {tc.offsets.length ? (
          <ItemGroup aria-label="Wells around the bit, lowest separation factor first" className="gap-0">
            {tc.offsets.map((o) => (
              <Item key={o.key} size="xs" role="listitem" className="flex-nowrap">
                <ItemMedia>
                  <svg width="12" height="4" aria-hidden="true">
                    <rect width="12" height="4" rx="2" fill={AC_COLOR[o.status]} />
                  </svg>
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="truncate">{short(o.name)}</ItemTitle>
                  <ItemDescription className="truncate" title={`closest at its ${fmt.n(o.offMD, 0)} m MD`}>
                    {fmt.n(o.dist, 1)} m
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant={BADGE[o.status]}>SF {sfText(o.sf)}</Badge>
                  <Button variant="ghost" size="xs" aria-label={`Travel to the closest approach to ${o.name}`} onPress={() => this.goTo(o.key)}>
                    Go
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <p className="type-caption">No other wellbore within {tc.range} m.</p>
        )}
        {tc.shared.length > 0 && (
          <p className="type-caption">
            Same hole here (above the kick-off, not counted): {tc.shared.map((o) => short(o.name)).join(', ')}.
          </p>
        )}
        {above && <p className="type-caption">Above the seabed the wells stand in their conductors in the platform's slot guides: the anti-collision scan starts below it.</p>}
        <p className="type-caption mt-auto">
          Offset wells within {TC_HALF} m along their hole, projected on the plane across this one; the rings are spaced so near wells get room (square-root scale). The shaded
          disc is {short(w.name)}'s own {tc.sigma}σ uncertainty. It follows the depth cursor: scrub the timeline to watch wells pass. Click a well to travel to its closest
          approach.
        </p>
      </>,
    );
  }

  // ------------------------------------------------------------------ drawing
  private draw(g: CanvasRenderingContext2D, W: number, H: number) {
    const hits: Hits = { dots: [], labels: [], paths: [] };
    this.hits = hits;
    const tc = this.tc;
    const cx = W / 2;
    const cy = H / 2;
    // room around the outer ring for the angle labels
    const RP = Math.max(20, Math.min(W, H) / 2 - textLen(26));
    const range = tc?.range ?? 100;
    const P = (x: number, y: number): [number, number] => {
      const p = tcPlot(x, y, range);
      return [cx + p.x * RP, cy - p.y * RP];
    };
    // rings and their distances
    g.lineWidth = 1;
    g.font = font.sans(9.5, 400);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    // a ring's distance only where it has room (from the outside in: the small plot keeps the outer ones)
    let lastLabel = Infinity;
    for (const r of [...TC_RINGS].reverse()) {
      if (r > range) continue;
      const rr = tcRadius(r, range) * RP;
      g.strokeStyle = wash(r === range ? 0.14 : 0.06);
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.stroke();
      if (lastLabel - rr < textLen(13)) continue;
      lastLabel = rr;
      g.fillStyle = ink.faint;
      g.fillText(`${r} m`, cx + 4, cy - rr + textLen(11));
    }
    // spokes every 30°, clockwise from high side
    const north = tc?.frame.north ?? false;
    const names = north ? ['N', 'E', 'S', 'W'] : ['HS', 'R', 'LS', 'L'];
    g.font = font.sans(10, 400);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      g.strokeStyle = wash(0.045);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.sin(t) * RP, cy - Math.cos(t) * RP);
      g.stroke();
      const rl = RP + textLen(13);
      g.fillStyle = a % 90 ? ink.faint : ink.muted;
      g.fillText(a % 90 ? `${a}°` : names[a / 90], cx + Math.sin(t) * rl, cy - Math.cos(t) * rl);
    }
    g.textBaseline = 'alphabetic';
    if (!tc) return;
    // the active well's own k·σ uncertainty
    // the accent, as the depth cursor elsewhere
    const acc = cssVar('--ui-accent', '#b954fd');
    const rr = Math.max(3, tcRadius(tc.refRadius, range) * RP);
    g.fillStyle = acc;
    g.globalAlpha = 0.16;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = acc;
    g.setLineDash([3, 3]);
    g.stroke();
    g.setLineDash([]);
    g.font = font.sans(10, 500);
    g.textAlign = 'right';
    g.fillStyle = acc;
    // named where there is room for it
    if (RP > textLen(110)) g.fillText(`${short(this.app.engine.activeWell.name)} ${tc.sigma}σ`, cx - rr * 0.72 - 4, cy - rr * 0.72);
    // the offset paths, the worst on top, clipped just outside the outer ring
    g.save();
    g.beginPath();
    g.arc(cx, cy, RP + 6, 0, Math.PI * 2);
    g.clip();
    const drawn = [...tc.offsets].sort((a, b) => RANK[a.status] - RANK[b.status] || b.sf - a.sf);
    const strong = (o: TcOffset) => o.key === this.hover || o.key === this.focus;
    for (const o of drawn) {
      const col = AC_COLOR[o.status];
      const clear = o.status === 'clear';
      const pts = o.path.map((q) => P(q.x, q.y));
      hits.paths.push({ key: o.key, pts });
      g.strokeStyle = col;
      g.lineWidth = (clear ? 1.2 : 2.2) + (strong(o) ? 1.2 : 0);
      g.globalAlpha = clear && !strong(o) ? 0.55 : 1;
      g.lineJoin = 'round';
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
    // a dot at each closest point
    for (const o of drawn) {
      const [x, y] = P(o.at.x, o.at.y);
      hits.dots.push({ x, y, key: o.key });
      g.fillStyle = AC_COLOR[o.status];
      g.strokeStyle = ink.card;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, strong(o) ? 5.5 : 4.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // labels: one per group of dots that would print over each other ("F-1 family"), for the lowest SF in it
    const near = textLen(14);
    const groups: { members: TcOffset[]; x: number; y: number }[] = [];
    for (const o of tc.offsets) {
      const [x, y] = P(o.at.x, o.at.y);
      const grp = groups.find((q) => Math.hypot(q.x - x, q.y - y) < near);
      if (grp) grp.members.push(o);
      else groups.push({ members: [o], x, y });
    }
    g.font = font.sans(11, 600);
    const lh = textLen(15);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [{ x0: cx - rr, y0: cy - rr, x1: cx + rr, y1: cy + rr }];
    const overlaps = (b: (typeof placed)[number]) => placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
    for (const grp of groups) {
      const o = grp.members[0];
      const text = `${this.groupName(grp.members)} · ${fmt.n(o.dist, 0)} m · SF ${sfText(o.sf)}`;
      const tw = g.measureText(text).width;
      // right of the dot, below it, above it; then the same on the left
      const tries: [number, number][] = [];
      for (const dy of [lh * 0.35, lh * 1.1, -lh * 0.45, lh * 1.9, -lh * 1.2]) tries.push([grp.x + 9, grp.y + dy], [grp.x - 9 - tw, grp.y + dy]);
      let box: (typeof placed)[number] | null = null;
      for (const [x, y] of tries) {
        const b = { x0: x - 2, y0: y - lh * 0.8, x1: x + tw + 2, y1: y + lh * 0.25 };
        if (b.x0 < 2 || b.x1 > W - 2 || b.y0 < 2 || b.y1 > H - 2) continue;
        if (overlaps(b)) continue;
        box = b;
        break;
      }
      // nowhere free: a clear well goes without (the list names it), a risk still gets its label
      if (!box && o.status === 'clear') continue;
      box ??= (() => {
        const x = grp.x + 9 + tw > W - 2 ? grp.x - 9 - tw : grp.x + 9;
        return { x0: x - 2, y0: grp.y + lh * 0.35 - lh * 0.8, x1: x + tw + 2, y1: grp.y + lh * 0.6 };
      })();
      placed.push(box);
      hits.labels.push({ ...box, key: o.key });
      // a halo, so the label reads over the rings and other paths
      g.textAlign = 'left';
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.strokeStyle = ink.card;
      g.globalAlpha = 0.85;
      g.strokeText(text, box.x0 + 2, box.y1 - lh * 0.25);
      g.globalAlpha = 1;
      g.fillStyle = AC_COLOR[o.status];
      g.fillText(text, box.x0 + 2, box.y1 - lh * 0.25);
    }
    // the hole itself
    g.fillStyle = ink.text;
    g.beginPath();
    g.arc(cx, cy, 3, 0, Math.PI * 2);
    g.fill();
    if (!tc.offsets.length) {
      g.font = font.sans(10.5, 400);
      g.textAlign = 'center';
      g.fillStyle = ink.muted;
      g.fillText(`No other wellbore within ${tc.range} m`, cx, cy + RP * 0.5);
    }
  }

  /** A label for wells whose dots fall together: one name, a family ("F-1 family"), two names, or the first and a count. */
  private groupName(members: TcOffset[]): string {
    if (members.length === 1) return short(members[0].name);
    const fam = wellFamily(members[0].name);
    if (members.every((m) => wellFamily(m.name) === fam)) return `${short(fam)} family`;
    if (members.length === 2) return members.map((m) => short(m.name)).join(', ');
    return `${short(members[0].name)} +${members.length - 1}`;
  }
}
