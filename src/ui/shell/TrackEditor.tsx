import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Checkbox } from '@tecton/react/components/checkbox';
import { Field, FieldLabel } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { ScrollArea } from '@tecton/react/components/scroll-area';
import { Separator } from '@tecton/react/components/separator';
import { Switch } from '@tecton/react/components/switch';
import { ColorSwatch } from '@tecton/react/tecton/color-swatch';
import { ArrowLeftRightIcon, ChevronDownIcon, ChevronUpIcon, PlusIcon, SlidersHorizontalIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { DEFAULT_TRACKS, MAX_CURVES_PER_TRACK, availableCurves, moveTrack, newTrack, specForOption, trackHasData, type CurveOption, type CurveSpec, type TrackSpec } from '../../data/trackLayout';
import type { App } from '../app';
import { CompactSelect, Note, SwitchField, type OptionGroup } from '../controls';
import { IconButton } from '../icon-button';
import { useRev } from '../signal';

const WIDTHS: [number, string][] = [
  [0.6, 'Narrow'],
  [0.9, 'Normal'],
  [1.3, 'Wide'],
];

/** Curve options grouped by where they come from. */
function curveGroups(opts: CurveOption[]): OptionGroup[] {
  const groups: [CurveOption['source'], string][] = [
    ['logs', 'Measured logs'],
    ['cpi', 'Equinor CPI (operator interp.)'],
    ['petro', 'Calculated in the app'],
  ];
  return groups
    .map(([src, label]) => ({ label, options: opts.filter((o) => o.source === src).map((o) => ({ id: o.id, label: `${o.label}${o.unit ? ` (${o.unit})` : ''}` })) }))
    .filter((g) => g.options.length);
}

/** number of curves a built-in track starts with (curves beyond it were added by the user) */
function builtInCount(t: TrackSpec): number {
  return DEFAULT_TRACKS.find((d) => d.id === t.id)?.curves.length ?? t.curves.length;
}

/** Show, hide, reorder, rescale and add log tracks. The layout is saved per browser. */
export function TrackEditor({ app }: { app: App }) {
  const logs = app.logs;
  useRev(logs.rev);
  const [editing, setEditing] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const w = logs.well;
  const opts = w ? availableCurves(w) : [];
  const change = (layout?: TrackSpec[]) => {
    if (layout) logs.tracks = layout;
    logs.commitLayout();
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 pr-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground">{logs.tracks.filter((t) => !t.hidden).length} tracks shown</span>
          <Button
            variant="ghost"
            size="xs"
            onPress={() => {
              setEditing(null);
              logs.resetLayout();
            }}
          >
            Reset to standard
          </Button>
        </div>
        <ul className="flex flex-col gap-1" aria-label="Tracks">
          {logs.tracks.map((t, i) => {
            const noData = w && !trackHasData(w, t);
            return (
              <li key={t.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-1">
                  <Switch size="sm" aria-label={`Show ${t.title}`} isSelected={!t.hidden} onChange={(on) => ((t.hidden = !on), change())} />
                  <span className="ml-1.5 min-w-0 flex-1 truncate text-sm" title={t.curves.map((c) => c.label).join(', ')}>
                    {t.title}
                  </span>
                  {t.custom && <Badge variant="info">added</Badge>}
                  {noData && <Badge variant="outline">no data</Badge>}
                  <IconButton label="Move up" size="icon-xs" isDisabled={i === 0} onPress={() => change(moveTrack(logs.tracks, t.id, -1))}>
                    <ChevronUpIcon />
                  </IconButton>
                  <IconButton label="Move down" size="icon-xs" isDisabled={i === logs.tracks.length - 1} onPress={() => change(moveTrack(logs.tracks, t.id, 1))}>
                    <ChevronDownIcon />
                  </IconButton>
                  <IconButton label="Scales and colours" size="icon-xs" variant={editing === t.id ? 'secondary' : 'ghost'} onPress={() => setEditing(editing === t.id ? null : t.id)}>
                    <SlidersHorizontalIcon />
                  </IconButton>
                  {t.custom && (
                    <IconButton label="Remove track" size="icon-xs" onPress={() => change(logs.tracks.filter((q) => q !== t))}>
                      <Trash2Icon />
                    </IconButton>
                  )}
                </div>
                {editing === t.id && <TrackFields app={app} t={t} onChange={() => change()} />}
              </li>
            );
          })}
        </ul>
        <Separator emphasis="subtle" />
        <div className="flex items-center gap-2">
          <CompactSelect label="Curve for a new track" value={pick} onChange={setPick} options={curveGroups(opts)} placeholder="Choose a curve …" className="min-w-0 flex-1" />
          <Button
            size="sm"
            isDisabled={!pick || !w}
            onPress={() => {
              const o = opts.find((q) => q.id === pick);
              if (!o || !w) return;
              const t = newTrack(w, o, logs.tracks);
              setEditing(t.id);
              setPick(null);
              change([...logs.tracks, t]);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add track
          </Button>
        </div>
        <SwitchField label="Hide tracks this well has no data for" isSelected={logs.hideEmpty} onChange={(v) => ((logs.hideEmpty = v), change())} />
        <Note>The layout is saved in this browser and applies to every well. Added tracks are skipped on wells that lack their curves.</Note>
      </div>
    </ScrollArea>
  );
}

function TrackFields({ app, t, onChange }: { app: App; t: TrackSpec; onChange: () => void }) {
  const w = app.logs.well;
  const titleId = useId();
  const widthId = useId();
  const shadeId = useId();
  const [title, setTitle] = useState(t.title);
  const opts = w ? availableCurves(w) : [];
  const width = WIDTHS.reduce((a, b) => (Math.abs(b[0] - t.flex) < Math.abs(a[0] - t.flex) ? b : a))[0];
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/50 p-2.5">
      {t.custom && (
        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor={titleId}>Title</FieldLabel>
          <Input
            id={titleId}
            variant="filled"
            maxLength={40}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              t.title = title.trim() || t.title;
              setTitle(t.title);
              onChange();
            }}
          />
        </Field>
      )}
      <Field orientation="horizontal" className="gap-2">
        <FieldLabel htmlFor={widthId}>Width</FieldLabel>
        <CompactSelect id={widthId} value={String(width)} onChange={(v) => ((t.flex = +v), onChange())} options={WIDTHS.map(([v, l]) => ({ id: String(v), label: l }))} />
      </Field>
      {t.curves.map((c, k) => (
        <CurveFields key={`${c.key}:${k}`} c={c} canRemove={t.curves.length > 1 && (!!t.custom || k >= builtInCount(t))} onRemove={() => ((t.curves = t.curves.filter((q) => q !== c)), onChange())} onChange={(first) => {
            if (k === 0 && first !== undefined) t.grid = first ? 'log' : 'linear';
            onChange();
          }} />
      ))}
      {t.custom && (
        <Field orientation="horizontal" className="gap-2">
          <Checkbox id={shadeId} isSelected={t.fill === 'shade'} onChange={(on) => ((t.fill = on ? 'shade' : undefined), onChange())} />
          <FieldLabel htmlFor={shadeId}>Shade under {t.curves[0].label}</FieldLabel>
        </Field>
      )}
      {t.curves.length < MAX_CURVES_PER_TRACK && w && (
        <CompactSelect
          label="Add a curve to this track"
          value={null}
          placeholder="Add a curve to this track …"
          options={curveGroups(opts)}
          onChange={(id) => {
            const o = opts.find((q) => q.id === id);
            if (!o) return;
            t.curves.push(specForOption(w, o, t.curves.map((q) => q.color)));
            onChange();
          }}
          className="w-full"
        />
      )}
    </div>
  );
}

/** Colour and scale of one curve. `onChange(log)` reports a log/linear switch. */
function CurveFields({ c, canRemove, onRemove, onChange }: { c: CurveSpec; canRemove: boolean; onRemove: () => void; onChange: (log?: boolean) => void }) {
  const logId = useId();
  const [min, setMin] = useState(String(+c.scale.min.toPrecision(6)));
  const [max, setMax] = useState(String(+c.scale.max.toPrecision(6)));
  const commit = (end: 'min' | 'max', raw: string) => {
    const x = +raw;
    const next = { ...c.scale, [end]: x };
    // a log scale needs positive ends; equal ends are meaningless
    if (raw.trim() !== '' && Number.isFinite(x) && next.min !== next.max && (!next.log || (next.min > 0 && next.max > 0))) {
      c.scale = next;
      onChange();
    } else {
      setMin(String(+c.scale.min.toPrecision(6)));
      setMax(String(+c.scale.max.toPrecision(6)));
    }
  };
  const logAllowed = !!c.scale.log || (c.scale.min > 0 && c.scale.max > 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <ColorSwatch color={c.color} size="sm" aria-label={`${c.label} colour`} onChange={(hex) => ((c.color = hex), onChange())} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={c.key}>
          {c.label}
        </span>
        {canRemove && (
          <IconButton label="Remove curve" size="icon-xs" onPress={onRemove}>
            <XIcon />
          </IconButton>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input aria-label="Left edge" variant="filled" type="number" step="any" className="w-20" value={min} onChange={(e) => setMin(e.target.value)} onBlur={() => commit('min', min)} />
        <span className="text-muted-foreground">→</span>
        <Input aria-label="Right edge" variant="filled" type="number" step="any" className="w-20" value={max} onChange={(e) => setMax(e.target.value)} onBlur={() => commit('max', max)} />
        <IconButton
          label="Reverse the scale"
          size="icon-xs"
          onPress={() => {
            c.scale = { ...c.scale, min: c.scale.max, max: c.scale.min };
            setMin(String(+c.scale.min.toPrecision(6)));
            setMax(String(+c.scale.max.toPrecision(6)));
            onChange();
          }}
        >
          <ArrowLeftRightIcon />
        </IconButton>
        <Field orientation="horizontal" className="w-auto gap-1.5" data-disabled={!logAllowed || undefined}>
          <Checkbox id={logId} isSelected={!!c.scale.log} isDisabled={!logAllowed} onChange={(on) => ((c.scale = { ...c.scale, log: on }), onChange(on))} />
          <FieldLabel htmlFor={logId}>log</FieldLabel>
        </Field>
      </div>
    </div>
  );
}
