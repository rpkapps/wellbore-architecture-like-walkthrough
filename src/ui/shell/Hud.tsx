import { Separator } from '@tecton/react/components/separator';
import { Panel, PanelContent } from '@tecton/react/tecton/panel';
import type { App } from '../app';
import { fmt } from '../dom';
import { useSignal } from '../signal';
import { CollapseButton, OverlayChip, SURFACE, useCollapsed } from './overlay';

/** Where the camera is and where along the well: compass, attitude, depths and the read-outs features add. */
export function Hud({ app }: { app: App }) {
  const huds = useSignal(app.huds);
  const [collapsed, setCollapsed] = useCollapsed('hud');
  if (collapsed) return <HudChip app={app} onExpand={() => setCollapsed(false)} />;
  return (
    <Panel variant="elevated" size="sm" aria-label="Position" className={`w-80 max-w-full ${SURFACE}`}>
      <PanelContent className="flex flex-col gap-2">
        <Camera app={app} end={<CollapseButton collapsed={false} name="position" onChange={setCollapsed} />} />
        <Separator emphasis="subtle" />
        <Depth app={app} />
        {huds.map((h) => (
          <div key={h.id} className="contents">
            {h.render()}
          </div>
        ))}
      </PanelContent>
    </Panel>
  );
}

function HudChip({ app, onExpand }: { app: App; onExpand: () => void }) {
  const hud = useSignal(app.hud);
  const p = useSignal(app.poseText);
  return (
    <OverlayChip name="position" onExpand={onExpand}>
      <Compass heading={hud.heading} azi={p.azi} className="size-6" />
      <span className="type-value whitespace-nowrap">
        {fmt.n(p.md, 0)} <span className="type-unit">MD</span> <span className="text-fg-3">·</span> {fmt.n(p.tvdss, 0)} <span className="type-unit">TVDSS</span> <span className="text-fg-3">·</span>{' '}
        {fmt.n(p.inc, 0)}°
      </span>
      <span className="type-caption hidden max-w-32 truncate @3xl:inline">{p.zone}</span>
    </OverlayChip>
  );
}

/**
 * Compass that turns with the camera: red north, and the well's azimuth as
 * the primary-coloured arrow.
 */
function Compass({ heading, azi, className }: { heading: number; azi: number; className: string }) {
  const hdg = fmt.n((heading + 360) % 360, 0);
  const a = (azi * Math.PI) / 180;
  const tip = [21 + 15 * Math.sin(a), 21 - 15 * Math.cos(a)];
  return (
    <svg viewBox="0 0 42 42" className={`${className} shrink-0`} role="img" aria-label={`Heading ${hdg}°, well azimuth ${fmt.n(azi, 0)}°`}>
      <circle cx="21" cy="21" r="19.5" className="fill-muted stroke-border" />
      <g transform={`rotate(${-heading} 21 21)`}>
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

function Camera({ app, end }: { app: App; end: React.ReactNode }) {
  const hud = useSignal(app.hud);
  const p = useSignal(app.poseText);
  const hdg = fmt.n((hud.heading + 360) % 360, 0);
  return (
    <div className="flex items-center gap-2">
      <Compass heading={hud.heading} azi={p.azi} className="size-9" />
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
      <div className="self-start">{end}</div>
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
