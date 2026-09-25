import { Button } from '@tecton/react/components/button';
import { Panel, PanelContent, PanelDescription, PanelFooter, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { Stat, StatGroup, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { PROV_DESCRIPTION, PROV_DOT } from '../prov';
import { useRev, useSignal } from '../signal';
import { CollapseButton, OverlayChip, useCollapsed } from './overlay';

/** The guided tour's chapter card: what the camera is looking at, with the key numbers. */
export function Narrative({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const ch = useSignal(app.chapter);
  const [collapsed, setCollapsed] = useCollapsed('narrative');
  if (app.engine.rig.mode !== 'guided' || !ch) return null;
  const c = app.chapters[ch.index];
  if (!c) return null;
  const n = app.chapters.length;
  const step = (d: number) => {
    app.stopTour();
    app.goChapter(ch.index + d);
  };
  const count = `${String(ch.index + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
  if (collapsed)
    return (
      <OverlayChip
        name="tour chapter"
        onExpand={() => setCollapsed(false)}
        end={
          <>
            <IconButton label="Previous chapter" size="icon-xs" onPress={() => step(-1)}>
              <ChevronLeftIcon />
            </IconButton>
            <IconButton label="Next chapter" size="icon-xs" onPress={() => step(1)}>
              <ChevronRightIcon />
            </IconButton>
          </>
        }
      >
        <span className="font-mono text-xs text-muted-foreground">{count}</span>
        <span className="max-w-56 truncate text-xs font-medium">{c.title}</span>
      </OverlayChip>
    );
  return (
    <Panel variant="elevated" size="sm" aria-label="Tour chapter" className="w-80 max-w-full">
      <PanelHeader className="flex-col items-stretch gap-1">
        <span className="flex items-center justify-between font-mono text-xs text-muted-foreground">
          CHAPTER {count}
          <CollapseButton collapsed={false} name="tour chapter" onChange={setCollapsed} />
        </span>
        <PanelTitle>{c.title}</PanelTitle>
        <PanelDescription>{c.text}</PanelDescription>
      </PanelHeader>
      <PanelContent>
        <StatGroup className="grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-x-3 gap-y-1">
          {c.facts.map((f) => (
            <Stat key={f.k} size="sm" title={PROV_DESCRIPTION[f.prov]}>
              <StatLabel className="flex items-center gap-1">
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PROV_DOT[f.prov]}`} />
                {f.k}
              </StatLabel>
              <StatValue unit={split(f.v)[1]}>{split(f.v)[0]}</StatValue>
            </Stat>
          ))}
        </StatGroup>
      </PanelContent>
      <PanelFooter>
        <IconButton label="Previous chapter" variant="outline" onPress={() => step(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton label="Next chapter" variant="outline" onPress={() => step(1)}>
          <ChevronRightIcon />
        </IconButton>
        <Button size="sm" variant={ch.touring ? 'outline' : 'default'} className="ml-auto" onPress={() => (ch.touring ? app.stopTour() : app.startTour())}>
          {ch.touring ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {ch.touring ? 'Pause tour' : 'Auto tour'}
        </Button>
      </PanelFooter>
    </Panel>
  );
}

/** "3467 m MD" → ["3467", "m MD"]; values without a separate unit ("72.3°") stay whole. */
function split(v: string): [string, string | undefined] {
  const m = /^([^\d]*[\d.,]+)\s+(\D+)$/.exec(v);
  return m ? [m[1], m[2]] : [v, undefined];
}
