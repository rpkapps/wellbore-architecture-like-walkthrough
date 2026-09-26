import { corrAxis, corrDatum, corrTrack, corrZones, type CorrAxis, type CorrDepthMode, type CorrZone } from '../data/correlation';
import type { Well } from '../data/dataset';
import { FORMATION_BY_ID, MODEL_HORIZONS } from '../data/stratigraphy';
import { Button } from '@tecton/react/components/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { ColumnsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { App } from '../ui/app';
import { CompactSelect, Note, SelectField, SwitchField } from '../ui/controls';
import { fmt } from '../ui/dom';
import { CanvasBox, PanelCanvas, ToolWindow } from '../ui/toolWindow';
import { Live, Rev, Signal } from '../ui/signal';
import { font, ink, wash } from '../ui/tokens';
import { CURVES, CURVE_BY_KEY } from './curves';
import { niceStep } from './geosteer';
import type { FeatureModule } from './registry';

interface Column {
  well: Well;
  axis: CorrAxis;
  zones: CorrZone[];
  /** depth of the flattening top on the correlation axis, null when the well does not reach it */
  datum: number | null;
  /** vertical shift applied to this well: panel depth = axis depth − shift */
  shift: number;
  tracks: Map<string, { md: number; d: number; v: number }[]>;
}

const OVERLAY_COLOR = '#ff8f9e';
/** select key for the empty choice (no flattening, no overlay) */
const NONE = '_none';
/** the tops it can flatten on (the seabed unit has no top in the wells) */
const FLATTEN_ON = MODEL_HORIZONS.filter((id) => !['nordland'].includes(id));

/**
 * Multi-well correlation panel: log tracks of every logged well side by side,
 * optionally flattened on a formation top, with the formation intervals and
 * the same tops joined between neighbouring wells.
 */
export class CorrelationFeature implements FeatureModule {
  readonly id = 'correlation' as const;
  private panel: ToolWindow;
  readonly rev = new Rev();
  /** the tracks are cached; playback only moves the cursor line over them */
  private view = new PanelCanvas({ draw: (g, W, H) => this.draw(g, W, H), cursor: (g, W, H) => this.drawCursor(g, W, H), visible: () => this.panel.visible, wheel: (e) => this.wheel(e) });
  /** the active well's track, for the cursor */
  private activeCol: { col: Column; x0: number } | null = null;
  private readout = new Signal<ReactNode>(null);
  private cols: Column[] = [];
  private datumId = 'hugin';
  private mode: CorrDepthMode = 'tvdss';
  private curve = 'GR';
  private overlay = 'RT';
  private order: 'we' | 'sn' | 'list' = 'we';
  private hidden = new Set<string>();
  private win: { d0: number; d1: number } | null = null;
  private loading = false;
  private lastMd = -1;
  private layout: { PL: number; PT: number; PB: number; cw: number; tw: number; Y: (d: number) => number; D: (y: number) => number } | null = null;

  constructor(private app: App) {
    // cached drawings: redraw when a colour they use changes
    app.paintRev.subscribe(() => this.view.invalidate());
    const curves = CURVES.map((c) => ({ id: c.key, label: c.label }));
    this.panel = new ToolWindow({
      id: 'correlation',
      title: 'Well correlation',
      badge: 'measured',
      onClose: () => app.flags.set('correlation', false),
      header: () => (
        <>
          <CompactSelect
            label="Flatten on a formation top"
            value={this.datumId || NONE}
            onChange={(v) => this.flattenOn(v === NONE ? '' : v)}
            options={[{ id: NONE, label: 'No flattening' }, ...FLATTEN_ON.map((id) => ({ id, label: `Flatten: ${FORMATION_BY_ID.get(id)?.name ?? id}` }))]}
          />
          <CompactSelect
            label="Vertical axis"
            value={this.mode}
            onChange={(v) => {
              this.mode = v as CorrDepthMode;
              this.win = null;
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={[
              { id: 'tvdss', label: 'TVDSS' },
              { id: 'md', label: 'MD' },
            ]}
          />
          <CompactSelect
            label="Filled curve"
            value={this.curve}
            onChange={(v) => {
              this.curve = v;
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={curves}
          />
          <CompactSelect
            label="Overlay curve"
            value={this.overlay || NONE}
            onChange={(v) => {
              this.overlay = v === NONE ? '' : v;
              this.rebuild();
              this.panel.rev.bump();
            }}
            options={[{ id: NONE, label: 'No overlay' }, ...CURVES.map((c) => ({ id: c.key, label: `+ ${c.label}` }))]}
          />
        </>
      ),
      links: () => ({
        subject: 'Logged wells',
        followsWell: false,
        channels: [
          { id: 'well', label: 'Highlight the open well', short: app.engine.activeWell.name.replace(/^15\/9-/, ''), on: true },
          { id: 'cursor', label: 'Show the depth cursor on it', short: 'depth cursor', on: true },
        ],
      }),
      body: () =>
        !this.loading && this.cols.length < 2 ? (
          this.renderEmpty()
        ) : (
          <>
            <CanvasBox
              view={this.view}
              aria-label="Log tracks of the logged wells side by side: click a track to travel there"
              className="cursor-pointer"
              onClick={(e) => this.click(e.nativeEvent.offsetX, e.nativeEvent.offsetY)}
              onPointerMove={(e) => this.hover(e.nativeEvent.offsetX, e.nativeEvent.offsetY)}
              onPointerLeave={() => this.hover(-1, -1)}
              onDoubleClick={() => ((this.win = null), this.view.invalidate())}
            />
            <p className="min-h-4 shrink-0 truncate font-mono text-xs text-muted-foreground">
              <Live s={this.readout} />
            </p>
          </>
        ),
    });
    // the well list follows the "More Volve wells" feature (skip the immediate call from watch)
    let first = true;
    app.flags.watch('extraWells', () => {
      if (!first) this.rev.bump();
      if (!first && app.flags.on('correlation')) void this.load();
      first = false;
    });
  }

  private wheel(e: WheelEvent) {
    if (!this.win || !this.layout) return;
    e.preventDefault();
    const { d0, d1 } = this.win;
    const span = d1 - d0;
    if (e.ctrlKey || e.metaKey) {
      // zoom about the depth under the pointer
      const at = this.layout.D(e.offsetY);
      const k = Math.exp(e.deltaY * 0.0015);
      const ns = Math.max(20, Math.min(6000, span * k));
      const f = (at - d0) / span;
      this.win = { d0: at - f * ns, d1: at - f * ns + ns };
    } else {
      const dd = (e.deltaY / 600) * span;
      this.win = { d0: d0 + dd, d1: d1 + dd };
    }
    this.view.invalidate();
  }

  enable() {
    this.panel.show();
    void this.load();
  }

  disable() {
    this.panel.hide();
  }

  onWell() {
    // interpretation parameters or uploads may have changed calculated curves and zones
    void this.load();
    // the link chip names the open well
    this.panel.rev.bump();
  }

  /** Can the tracks be flattened on this formation's top? */
  static canFlatten(id: string) {
    return FLATTEN_ON.includes(id);
  }

  /** Flatten the tracks on a formation top ('' for none): the task bar's "Flatten on top". */
  flattenOn(id: string) {
    if (id && !CorrelationFeature.canFlatten(id)) return;
    this.datumId = id;
    this.win = null;
    if (this.app.flags.on('correlation')) this.rebuild();
    this.panel.rev.bump();
  }

  /** Show a well's track again if it was left out (the task bar's "Correlate"). */
  include(wellId: string) {
    if (!this.hidden.delete(wellId)) return;
    if (this.app.flags.on('correlation')) this.rebuild();
    this.rev.bump();
  }

  /** Fewer than two wells to correlate: say why, and offer what adds one. */
  private renderEmpty() {
    const extra = this.app.flags.on('extraWells');
    const left = this.hidden.size > 0;
    return (
      <Empty className="min-h-0 flex-1 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ColumnsIcon />
          </EmptyMedia>
          <EmptyTitle>Correlation needs two wells with logs</EmptyTitle>
          <EmptyDescription>
            {this.cols.length ? `Only ${this.cols[0].well.name} has logs here.` : 'No well shown here has logs.'}{' '}
            {left ? 'Some wells are left out in its settings.' : extra ? 'Import the logs of another well.' : 'More Volve wells adds wells with full log suites.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {left ? (
            <Button size="sm" onPress={() => (this.hidden.clear(), this.rebuild(), this.rev.bump(), this.panel.rev.bump())}>
              Show every logged well
            </Button>
          ) : extra ? (
            <Button size="sm" onPress={() => this.app.dataOpen.set(true)}>
              Import logs…
            </Button>
          ) : (
            <Button size="sm" onPress={() => this.app.flags.set('extraWells', true)}>
              Add more Volve wells
            </Button>
          )}
        </EmptyContent>
      </Empty>
    );
  }

  frame() {
    const md = this.app.engine.rig.md;
    if (Math.abs(md - this.lastMd) < 0.5) return;
    this.lastMd = md;
    this.view.moveCursor();
  }

  settings() {
    return (
      <>
        <SelectField
          label="Well order"
          value={this.order}
          onChange={(v) => {
            this.order = v as typeof this.order;
            this.rebuild();
            this.rev.bump();
          }}
          options={[
            { id: 'we', label: 'West → east' },
            { id: 'sn', label: 'South → north' },
            { id: 'list', label: 'Well list order' },
          ]}
        />
        {this.candidates().map((w) => (
          <SwitchField
            key={w.id}
            label={w.name}
            isSelected={!this.hidden.has(w.id)}
            onChange={(v) => {
              if (v) this.hidden.delete(w.id);
              else this.hidden.add(w.id);
              this.rebuild();
              this.rev.bump();
              this.panel.rev.bump();
            }}
          />
        ))}
        <Note>TVDSS shows each well’s first downward pass, so laterals are compressed; switch to MD to see them in full. Wheel scrolls, Ctrl + wheel zooms, double-click resets. Click a track to travel there (other wells become active).</Note>
      </>
    );
  }

  private candidates(): Well[] {
    const extra = this.app.flags.on('extraWells');
    return this.app.field.wells.filter((w) => (w.lasFile || w.logs) && (!w.extra || extra));
  }

  private async load() {
    if (this.loading) return;
    this.loading = true;
    this.view.invalidate();
    try {
      for (const w of this.candidates()) if (!w.loaded) await this.app.field.ensureLoaded(w);
    } catch (err) {
      console.error(err);
    } finally {
      this.loading = false;
    }
    if (this.app.flags.on('correlation')) this.rebuild();
    // uploads may have added logged wells to the settings list
    this.rev.bump();
    this.panel.rev.bump();
  }

  private rebuild() {
    const f = this.app.field;
    const dz = f.meta.datumElevation;
    const list = this.candidates().filter((w) => w.logs && !this.hidden.has(w.id));
    const cols: Column[] = list.map((w) => {
      const axis = corrAxis(w.trajectory, this.mode, dz);
      const zones = corrZones(w.zones, axis);
      return { well: w, axis, zones, datum: this.datumId ? corrDatum(zones, this.datumId) : null, shift: 0, tracks: new Map() };
    });
    // wells that never reach the flattening top hang at the mean datum depth
    const withDatum = cols.filter((c) => c.datum !== null);
    const mean = withDatum.length ? withDatum.reduce((s, c) => s + c.datum!, 0) / withDatum.length : 0;
    for (const c of cols) c.shift = this.datumId ? (c.datum ?? mean) : 0;
    // plan position used for ordering: where the well crosses the datum, else its TD
    const planPos = (c: Column) => {
      const z = this.datumId ? c.well.zones.find((q) => q.formationId === this.datumId) : undefined;
      return c.well.trajectory.at(z ? z.topMD : c.well.trajectory.mdEnd);
    };
    if (this.order === 'we') cols.sort((a, b) => planPos(a).ew - planPos(b).ew);
    else if (this.order === 'sn') cols.sort((a, b) => planPos(a).ns - planPos(b).ns);
    for (const c of cols) {
      for (const key of [this.curve, this.overlay]) {
        const data = key ? CURVE_BY_KEY.get(key)?.get(c.well) : null;
        if (data) c.tracks.set(key, corrTrack(data.depth, data.values, c.axis, 0.5));
      }
    }
    this.cols = cols;
    if (!this.win) this.win = this.defaultWindow();
    this.lastMd = -1;
    this.view.invalidate();
  }

  private defaultWindow(): { d0: number; d1: number } {
    if (this.datumId) return { d0: -150, d1: 250 };
    // no flattening: frame the reservoir section of all wells
    const tops = this.cols.map((c) => c.zones.find((z) => ['draupne', 'heather', 'hugin'].includes(z.formationId))?.top).filter((v): v is number => v !== undefined);
    if (tops.length) return { d0: Math.min(...tops) - 150, d1: Math.max(...tops) + 300 };
    const all = this.cols.flatMap((c) => [c.zones[0]?.top ?? 0, c.zones[c.zones.length - 1]?.base ?? 3000]);
    return { d0: Math.min(...all), d1: Math.max(...all) };
  }

  /** column index and MD under a canvas point */
  private pick(x: number, y: number): { col: Column; md: number; d: number } | null {
    const L = this.layout;
    if (!L || !this.cols.length) return null;
    const i = Math.floor((x - L.PL) / L.cw);
    if (i < 0 || i >= this.cols.length) return null;
    const col = this.cols[i];
    const d = L.D(y) + col.shift;
    // invert the axis on the trajectory grid (the axis is monotone in MD)
    const t = col.well.trajectory;
    let lo = t.md[0];
    let hi = Math.max(t.mdEnd, col.well.tdMD);
    if (col.axis.at(hi) < d || col.axis.at(lo) > d) return null;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (col.axis.at(m) < d) lo = m;
      else hi = m;
    }
    return { col, md: lo, d };
  }

  private click(x: number, y: number) {
    const p = this.pick(x, y);
    if (!p) return;
    if (p.col.well === this.app.engine.activeWell) this.app.travelTo(p.md);
    else void this.app.loadWellAsync(p.col.well.id, false).then(() => this.app.travelTo(p.md));
  }

  private hover(x: number, y: number) {
    const p = x >= 0 ? this.pick(x, y) : null;
    const e = this.app.engine;
    if (!p) {
      this.readout.set(this.cols.length ? 'Hover a track for values · click to travel' : null);
      if (e.wellbore) e.wellbore.uniforms.uHoverMd.value = -1e6;
      this.app.engine.requestRender();
      return;
    }
    const z = p.col.well.zoneAt(p.md);
    const val = (key: string) => {
      const tr = key ? p.col.tracks.get(key) : undefined;
      const def = CURVE_BY_KEY.get(key);
      if (!tr || !def || !tr.length) return '';
      const s = tr.reduce((a, b) => (Math.abs(b.md - p.md) < Math.abs(a.md - p.md) ? b : a));
      return Math.abs(s.md - p.md) < 3 ? ` · ${def.key} ${def.unit === 'Ω·m' ? fmt.res(s.v) : fmt.n(s.v, def.unit === 'v/v' || def.unit === 'g/cm³' ? 2 : 0)} ${def.unit}` : '';
    };
    const rel = this.datumId && p.col.datum !== null ? ` · ${fmt.n(p.d - p.col.datum, 1)} m ${p.d >= p.col.datum ? 'below' : 'above'} ${FORMATION_BY_ID.get(this.datumId)?.name ?? ''} top` : '';
    this.readout.set(`${p.col.well.name} · MD ${fmt.n(p.md, 1)} m · ${this.mode === 'tvdss' ? 'TVDSS' : 'MD'} ${fmt.n(p.d, 1)} m${rel} · ${z?.name ?? ''}${val(this.curve)}${val(this.overlay)}`);
    if (e.wellbore) e.wellbore.uniforms.uHoverMd.value = p.col.well === e.activeWell ? p.md : -1e6;
    this.app.engine.requestRender();
  }

  private draw(g: CanvasRenderingContext2D, W: number, H: number) {
    this.activeCol = null;
    g.font = font.sans(11, 400);
    if (this.loading && !this.cols.length) {
      g.fillStyle = ink.muted;
      g.textAlign = 'center';
      g.fillText('Loading logged wells …', W / 2, H / 2);
      return;
    }
    if (!this.cols.length || !this.win) {
      g.fillStyle = ink.muted;
      g.textAlign = 'center';
      g.fillText('No logged wells selected.', W / 2, H / 2);
      return;
    }
    const PL = 50;
    const PR = 8;
    const PT = 38;
    const PB = 18;
    const n = this.cols.length;
    const cw = (W - PL - PR) / n;
    const tw = Math.max(24, cw * 0.62);
    const { d0, d1 } = this.win;
    const Y = (d: number) => PT + ((d - d0) / (d1 - d0)) * (H - PT - PB);
    const D = (y: number) => d0 + ((y - PT) / (H - PT - PB)) * (d1 - d0);
    this.layout = { PL, PT, PB, cw, tw, Y, D };
    const left = (i: number) => PL + i * cw + (cw - tw) / 2;
    g.save();
    g.beginPath();
    g.rect(PL, PT, W - PL - PR, H - PT - PB);
    g.clip();
    // formation fills between neighbouring wells, then the same tops joined
    for (let i = 0; i < n - 1; i++) {
      const a = this.cols[i];
      const b = this.cols[i + 1];
      const xa = left(i) + tw;
      const xb = left(i + 1);
      for (const za of a.zones) {
        const zb = b.zones.find((q) => q.formationId === za.formationId);
        if (!zb) continue;
        const col = FORMATION_BY_ID.get(za.formationId)?.color ?? '#555';
        g.fillStyle = col;
        g.globalAlpha = 0.28;
        g.beginPath();
        g.moveTo(xa, Y(za.top - a.shift));
        g.lineTo(xb, Y(zb.top - b.shift));
        g.lineTo(xb, Y(zb.base - b.shift));
        g.lineTo(xa, Y(za.base - a.shift));
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = col;
        g.lineWidth = za.formationId === this.datumId ? 1.8 : 1;
        g.setLineDash(za.formationId === this.datumId ? [] : [4, 3]);
        g.beginPath();
        g.moveTo(xa, Y(za.top - a.shift));
        g.lineTo(xb, Y(zb.top - b.shift));
        g.stroke();
        g.setLineDash([]);
      }
    }
    // tracks
    const active = this.app.engine.activeWell;
    const def = CURVE_BY_KEY.get(this.curve);
    const odef = this.overlay ? CURVE_BY_KEY.get(this.overlay) : undefined;
    this.cols.forEach((c, i) => {
      const x0 = left(i);
      // zone colours behind the track
      for (const z of c.zones) {
        const y0 = Y(z.top - c.shift);
        const y1 = Y(z.base - c.shift);
        if (y1 < PT || y0 > H - PB) continue;
        g.fillStyle = FORMATION_BY_ID.get(z.formationId)?.color ?? '#555';
        g.globalAlpha = 0.45;
        g.fillRect(x0, y0, tw, y1 - y0);
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(8,11,15,0.35)';
      g.fillRect(x0, PT, tw, H - PT - PB);
      // filled curve
      const tr = c.tracks.get(this.curve);
      if (def && tr) {
        for (let k = 1; k < tr.length; k++) {
          const s = tr[k];
          const y = Y(s.d - c.shift);
          if (y < PT - 2 || y > H - PB + 2) continue;
          if (s.d - tr[k - 1].d > 3) continue; // gap in the log
          const yp = Y(tr[k - 1].d - c.shift);
          const hgt = Math.max(1, y - yp);
          const rgb = def.color(s.v, this.app.colormapName);
          g.fillStyle = `rgb(${rgb.map((q) => Math.round(q * 255)).join(',')})`;
          g.fillRect(x0, yp, def.amp(s.v) * tw, hgt);
        }
        g.strokeStyle = 'rgba(240,244,248,0.85)';
        g.lineWidth = 1;
        this.polyline(g, tr, (s) => x0 + def.amp(s.v) * tw, (s) => s.d - c.shift, Y);
      }
      const ot = this.overlay ? c.tracks.get(this.overlay) : undefined;
      if (odef && ot) {
        g.strokeStyle = OVERLAY_COLOR;
        g.lineWidth = 1.1;
        this.polyline(g, ot, (s) => x0 + odef.amp(s.v) * tw, (s) => s.d - c.shift, Y);
      }
      if (c.well === active) this.activeCol = { col: c, x0 };
      g.strokeStyle = c.well === active ? '#7fe3ff' : wash(0.18);
      g.lineWidth = c.well === active ? 1.5 : 1;
      g.strokeRect(x0 + 0.5, PT, tw - 1, H - PT - PB);
    });
    // datum line
    if (this.datumId) {
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(PL, Y(0));
      g.lineTo(W - PR, Y(0));
      g.stroke();
    }
    g.restore();
    // headers
    g.textAlign = 'center';
    this.cols.forEach((c, i) => {
      const x = left(i) + tw / 2;
      g.font = font.sans(11, c.well === active ? 600 : 500);
      g.fillStyle = c.well === active ? '#7fe3ff' : ink.text;
      g.fillText(c.well.name.replace(/^15\/9-/, ''), x, 14);
      g.font = font.sans(9.5, 400);
      g.fillStyle = ink.faint;
      const sub = this.datumId && c.datum === null ? 'top not reached' : !c.tracks.get(this.curve) ? `no ${def?.key ?? 'curve'}` : this.datumId ? `${fmt.n(c.datum!, 0)} m` : '';
      g.fillText(sub, x, 28);
    });
    // depth axis
    g.fillStyle = ink.card;
    g.globalAlpha = 0.85;
    g.fillRect(0, PT, PL - 4, H - PT);
    g.globalAlpha = 1;
    g.font = font.mono(10);
    g.fillStyle = ink.muted;
    g.textAlign = 'right';
    const st = niceStep((d1 - d0) / 8);
    for (let d = Math.ceil(d0 / st) * st; d <= d1; d += st) g.fillText(d.toFixed(0), PL - 8, Y(d) + 3);
    g.textAlign = 'left';
    g.fillText(this.datumId ? 'rel.' : this.mode === 'tvdss' ? 'TVDSS' : 'MD', 4, PT - 6);
    // scale note
    g.textAlign = 'right';
    g.font = font.sans(10, 400);
    const flat = this.datumId ? `flattened on ${FORMATION_BY_ID.get(this.datumId)?.name ?? this.datumId} top (m ${this.mode === 'tvdss' ? 'TVD' : 'MD'} from top)` : `${this.mode === 'tvdss' ? 'TVDSS' : 'MD'} m`;
    g.fillText(`${flat} · ${def ? `${def.label} ${def.range}` : ''}${odef ? ` · + ${odef.label}` : ''}`, W - PR, H - 4);
    if (odef) {
      g.fillStyle = OVERLAY_COLOR;
      g.fillRect(PL, H - 11, 14, 2);
    }
  }

  /** the cursor on the active well, inside the tracks' frame */
  private drawCursor(g: CanvasRenderingContext2D, W: number, H: number) {
    const L = this.layout;
    const a = this.activeCol;
    if (!L || !a) return;
    const y = L.Y(a.col.axis.at(this.app.engine.rig.md) - a.col.shift);
    if (y < L.PT || y > H - L.PB) return;
    g.save();
    g.beginPath();
    g.rect(L.PL, L.PT, W - L.PL - 8, H - L.PT - L.PB);
    g.clip();
    g.strokeStyle = '#7fe3ff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(a.x0 - 4, y);
    g.lineTo(a.x0 + L.tw + 4, y);
    g.stroke();
    g.restore();
  }

  /** stroke a log curve, breaking it where the samples are more than 3 m apart */
  private polyline<T>(g: CanvasRenderingContext2D, pts: T[], fx: (p: T) => number, fd: (p: T) => number, Y: (d: number) => number) {
    g.beginPath();
    let prev = NaN;
    for (const p of pts) {
      const d = fd(p);
      if (Number.isFinite(prev) && d - prev <= 3) g.lineTo(fx(p), Y(d));
      else g.moveTo(fx(p), Y(d));
      prev = d;
    }
    g.stroke();
  }
}
