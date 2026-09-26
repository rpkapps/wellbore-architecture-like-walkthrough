import { Popover, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@tecton/react/components/popover';
import { ChevronDownIcon } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { Button as AriaButton, ListBox, ListBoxItem } from 'react-aria-components';
import { colormap, COLORMAPS, RES_RANGE, resToT, toCss, type ColormapName } from '../../data/colormap';
import type { App } from '../app';
import { useRev } from '../signal';

const LMIN = Math.log10(RES_RANGE.min);
const LMAX = Math.log10(RES_RANGE.max);
const TICKS = [0.2, 1, 10, 100, 1000];

const stops = (n: ColormapName, k = 24) => Array.from({ length: k }, (_, i) => `${toCss(colormap(n, i / (k - 1)))} ${((i / (k - 1)) * 100).toFixed(1)}%`).join(',');

/** The active well's deep resistivity, decimated to `n` values (for the previews). */
function sample(app: App, n: number): number[] | null {
  const w = app.engine.activeWell;
  const name = w.petro?.inputs.rt;
  const c = name ? w.logs?.curves.get(name) : undefined;
  if (!c) return null;
  const v = c.values;
  const out: number[] = [];
  const step = v.length / n;
  for (let i = 0; i < n; i++) {
    // the median of each slice keeps spikes from dominating a pixel
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    const s: number[] = [];
    for (let j = a; j < b; j += Math.max(1, Math.floor((b - a) / 9))) if (Number.isFinite(v[j]) && v[j] > 0) s.push(v[j]);
    s.sort((x, y) => x - y);
    out.push(s.length ? s[s.length >> 1] : NaN);
  }
  return out;
}

/**
 * The resistivity colour ramp, clickable: it opens the colour maps, each
 * drawn as its ramp over the active well's own deep-resistivity log, so the
 * choice shows what the wellbore will look like. Hovering or moving through
 * the list previews a map in the 3D view and the log tracks; leaving without
 * choosing puts the previous one back.
 */
export function ColormapPicker({ app, size = 'md' }: { app: App; size?: 'md' | 'sm' }) {
  useRev(app.viewRev, app.wellRev);
  const current = app.colormapName;
  const committed = useRef(current);
  const w = app.engine.activeWell;
  const trace = useMemo(() => sample(app, 96), [app, w, w.logs]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = (n: ColormapName) => n !== app.colormapName && app.setColormap(n);
  const restore = () => committed.current !== app.colormapName && app.setColormap(committed.current);
  return (
    <PopoverTrigger
      onOpenChange={(open) => {
        if (open) committed.current = app.colormapName;
        else restore();
      }}
    >
      <AriaButton
        aria-label={`Resistivity colours: ${COLORMAPS.find((c) => c.id === current)?.label}. Change`}
        className="group/cmap flex w-full cursor-pointer flex-col gap-1 rounded-md p-1 -m-1 text-left outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:bg-ghost-hover"
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={`flex-1 rounded-sm ring-1 ring-foreground/10 ${size === 'sm' ? 'h-2' : 'h-2.5'}`} style={{ background: `linear-gradient(90deg,${stops(current)})` }} />
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-fg-3 group-data-hovered/cmap:text-fg-1" />
        </span>
        {size === 'md' && (
          <span className="type-unit relative mr-5 h-3">
            {TICKS.map((v) => (
              <span key={v} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${((Math.log10(v) - LMIN) / (LMAX - LMIN)) * 100}%` }}>
                {v}
              </span>
            ))}
          </span>
        )}
      </AriaButton>
      <Popover placement="bottom end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Resistivity colours</PopoverTitle>
          <PopoverDescription>{trace ? `Each map drawn over ${w.name}’s deep resistivity, top to TD.` : 'Hover a map to preview it in the view.'}</PopoverDescription>
        </PopoverHeader>
        <ListBox
          aria-label="Colour maps"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[committed.current]}
          onSelectionChange={(k) => {
            const n = [...k][0] as ColormapName | undefined;
            if (!n) return;
            committed.current = n;
            app.setColormap(n);
          }}
          onFocusChange={(focused) => !focused && restore()}
          className="-mx-1 flex flex-col gap-1 outline-none"
        >
          {COLORMAPS.map((c) => (
            <ListBoxItem
              key={c.id}
              id={c.id}
              textValue={c.label}
              onHoverStart={() => preview(c.id)}
              onHoverEnd={restore}
              onFocus={() => preview(c.id)}
              className="group/opt flex cursor-pointer flex-col gap-1 rounded-md p-1.5 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:bg-ghost-hover data-selected:bg-ghost-active"
            >
              <span className="flex items-center gap-2">
                <span className="type-label flex-1 group-data-selected/opt:text-fg-1">{c.label}</span>
                <span aria-hidden className="size-1.5 rounded-full bg-ui-accent opacity-0 group-data-selected/opt:opacity-100" />
              </span>
              <span aria-hidden className="h-2 rounded-sm ring-1 ring-foreground/10" style={{ background: `linear-gradient(90deg,${stops(c.id)})` }} />
              {trace && <Trace values={trace} map={c.id} />}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </PopoverTrigger>
  );
}

/** The well's resistivity as a strip of colour (depth left to right), with the curve itself on top. */
function Trace({ values, map }: { values: number[]; map: ColormapName }) {
  const n = values.length;
  const H = 18;
  const y = (r: number) => H - 1.5 - resToT(r) * (H - 3);
  let d = '';
  values.forEach((r, i) => {
    if (!Number.isFinite(r)) return;
    d += `${d && Number.isFinite(values[i - 1]) ? 'L' : 'M'}${i + 0.5},${y(r).toFixed(1)}`;
  });
  return (
    <svg aria-hidden viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" className="h-[18px] w-full overflow-hidden rounded-sm">
      {values.map((r, i) => (Number.isFinite(r) ? <rect key={i} x={i} y={0} width={1.05} height={H} fill={toCss(colormap(map, resToT(r)))} /> : null))}
      <path d={d} fill="none" stroke="rgb(255 255 255 / 0.75)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
