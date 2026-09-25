import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@tecton/react/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { TrajectoryIcon } from '@tecton/react/icons';
import { OverflowItem, Toolbar } from '@tecton/react/tecton/overflow';
import { BookOpenIcon, CircleDotIcon, GaugeIcon, OrbitIcon, PauseIcon, PlaneIcon, PlayIcon, VideoIcon } from 'lucide-react';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { GuidedView } from '../../scene/cameraRig';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { useRev, useSignal } from '../signal';
import { font, ink } from '../tokens';

const SPEEDS = [15, 45, 120, 300];
const STRIP = 16;

const first = (k: 'all' | Set<Key>) => (k === 'all' || !k.size ? null : String([...k][0]));

/** Play along the well, scrub the whole hole, pick the camera, the speed and a tour chapter. */
export function Timeline({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const playing = useSignal(app.playing);
  const chapter = useSignal(app.chapter);
  const rig = app.engine.rig;
  const guided = rig.mode === 'guided';
  const views: [string, string, ReactNode][] = guided
    ? [
        ['tunnel', 'Inside', <CircleDotIcon />],
        ['chase', 'Chase', <TrajectoryIcon />],
        ['orbit', 'Orbit', <OrbitIcon />],
      ]
    : [
        ['fly', 'Fly', <PlaneIcon />],
        ['orbit', 'Orbit', <OrbitIcon />],
      ];
  const view = guided ? rig.guidedView : rig.exploreView;
  const setView = (v: string | null) => v && (guided ? app.setGuidedView(v as GuidedView) : app.setExploreView(v as 'fly' | 'orbit'));
  const chapterKey = chapter ? String(chapter.index) : null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-card px-2 py-1.5">
      <IconButton label={playing ? 'Pause (Space)' : 'Play along the well (Space)'} variant="default" size="icon-sm" placement="top" onPress={() => app.togglePlay()}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
      <Track app={app} />
      <Toolbar aria-label="Walkthrough" className="min-w-0 flex-[2_1_0%] justify-end">
        <OverflowItem
          id="camera"
          priority={3}
          overflow={
            <DropdownMenuSub>
              <DropdownMenuSubTrigger id="camera">
                <VideoIcon />
                Camera
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuGroup selectionMode="single" selectedKeys={[view]} onSelectionChange={(k) => setView(first(k))}>
                  {views.map(([id, label]) => (
                    <DropdownMenuItem key={id} id={id}>
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          }
        >
          <ToggleGroup aria-label="Camera" size="sm" selectionMode="single" disallowEmptySelection selectedKeys={[view]} onSelectionChange={(k) => setView(first(k))}>
            {views.map(([id, label, icon]) => (
              <ToggleGroupItem key={id} id={id} aria-label={label}>
                {icon}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </OverflowItem>
        <OverflowItem
          id="chapter"
          priority={2}
          overflow={
            <DropdownMenuSub>
              <DropdownMenuSubTrigger id="chapter">
                <BookOpenIcon />
                Chapter
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuGroup
                  selectionMode="single"
                  selectedKeys={chapterKey ? [chapterKey] : []}
                  onSelectionChange={(k) => {
                    const c = first(k);
                    if (c !== null) app.goChapter(+c);
                  }}
                >
                  {app.chapters.map((c, i) => (
                    <DropdownMenuItem key={i} id={String(i)} textValue={c.title}>
                      {i + 1}. {c.title}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          }
        >
          <Select aria-label="Tour chapter" placeholder="Chapter…" selectedKey={chapterKey} onSelectionChange={(k: Key | null) => k !== null && app.goChapter(+String(k))} className="w-40">
            <SelectTrigger size="sm">
              <BookOpenIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent placement="top end" className="min-w-72">
              {app.chapters.map((c, i) => (
                <SelectItem key={i} id={String(i)} textValue={`${i + 1}. ${c.title}`}>
                  {i + 1}. {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OverflowItem>
        <OverflowItem
          id="speed"
          priority={1}
          overflow={
            <DropdownMenuSub>
              <DropdownMenuSubTrigger id="speed">
                <GaugeIcon />
                Speed
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuGroup
                  selectionMode="single"
                  selectedKeys={[String(rig.speed)]}
                  onSelectionChange={(k) => {
                    const s = first(k);
                    if (s !== null) app.setSpeed(+s);
                  }}
                >
                  {SPEEDS.map((s) => (
                    <DropdownMenuItem key={s} id={String(s)}>{`${s} m/s`}</DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          }
        >
          <Select aria-label="Travel speed" selectedKey={String(rig.speed)} onSelectionChange={(k: Key | null) => k !== null && app.setSpeed(+String(k))} className="w-28">
            <SelectTrigger size="sm">
              <GaugeIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent placement="top">
              {SPEEDS.map((s) => (
                <SelectItem key={s} id={String(s)} textValue={`${s} m/s`}>
                  {s} m/s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OverflowItem>
      </Toolbar>
    </div>
  );
}

/** The whole well as a strip: formations, inclination, pay, casing shoes, tour chapters, a depth scale and the playhead. */
function Track({ app }: { app: App }) {
  useRev(app.wellRev);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = app.engine.activeWell;
  const td = w.tdMD;

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const draw = () => drawTrack(app, cv);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [app, w, app.chapters]);

  const scrub = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    app.scrubTo(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * td);
  };
  return (
    <div className="relative h-9 min-w-40 flex-[3_1_0%]">
      <canvas
        ref={canvas}
        aria-label="Well timeline: drag to move along the hole"
        className="absolute inset-0 size-full cursor-ew-resize touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => e.buttons && scrub(e)}
      />
      <Playhead app={app} td={td} />
    </div>
  );
}

function Playhead({ app, td }: { app: App; td: number }) {
  const pose = useSignal(app.pose);
  return <div aria-hidden className="pointer-events-none absolute top-0 w-0.5 -translate-x-1/2 rounded-full bg-primary" style={{ left: `${(Math.min(pose.md, td) / td) * 100}%`, height: STRIP + 6 }} />;
}

function drawTrack(app: App, cv: HTMLCanvasElement) {
  const w = app.engine.activeWell;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const td = w.tdMD;
  const x = (md: number) => (md / td) * W;
  const top = 3;
  // formations along the hole
  for (const z of w.zones) {
    g.fillStyle = z.formationId === 'sea' ? '#1d4e6b' : z.formationId === 'air' ? '#1a2029' : (FORMATION_BY_ID.get(z.formationId)?.color ?? '#555');
    g.fillRect(x(z.topMD), top, Math.max(1, x(z.baseMD) - x(z.topMD)), STRIP);
  }
  // inclination profile
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 1;
  g.beginPath();
  for (let px = 0; px < W; px++) {
    const inc = w.trajectory.at(Math.min((px / W) * td, w.trajectory.mdEnd)).inc;
    const y = top + STRIP - 2 - (inc / 95) * (STRIP - 4);
    if (px === 0) g.moveTo(px, y);
    else g.lineTo(px, y);
  }
  g.stroke();
  // pay
  if (w.petro && w.logs) {
    g.fillStyle = '#ffb547';
    const d = w.logs.depth;
    for (let i = 0; i < d.length; i += 3) if (w.petro.pay[i]) g.fillRect(x(d[i]), top + STRIP - 3, Math.max(1, x(0.3)), 3);
  }
  // casing shoes
  g.fillStyle = '#dfe6ec';
  for (const c of w.casing) g.fillRect(x(c.shoeMD) - 0.5, top, 1.5, STRIP);
  // tour chapters: ticks above the strip
  g.fillStyle = ink.text;
  for (const c of app.chapters) g.fillRect(x(c.md) - 0.5, 0, 1, top + 3);
  // depth scale, labels kept apart
  g.font = font.mono(9.5);
  g.textBaseline = 'top';
  const ly = top + STRIP + 3;
  const step = td > 3000 ? 500 : 250;
  const tdLabel = `TD ${td.toFixed(0)}`;
  const tdW = g.measureText(tdLabel).width;
  g.fillStyle = ink.muted;
  g.textAlign = 'right';
  g.fillText(tdLabel, W, ly);
  g.fillStyle = ink.faint;
  g.textAlign = 'left';
  let last = -Infinity;
  for (let md = 0; md < td; md += step) {
    const label = md === 0 ? '0 m' : String(md);
    const lw = g.measureText(label).width;
    const lx = md === 0 ? 0 : x(md) - lw / 2;
    if (lx < last + 8 || lx + lw > W - tdW - 8) continue;
    g.fillText(label, lx, ly);
    last = lx + lw;
  }
}
