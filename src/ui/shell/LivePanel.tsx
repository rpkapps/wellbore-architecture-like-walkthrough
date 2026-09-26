import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { ActivityIcon, ListFilterIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimeSeries } from '../../connect/store';
import type { App } from '../app';
import { CompactSelect } from '../controls';
import { IconButton } from '../icon-button';
import { themeRev } from '../prefs';
import { useSignal } from '../signal';
import { cssVar, font, ink, textLen, wash } from '../tokens';
import { fitStore } from '../toolWindow';
import { binWidth, Envelope, LiveClock } from '../liveEnvelope';

/**
 * Strip charts of the readings a live source delivers by time — the rig's
 * view of a well being drilled: one track per channel, newest at the right,
 * the last value large. Drawn on one canvas; each pixel column shows the
 * minimum and maximum of the readings it covers, so an hour of 1 Hz data
 * draws as fast as a minute.
 */
const WINDOWS = [
  { id: '300000', label: '5 min' },
  { id: '1800000', label: '30 min' },
  { id: '7200000', label: '2 h' },
  { id: '43200000', label: '12 h' },
  { id: 'all', label: 'All' },
];
/** Drilling channels first, in the order a driller reads them. */
const PREFERRED = ['ROPA', 'ROP', 'WOBA', 'WOB', 'RPMA', 'RPM', 'TQA', 'TORQUE', 'SPPA', 'SPP', 'HKLA', 'HKL', 'MFIA', 'FLOWIN', 'GR', 'RDEP', 'DMEA', 'DBTM'];
const COLORS = ['azure', 'saffron', 'lime', 'orchid', 'red', 'violet', 'green', 'pink', 'lemon', 'blue'];

function pickDefault(names: string[]): string[] {
  const up = (s: string) => s.toUpperCase();
  const ranked = [...names].sort((a, b) => {
    const ia = PREFERRED.indexOf(up(a));
    const ib = PREFERRED.indexOf(up(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return ranked.slice(0, 6);
}

export function LiveActions({ app }: { app: App }) {
  const { wellId, series, setWellId, shown, setShown, windowMs, setWindowMs, wells } = useLiveState(app);
  const names = series ? [...series.channels.keys()] : [];
  return (
    <>
      {wells.length > 1 && <CompactSelect label="Well" value={wellId} onChange={setWellId} options={wells.map((w) => ({ id: w.id, label: w.name }))} className="max-w-36 min-w-0" />}
      <CompactSelect label="Time window" value={windowMs} onChange={setWindowMs} options={WINDOWS} />
      <DropdownMenuTrigger>
        <IconButton label="Channels" isDisabled={!names.length}>
          <ListFilterIcon />
        </IconButton>
        <DropdownMenu
          placement="bottom end"
          className="max-h-80 w-max min-w-44"
          selectionMode="multiple"
          selectedKeys={shown}
          onSelectionChange={(k) => setShown(k === 'all' ? names : [...k].map(String))}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Channels</DropdownMenuLabel>
            {names.map((n) => (
              <DropdownMenuItem key={n} id={n} textValue={n}>
                {n}
                <span className="ml-auto pl-3 text-xs text-muted-foreground">{series?.channels.get(n)?.unit}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenu>
      </DropdownMenuTrigger>
    </>
  );
}

/** Shared between the panel's header controls and its body (they render apart). */
const state = { well: null as string | null, shown: new Map<string, string[]>(), windowMs: '1800000' };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function useLiveState(app: App) {
  const focus = useSignal(app.liveWell);
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    // readings arrive several times a second, but only new wells or channels change the controls
    let key = '';
    const shape = () => {
      const k = app.field.wells
        .filter((w) => app.hub.series(w.id)?.n)
        .map((w) => `${w.id}:${[...app.hub.series(w.id)!.channels.keys()].join(',')}`)
        .join('|');
      if (k !== key) {
        key = k;
        l();
      }
    };
    shape();
    const off = app.hub.seriesRev.subscribe(shape);
    return () => {
      listeners.delete(l);
      off();
    };
  }, [app]);
  const wells = app.field.wells.filter((w) => app.hub.series(w.id)?.n);
  const active = app.engine.activeWell;
  const wellId = (focus && app.hub.series(focus)?.n ? focus : null) ?? state.well ?? (app.hub.series(active.id)?.n ? active.id : wells[0]?.id) ?? '';
  const series = app.hub.series(wellId);
  const names = series ? [...series.channels.keys()] : [];
  const shown = state.shown.get(wellId) ?? pickDefault(names);
  return {
    wells,
    wellId,
    series,
    shown,
    windowMs: state.windowMs,
    setWellId: (id: string) => {
      state.well = id;
      app.liveWell.set(null);
      notify();
    },
    setShown: (s: string[]) => {
      state.shown.set(wellId, s);
      notify();
    },
    setWindowMs: (w: string) => {
      state.windowMs = w;
      notify();
    },
  };
}

export function LiveBody({ app }: { app: App }) {
  const { series, shown, windowMs, wellId } = useLiveState(app);
  const cv = useRef<HTMLCanvasElement>(null);
  const ov = useRef<HTMLCanvasElement>(null);
  const channels = useMemo(() => shown.filter((n) => series?.channels.has(n)), [shown, series, series?.channels.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chart draws from per-channel min / max bins (see liveEnvelope.ts), so a
  // frame costs one span per pixel column however many readings there are.
  // While readings stream in, the time axis moves smoothly, trailing the
  // newest reading a little, instead of jumping with each batch. The chart is
  // drawn again once the strip has moved by a pixel, not on every frame: a
  // frame's tracks cost the same to rasterise however little they moved, and
  // at 2 h or All (a few pixels a second, and many readings a bin, so tall
  // spans) drawing every frame kept the page busy for nothing. The pointer's
  // line and values are on an overlay canvas, so hovering never redraws the
  // chart. Nothing is drawn while the chart is out of sight.
  useEffect(() => {
    const c = cv.current;
    const o = ov.current;
    if (!c || !o || !series) return;
    const win = windowMs === 'all' ? Infinity : Number(windowMs);
    const clock = new LiveClock();
    const envelopes = new Map<string, Envelope>();
    let size = { W: 0, H: 0 };
    let hoverX: number | null = null;
    let view: View | null = null;
    let visible = true;
    let raf = 0;
    let dirty = true;
    let hoverDirty = true;
    const frame = () => {
      raf = 0;
      if (!visible || document.hidden || !size.W || !size.H) return;
      const now = performance.now();
      const moving = clock.moving(now);
      const t1 = clock.edge(now);
      // how far the strip moved since it was drawn, in px (NaN before any reading)
      const moved = view ? (Math.abs(t1 - view.t1) / view.span) * (size.W - 8) : Infinity;
      if (dirty || moved >= 1 || (!moving && moved > 0)) {
        dirty = false;
        hoverDirty = true;
        view = paint(c, size.W, size.H, series, channels, win, t1, envelopes);
      }
      if (hoverDirty) {
        hoverDirty = false;
        paintHover(o, size.W, size.H, series, channels, view, hoverX);
      }
      // keep the strip moving while readings arrive; at rest, draw only on a change
      if (moving) raf = requestAnimationFrame(frame);
    };
    const kick = (redraw = true) => {
      if (redraw) dirty = true;
      hoverDirty = true;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    // new readings show as the strip moves on to them (see `frame`)
    const arrive = () => {
      clock.arrive(series.last, performance.now());
      kick(false);
    };
    clock.arrive(series.last, performance.now());
    const offData = app.hub.seriesRev.subscribe(arrive);
    // a new theme, accent or density: the colours and text sizes change
    const offLook = themeRev.subscribe(() => kick());
    // the size comes with the observation, once per frame after layout: draw now, so the chart never shows stretched
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      size = { W: Math.round(r.width), H: Math.round(r.height) };
      dirty = true;
      if (raf) cancelAnimationFrame(raf);
      frame();
    });
    if (c.parentElement) ro.observe(c.parentElement);
    // a background tab, a folded column or a hidden panel: no drawing until it shows again
    const io = new IntersectionObserver((es) => {
      visible = es[es.length - 1].isIntersecting;
      if (visible) kick();
    });
    io.observe(c);
    const onVisibility = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVisibility);
    const move = (e: PointerEvent) => {
      hoverX = e.offsetX;
      kick(false);
    };
    const leave = () => {
      hoverX = null;
      kick(false);
    };
    o.addEventListener('pointermove', move);
    o.addEventListener('pointerleave', leave);
    kick();
    return () => {
      offData();
      offLook();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      o.removeEventListener('pointermove', move);
      o.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(raf);
    };
  }, [app, series, wellId, channels, windowMs]);

  if (!series?.n)
    return (
      <Empty className="flex-1 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>No readings by time yet</EmptyTitle>
          <EmptyDescription>Rig and sensor readings from a live source show here as strip charts. Start one from the Live data panel.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    // the canvases keep their backing store's size (grown in steps); this box clips them
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={cv} role="img" aria-label={`Live readings: ${channels.join(', ')}`} className="absolute top-0 left-0 block" />
      <canvas ref={ov} aria-hidden className="absolute top-0 left-0 block cursor-crosshair" />
    </div>
  );
}

// ------------------------------------------------------------------ drawing

const GAP = 4;

/** What the last chart frame drew: the time mapping and where each track is, for the pointer overlay. */
interface View {
  t0: number;
  /** the time at the right edge */
  t1: number;
  span: number;
  axis: number;
  tracks: { top: number; th: number; color: string }[];
}

const xOf = (v: View, W: number, t: number) => ((t - v.t0) / v.span) * (W - 8) + 4;

function paint(c: HTMLCanvasElement, W: number, H: number, s: TimeSeries, names: string[], windowMs: number, t1: number, envelopes: Map<string, Envelope>): View | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fitStore(c, W, H, dpr);
  // the time axis and the label offsets grow with the density's text
  const AXIS = textLen(18);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!names.length || !Number.isFinite(t1)) return null;
  // a fixed window once there is enough data; until then the data fills the width
  const t0 = Number.isFinite(windowMs) ? Math.max(t1 - windowMs, s.first) : s.first;
  const span = Math.max(1, t1 - t0);
  const view: View = { t0, t1, span, axis: AXIS, tracks: [] };
  const x = (t: number) => xOf(view, W, t);
  // the bins stay the same while the window only slides: for "All" the width steps up as the data doubles
  const bin = binWidth(Number.isFinite(windowMs) ? windowMs : span, W - 8);
  const th = (H - AXIS - GAP * (names.length - 1)) / names.length;

  names.forEach((name, k) => {
    const ch = s.channels.get(name)!;
    const top = k * (th + GAP);
    const color = cssVar(`--tecton-palette-${COLORS[k % COLORS.length]}-560`, '#7fe3ff');
    view.tracks.push({ top, th, color });
    let env = envelopes.get(name);
    if (!env) envelopes.set(name, (env = new Envelope()));
    env.update(s, ch.v, bin);
    const [a, b] = env.range(t0, t1);
    // range of the visible readings, and the newest one shown
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i <= b; i++) {
      const m = env.mn[i];
      if (Number.isNaN(m)) continue;
      if (m < lo) lo = m;
      if (env.mx[i] > hi) hi = env.mx[i];
    }
    const last = lastBefore(s, ch.v, t1);
    g.fillStyle = wash(0.03);
    g.fillRect(0, top, W, th);
    if (!Number.isFinite(lo)) {
      g.fillStyle = ink.faint;
      g.font = font.sans(11);
      g.textBaseline = 'alphabetic';
      g.fillText(`${name} — no readings in this window`, 8, top + textLen(16));
      return;
    }
    if (hi - lo < 1e-9) {
      hi += 0.5;
      lo -= 0.5;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const y = (v: number) => top + th - 2 - ((v - lo) / (hi - lo)) * (th - 4);
    // one vertical span per bin (min to max of its readings), joined; clipped to the track's time
    g.save();
    g.beginPath();
    g.rect(4, top, W - 8, th);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = 1.25;
    g.beginPath();
    let started = false;
    for (let i = a; i <= b; i++) {
      const mn = env.mn[i];
      if (Number.isNaN(mn)) continue;
      const px = x((env.base + i + 0.5) * env.bin);
      if (!started) {
        g.moveTo(px, y(mn));
        started = true;
      } else g.lineTo(px, y(mn));
      if (env.mx[i] !== mn) g.lineTo(px, y(env.mx[i]));
    }
    g.stroke();
    g.restore();
    // labels: name, unit and range on the left, the latest value on the right, each on a backdrop so the trace never hides them
    const info = `${ch.unit || ''}  ${fmt(lo + pad)}–${fmt(hi - pad)}`;
    const value = Number.isNaN(last) ? '—' : fmt(last);
    const big = th > 44;
    g.font = font.sans(11, 600);
    const nameW = g.measureText(name).width;
    g.font = font.sans(10);
    const infoW = g.measureText(info).width;
    g.font = font.mono(big ? 16 : 12, 600);
    const valueW = g.measureText(value).width;
    g.globalAlpha = 0.8;
    g.fillStyle = ink.card;
    g.beginPath();
    g.roundRect(4, top + textLen(3), nameW + infoW + 14, textLen(15), 3);
    g.roundRect(W - 12 - valueW, top + textLen(2), valueW + 8, textLen(big ? 21 : 16), 3);
    g.fill();
    g.globalAlpha = 1;
    g.textBaseline = 'top';
    g.font = font.sans(11, 600);
    g.fillStyle = color;
    g.fillText(name, 8, top + textLen(5));
    g.font = font.sans(10);
    g.fillStyle = ink.muted;
    g.fillText(info, 14 + nameW, top + textLen(6));
    g.font = font.mono(big ? 16 : 12, 600);
    g.fillStyle = ink.text;
    g.textAlign = 'right';
    g.fillText(value, W - 8, top + textLen(4));
    g.textAlign = 'left';
  });

  // time axis
  const axisTop = H - AXIS;
  g.fillStyle = ink.muted;
  g.font = font.sans(10);
  g.textBaseline = 'middle';
  const steps = [1e3, 5e3, 15e3, 3e4, 6e4, 3e5, 6e5, 18e5, 36e5, 108e5, 216e5, 432e5, 864e5];
  const step = steps.find((st) => (st / span) * W > 70) ?? steps[steps.length - 1];
  g.strokeStyle = wash(0.08);
  g.lineWidth = 1;
  g.beginPath();
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = Math.round(x(t)) + 0.5;
    g.moveTo(px, 0);
    g.lineTo(px, axisTop);
  }
  g.stroke();
  g.textAlign = 'center';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = Math.round(x(t)) + 0.5;
    const d = new Date(t);
    const label = step < 6e4 ? d.toISOString().slice(11, 19) : d.toISOString().slice(11, 16);
    g.fillText(label, Math.min(W - 24, Math.max(24, px)), axisTop + AXIS / 2);
  }
  g.textAlign = 'left';
  return view;
}

/** The newest reading of a channel at or before `t` (NaN when none is near). */
function lastBefore(s: TimeSeries, v: Float32Array, t: number): number {
  const end = Math.min(s.n, s.indexAt(t + 1e-6));
  for (let i = end - 1, k = 0; i >= 0 && k < 64; i--, k++) if (!Number.isNaN(v[i])) return v[i];
  return NaN;
}

/** The pointer's time over the chart: a line, its time, and each track's reading there. */
function paintHover(o: HTMLCanvasElement, W: number, H: number, s: TimeSeries, names: string[], view: View | null, hoverX: number | null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fitStore(o, W, H, dpr);
  const g = o.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, o.width, o.height);
  if (hoverX === null || !view || !s.n) return;
  const t = view.t0 + ((hoverX - 4) / (W - 8)) * view.span;
  const i = Math.min(s.n - 1, s.indexAt(t));
  const px = Math.round(xOf(view, W, s.t[i])) + 0.5;
  const axisTop = H - view.axis;
  g.strokeStyle = ink.muted;
  g.lineWidth = 1;
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, axisTop);
  g.stroke();
  g.setLineDash([]);
  g.textBaseline = 'middle';
  // each track's reading at the pointer, beside the line
  g.font = font.mono(11, 600);
  const right = px < W - 90;
  names.forEach((name, k) => {
    const tr = view.tracks[k];
    const v = tr && s.channels.get(name)?.v[i];
    if (!tr || v === undefined || Number.isNaN(v)) return;
    const label = fmt(v);
    const w = g.measureText(label).width + 8;
    const h = textLen(16);
    const lx = right ? px + 4 : px - 4 - w;
    const ly = tr.top + tr.th / 2 - h / 2;
    g.fillStyle = ink.card;
    g.fillRect(lx, ly, w, h);
    g.fillStyle = tr.color;
    g.fillText(label, lx + 4, ly + h / 2);
  });
  // the pointer's time on the axis
  const label = new Date(s.t[i]).toISOString().slice(11, 19);
  g.font = font.mono(10, 600);
  const w = g.measureText(label).width + 8;
  const lx = Math.min(W - w, Math.max(0, px - w / 2));
  g.fillStyle = ink.card;
  g.fillRect(lx, axisTop + 2, w, view.axis - 4);
  g.fillStyle = ink.text;
  g.fillText(label, lx + 4, axisTop + view.axis / 2);
}

function fmt(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}
