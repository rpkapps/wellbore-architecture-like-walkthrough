import { Button } from '@tecton/react/components/button';
import { Panel, PanelContent, PanelDescription, PanelFooter, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { Stat, StatGroup, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { PROV_DESCRIPTION, PROV_DOT } from '../prov';
import { useRev, useSignal } from '../signal';

/** The guided tour's chapter card: what the camera is looking at, with the key numbers. */
export function Narrative({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const ch = useSignal(app.chapter);
  if (app.engine.rig.mode !== 'guided' || !ch) return null;
  const c = app.chapters[ch.index];
  if (!c) return null;
  const n = app.chapters.length;
  return (
    <Panel variant="elevated" size="sm" aria-label="Tour chapter" className="w-80 max-w-full">
      <PanelHeader className="flex-col items-stretch gap-1">
        <span className="font-mono text-xs text-muted-foreground">
          CHAPTER {String(ch.index + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}
        </span>
        <PanelTitle>{c.title}</PanelTitle>
        <PanelDescription>{c.text}</PanelDescription>
      </PanelHeader>
      <PanelContent>
        <StatGroup className="gap-x-4 gap-y-2">
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
        <IconButton
          label="Previous chapter"
          variant="outline"
          onPress={() => {
            app.stopTour();
            app.goChapter(ch.index - 1);
          }}
        >
          <ChevronLeftIcon />
        </IconButton>
        <IconButton
          label="Next chapter"
          variant="outline"
          onPress={() => {
            app.stopTour();
            app.goChapter(ch.index + 1);
          }}
        >
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
