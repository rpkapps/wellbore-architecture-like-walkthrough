import { Alert, AlertDescription } from '@tecton/react/components/alert';
import { Skeleton } from '@tecton/react/components/skeleton';
import { Button } from '@tecton/react/components/button';
import { Popover, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@tecton/react/components/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tecton/react/components/table';
import { Stat, StatDelta, StatGroup, StatHelp, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import { DownloadIcon, InfoIcon, RotateCcwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Key } from 'react-aria-components';
import { sampleCurve } from '../../data/las';
import { DEFAULT_PARAMS, PARAM_NOTES, autoGrLimits, payIntervals, type PetroParams } from '../../data/petro';
import { FORMATION_BY_ID } from '../../data/stratigraphy';
import type { App } from '../app';
import { CompactSelect, Note } from '../controls';
import { download, fmt } from '../dom';
import { ProvBadge } from '../prov';
import { IconButton } from '../icon-button';
import { useRev, useSignal } from '../signal';
import { FluidDonut } from '../viz/FluidDonut';
import { ScrubField } from '../scrub';
import { PanelAccordion, PanelSection } from '../section';

interface ParamDef {
  key: keyof PetroParams;
  label: string;
  unit?: string;
  step: number;
  options?: [string, string][];
  range?: [number, number];
  /** logarithmic slider */
  log?: boolean;
  /** drawn over the distribution of this curve, highlighting the side it keeps */
  hist?: { curve: 'gr' | 'vsh' | 'phie' | 'sw'; keep: 'below' | 'above'; tone?: 'pay' | 'shale' };
}

const GROUPS: { title: string; params: ParamDef[] }[] = [
  {
    title: 'Shale volume',
    params: [
      { key: 'grClean', label: 'GR clean sand', unit: 'API', step: 1, range: [0, 80], hist: { curve: 'gr', keep: 'below' } },
      { key: 'grShale', label: 'GR shale', unit: 'API', step: 1, range: [50, 200], hist: { curve: 'gr', keep: 'above', tone: 'shale' } },
      {
        key: 'vshMethod',
        label: 'Vsh transform',
        step: 0,
        options: [
          ['linear', 'Linear IGR'],
          ['larionov-older', 'Larionov (older rocks)'],
          ['larionov-tertiary', 'Larionov (Tertiary)'],
        ],
      },
    ],
  },
  {
    title: 'Porosity',
    params: [
      { key: 'rhoMa', label: 'Matrix density ρma', unit: 'g/cm³', step: 0.01, range: [2.6, 2.75] },
      { key: 'rhoFl', label: 'Fluid density ρfl', unit: 'g/cm³', step: 0.01, range: [0.8, 1.2] },
      {
        key: 'porosityMethod',
        label: 'Method',
        step: 0,
        options: [
          ['density', 'Density'],
          ['neutron-density', 'Neutron–density (RMS)'],
        ],
      },
    ],
  },
  {
    title: 'Saturation',
    params: [
      {
        key: 'satModel',
        label: 'Model',
        step: 0,
        options: [
          ['archie', 'Archie'],
          ['simandoux', 'Modified Simandoux'],
        ],
      },
      { key: 'rw', label: 'Rw', unit: 'Ω·m', step: 0.001, range: [0.005, 0.5], log: true },
      { key: 'rwTemp', label: 'Rw reference temp.', unit: '°C', step: 1, range: [20, 150] },
      { key: 'a', label: 'Tortuosity a', step: 0.05, range: [0.5, 1.5] },
      { key: 'm', label: 'Cementation m', step: 0.05, range: [1.5, 2.6] },
      { key: 'n', label: 'Saturation n', step: 0.05, range: [1.5, 3] },
      { key: 'rsh', label: 'Rsh (Simandoux)', unit: 'Ω·m', step: 0.1, range: [0.5, 10] },
    ],
  },
  {
    title: 'Net pay cut-offs',
    params: [
      { key: 'cutVsh', label: 'Vsh ≤', step: 0.01, range: [0, 1], hist: { curve: 'vsh', keep: 'below' } },
      { key: 'cutPhi', label: 'φ ≥', step: 0.01, range: [0, 0.3], hist: { curve: 'phie', keep: 'above' } },
      { key: 'cutSw', label: 'Sw ≤', step: 0.01, range: [0, 1], hist: { curve: 'sw', keep: 'below' } },
    ],
  },
];

interface Summary {
  pay: number;
  phi: number;
  sw: number;
  hc: number;
  ints: number;
}

function summarise(app: App): Summary {
  let pay = 0;
  let phi = 0;
  let swpv = 0;
  let hc = 0;
  for (const s of app.zoneSummaries()) {
    if (!(s.pay > 0)) continue;
    pay += s.pay;
    phi += s.phiAvg * s.pay;
    swpv += s.swAvg * s.phiAvg * s.pay;
    hc += s.hcColumn;
  }
  const w = app.engine.activeWell;
  const ints = w.logs && w.petro ? payIntervals(w.logs.depth, w.petro.pay, 1.0).length : 0;
  return { pay, phi: pay > 0 ? phi / pay : NaN, sw: phi > 0 ? swpv / phi : NaN, hc, ints };
}

/**
 * Live petrophysical interpretation: the parameters that turn the measured
 * logs into Vsh, porosity and saturation, and what they do to the pay.
 */
export function InterpretationPanel({ app }: { app: App }) {
  useRev(app.wellRev);
  const w = app.engine.activeWell;
  // changes are shown relative to when the panel was opened, or the well changed
  const [baseline, setBaseline] = useState(() => summarise(app));
  useEffect(() => setBaseline(summarise(app)), [app, w]);
  const [resets, setResets] = useState(0);
  const [open, setOpen] = useState<Set<Key>>(() => new Set(['Saturation', 'Net pay cut-offs', 'zones']));
  const timer = useRef<number | null>(null);
  const live = useRef({ at: 0, cost: 0, timer: 0 });
  // the curves, 3D and headline numbers follow the drag, paced so they take
  // at most about a third of the time (the control stays responsive on slow
  // machines); the rest of the app (features, zone table, timeline) catches
  // up once the drag settles
  const apply = () => {
    const L = live.current;
    const run = () => {
      const t0 = performance.now();
      app.reinterpretLive();
      L.at = performance.now();
      L.cost = L.at - t0;
    };
    clearTimeout(L.timer);
    const wait = L.at + 2 * L.cost - performance.now();
    if (wait <= 0) run();
    else L.timer = window.setTimeout(run, wait);
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => app.reinterpret(), 260);
  };
  const set = (key: keyof PetroParams, v: number | string) => {
    (w.params as unknown as Record<string, unknown>)[key] = v;
    apply();
  };
  const reset = () => {
    Object.assign(w.params, DEFAULT_PARAMS);
    const g = w.logs ? autoGrLimits(w.logs) : null;
    if (g) {
      w.params.grClean = g.clean;
      w.params.grShale = g.shale;
    }
    app.reinterpret();
    setResets((n) => n + 1);
    app.toast('Parameters reset to the defaults calibrated against Equinor CPI.');
  };
  const inputs = w.petro?.inputs;
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 p-3">
        <SummaryStats app={app} baseline={baseline} />
        <div className="-ml-2 flex flex-wrap gap-0.5">
          <Button variant="ghost" size="xs" onPress={reset}>
            <RotateCcwIcon data-icon="inline-start" />
            Reset to calibrated
          </Button>
          <Button variant="ghost" size="xs" onPress={() => exportCsv(app)}>
            <DownloadIcon data-icon="inline-start" />
            Export curves
          </Button>
        </div>
      </div>
      <PanelAccordion expandedKeys={open} onExpandedChange={setOpen}>
        <PanelSection id="method" title="How it works">
          <div className="flex flex-col gap-2">
            <Note>
              The measured logs (gamma ray, density, deep resistivity) are converted into shale volume, porosity and water saturation. The results drive the Hydrocarbons 3D view, the Vsh · Porosity
              and Saturation log tracks, the pay flags and the zone table; the measured Resistivity view never changes. Try Rw 0.025 → 0.08 (fresher brine) and watch pay shrink.
            </Note>
            <div className="flex flex-col gap-1 font-mono text-xs text-foreground">
              <span>Vsh = (GR − GRclean)/(GRshale − GRclean)</span>
              <span>φ = (ρma − ρb)/(ρma − ρfl)</span>
              <span>Sw = (a·Rw / (φᵐ·Rt))^(1/n), So = 1 − Sw</span>
            </div>
            <Note>
              <ProvBadge prov="calculated" /> Inputs from {w.name}: {[inputs?.gr, inputs?.rt, inputs?.rhob, inputs?.nphi].filter(Boolean).join(', ') || '—'} (measured).
            </Note>
            {!w.petro?.available && (
              <Alert variant="destructive">
                <AlertDescription>Density or resistivity missing — saturation cannot be computed for this well.</AlertDescription>
              </Alert>
            )}
          </div>
        </PanelSection>
        {GROUPS.map((g) => (
          <PanelSection key={g.title} id={g.title} title={g.title}>
            {/* built only while open: hidden controls would mount unfocusable */}
            {open.has(g.title) && (
              <div className="flex flex-col gap-1">
                {g.params.map((d) => (
                  <Param key={`${w.id}:${d.key}:${resets}`} def={d} value={w.params[d.key] as number | string} onChange={(v) => set(d.key, v)} data={d.hist ? histData(app, d.hist.curve) : null} />
                ))}
              </div>
            )}
          </PanelSection>
        ))}
        <PanelSection id="zones" title="Zone summary (along hole)">
          <ZoneTable app={app} />
        </PanelSection>
        {w.cpi && w.logs && w.petro && (
          <PanelSection id="cpi" title="Validation vs. Equinor CPI">
            <CpiValidation app={app} />
          </PanelSection>
        )}
      </PanelAccordion>
    </div>
  );
}

function SummaryStats({ app, baseline }: { app: App; baseline: Summary }) {
  useRev(app.interpRev);
  const w = app.engine.activeWell;
  const loading = useSignal(app.loadingWell);
  if (loading)
    return (
      <div role="status" aria-label={`Loading ${loading}`} className="flex items-center gap-3">
        <Skeleton className="size-[76px] rounded-full" />
        <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    );
  if (!w.petro?.available)
    return (
      <Alert variant="destructive">
        <AlertDescription>{w.name} has no density + resistivity logs, so saturation cannot be calculated. Switch to 15/9-F-11 B, F-11 A or F-1 C.</AlertDescription>
      </Alert>
    );
  const cur = summarise(app);
  const delta = (now: number, was: number, f: (v: number) => string, higherIsMore = true) => {
    if (!Number.isFinite(was) || !Number.isFinite(now) || Math.abs(now - was) < 1e-6) return null;
    const up = now > was;
    return <StatDelta trend={up === higherIsMore ? 'up' : 'down'}>was {f(was)}</StatDelta>;
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <FluidDonut sw={cur.sw} phi={cur.phi} />
        <StatGroup className="flex-1 grid-cols-2 gap-x-3 gap-y-2">
          <Stat size="sm">
            <StatLabel>Net pay (MD)</StatLabel>
            <StatValue unit="m">{fmt.n(cur.pay, 1)}</StatValue>
            {delta(cur.pay, baseline.pay, (v) => `${fmt.n(v, 1)} m`)}
          </Stat>
          <Stat size="sm">
            <StatLabel>Avg φ in pay</StatLabel>
            <StatValue>{fmt.pct(cur.phi, 1)}</StatValue>
            {delta(cur.phi, baseline.phi, (v) => fmt.pct(v, 1))}
          </Stat>
          <Stat size="sm">
            <StatLabel>Avg Sw in pay</StatLabel>
            <StatValue>{fmt.pct(cur.sw, 0)}</StatValue>
            {delta(cur.sw, baseline.sw, (v) => fmt.pct(v, 0), false)}
          </Stat>
          <Stat size="sm">
            <StatLabel>HC column</StatLabel>
            <StatValue unit="m">{fmt.n(cur.hc, 2)}</StatValue>
            {delta(cur.hc, baseline.hc, (v) => `${fmt.n(v, 2)} m`)}
          </Stat>
        </StatGroup>
      </div>
      <StatHelp>{cur.ints} pay intervals ≥ 1 m · changes since this panel opened</StatHelp>
    </div>
  );
}

/** The samples a parameter acts on, for the histogram under its slider. */
function histData(app: App, curve: 'gr' | 'vsh' | 'phie' | 'sw'): ArrayLike<number> | null {
  const w = app.engine.activeWell;
  if (curve === 'gr') {
    const name = w.petro?.inputs.gr;
    return (name && w.logs?.curves.get(name)?.values) || null;
  }
  return w.petro?.[curve].values ?? null;
}

/** What a parameter means and where its default comes from, opened from the (i) at the end of its row. */
function NoteButton({ title, note }: { title: string; note: string }) {
  return (
    <PopoverTrigger>
      <IconButton label={`About ${title}`} size="icon-xs" className="text-fg-3 opacity-0 group-hover/param:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100">
        <InfoIcon />
      </IconButton>
      <Popover placement="left top" className="w-64">
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <PopoverDescription>{note}</PopoverDescription>
        </PopoverHeader>
      </Popover>
    </PopoverTrigger>
  );
}

/** One parameter on one 24 px row: a scrub bar for numbers (over the data it cuts, for cut-offs), or a label and a select. */
function Param({ def: d, value, onChange, data }: { def: ParamDef; value: number | string; onChange: (v: number | string) => void; data: ArrayLike<number> | null }) {
  const note = PARAM_NOTES[d.key];
  const [num, setNum] = useState(() => (typeof value === 'number' ? value : parseFloat(value)));
  const info = note ? <NoteButton title={d.label} note={note} /> : <span className="w-6 shrink-0" />;
  if (d.options)
    return (
      <div className="group/param flex h-7 min-w-0 items-center gap-1">
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md bg-muted/70 pl-2">
          <span className="type-label min-w-0 flex-1 truncate">{d.label}</span>
          <CompactSelect label={d.label} value={String(value)} onChange={onChange} options={d.options.map(([v, l]) => ({ id: v, label: l }))} className="max-w-[62%] min-w-0 shrink" />
        </div>
        {info}
      </div>
    );
  const [lo, hi] = d.range ?? [0, 1];
  return (
    <div className="group/param">
      <ScrubField
        label={d.label}
        unit={d.unit}
        value={num}
        min={lo}
        max={hi}
        step={d.step}
        log={d.log}
        histogram={d.hist ? { values: data, keep: d.hist.keep, tone: d.hist.tone } : undefined}
        onChange={(v) => {
          setNum(v);
          onChange(v);
        }}
        end={info}
      />
    </div>
  );
}

function ZoneTable({ app }: { app: App }) {
  const sums = app.zoneSummaries().filter((s) => s.coverage > 0.05 && s.gross > 1);
  const totPay = sums.reduce((a, s) => a + s.pay, 0);
  const totHc = sums.reduce((a, s) => a + s.hcColumn, 0);
  return (
    <div className="flex flex-col gap-2">
      <Table
        aria-label="Zone summary"
        className="table-fixed text-[0.8rem]! [&_td]:px-1! [&_td]:py-1! [&_th]:h-7! [&_th]:px-1! [&_th]:text-[0.7rem]! [&_th]:font-semibold! [&_th]:tracking-wide [&_th]:text-fg-3! [&_th]:uppercase"
      >
        <TableHeader>
          <TableHead isRowHeader className="w-[40%]">
            Zone
          </TableHead>
          <TableHead className="text-right">Pay</TableHead>
          <TableHead className="text-right">N/G</TableHead>
          <TableHead className="text-right">φ</TableHead>
          <TableHead className="text-right">Sw</TableHead>
        </TableHeader>
        <TableBody>
          {sums.map((s) => {
            const f = FORMATION_BY_ID.get(s.zone.formationId);
            return (
              <TableRow key={`${s.zone.formationId}:${s.zone.topMD}`} id={`${s.zone.formationId}:${s.zone.topMD}`}>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: f?.color }} />
                    <span className="truncate text-fg-1">{f?.name ?? s.zone.name}</span>
                  </span>
                  <span className="type-unit block truncate">
                    {fmt.n(s.zone.topMD, 0)} · {fmt.n(s.gross, 0)} m
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="type-value text-[0.8rem]!">{fmt.n(s.pay, 1)}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="type-value text-[0.8rem]!">{fmt.pct(s.ntg)}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="type-value text-[0.8rem]!">{fmt.pct(s.phiAvg, 1)}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="type-value text-[0.8rem]!">{fmt.pct(s.swAvg)}</span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Note>
        <ProvBadge prov="calculated" /> Total net pay {fmt.n(totPay, 1)} m MD · hydrocarbon column Σφ·So·h {fmt.n(totHc, 2)} m. Along-hole values in a horizontal well are not true vertical thickness.
      </Note>
    </div>
  );
}

/** Correlation of the live interpretation with the operator's CPI, sample by sample. */
function CpiValidation({ app }: { app: App }) {
  const w = app.engine.activeWell;
  if (!w.cpi || !w.logs || !w.petro) return null;
  const cpi = w.cpi;
  const logs = w.logs;
  const cmp = (cpiC: { values: Float32Array } | undefined, mine: Float32Array) => {
    if (!cpiC) return null;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < cpi.depth.length; i += 2) {
      const x = cpiC.values[i];
      const y = sampleCurve(logs.depth, mine, cpi.depth[i]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        a.push(x);
        b.push(y);
      }
    }
    if (a.length < 20) return null;
    const ma = a.reduce((s, v) => s + v, 0) / a.length;
    const mb = b.reduce((s, v) => s + v, 0) / b.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < a.length; i++) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) ** 2;
      sbb += (b[i] - mb) ** 2;
    }
    return { r: sab / Math.sqrt(saa * sbb), bias: mb - ma };
  };
  const cs = cmp(cpi.curves.get('SW'), w.petro.sw.values);
  const cp = cmp(cpi.curves.get('PHIF'), w.petro.phie.values);
  const pu = (b: number) => `bias ${b >= 0 ? '+' : ''}${(b * 100).toFixed(1)} pu`;
  return (
    <div className="flex flex-col gap-2">
      <StatGroup className="grid-cols-2">
        {cs && (
          <Stat size="sm">
            <StatLabel>Sw correlation</StatLabel>
            <StatValue>r = {cs.r.toFixed(2)}</StatValue>
            <StatHelp>{pu(cs.bias)}</StatHelp>
          </Stat>
        )}
        {cp && (
          <Stat size="sm">
            <StatLabel>φ correlation</StatLabel>
            <StatValue>r = {cp.r.toFixed(2)}</StatValue>
            <StatHelp>{pu(cp.bias)}</StatHelp>
          </Stat>
        )}
      </StatGroup>
      <Note>
        <ProvBadge prov="interpreted" /> Compared sample-by-sample with {cpi.source}. The CPI Sw is the dashed violet curve in the Saturation track.
      </Note>
    </div>
  );
}

export function exportCsv(app: App) {
  const w = app.engine.activeWell;
  if (!w.logs || !w.petro) return;
  const p = w.petro;
  const lines = [`# ${w.name} — calculated interpretation (BoreWalk). Parameters: ${JSON.stringify(w.params)}`, 'DEPTH_M,VSH_CALC,PHIE_CALC,SW_CALC,SO_CALC,HCPV_CALC,NET,PAY'];
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '');
  for (let i = 0; i < w.logs.depth.length; i++) {
    if (!Number.isFinite(p.phie.values[i]) && !Number.isFinite(p.vsh.values[i])) continue;
    lines.push([w.logs.depth[i].toFixed(2), f(p.vsh.values[i]), f(p.phie.values[i]), f(p.sw.values[i]), f(p.so.values[i]), f(p.hcpv.values[i]), p.net[i], p.pay[i]].join(','));
  }
  download(`${w.name.replace(/[^\w]+/g, '_')}_interpretation.csv`, lines.join('\n'), 'text/csv');
}
