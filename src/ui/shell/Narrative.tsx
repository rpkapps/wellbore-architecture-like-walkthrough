import { Button } from '@tecton/react/components/button';
import { Panel, PanelContent, PanelDescription, PanelFooter, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { PROV_DESCRIPTION, PROV_DOT } from '../prov';
import { useRev, useSignal } from '../signal';
import { CollapseButton, Morph, OverlayChip, SURFACE, useCollapsed } from './overlay';

/**
 * The guided tour's chapter card, anchored over its numbered marker on the
 * timeline: it shows while the tour or the walk plays, or once a chapter is
 * chosen (a marker, N / P); closed, the markers on the strip are all that is
 * left of it. It sits above the viewport toolbar (it is the first row of
 * the toolbar's column, a row of no height the card rises out of), as near
 * the marker as the free area allows, with a thin line down to it.
 */
export function Narrative({ app }: { app: App }) {
  // of the view, only the navigation mode matters here (a slider on the view bumps viewRev per step)
  const guided = useSyncExternalStore(app.viewRev.subscribe, () => app.engine.rig.mode === 'guided');
  const rev = useRev(app.wellRev);
  const ch = useSignal(app.chapter);
  const open = useSignal(app.chapterCard);
  const [collapsed, setCollapsed] = useCollapsed('narrative');
  const c = guided && open && ch ? app.chapters[ch.index] : undefined;
  const index = c ? ch!.index : -1;
  const place = useAnchor(index, collapsed, rev);
  if (!c || !ch) return null;
  return (
    <div ref={place.area} className="pointer-events-none relative h-0 w-full">
      {place.tether && <div aria-hidden className="absolute top-0 w-0.5 -translate-x-1/2 rounded-full bg-ui-accent/80" style={{ left: place.tether.x, height: place.tether.h }} />}
      <div ref={place.card} className="pointer-events-auto absolute bottom-0 max-w-full" style={{ left: place.left }}>
        <Morph anchor="bl">
          <Card app={app} index={ch.index} touring={ch.touring} collapsed={collapsed} setCollapsed={setCollapsed} />
        </Morph>
      </div>
    </div>
  );
}

/**
 * Where the card goes: centred over the chapter's marker on the timeline
 * (found by its `data-chapter`), kept inside the free area; the line runs
 * from the card down past the toolbar to the timeline. Measured when the
 * chapter, the card's form or the well changes, and when the column or the
 * card resizes (a panel column dragged, the window resized, a prompt shown).
 */
function useAnchor(index: number, collapsed: boolean, rev: number) {
  const area = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; tether: { x: number; h: number } | null }>({ left: 0, tether: null });
  useLayoutEffect(() => {
    const a = area.current;
    const k = card.current;
    if (index < 0 || !a || !k) return;
    const column = a.parentElement!;
    const measure = () => {
      const r = a.getBoundingClientRect();
      const m = document.querySelector(`[data-chapter="${index}"]`)?.getBoundingClientRect();
      const w = k.offsetWidth;
      const x = m ? m.left + m.width / 2 - r.left : w / 2;
      const left = Math.round(Math.max(0, Math.min(r.width - w, x - w / 2)));
      // past the bottom of the column (just above the free area's edge) to the timeline
      const h = Math.round(column.getBoundingClientRect().bottom - r.top + 14);
      const tether = m && x > 4 && x < r.width - 4 ? { x: Math.round(x), h } : null;
      setPos((p) => (p.left === left && p.tether?.x === tether?.x && p.tether?.h === tether?.h ? p : { left, tether }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(column);
    ro.observe(k);
    return () => ro.disconnect();
  }, [index, collapsed, rev]);
  return { area, card, ...pos };
}

/** The card itself: the chapter's text and key numbers, previous / next, and the auto tour. */
function Card({ app, index, touring, collapsed, setCollapsed }: { app: App; index: number; touring: boolean; collapsed: boolean; setCollapsed: (v: boolean) => void }) {
  const c = app.chapters[index];
  const n = app.chapters.length;
  const step = (d: number) => {
    app.stopTour();
    app.goChapter(index + d);
  };
  const closeButton = (
    <IconButton
      label="Close (the chapters stay on the timeline)"
      size="icon-xs"
      onPress={() => {
        app.stopTour();
        app.chapterCard.set(false);
      }}
    >
      <XIcon />
    </IconButton>
  );
  const count = `${String(index + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
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
            {closeButton}
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
          <span className="flex items-center">
            <CollapseButton collapsed={false} name="tour chapter" onChange={setCollapsed} />
            {closeButton}
          </span>
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
        <IconButton label="Previous chapter (P)" onPress={() => step(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton label="Next chapter (N)" onPress={() => step(1)}>
          <ChevronRightIcon />
        </IconButton>
        <Button size="sm" variant={touring ? 'outline' : 'default'} className="ml-auto" onPress={() => (touring ? app.stopTour() : app.startTour())}>
          {touring ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {touring ? 'Pause tour' : 'Auto tour'}
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
