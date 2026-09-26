import * as THREE from 'three';
import { toCss } from '../data/colormap';
import { CROSSPLOTS, bvwLine, crossplotPoints, matrixLine, mdIntervals, missingCurves, pickettLine, type Axis, type CrossplotKind, type XPoint } from '../data/crossplot';
import type { Well } from '../data/dataset';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import { Button } from '@tecton/react/components/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { ChartScatterIcon } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { App } from '../ui/app';
import { CompactSelect, Note, type Option } from '../ui/controls';
import { fmt } from '../ui/dom';
import { MARKING_COLOR } from '../ui/marking';
import { CanvasBox, PanelCanvas, ToolWindow } from '../ui/toolWindow';
import { Live, Signal } from '../ui/signal';
import { font, ink, textLen, wash } from '../ui/tokens';
import { CURVE_BY_KEY } from './curves';
import { type FeatureModule, windowClosed } from './registry';

type ColourBy = 'formation' | 'gr' | 'sw' | 'md';

const SEL_COLOR = MARKING_COLOR;
const MARK_SOURCE = 'Crossplot';
/** plot margins; the ones holding labels grow with the density's text */
const pads = () => ({ l: textLen(52), r: 14, t: 12, b: textLen(34) });
/** select key for "all logged depths" */
const ALL = '_all';

/**
 * Crossplots of the active well (density–neutron, Pickett, Buckles) linked to
 * the 3D view: hovering a point highlights its depth on the borehole, a click
 * travels there, and a dragged box selects samples that are then marked
 * along the well in 3D and listed as depth intervals.
 */
export class CrossplotFeature implements FeatureModule {
  readonly id = 'crossplot' as const;
  private panel: ToolWindow;
  /** the plot (grid, overlays, points) is cached; the cursor ring and the brush are drawn over it */
  private view = new PanelCanvas({ draw: (g, W, H) => this.drawLayer(g, W, H), cursor: (g) => this.drawCursor(g), visible: () => this.panel.visible });
  /** the sample the cursor ring is on (-1: none) */
  private ringAt = -1;
  private readout = new Signal<ReactNode>(null);
  private foot = new Signal<ReactNode>(null);
  private kind: CrossplotKind = 'pickett';
  private zone = 'reservoir';
  private colourBy: ColourBy = 'formation';
  private pts: XPoint[] = [];
  private selected = new Set<number>(); // indices into pts
  private lastMd = -1;
  private brush: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private tx: ((v: number) => number) | null = null;
  private ty: ((v: number) => number) | null = null;
  private zoneOpts: Option[] = [];
  private down: { x: number; y: number } | null = null;
  private markers?: THREE.Points;
  private wellId = '';
  /** the well it stays on whichever well is open (null: the open one) */
  private pinned: Well | null = null;
  /** curves this plot needs that the well lacks: it shows an empty state instead */
  private missing: string[] = [];
  /** the logged wells are being loaded, to suggest one that has the curves */
  private scouting = false;

  constructor(private app: App) {
    // cached drawings: redraw when a colour they use changes
    app.paintRev.subscribe(() => this.view.invalidate());
    this.panel = new ToolWindow({
      id: 'crossplot',
      title: 'Crossplot',
      badge: 'calculated',
      onClose: () => windowClosed(app.flags, 'crossplot', () => this.panel.hide()),
      header: () => (
        <>
          <CompactSelect
            label="Crossplot"
            value={this.kind}
            onChange={(v) => {
              this.kind = v as CrossplotKind;
              this.clearSelection();
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={Object.entries(CROSSPLOTS).map(([k, d]) => ({ id: k, label: d.label }))}
          />
          <CompactSelect
            label="Depth interval"
            value={this.zone || ALL}
            onChange={(v) => {
              this.zone = v === ALL ? '' : v;
              this.clearSelection();
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={this.zoneOpts}
          />
          <CompactSelect
            label="Colour points by"
            value={this.colourBy}
            onChange={(v) => {
              this.colourBy = v as ColourBy;
              this.view.invalidate();
              this.panel.rev.bump();
            }}
            options={[
              { id: 'formation', label: 'Formation' },
              { id: 'gr', label: 'Gamma ray' },
              { id: 'sw', label: 'Sw' },
              { id: 'md', label: 'Depth' },
            ]}
          />
        </>
      ),
      links: () => {
        const w = this.well();
        const open = w === app.engine.activeWell;
        return {
          subject: w.name,
          followsWell: !this.pinned,
          pinned: this.pinned?.name,
          pin: (on) => this.pinTo(on ? w : null),
          channels: [
            { id: 'cursor', label: 'Ring the cursor sample', short: 'depth cursor', on: open, disabled: open ? undefined : 'open well only' },
            { id: 'marking', label: 'Mark selected samples in 3D', short: 'marking', on: this.selected.size > 0 },
          ],
        };
      },
      body: () =>
        this.missing.length ? (
          this.renderEmpty()
        ) : (
          <>
            <CanvasBox
              view={this.view}
              aria-label="Crossplot of the active well: hover a point for its depth, click to travel, drag a box to select samples"
              className="cursor-crosshair"
              onPointerDown={(e) => this.pointerDown(e)}
              onPointerMove={(e) => this.pointerMove(e.nativeEvent)}
              onPointerUp={(e) => this.pointerUp(e.nativeEvent)}
              onPointerCancel={() => this.pointerCancel()}
              onPointerLeave={() => {
                if (!this.down) this.hoverMd(null);
              }}
            />
            <p className="min-h-4 shrink-0 truncate font-mono text-xs text-muted-foreground">
              <Live s={this.readout} />
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs">
              <Live s={this.foot} />
            </div>
          </>
        ),
    });
  }

  enable() {
    this.panel.show();
    // the well may have changed while the feature was off
    this.selected.clear();
    this.rebuild();
    this.renderFoot();
  }

  disable() {
    this.panel.hide();
    this.setMarkers([]);
    this.setMarking([]);
    this.hoverMd(null);
  }

  /** The well it plots: the open one, unless it is pinned to another. */
  private well(): Well {
    return this.pinned ?? this.app.engine.activeWell;
  }

  private isOpenWell() {
    return this.well() === this.app.engine.activeWell;
  }

  /** Keep the plot on one well whichever well is open (null: follow the open well). */
  pinTo(w: Well | null) {
    this.pinned = w;
    if (this.app.flags.on('crossplot')) this.onWell();
    this.panel.rev.bump();
  }

  /** Does the well it plots have this formation (a depth interval it can plot)? */
  hasZone(formationId: string) {
    return this.well().zones.some((z) => z.formationId === formationId);
  }

  /** Plot one formation's samples (the task bar's "Crossplot zone"). */
  showZone(formationId: string) {
    if (!this.hasZone(formationId)) return false;
    this.zone = formationId;
    this.selected.clear();
    if (this.app.flags.on('crossplot')) {
      this.rebuild();
      this.applySelection();
    }
    this.panel.rev.bump();
    return true;
  }

  onWell() {
    // new well, or the interpretation changed (φ, Sw and the Pickett lines depend on it)
    const same = this.well().id === this.wellId;
    const keep = same ? this.selectedMds() : [];
    this.selected.clear();
    this.rebuild();
    // keep a selection across re-interpretation of the same samples
    if (keep.length) {
      const set = new Set(keep);
      this.pts.forEach((p, i) => set.has(p.md) && this.selected.add(i));
    }
    this.applySelection();
  }

  frame() {
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.25) return;
    this.lastMd = md;
    // the ring shows only on a sample within a metre of the camera: redraw when that sample changes
    if (this.ringSample(md) !== this.ringAt) this.view.moveCursor();
  }

  settings() {
    return <Note>Pickett: the Sw = 1 water line and iso-Sw lines follow a, m, n and Rw from the Interpretation drawer, so the water line should run along the wet sands when the parameters are right. Hover a point to see its depth in 3D, click to travel there, drag a box to mark samples along the well.</Note>;
  }

  private rebuild() {
    const w = this.well();
    this.wellId = w?.id ?? '';
    this.fillZones();
    this.missing = missingCurves(this.kind, w?.logs);
    if (this.missing.length) this.scout();
    if (!w?.logs || this.missing.length) {
      this.pts = [];
    } else {
      const zones = w.zones;
      let opts: { fromMD?: number; toMD?: number; formationId?: string } = {};
      if (this.zone === 'reservoir') {
        const res = zones.filter((z) => ['draupne', 'heather', 'hugin', 'sleipner', 'skagerrak'].includes(z.formationId));
        if (res.length) opts = { fromMD: res[0].topMD, toMD: res[res.length - 1].baseMD };
      } else if (this.zone) opts = { formationId: this.zone };
      this.pts = crossplotPoints(this.kind, w.logs, w.petro, zones, opts);
    }
    const inputs = this.kind === 'nd' ? 'measured' : 'calculated';
    this.panel.opts.badge = inputs;
    this.panel.rev.bump();
    this.renderFoot();
    this.view.invalidate();
  }

  /** A logged well that has what this plot needs, to offer when this one does not. */
  private suggestion(): Well | null {
    const w = this.well();
    return this.app.selectableWells().find((o) => o !== w && o.logs && !missingCurves(this.kind, o.logs).length) ?? null;
  }

  /** The crossplot kinds this well can plot. */
  private possibleKinds(): CrossplotKind[] {
    return (Object.keys(CROSSPLOTS) as CrossplotKind[]).filter((k) => !missingCurves(k, this.well().logs).length);
  }

  /** Load the other logged wells (once), so the empty state can name one that has the curves. */
  private scout() {
    if (this.scouting || this.suggestion()) return;
    const todo = this.app.selectableWells().filter((o) => !o.loaded && o.lasFile);
    if (!todo.length) return;
    this.scouting = true;
    void Promise.allSettled(todo.map((o) => this.app.field.ensureLoaded(o))).then(() => {
      this.scouting = false;
      this.panel.rev.bump();
    });
  }

  /** Nothing to plot: the well lacks the curves. Name a well that has them, or another plot this one can make. */
  private renderEmpty() {
    const w = this.well();
    const other = this.suggestion();
    const alt = this.possibleKinds().find((k) => k !== this.kind);
    const need = this.missing.join(' and ');
    const them = this.missing.length > 1 ? 'them' : 'it';
    const setKind = (k: CrossplotKind) => {
      this.kind = k;
      this.clearSelection();
      this.rebuild();
      this.panel.rev.bump();
    };
    return (
      <Empty className="min-h-0 flex-1 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChartScatterIcon />
          </EmptyMedia>
          <EmptyTitle>
            {w.name} has no {need}
          </EmptyTitle>
          <EmptyDescription>
            {CROSSPLOTS[this.kind].label} plots need {them}. {other ? `${other.name} has ${them}.` : this.scouting ? 'Looking for a well that has …' : 'Import logs that include them.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {other ? (
            <Button size="sm" onPress={() => (this.pinned ? this.pinTo(other) : this.app.selectWell(other.id))}>
              Switch to {other.name}
            </Button>
          ) : (
            !this.scouting && (
              <Button size="sm" onPress={() => this.app.dataOpen.set(true)}>
                Import logs…
              </Button>
            )
          )}
          {alt && (
            <Button size="sm" variant="ghost" onPress={() => setKind(alt)}>
              {CROSSPLOTS[alt].label} instead
            </Button>
          )}
        </EmptyContent>
      </Empty>
    );
  }

  private fillZones() {
    const w = this.well();
    const prev = this.zone;
    const opts: Option[] = [
      { id: 'reservoir', label: 'Reservoir' },
      { id: ALL, label: 'All logged depths' },
    ];
    const seen = new Set<string>();
    for (const z of w?.zones ?? []) {
      if (seen.has(z.formationId) || z.formationId === 'air' || z.formationId === 'sea') continue;
      seen.add(z.formationId);
      opts.push({ id: z.formationId, label: z.name });
    }
    this.zoneOpts = opts;
    this.zone = opts.some((o) => o.id === (prev || ALL)) ? prev : 'reservoir';
  }

  // ------------------------------------------------------------------ axes
  private scale(a: Axis, p0: number, p1: number): (v: number) => number {
    const f = a.log ? Math.log10 : (v: number) => v;
    const lo = f(a.min);
    const hi = f(a.max);
    const [s0, s1] = a.reversed ? [p1, p0] : [p0, p1];
    return (v: number) => s0 + ((f(Math.max(v, a.log ? 1e-6 : -Infinity)) - lo) / (hi - lo)) * (s1 - s0);
  }

  private colour(p: XPoint): string {
    if (this.colourBy === 'formation') return FORMATION_BY_ID.get(p.formationId)?.color ?? '#9aa';
    if (this.colourBy === 'gr') {
      const d = CURVE_BY_KEY.get('GR')!;
      return Number.isFinite(p.gr) ? toCss(d.color(p.gr, this.app.colormapName)) : '#777';
    }
    if (this.colourBy === 'sw') {
      const d = CURVE_BY_KEY.get('SO')!;
      return Number.isFinite(p.sw) ? toCss(d.color(p.sw, this.app.colormapName)) : '#777';
    }
    const t = (p.md - (this.pts[0]?.md ?? 0)) / ((this.pts[this.pts.length - 1]?.md ?? 1) - (this.pts[0]?.md ?? 0) || 1);
    return `hsl(${200 - 170 * t},75%,${62 - 12 * t}%)`;
  }

  /** the static plot: grid, overlays, points */
  private drawLayer(g: CanvasRenderingContext2D, W: number, H: number) {
    const def = CROSSPLOTS[this.kind];
    const PAD = pads();
    const X = this.scale(def.x, PAD.l, W - PAD.r);
    const Y = this.scale(def.y, H - PAD.b, PAD.t);
    this.tx = X;
    this.ty = Y;
    // grid + ticks
    g.font = font.mono(10);
    g.strokeStyle = ink.grid;
    g.fillStyle = ink.muted;
    g.lineWidth = 1;
    const ticks = (a: Axis) => {
      if (a.log) {
        const out: number[] = [];
        for (let e = Math.floor(Math.log10(a.min)); e <= Math.ceil(Math.log10(a.max)); e++)
          for (const m of [1, 2, 5]) {
            const v = m * 10 ** e;
            if (v >= a.min && v <= a.max) out.push(v);
          }
        return out;
      }
      const span = a.max - a.min;
      const st = span > 0.6 ? 0.2 : 0.05;
      const out: number[] = [];
      for (let v = Math.ceil(a.min / st) * st; v <= a.max + 1e-9; v += st) out.push(+v.toFixed(3));
      return out;
    };
    const lbl = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) : v.toFixed(2).replace(/^0/, '').replace(/^-0/, '-'));
    g.textAlign = 'center';
    // tick labels that would touch the previous one are left out (the grid line stays)
    let lastX = -Infinity;
    for (const v of ticks(def.x)) {
      g.beginPath();
      g.moveTo(X(v), PAD.t);
      g.lineTo(X(v), H - PAD.b);
      g.stroke();
      const half = g.measureText(lbl(v)).width / 2;
      if (X(v) - half < lastX + 4) continue;
      lastX = X(v) + half;
      g.fillText(lbl(v), X(v), H - PAD.b + textLen(13));
    }
    g.textAlign = 'right';
    let lastY = Infinity;
    for (const v of ticks(def.y)) {
      g.beginPath();
      g.moveTo(PAD.l, Y(v));
      g.lineTo(W - PAD.r, Y(v));
      g.stroke();
      if (lastY - Y(v) < textLen(12)) continue;
      lastY = Y(v);
      g.fillText(lbl(v), PAD.l - 5, Y(v) + textLen(3.5));
    }
    g.font = font.sans(10.5, 400);
    g.fillStyle = ink.text;
    g.textAlign = 'center';
    g.fillText(def.x.label, (PAD.l + W - PAD.r) / 2, H - 6);
    g.save();
    g.translate(textLen(12), (PAD.t + H - PAD.b) / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(fitText(g, def.y.label, H - PAD.t - PAD.b), 0, 0);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b);
    g.clip();
    // points
    const sel = this.selected.size > 0;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const on = this.selected.has(i);
      g.globalAlpha = sel && !on ? 0.18 : 0.75;
      g.fillStyle = on ? SEL_COLOR : this.colour(p);
      g.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3);
    }
    g.globalAlpha = 1;
    // reference lines from the interpretation parameters
    const params = this.app.engine.activeWell?.params;
    const line = (pts: [number, number][], color: string, label?: string, dash: number[] = []) => {
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.lineWidth = 1.4;
      g.beginPath();
      pts.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
      g.setLineDash([]);
      if (label) {
        // label at the last point inside the plot
        const inside = pts.filter(([x, y]) => X(x) > PAD.l && X(x) < W - PAD.r - 30 && Y(y) > PAD.t + 8 && Y(y) < H - PAD.b);
        const q = inside[inside.length - 1];
        if (q) {
          g.fillStyle = color;
          g.font = font.sans(10, 400);
          // keep the label inside the plot: flip it to the left of the point near the right edge
          const flip = X(q[0]) + 4 + g.measureText(label).width > W - PAD.r - 2;
          g.textAlign = flip ? 'right' : 'left';
          g.fillText(label, X(q[0]) + (flip ? -4 : 4), Y(q[1]) - 3);
        }
      }
    };
    if (params && this.kind === 'pickett') {
      let swRight = -Infinity;
      for (const [sw, c] of [
        [1, '#5fb4ff'],
        [0.5, '#9fd0a8'],
        [0.3, '#e8c170'],
        [0.2, '#f0976a'],
      ] as const) {
        line(pickettLine(params, sw), c, undefined, sw === 1 ? [] : [5, 3]);
        // label each line at φ = 0.35, where neighbouring lines are far enough apart
        g.fillStyle = c;
        g.textAlign = 'left';
        g.font = font.sans(10, 400);
        // left out where it would run into the previous line's label
        const text = sw === 1 ? 'Sw 1 water' : `Sw ${sw}`;
        const lx = X((params.a * params.rw) / (0.35 ** params.m * sw ** params.n)) + 5;
        if (lx < swRight + 6) continue;
        swRight = lx + g.measureText(text).width;
        g.fillText(text, lx, Y(0.35) + 3);
      }
    } else if (params && this.kind === 'nd') {
      const ml = matrixLine(params);
      line(ml, '#e8c170', `ρma ${params.rhoMa}`);
      g.fillStyle = '#e8c170';
      g.font = font.sans(9.5, 400);
      for (const [x, y] of ml) {
        g.beginPath();
        g.arc(X(x), Y(y), 2, 0, Math.PI * 2);
        g.fill();
        if (x > 0) g.fillText(`${Math.round(x * 100)}`, X(x) + 4, Y(y) + 10);
      }
    } else if (params && this.kind === 'buckles') {
      for (const b of [0.02, 0.04, 0.06, 0.1]) line(bvwLine(b), 'rgba(160,210,255,0.75)', `BVW ${b}`, [5, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(X(params.cutSw), PAD.t);
      g.lineTo(X(params.cutSw), H - PAD.b);
      g.moveTo(PAD.l, Y(params.cutPhi));
      g.lineTo(W - PAD.r, Y(params.cutPhi));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.textAlign = 'left';
      g.fillText('pay', PAD.l + 4, PAD.t + textLen(12));
    }
    g.restore();
    g.strokeStyle = wash(0.2);
    g.strokeRect(PAD.l + 0.5, PAD.t + 0.5, W - PAD.l - PAD.r - 1, H - PAD.t - PAD.b - 1);
    if (!this.pts.length) {
      g.fillStyle = ink.muted;
      g.textAlign = 'center';
      g.font = font.sans(11, 400);
      const need = this.kind === 'nd' ? 'NPHI and RHOB' : 'RT and RHOB (for φ)';
      g.fillText(`No samples with ${need} in this interval.`, (PAD.l + W - PAD.r) / 2, (PAD.t + H - PAD.b) / 2);
    }
  }

  /** the sample the camera is within a metre of, or -1 */
  private ringSample(md: number) {
    if (!this.pts.length || !this.isOpenWell()) return -1;
    const i = this.nearestMd(md);
    return Math.abs(this.pts[i].md - md) < 1 ? i : -1;
  }

  private drawCursor(g: CanvasRenderingContext2D) {
    // the sample at the camera depth
    const X = this.tx;
    const Y = this.ty;
    this.ringAt = this.ringSample(this.app.engine.rig.md);
    if (X && Y && this.ringAt >= 0) {
      const p = this.pts[this.ringAt];
      g.strokeStyle = '#7fe3ff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(X(p.x), Y(p.y), 6, 0, Math.PI * 2);
      g.stroke();
    }
    if (this.brush) {
      const b = this.brush;
      g.fillStyle = 'rgba(255,95,210,0.12)';
      g.strokeStyle = SEL_COLOR;
      g.lineWidth = 1;
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
  }

  private nearestMd(md: number): number {
    // points are in MD order
    let lo = 0;
    let hi = this.pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.pts[m].md <= md) lo = m;
      else hi = m;
    }
    return Math.abs(this.pts[hi].md - md) < Math.abs(this.pts[lo].md - md) ? hi : lo;
  }

  private nearest(x: number, y: number, r = 8): number {
    if (!this.tx || !this.ty) return -1;
    let best = -1;
    let bd = r * r;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      const d = (this.tx(p.x) - x) ** 2 + (this.ty(p.y) - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ interaction
  private pointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    this.down = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent) {
    const down = this.down;
    if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 4) {
      this.brush = { x0: down.x, y0: down.y, x1: e.offsetX, y1: e.offsetY };
      this.view.invalidateCursor();
      return;
    }
    if (down) return;
    const i = this.nearest(e.offsetX, e.offsetY);
    const p = this.pts[i];
    if (!p) {
      this.hoverMd(null);
      this.readout.set(this.pts.length ? `${this.pts.length.toLocaleString('en-US')} samples · hover for depth · drag a box to select` : null);
      return;
    }
    this.hoverMd(p.md);
    const def = CROSSPLOTS[this.kind];
    const fx = (v: number, a: Axis) => (a.log ? fmt.res(v) : fmt.n(v, 3));
    const z = this.well().zoneAt(p.md);
    this.readout.set(`MD ${fmt.n(p.md, 1)} m · ${z?.name ?? ''} · x ${fx(p.x, def.x)} · y ${fx(p.y, def.y)}${Number.isFinite(p.gr) ? ` · GR ${fmt.n(p.gr, 0)}` : ''}${Number.isFinite(p.sw) ? ` · Sw ${fmt.n(p.sw, 2)}` : ''}`);
  }

  private pointerUp(e: PointerEvent) {
    if (!this.down) return;
    const b = this.brush;
    this.down = null;
    this.brush = null;
    if (b && this.tx && this.ty) {
      const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
      const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
      if (!e.shiftKey) this.selected.clear();
      this.pts.forEach((p, i) => {
        const x = this.tx!(p.x);
        const y = this.ty!(p.y);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) this.selected.add(i);
      });
      this.applySelection();
    } else {
      const i = this.nearest(e.offsetX, e.offsetY);
      if (i >= 0) this.travel(this.pts[i].md);
      else if (this.selected.size) this.clearSelection();
    }
    this.view.invalidateCursor();
  }

  private pointerCancel() {
    this.down = null;
    this.brush = null;
    this.view.invalidateCursor();
  }

  /** Travel to a depth of the plotted well (opening it first when it is pinned and not open). */
  private travel(md: number) {
    if (this.isOpenWell()) this.app.travelTo(md);
    else void this.app.loadWellAsync(this.well().id, false).then(() => this.app.travelTo(md));
  }

  private hoverMd(md: number | null) {
    // the highlight is on the open well's wall
    if (md !== null && !this.isOpenWell()) md = null;
    const wb = this.app.engine.wellbore;
    if (wb) wb.uniforms.uHoverMd.value = md ?? -1e6;
    this.app.engine.requestRender();
  }

  private selectedMds(): number[] {
    return [...this.selected].map((i) => this.pts[i]?.md).filter((v): v is number => v !== undefined);
  }

  private clearSelection() {
    this.selected.clear();
    this.applySelection();
  }

  private applySelection() {
    const mds = this.selectedMds();
    this.setMarkers(mds);
    this.setMarking(mds);
    this.renderFoot();
    this.view.invalidate();
    // the link chip says whether it marks
    this.panel.rev.bump();
  }

  /** Share the marked depths (the timeline shows them as ticks); clear only a marking this plot made. */
  private setMarking(mds: number[]) {
    const m = this.app.marking;
    if (!mds.length) {
      if (m.value?.source === MARK_SOURCE) m.set(null);
      return;
    }
    m.set({ well: this.well().id, intervals: mdIntervals(mds).map((q) => [q.top, q.base]), source: MARK_SOURCE });
  }

  private renderFoot() {
    const mds = this.selectedMds();
    if (!mds.length) {
      this.foot.set(<span className="text-muted-foreground">Drag a box to select samples (Shift adds). They are marked along the well in 3D.</span>);
      return;
    }
    const iv = mdIntervals(mds).sort((a, b) => b.n - a.n);
    const net = iv.reduce((s, q) => s + (q.base - q.top), 0);
    this.foot.set(
      <>
        <span>
          <b className="font-medium">{mds.length.toLocaleString('en-US')} samples</b>
          <span className="text-muted-foreground">
            {' '}
            · {iv.length} interval{iv.length > 1 ? 's' : ''} · {fmt.n(net, 1)} m MD
          </span>
        </span>
        {iv.slice(0, 6).map((q) => {
          const text = q.base - q.top < 1 ? `${fmt.n(q.top, 0)}` : `${fmt.n(q.top, 0)}–${fmt.n(q.base, 0)}`;
          return (
            <Button key={q.top} variant="ghost" size="xs" aria-label={`Travel to ${text} m MD`} onPress={() => this.travel((q.top + q.base) / 2)}>
              {text}
            </Button>
          );
        })}
        <Button variant="ghost" size="xs" onPress={() => this.clearSelection()}>
          Clear selection
        </Button>
      </>,
    );
  }

  /** mark the selected sample depths along the active well in 3D */
  private setMarkers(mds: number[]) {
    const e = this.app.engine;
    if (this.markers) {
      e.scene.remove(this.markers);
      this.markers.geometry.dispose();
      (this.markers.material as THREE.Material).dispose();
      this.markers = undefined;
    }
    if (!mds.length || !e.activeWell) return;
    // on the plotted well's path (a pinned plot marks its own well)
    const t = this.well().trajectory;
    const pos = new Float32Array(mds.length * 3);
    const v = new THREE.Vector3();
    mds.forEach((md, i) => {
      const p = t.at(Math.min(md, t.mdEnd));
      e.coords.toScene(p.ns, p.ew, p.tvd, v);
      pos.set([v.x, v.y, v.z], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: SEL_COLOR, size: 5, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.9 });
    this.markers = new THREE.Points(geo, mat);
    this.markers.renderOrder = 999;
    this.markers.frustumCulled = false;
    e.scene.add(this.markers);
  }
}

/** Text cut to `max` px with an ellipsis. */
function fitText(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
