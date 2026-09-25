import { Separator } from '@tecton/react/components/separator';
import { Panel, PanelContent } from '@tecton/react/tecton/panel';
import { Stat, StatGroup, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import type { App } from '../app';
import { fmt } from '../dom';
import { useSignal } from '../signal';

/** Where the camera is and where along the well: compass, depth read-outs and the read-outs features add. */
export function Hud({ app }: { app: App }) {
  const huds = useSignal(app.huds);
  return (
    <Panel variant="elevated" size="sm" aria-label="Position" className="w-80 max-w-full">
      <PanelContent className="flex flex-col gap-2">
        <Camera app={app} />
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

function Camera({ app }: { app: App }) {
  const hud = useSignal(app.hud);
  const hdg = fmt.n((hud.heading + 360) % 360, 0);
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 42 42" className="size-8 shrink-0" role="img" aria-label={`Heading ${hdg}°`}>
        <circle cx="21" cy="21" r="19" className="fill-muted stroke-border" />
        <g transform={`rotate(${-hud.heading} 21 21)`}>
          <path d="M21 5 L24.5 21 L21 19 L17.5 21 Z" className="fill-red-460" />
          <path d="M21 37 L24.5 21 L21 23 L17.5 21 Z" className="fill-muted-foreground" opacity=".45" />
          <text x="21" y="4.2" textAnchor="middle" fontSize="6" fontWeight="600" className="fill-foreground">
            N
          </text>
        </g>
      </svg>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{hud.where}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {hud.nav} · {hud.camY >= 0 ? '+' : ''}
          {fmt.n(hud.camY, 0)} m · {hdg}°
        </span>
      </div>
    </div>
  );
}

function Depth({ app }: { app: App }) {
  const p = useSignal(app.pose);
  return (
    <div className="flex flex-col gap-1">
      <StatGroup className="grid-cols-3 gap-x-3">
        <Stat size="sm">
          <StatLabel>MD</StatLabel>
          <StatValue unit="m">{fmt.n(p.md, 1)}</StatValue>
        </Stat>
        <Stat size="sm">
          <StatLabel>TVDSS</StatLabel>
          <StatValue unit="m">{fmt.n(p.tvdss, 1)}</StatValue>
        </Stat>
        <Stat size="sm">
          <StatLabel>Inclination</StatLabel>
          <StatValue>{fmt.n(p.inc, 1)}°</StatValue>
        </Stat>
      </StatGroup>
      <span className="truncate text-xs text-muted-foreground" title={`${p.zone} · ${p.section}`}>
        {p.zone} · {p.section} · azimuth {fmt.n(p.azi, 0)}°
      </span>
    </div>
  );
}
