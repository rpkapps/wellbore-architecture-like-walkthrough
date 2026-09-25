import { Button } from '@tecton/react/components/button';
import { Panel, PanelContent, PanelDescription, PanelFooter, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { PROV_DESCRIPTION, PROV_DOT } from '../prov';
import { useRev, useSignal } from '../signal';
import { CollapseButton, OverlayChip, SURFACE, useCollapsed } from './overlay';

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
        <span className="type-unit">{count}</span>
        <span className="type-title max-w-56 truncate">{c.title}</span>
      </OverlayChip>
    );
  return (
    <Panel variant="elevated" size="sm" aria-label="Tour chapter" className={`w-80 max-w-full ${SURFACE}`}>
      <PanelHeader className="flex-col items-stretch gap-1">
        <span className="type-section flex items-center justify-between">
          CHAPTER {count}
          <CollapseButton collapsed={false} name="tour chapter" onChange={setCollapsed} />
        </span>
        <PanelTitle className="text-[1.07rem]! leading-snug font-semibold! text-fg-1!">{c.title}</PanelTitle>
        <PanelDescription className="type-label leading-relaxed!">{c.text}</PanelDescription>
      </PanelHeader>
      <PanelContent>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-x-3 gap-y-2">
          {c.facts.map((f) => (
            <div key={f.k} className="flex min-w-0 flex-col" title={PROV_DESCRIPTION[f.prov]}>
              <dt className="type-section flex items-center gap-1">
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PROV_DOT[f.prov]}`} />
                {f.k}
              </dt>
              <dd className="type-value truncate text-[1rem]!">
                {split(f.v)[0]}
                {split(f.v)[1] && <span className="type-unit ml-1">{split(f.v)[1]}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </PanelContent>
      <PanelFooter>
        <IconButton label="Previous chapter" onPress={() => step(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton label="Next chapter" onPress={() => step(1)}>
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
