import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@tecton/react/components/chart';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@tecton/react/components/empty';
import { Separator } from '@tecton/react/components/separator';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@tecton/react/components/sheet';
import { Stat, StatGroup, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import { Bar, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from 'recharts';
import { toMonthly } from '../../data/csv';
import type { ProductionRecord } from '../../data/types';
import type { App } from '../app';
import { Note, Section } from '../controls';
import { fmt } from '../dom';
import { isProvenance, ProvBadge } from '../prov';
import { useRev } from '../signal';

const rateConfig = {
  oil: { label: 'Oil', color: 'var(--chart-2)' },
  water: { label: 'Water', color: 'var(--chart-4)' },
  inj: { label: 'Water injected', color: 'var(--chart-3)' },
  cum: { label: 'Cum. oil', color: 'var(--foreground)' },
} satisfies ChartConfig;

const gaugeConfig = {
  bhp: { label: 'BHP (bar)', color: 'var(--chart-5)' },
  bht: { label: 'BHT (°C)', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const days = (x: ProductionRecord) => new Date(Date.UTC(new Date(x.t).getUTCFullYear(), new Date(x.t).getUTCMonth() + 1, 0)).getUTCDate();
const month = (t?: number) => (t ? new Date(t).toISOString().slice(0, 7) : '—');

/** Reported production of the active well: totals, monthly rates and the downhole gauge. */
export function ProductionSheet({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet side="right" isOpen={isOpen} onOpenChange={onOpenChange} className="data-[side=right]:sm:max-w-2xl">
      <SheetHeader>
        <SheetTitle>Production history</SheetTitle>
        <SheetDescription>Reported volumes, standard conditions</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <Body app={app} />
      </div>
    </Sheet>
  );
}

function Body({ app }: { app: App }) {
  useRev(app.wellRev);
  const w = app.engine.activeWell;
  const series = w.production;
  const r = series ? toMonthly(series) : w.productionMonthly;
  if (!r.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No production data</EmptyTitle>
          <EmptyDescription>No production data is associated with {w.name}. Upload a production CSV (date + oil / gas / water columns) from the Data manager to attach one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  const cumOil = r.reduce((s, x) => s + x.oil, 0);
  const cumGas = r.reduce((s, x) => s + x.gas, 0);
  const cumWat = r.reduce((s, x) => s + x.water, 0);
  const cumWi = r.reduce((s, x) => s + x.waterInj, 0);
  const peak = r.reduce((a, x) => Math.max(a, x.oil / days(x)), 0);
  const first = r.find((x) => x.oil > 0);
  const last = [...r].reverse().find((x) => x.oil > 0 || x.waterInj > 0);
  const wc = cumWat / Math.max(1, cumWat + cumOil);
  let cum = 0;
  const rows = r.map((x) => {
    const d = days(x);
    cum += x.oil;
    return { month: month(x.t), oil: x.oil / d, water: x.water / d, inj: x.waterInj / d, cum, bhp: x.bhp ?? null, bht: x.bht ?? null };
  });
  const years = rows.filter((x, i) => i === 0 || x.month.endsWith('-01')).map((x) => x.month);
  const hasGauge = rows.some((x) => x.bhp !== null && Number.isFinite(x.bhp));
  const prov = series?.provenance;
  return (
    <>
      <Section title={series?.wellName ?? w.productionWell ?? w.name} aside={<ProvBadge prov={isProvenance(prov) ? prov : 'measured'} />}>
        <Note>
          {series?.source ?? 'Equinor Volve monthly production'} · {month(first?.t)} → {month(last?.t)}
        </Note>
        <StatGroup className="grid-cols-4">
          <Stat size="sm">
            <StatLabel>Cum. oil</StatLabel>
            <StatValue unit="Sm³">{fmt.big(cumOil)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Cum. gas</StatLabel>
            <StatValue unit="Sm³">{fmt.big(cumGas)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Cum. water</StatLabel>
            <StatValue unit="Sm³">{fmt.big(cumWat)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Peak oil</StatLabel>
            <StatValue unit="Sm³/d">{fmt.n(peak, 0)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Water cut (cum.)</StatLabel>
            <StatValue>{fmt.pct(wc, 1)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>GOR (cum.)</StatLabel>
            <StatValue unit="Sm³/Sm³">{fmt.n(cumGas / Math.max(1, cumOil), 0)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Water injected</StatLabel>
            <StatValue unit="Sm³">{fmt.big(cumWi)}</StatValue>
          </Stat>
          <Stat size="sm">
            <StatLabel>Months</StatLabel>
            <StatValue>{r.length}</StatValue>
          </Stat>
        </StatGroup>
      </Section>
      <Separator emphasis="subtle" />
      <Section title="Monthly rates · cumulative oil">
        <ChartContainer config={rateConfig} className="h-64 w-full">
          <ComposedChart accessibilityLayer data={rows} margin={{ left: 0, right: 0, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" ticks={years} tickFormatter={(m: string) => m.slice(0, 4)} tickLine={false} axisLine={false} />
            <YAxis yAxisId="rate" tickFormatter={(v: number) => fmt.big(v)} tickLine={false} axisLine={false} width={56} />
            <YAxis yAxisId="cum" orientation="right" tickFormatter={(v: number) => fmt.big(v)} tickLine={false} axisLine={false} width={56} />
            <ChartTooltip content={<ChartTooltipContent formatter={rateTip} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar yAxisId="rate" dataKey="oil" stackId="rate" fill="var(--color-oil)" isAnimationActive={false} />
            <Bar yAxisId="rate" dataKey="water" stackId="rate" fill="var(--color-water)" isAnimationActive={false} />
            <Line yAxisId="rate" dataKey="inj" stroke="var(--color-inj)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line yAxisId="cum" dataKey="cum" stroke="var(--color-cum)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      </Section>
      <Section title="Downhole gauge (monthly mean)">
        {hasGauge ? (
          <ChartContainer config={gaugeConfig} className="h-44 w-full">
            <LineChart accessibilityLayer data={rows} margin={{ left: 0, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" ticks={years} tickFormatter={(m: string) => m.slice(0, 4)} tickLine={false} axisLine={false} />
              <YAxis yAxisId="p" domain={['dataMin - 10', 'dataMax + 10']} tickFormatter={(v: number) => fmt.n(v, 0)} tickLine={false} axisLine={false} width={56} />
              <YAxis yAxisId="t" orientation="right" domain={['dataMin - 2', 'dataMax + 2']} tickFormatter={(v: number) => fmt.n(v, 0)} tickLine={false} axisLine={false} width={56} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line yAxisId="p" dataKey="bhp" stroke="var(--color-bhp)" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
              <Line yAxisId="t" dataKey="bht" stroke="var(--color-bht)" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        ) : (
          <Note>No downhole gauge data.</Note>
        )}
      </Section>
      <Note>Volumes are the operator-reported, allocated well volumes from the Volve production database (NPD reporting). Production for the F-11 wellbores is reported at the well level (NPD wellbore 15/9-F-11).</Note>
    </>
  );
}

function rateTip(value: unknown, name: unknown) {
  const v = Number(value);
  const label = rateConfig[name as keyof typeof rateConfig]?.label ?? String(name);
  return (
    <span className="flex w-full justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{name === 'cum' ? `${fmt.big(v)} Sm³` : `${fmt.n(v, 0)} Sm³/d`}</span>
    </span>
  );
}
