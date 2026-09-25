import { Popover, PopoverTrigger } from '@tecton/react/components/popover';
import { Separator } from '@tecton/react/components/separator';
import { Panel } from '@tecton/react/tecton/panel';
import { useLayoutEffect, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { App } from '../app';
import { fmt } from '../dom';
import { Tip } from '../icon-button';
import { useSignal } from '../signal';
import { SURFACE } from './overlay';

/**
 * Where along the well, at the left end of the timeline: MD, TVDSS, the
 * inclination, the formation and what features add in a few words
 * (geosteering: IN ZONE). Pressing it opens the full details above it.
 * Fixed width, so the strip beside it does not move as the numbers change.
 */
export function PoseReadout({ app }: { app: App }) {
  return (
    <PopoverTrigger>
      <Tip label="Position details" placement="top">
        <AriaButton className="flex h-11 w-48 shrink-0 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2 text-left outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:bg-ghost-hover data-pressed:bg-ghost-active">
          <ReadoutText app={app} />
        </AriaButton>
      </Tip>
      <Popover placement="top start" offset={10} className="w-80">
        <HudDetails app={app} />
      </Popover>
    </PopoverTrigger>
  );
}

/** The read-out's two lines; only they render as the camera moves (at most ~15 times a second). */
function ReadoutText({ app }: { app: App }) {
  const p = useSignal(app.poseText);
  const chips = useSignal(app.huds).filter((h) => h.chip);
  return (
    <>
      <span className="type-value flex items-baseline gap-1 text-xs! whitespace-nowrap">
        <span className="type-unit">MD</span>
        {fmt.n(p.md, 1)}
        <span className="type-unit ml-1.5">TVDSS</span>
        {fmt.n(p.tvdss, 1)}
      </span>
      <span className="type-caption flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span className="type-value text-xs!">{fmt.n(p.inc, 0)}°</span>
        <span className="min-w-0 truncate text-fg-2">{p.zone}</span>
        {chips.map((h) => (
          <span key={h.id} className="flex shrink-0 items-center">
            {h.chip!()}
          </span>
        ))}
      </span>
    </>
  );
}

/** Where the camera is and where along the well: compass, attitude, depths and the read-outs features add. */
export function HudDetails({ app }: { app: App }) {
  const huds = useSignal(app.huds).filter((h) => !h.prompt);
  return (
    <div aria-label="Position" className="flex flex-col gap-2">
      <Camera app={app} />
      <Separator emphasis="subtle" />
      <Depth app={app} />
      {huds.map((h) => (
        <div key={h.id} className="contents">
          {h.render()}
        </div>
      ))}
    </div>
  );
}

/**
 * What the next click in the 3D view does (measuring), over the view just
 * above its toolbar: an instruction has to be in sight, not in the details.
 */
export function HudPrompts({ app }: { app: App }) {
  const prompts = useSignal(app.huds).filter((h) => h.prompt);
  if (!prompts.length) return null;
  return (
    <Panel variant="elevated" size="sm" aria-label="Prompt" className={`pointer-events-auto relative w-fit max-w-full ${SURFACE}`}>
      <div className="flex flex-col gap-1 py-1 pr-1 pl-2.5">
        {prompts.map((h) => (
          <div key={h.id} className="contents">
            {h.render()}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * Compass that turns with the camera: red north, and the well's azimuth as
 * the primary-coloured arrow. It turns every frame the camera does, so the
 * rotation is written straight to the SVG, not rendered.
 */
function Compass({ app, className }: { app: App; className: string }) {
  const azi = useSignal(app.poseText).azi;
  const rose = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    let said = NaN;
    const turn = (h: number) => {
      rose.current?.setAttribute('transform', `rotate(${-h} 21 21)`);
      // the label names whole degrees: rewritten only when those change
      const d = Math.round(h);
      if (d !== said) svg.current?.setAttribute('aria-label', label((said = d), azi));
    };
    turn(app.heading.value);
    return app.heading.subscribe(turn);
  }, [app, azi]);
  const a = (azi * Math.PI) / 180;
  const tip = [21 + 15 * Math.sin(a), 21 - 15 * Math.cos(a)];
  return (
    <svg ref={svg} viewBox="0 0 42 42" className={`${className} shrink-0`} role="img" aria-label={label(app.heading.value, azi)}>
      <circle cx="21" cy="21" r="19.5" className="fill-muted stroke-border" />
      <g ref={rose} transform={`rotate(${-app.heading.value} 21 21)`}>
        {[0, 90, 180, 270].map((d) => (
          <rect key={d} x="20.5" y="2.5" width="1" height="3" className="fill-muted-foreground/60" transform={`rotate(${d} 21 21)`} />
        ))}
        <path d="M21 6 L24 21 L21 19.5 L18 21 Z" className="fill-red-460" />
        <path d="M21 36 L24 21 L21 22.5 L18 21 Z" className="fill-muted-foreground/40" />
        <line x1="21" y1="21" x2={tip[0]} y2={tip[1]} strokeWidth="2" strokeLinecap="round" className="stroke-ui-accent" />
        <circle cx={tip[0]} cy={tip[1]} r="2.6" className="fill-ui-accent" />
      </g>
      <circle cx="21" cy="21" r="2" className="fill-foreground" />
    </svg>
  );
}

const label = (heading: number, azi: number) => `Heading ${fmt.n((heading + 360) % 360, 0)}°, well azimuth ${fmt.n(azi, 0)}°`;

/** The compass, then where the camera is; only the read-outs render as it moves (at most ~15 times a second). */
function Camera({ app }: { app: App }) {
  return (
    <div className="flex items-center gap-2">
      <Compass app={app} className="size-9" />
      <CameraText app={app} />
    </div>
  );
}

function CameraText({ app }: { app: App }) {
  const hud = useSignal(app.hud);
  const hdg = fmt.n((hud.heading + 360) % 360, 0);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="type-title truncate" title={hud.where}>
        {hud.where}
      </span>
      {/* the navigation mode gives way first; the camera's elevation and heading always show */}
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="type-caption min-w-0 flex-1 truncate" title={hud.nav}>
          {hud.nav}
        </span>
        <span className="type-caption shrink-0 font-mono tabular-nums" title="Camera elevation and heading">
          {hud.camY >= 0 ? '+' : ''}
          {fmt.n(hud.camY, 0)} m · {hdg}°
        </span>
      </span>
    </div>
  );
}

function Depth({ app }: { app: App }) {
  const p = useSignal(app.poseText);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Attitude inc={p.inc} />
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5">
          <Read k="MD" v={fmt.n(p.md, 1)} unit="m" />
          <Read k="TVDSS" v={fmt.n(p.tvdss, 1)} unit="m" />
        </dl>
      </div>
      <span className="type-caption truncate" title={`${p.zone} · ${p.section}`}>
        <span className="text-fg-2">{p.zone}</span> · azimuth {fmt.n(p.azi, 0)}°
      </span>
    </div>
  );
}

/** A key figure: a small uppercase name, then the number, right-aligned. */
function Read({ k, v, unit }: { k: string; v: string; unit?: string }) {
  return (
    <>
      <dt className="type-section">{k}</dt>
      <dd className="type-key truncate text-right">
        {v}
        {unit && <span className="type-unit ml-0.5">{unit}</span>}
      </dd>
    </>
  );
}

/**
 * Inclination as the bit sees it: a quarter dial from vertical (down) to
 * horizontal (right), with the hole drawn at its current angle.
 */
function Attitude({ inc }: { inc: number }) {
  const R = 26;
  const cx = 4;
  const cy = 4;
  const pt = (deg: number, r = R) => [cx + r * Math.sin((deg * Math.PI) / 180), cy + r * Math.cos((deg * Math.PI) / 180)];
  const arc = (from: number, to: number, r = R) => {
    const [x0, y0] = pt(from, r);
    const [x1, y1] = pt(to, r);
    return `M${x0},${y0} A${r},${r} 0 0 0 ${x1},${y1}`;
  };
  const i = Math.max(0, Math.min(95, inc));
  const [nx, ny] = pt(i, R - 3);
  return (
    <svg viewBox="0 0 92 34" className="h-[34px] w-[92px] shrink-0" role="img" aria-label={`Inclination ${fmt.n(inc, 1)}°`}>
      <path d={arc(0, 90)} fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-muted" />
      <path d={arc(0, Math.min(i, 90))} fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-ui-accent/70" />
      {[30, 60].map((d) => {
        const [a, b] = pt(d, R - 4);
        const [c, e] = pt(d, R + 3);
        return <line key={d} x1={a} y1={b} x2={c} y2={e} className="stroke-card" strokeWidth="1.5" />;
      })}
      <line x1={cx} y1={cy} x2={nx} y2={ny} strokeWidth="2.5" strokeLinecap="round" className="stroke-foreground" />
      <circle cx={cx} cy={cy} r="2.5" className="fill-foreground" />
      <text x="35" y="12" fontSize="8" fontWeight="600" letterSpacing=".07em" className="fill-fg-3">
        INC
      </text>
      <text x="35" y="28" fontSize="15" fontWeight="500" className="fill-fg-1 font-mono tabular-nums">
        {fmt.n(inc, 1)}°
      </text>
    </svg>
  );
}
