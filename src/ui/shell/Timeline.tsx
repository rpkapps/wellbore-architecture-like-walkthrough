import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { GaugeIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { payIntervals } from '../../data/petro';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { App } from '../app';
import { fmt } from '../dom';
import { IconButton } from '../icon-button';
import { useRev, useSignal } from '../signal';
import { PoseReadout } from './Hud';
import { SURFACE } from './overlay';

const SPEEDS = [15, 45, 120, 300];

// vertical layout of the strip (px)
const H = 56;
const CH_Y = 7; // chapter markers
const S_TOP = 17; // formation strip
const S_H = 20;
const S_BOT = S_TOP + S_H;
const LABEL_Y = 51; // depth scale baseline

/**
 * Play along the well and scrub the whole hole. Play, the speed and where
 * the camera is along the well (which opens the position details), then the
 * strip across the rest of the window: formations, inclination, pay, casing
 * shoes and the tour chapters, with a draggable playhead.
 */
export function Timeline({ app }: { app: App }) {
  const playing = useSignal(app.playing);
  return (
    <div className={`flex h-full items-center gap-1.5 border py-1 pr-3 pl-2 ${SURFACE}`}>
      <IconButton
        label={playing ? 'Pause (Space)' : 'Play along the well (Space)'}
        size="icon-sm"
        placement="top"
        onPress={() => app.togglePlay()}
        className="size-8! rounded-full! bg-ui-accent! text-background! shadow-[0_0_14px_-2px_var(--ui-accent)] hover:brightness-110 [&_svg]:size-4! [&_svg]:fill-current"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
      <SpeedMenu app={app} />
      <PoseReadout app={app} />
      <Strip app={app} />
    </div>
  );
}

function SpeedMenu({ app }: { app: App }) {
  useRev(app.viewRev);
  const speed = app.engine.rig.speed;
  return (
    <DropdownMenuTrigger>
      <Button variant="ghost" size="xs" aria-label={`Travel speed, ${speed} m/s`}>
        <GaugeIcon data-icon="inline-start" />
        <span className="font-mono tabular-nums">{speed}</span>
      </Button>
      <DropdownMenu placement="top start" className="w-max min-w-36">
        <DropdownMenuGroup
          selectionMode="single"
          selectedKeys={[String(speed)]}
          onSelectionChange={(k) => {
            if (k !== 'all' && k.size) app.setSpeed(+String([...k][0]));
          }}
        >
          <DropdownMenuLabel>Travel speed</DropdownMenuLabel>
          {SPEEDS.map((s) => (
            <DropdownMenuItem key={s} id={String(s)}>{`${s} m/s`}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}

interface Hover {
  x: number;
  md: number;
  chapter?: number;
}

/**
 * What is under the pointer. It changes on every pointer move, so it is kept
 * out of the strip's state: only the hover line and card render when it moves.
 */
class HoverStore {
  private v: Hover | null = null;
  private ls = new Set<() => void>();
  get = () => this.v;
  set(fn: (h: Hover | null) => Hover | null) {
    const v = fn(this.v);
    if (v === this.v) return;
    this.v = v;
    for (const l of this.ls) l();
  }
  subscribe = (l: () => void) => {
    this.ls.add(l);
    return () => void this.ls.delete(l);
  };
}

function Strip({ app }: { app: App }) {
  const rev = useRev(app.wellRev);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const hover = useMemo(() => new HoverStore(), []);
  const left = useRef(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // later sizes come with the observation (no layout read); it changes only when the window does
    const ro = new ResizeObserver((es) => setW(Math.round(es[es.length - 1].contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const w = app.engine.activeWell;
  const td = w.tdMD;
  // stable between renders, so the playhead does not re-subscribe
  const x = useCallback((md: number) => (Math.max(0, Math.min(td, md)) / td) * W, [td, W]);
  const mdAt = (px: number) => Math.max(0, Math.min(1, px / W)) * td;

  const scrub = (ev: ReactPointerEvent<SVGSVGElement>, px: number) => {
    if (ev.buttons) app.scrubTo(mdAt(px));
  };
  const key = useCallback(
    (e: KeyboardEvent) => {
      const md = app.pose.value.md;
      const step = e.shiftKey ? 100 : 10;
      const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? md + step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? md - step : e.key === 'Home' ? 0 : e.key === 'End' ? td : null;
      if (to === null) return;
      e.preventDefault();
      app.scrubTo(Math.max(0, Math.min(td, to)));
    },
    [app, td],
  );
  const onChapter = useCallback((i: number | null) => hover.set((h) => (h ? { ...h, chapter: i ?? undefined } : null)), [hover]);

  // the strip drawn in MD across 0..1 of the width, so it does not depend on the width
  const base = useMemo(() => <Base app={app} />, [app, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} className="relative min-w-0 flex-1" style={{ height: H }}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          className="absolute inset-0 cursor-ew-resize touch-none overflow-visible outline-none select-none"
          // where the strip starts, read when the pointer arrives rather than on every move (a read after a write forces layout)
          onPointerEnter={(e) => (left.current = e.currentTarget.getBoundingClientRect().left)}
          onPointerDown={(e) => {
            left.current = e.currentTarget.getBoundingClientRect().left;
            e.currentTarget.setPointerCapture(e.pointerId);
            app.scrubTo(mdAt(e.clientX - left.current));
          }}
          onPointerMove={(e) => {
            const px = e.clientX - left.current;
            scrub(e, px);
            hover.set((h) => ({ x: px, md: mdAt(px), chapter: h?.chapter }));
          }}
          onPointerLeave={() => hover.set(() => null)}
        >
          {base}
          <Chapters app={app} x={x} W={W} onHover={onChapter} />
          <HoverLine hover={hover} />
          <Playhead app={app} x={x} W={W} td={td} onKey={key} />
        </svg>
      )}
      <HoverCard app={app} hover={hover} W={W} />
    </div>
  );
}

function HoverLine({ hover }: { hover: HoverStore }) {
  const h = useSyncExternalStore(hover.subscribe, hover.get);
  if (!h || h.chapter !== undefined) return null;
  return <line x1={h.x} x2={h.x} y1={S_TOP - 2} y2={S_BOT + 2} className="pointer-events-none stroke-foreground/50" strokeDasharray="2 2" />;
}

/**
 * The static part of the strip: formations, inclination, pay, shoes and the
 * depth scale. Drawn in MD (a viewBox stretched to the width) and placed by
 * percentages, so resizing the window does not render it again.
 */
function Base({ app }: { app: App }) {
  const w = app.engine.activeWell;
  const td = w.tdMD;
  const pct = (md: number) => `${((md / td) * 100).toFixed(3)}%`;
  const inc: string[] = [];
  for (let i = 0; i <= 800; i++) {
    const md = (i / 800) * td;
    const t = w.trajectory.at(Math.min(md, w.trajectory.mdEnd));
    inc.push(`${i === 0 ? 'M' : 'L'}${md.toFixed(1)},${(S_BOT - 2 - (t.inc / 95) * (S_H - 5)).toFixed(1)}`);
  }
  const pay = w.logs && w.petro ? payIntervals(w.logs.depth, w.petro.pay, 0.5) : [];
  return (
    <g>
      <defs>
        <clipPath id="tl-strip">
          <rect x={0} y={S_TOP} width="100%" height={S_H} rx={3} />
        </clipPath>
      </defs>
      <g clipPath="url(#tl-strip)">
        <rect x={0} y={S_TOP} width="100%" height={S_H} className="fill-muted" />
        <svg width="100%" height={H} viewBox={`0 0 ${td} ${H}`} preserveAspectRatio="none" overflow="visible">
          {w.zones.map((z) => (
            <rect
              key={`${z.formationId}:${z.topMD}`}
              x={z.topMD}
              y={S_TOP}
              width={Math.max(td / 1500, z.baseMD - z.topMD)}
              height={S_H}
              fill={z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a2029' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555')}
            />
          ))}
          {pay.map((p) => (
            <rect key={p.top} x={p.top} y={S_BOT - 3} width={Math.max(td / 1000, p.base - p.top)} height={3} className="fill-saffron-560" />
          ))}
          <path d={inc.join('')} fill="none" className="stroke-foreground/70" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </g>
      {w.casing.map((c) => (
        <svg key={c.shoeMD} x={pct(c.shoeMD)} overflow="visible" className="fill-foreground/80">
          <rect x={-0.5} y={S_TOP} width={1} height={S_H} className="fill-foreground/35" />
          <path d={`M-3,${S_BOT} L3,${S_BOT} L0,${S_BOT - 4} Z`} />
        </svg>
      ))}
    </g>
  );
}

/** Tour chapters as numbered stops above the strip; crowded ones shrink to dots. */
function Chapters({ app, x, W, onHover }: { app: App; x: (md: number) => number; W: number; onHover: (i: number | null) => void }) {
  const chapter = useSignal(app.chapter);
  const cs = app.chapters;
  const minGap = cs.reduce((g, c, i) => (i ? Math.min(g, x(c.md) - x(cs[i - 1].md)) : g), Infinity);
  const big = minGap >= 15;
  return (
    <g>
      {cs.map((c, i) => {
        const cx = Math.max(7, Math.min(W - 7, x(c.md)));
        const on = chapter?.index === i;
        return (
          <g
            key={i}
            role="button"
            tabIndex={0}
            aria-label={`Chapter ${i + 1}: ${c.title}`}
            // the chapter card finds its marker by this, to sit above it
            data-chapter={i}
            className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-ring"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerEnter={() => onHover(i)}
            onPointerLeave={() => onHover(null)}
            onClick={() => app.goChapter(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                app.goChapter(i);
              }
            }}
          >
            <line x1={x(c.md)} x2={x(c.md)} y1={CH_Y + 4} y2={S_TOP} className="stroke-border" />
            <circle cx={cx} cy={CH_Y} r={big ? 6.5 : 3.5} strokeWidth={1.5} className={on ? 'fill-ui-accent stroke-ui-accent' : 'fill-background stroke-fg-3 hover:stroke-fg-1'} />
            {big && (
              <text x={cx} y={CH_Y + 3} textAnchor="middle" fontSize={8.5} fontWeight={600} className={`pointer-events-none ${on ? 'fill-background' : 'fill-fg-2'}`}>
                {i + 1}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Where the camera is: a glowing line with a round knob (the original
 * BoreWalk playhead) in the accent colour, a depth tag under it, and what is
 * still ahead dimmed. It follows the camera every frame, so it is moved by
 * setting SVG attributes instead of re-rendering; only the scale re-renders,
 * when the labels it hides change.
 */
function Playhead({ app, x, W, td, onKey }: { app: App; x: (md: number) => number; W: number; td: number; onKey: (e: KeyboardEvent) => void }) {
  const head = useRef<SVGGElement>(null);
  const dim = useRef<SVGRectElement>(null);
  const tagBox = useRef<SVGRectElement>(null);
  const tagText = useRef<SVGTextElement>(null);
  const slider = useRef<SVGGElement>(null);
  const [gap, setGap] = useState<[number, number]>([-1, -1]);
  const gapKey = useRef('');
  useLayoutEffect(() => {
    const place = () => {
      const md = app.pose.value.md;
      const px = x(md);
      const tag = `${fmt.n(md, 0)} m`;
      const tw = tag.length * 6 + 10;
      const tx = Math.max(0, Math.min(W - tw, px - tw / 2));
      head.current?.setAttribute('transform', `translate(${px.toFixed(1)},0)`);
      dim.current?.setAttribute('x', px.toFixed(1));
      dim.current?.setAttribute('width', Math.max(0, W - px).toFixed(1));
      tagBox.current?.setAttribute('x', tx.toFixed(1));
      tagBox.current?.setAttribute('width', String(tw));
      if (tagText.current) {
        tagText.current.setAttribute('x', (tx + tw / 2).toFixed(1));
        tagText.current.textContent = tag;
      }
      slider.current?.setAttribute('aria-valuenow', String(Math.round(md)));
      slider.current?.setAttribute('aria-valuetext', `${tag} MD`);
      // re-render the scale only when the span it must keep clear moves by a label
      const g: [number, number] = [tx - 6, tx + tw + 6];
      const key = `${Math.round(g[0] / 24)}:${Math.round(g[1] / 24)}`;
      if (key !== gapKey.current) {
        gapKey.current = key;
        setGap(g);
      }
    };
    place();
    return app.pose.subscribe(place);
  }, [app, x, W]);
  return (
    <g
      ref={slider}
      role="slider"
      tabIndex={0}
      aria-label="Position along the well"
      aria-valuemin={0}
      aria-valuemax={Math.round(td)}
      onKeyDown={onKey}
      className="outline-none [&:focus-visible_.knob]:stroke-ring"
    >
      <rect ref={dim} y={S_TOP} height={S_H} className="pointer-events-none fill-background/45" />
      <Scale td={td} W={W} x={x} gap={gap} />
      <g ref={head} className="pointer-events-none">
        <rect x={-1} y={S_TOP - 3} width={2} height={S_H + 6} rx={1} className="fill-ui-accent" style={{ filter: 'drop-shadow(0 0 4px var(--ui-accent))' }} />
        <circle cy={S_TOP - 4} r={8} className="fill-ui-accent/20" />
        <circle cy={S_TOP - 4} r={5} strokeWidth={2} className="knob fill-ui-accent stroke-transparent" />
      </g>
      <rect ref={tagBox} y={LABEL_Y - 9.5} height={13} rx={6.5} className="fill-ui-accent" />
      <text ref={tagText} y={LABEL_Y} textAnchor="middle" fontSize={9.5} fontWeight={600} className="fill-background font-mono" />
    </g>
  );
}

/** The depth scale under the strip; labels that would touch the playhead's tag are left out. */
function Scale({ td, W, x, gap }: { td: number; W: number; x: (md: number) => number; gap: [number, number] }) {
  const step = niceStep(td / Math.max(2, W / 80));
  const tdLabel = `TD ${fmt.n(td, 0)} m`;
  const cw = 5.9; // IBM Plex Mono advance at 9.5 px
  const labels: { md: number; text: string; x0: number; x1: number; anchor: 'start' | 'middle' | 'end' }[] = [{ md: 0, text: '0 m', x0: 0, x1: 3 * cw, anchor: 'start' }];
  for (let md = step; md < td; md += step) {
    const text = fmt.n(md, 0);
    labels.push({ md, text, x0: x(md) - (text.length * cw) / 2, x1: x(md) + (text.length * cw) / 2, anchor: 'middle' });
  }
  const end = { md: td, text: tdLabel, x0: W - tdLabel.length * cw, x1: W, anchor: 'end' as const };
  const shown = labels.filter((l) => l.x1 < end.x0 - 10 && (l.x1 < gap[0] || l.x0 > gap[1]));
  if (end.x1 < gap[0] || end.x0 > gap[1]) shown.push(end);
  return (
    <g className="pointer-events-none fill-muted-foreground font-mono" fontSize={9.5}>
      {shown.map((l) => (
        <g key={l.md}>
          {l.anchor === 'middle' && <rect x={x(l.md) - 0.5} y={S_BOT + 2} width={1} height={3} className="fill-border" />}
          <text x={l.anchor === 'start' ? 0 : l.anchor === 'end' ? W : x(l.md)} y={LABEL_Y} textAnchor={l.anchor} className={l.anchor === 'end' ? 'fill-foreground' : undefined}>
            {l.text}
          </text>
        </g>
      ))}
    </g>
  );
}

/** What is under the pointer: a chapter's title, or the depth and formation. */
function HoverCard({ app, hover: store, W }: { app: App; hover: HoverStore; W: number }) {
  const hover = useSyncExternalStore(store.subscribe, store.get);
  if (!hover) return null;
  const w = app.engine.activeWell;
  let title: string;
  let sub: string;
  if (hover.chapter !== undefined) {
    const c = app.chapters[hover.chapter];
    title = `${hover.chapter + 1}. ${c.title}`;
    sub = `${fmt.n(c.md, 0)} m MD · click to go`;
  } else {
    const z = w.zones.find((z) => hover.md >= z.topMD && hover.md < z.baseMD);
    const t = w.trajectory.at(Math.min(hover.md, w.trajectory.mdEnd));
    title = z?.name ?? '—';
    sub = `${fmt.n(hover.md, 0)} m MD · ${fmt.n(t.tvd - app.field.meta.datumElevation, 0)} m TVDSS · ${fmt.n(t.inc, 0)}°`;
  }
  const left = Math.max(0, Math.min(W - 224, hover.x - 112));
  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-full z-20 mb-2 flex w-56 flex-col rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left }}
    >
      <span className="truncate font-medium">{title}</span>
      <span className="truncate font-mono text-[10.5px] text-muted-foreground">{sub}</span>
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
