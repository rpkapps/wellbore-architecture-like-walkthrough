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
  const hover = useRef<number | null>(null);
  const size = useRef({ W: 0, H: 0 });
  const draw = useRef<() => void>(() => {});
  const channels = useMemo(() => shown.filter((n) => series?.channels.has(n)), [shown, series, series?.channels.size]); // eslint-disable-line react-hooks/exhaustive-deps

  draw.current = () => {
    const c = cv.current;
    if (!c || !series) return;
    paint(c, size.current.W, size.current.H, series, channels, windowMs === 'all' ? Infinity : Number(windowMs), hover.current);
  };

  // redraw when readings arrive, the size changes or the pointer moves; at most once a frame
  useEffect(() => {
    let raf = 0;
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw.current()));
    };
    const off = app.hub.seriesRev.subscribe(kick);
    // a new theme, accent or density: the colours and text sizes change
    const offLook = themeRev.subscribe(kick);
    const c = cv.current;
    // the size comes with the observation, once per frame after layout: draw now, so the chart never shows stretched
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      size.current = { W: Math.round(r.width), H: Math.round(r.height) };
      draw.current();
    });
    if (c?.parentElement) ro.observe(c.parentElement);
    const move = (e: PointerEvent) => {
      hover.current = e.offsetX;
      kick();
    };
    const leave = () => {
      hover.current = null;
      kick();
    };
    c?.addEventListener('pointermove', move);
    c?.addEventListener('pointerleave', leave);
    kick();
    return () => {
      off();
      offLook();
      ro.disconnect();
      c?.removeEventListener('pointermove', move);
      c?.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(raf);
    };
  }, [app, wellId, channels, windowMs]);

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
    // the canvas keeps its backing store's size (grown in steps); this box clips it
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={cv} role="img" aria-label={`Live readings: ${channels.join(', ')}`} className="absolute top-0 left-0 block cursor-crosshair" />
    </div>
  );
}

// ------------------------------------------------------------------ drawing

const GAP = 4;

function paint(c: HTMLCanvasElement, W: number, H: number, s: TimeSeries, names: string[], windowMs: number, hoverX: number | null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!W || !H) return;
  fitStore(c, W, H, dpr);
  // the time axis and the label offsets grow with the density's text
  const AXIS = textLen(18);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!names.length) return;
  const t1 = s.last;
  // a fixed window once there is enough data; until then the data fills the width
  const t0 = Number.isFinite(windowMs) ? Math.max(t1 - windowMs, s.first) : s.first;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * (W - 8) + 4;
  const i0 = s.indexAt(t0);
  const th = (H - AXIS - GAP * (names.length - 1)) / names.length;
  const hoverT = hoverX === null ? null : t0 + ((hoverX - 4) / (W - 8)) * span;
  const hoverI = hoverT === null ? -1 : Math.min(s.n - 1, s.indexAt(hoverT));

  names.forEach((name, k) => {
    const ch = s.channels.get(name)!;
    const top = k * (th + GAP);
    const color = cssVar(`--tecton-palette-${COLORS[k % COLORS.length]}-560`, '#7fe3ff');
    // range of the visible readings
    let lo = Infinity;
    let hi = -Infinity;
    let last = NaN;
    for (let i = i0; i < s.n; i++) {
      const v = ch.v[i];
      if (Number.isNaN(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      last = v;
    }
    g.fillStyle = wash(0.03);
    g.fillRect(0, top, W, th);
    if (!Number.isFinite(lo)) {
      g.fillStyle = ink.faint;
      g.font = font.sans(11);
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
    // one vertical span per pixel column (min to max of the readings in it), joined
    g.strokeStyle = color;
    g.lineWidth = 1.25;
    g.beginPath();
    let col = -1;
    let cmin = 0;
    let cmax = 0;
    let started = false;
    const flush = () => {
      if (col < 0) return;
      if (!started) {
        g.moveTo(col, y(cmin));
        started = true;
      } else g.lineTo(col, y(cmin));
      if (cmax !== cmin) g.lineTo(col, y(cmax));
    };
    for (let i = i0; i < s.n; i++) {
      const v = ch.v[i];
      if (Number.isNaN(v)) continue;
      const px = Math.round(x(s.t[i]));
      if (px !== col) {
        flush();
        col = px;
        cmin = cmax = v;
      } else {
        if (v < cmin) cmin = v;
        if (v > cmax) cmax = v;
      }
    }
    flush();
    g.stroke();
    // labels: name and unit on the left, the latest value on the right
    g.font = font.sans(11, 600);
    g.fillStyle = color;
    g.textBaseline = 'top';
    g.fillText(name, 8, top + textLen(5));
    const nameW = g.measureText(name).width;
    g.font = font.sans(10);
    g.fillStyle = ink.muted;
    g.fillText(`${ch.unit || ''}  ${fmt(lo + pad)}–${fmt(hi - pad)}`, 14 + nameW, top + textLen(6));
    const shownV = hoverI >= 0 ? ch.v[hoverI] : last;
    g.font = font.mono(th > 44 ? 16 : 12, 600);
    g.fillStyle = ink.text;
    g.textAlign = 'right';
    g.fillText(Number.isNaN(shownV) ? '—' : fmt(shownV), W - 8, top + textLen(4));
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
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = Math.round(x(t)) + 0.5;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, axisTop);
    g.stroke();
    const d = new Date(t);
    const label = step < 6e4 ? d.toISOString().slice(11, 19) : d.toISOString().slice(11, 16);
    g.textAlign = 'center';
    g.fillText(label, Math.min(W - 24, Math.max(24, px)), axisTop + AXIS / 2);
  }
  g.textAlign = 'left';
  // the pointer's time
  if (hoverX !== null && hoverI >= 0) {
    const px = Math.round(x(s.t[hoverI])) + 0.5;
    g.strokeStyle = ink.muted;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, axisTop);
    g.stroke();
    g.setLineDash([]);
    const label = new Date(s.t[hoverI]).toISOString().slice(11, 19);
    g.font = font.mono(10, 600);
    const w = g.measureText(label).width + 8;
    const lx = Math.min(W - w, Math.max(0, px - w / 2));
    g.fillStyle = ink.card;
    g.fillRect(lx, axisTop + 2, w, AXIS - 4);
    g.fillStyle = ink.text;
    g.fillText(label, lx + 4, axisTop + AXIS / 2);
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}
