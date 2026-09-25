import { Button } from '@tecton/react/components/button';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { GaugeIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { payIntervals } from '../../data/petro';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { App } from '../app';
import { fmt } from '../dom';
import { IconButton } from '../icon-button';
import { useRev, useSignal } from '../signal';
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
 * Play along the well and scrub the whole hole. The strip spans the full
 * width of the window: formations, inclination, pay, casing shoes and the
 * tour chapters, with a draggable playhead.
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
      <DropdownMenu placement="top start" className="min-w-36">
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

function Strip({ app }: { app: App }) {
  const rev = useRev(app.wellRev);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const w = app.engine.activeWell;
  const td = w.tdMD;
  const x = (md: number) => (Math.max(0, Math.min(td, md)) / td) * W;
  const mdAt = (px: number) => Math.max(0, Math.min(1, px / W)) * td;

  const scrub = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    app.scrubTo(mdAt(ev.clientX - r.left));
  };
  const key = (e: KeyboardEvent) => {
    const md = app.pose.value.md;
    const step = e.shiftKey ? 100 : 10;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? md + step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? md - step : e.key === 'Home' ? 0 : e.key === 'End' ? td : null;
    if (to === null) return;
    e.preventDefault();
    app.scrubTo(Math.max(0, Math.min(td, to)));
  };

  const base = useMemo(() => (W > 0 ? <Base app={app} W={W} /> : null), [app, W, rev]);

  return (
    <div ref={box} className="relative min-w-0 flex-1" style={{ height: H }}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          className="absolute inset-0 cursor-ew-resize touch-none overflow-visible outline-none select-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrub(e);
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (e.buttons) scrub(e);
            setHover((h) => ({ x: e.clientX - r.left, md: mdAt(e.clientX - r.left), chapter: h?.chapter }));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {base}
          <Chapters app={app} x={x} W={W} onHover={(i) => setHover((h) => (h ? { ...h, chapter: i ?? undefined } : null))} />
          {hover && hover.chapter === undefined && <line x1={hover.x} x2={hover.x} y1={S_TOP - 2} y2={S_BOT + 2} className="stroke-foreground/50" strokeDasharray="2 2" />}
          <Playhead app={app} x={x} W={W} td={td} onKey={key} />
        </svg>
      )}
      {hover && <HoverCard app={app} hover={hover} W={W} />}
    </div>
  );
}

/** The static part of the strip: formations, inclination, pay, shoes and the depth scale. */
function Base({ app, W }: { app: App; W: number }) {
  const w = app.engine.activeWell;
  const td = w.tdMD;
  const x = (md: number) => (md / td) * W;
  const inc: string[] = [];
  for (let px = 0; px <= W; px += 2) {
    const t = w.trajectory.at(Math.min((px / W) * td, w.trajectory.mdEnd));
    inc.push(`${px === 0 ? 'M' : 'L'}${px},${(S_BOT - 2 - (t.inc / 95) * (S_H - 5)).toFixed(1)}`);
  }
  const pay = w.logs && w.petro ? payIntervals(w.logs.depth, w.petro.pay, 0.5) : [];
  return (
    <g>
      <defs>
        <clipPath id="tl-strip">
          <rect x={0} y={S_TOP} width={W} height={S_H} rx={3} />
        </clipPath>
      </defs>
      <g clipPath="url(#tl-strip)">
        <rect x={0} y={S_TOP} width={W} height={S_H} className="fill-muted" />
        {w.zones.map((z) => (
          <rect
            key={`${z.formationId}:${z.topMD}`}
            x={x(z.topMD)}
            y={S_TOP}
            width={Math.max(1, x(z.baseMD) - x(z.topMD))}
            height={S_H}
            fill={z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a2029' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555')}
          />
        ))}
        {pay.map((p) => (
          <rect key={p.top} x={x(p.top)} y={S_BOT - 3} width={Math.max(1.5, x(p.base) - x(p.top))} height={3} className="fill-saffron-560" />
        ))}
        <path d={inc.join('')} fill="none" className="stroke-foreground/70" strokeWidth={1.25} strokeLinejoin="round" />
      </g>
      {w.casing.map((c) => (
        <g key={c.shoeMD} className="fill-foreground/80">
          <rect x={x(c.shoeMD) - 0.5} y={S_TOP} width={1} height={S_H} className="fill-foreground/35" />
          <path d={`M${x(c.shoeMD) - 3},${S_BOT} L${x(c.shoeMD) + 3},${S_BOT} L${x(c.shoeMD)},${S_BOT - 4} Z`} />
        </g>
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
function HoverCard({ app, hover, W }: { app: App; hover: Hover; W: number }) {
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
