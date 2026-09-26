/*
 * The data catalog's Chart: line, area, bar, scatter, pie and composed
 * charts over a dataset, inline rows or a data-model array, drawn with
 * Recharts inside Tecton's ChartContainer (colours only from the theme's
 * chart accents, via the ChartConfig).
 */
import { memo, useMemo } from 'react';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@tecton/react/components/chart';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, Scatter, XAxis, YAxis } from 'recharts';
import type { DatasetColumn } from '../../core/types';
import { formatExact, formatNumber, formatTime } from '../data';
import { useRuntime, useRows, useText, type NodeProps } from '../runtime';
import { buildChartModel, type ChartModel } from './chartModel';
import { DataFrame, Note, PendingBlock } from './frame';

type Rec = Record<string, unknown>;

const AXIS_LABEL = { fontSize: 11, fill: 'var(--muted-foreground)' } as const;

function xTickFormatter(model: ChartModel) {
  if (model.xType === 'time') return (v: unknown) => formatTime(Number(v), model.xSpan);
  if (model.xType === 'number') return (v: unknown) => formatNumber(Number(v));
  return (v: unknown) => {
    const s = String(v ?? '');
    return s.length > 14 ? `${s.slice(0, 13)}…` : s;
  };
}

function xLabelFormatter(model: ChartModel) {
  if (model.xType === 'time') return (v: unknown) => formatTime(Number(v), 0, model.xSpan < 3 * 864e5);
  if (model.xType === 'number') return (v: unknown) => `${model.xLabel ? `${model.xLabel}: ` : ''}${formatExact(Number(v))}`;
  return (v: unknown) => String(v ?? '');
}

/** The Recharts drawing, memoised on the prepared model. */
const ChartBody = memo(function ChartBody({ model, height, yLabel, y2Label, log }: { model: ChartModel; height: number; yLabel?: string; y2Label?: string; log: boolean }) {
  const config = useMemo<ChartConfig>(() => {
    if (model.kind === 'pie')
      return Object.fromEntries(model.data.map((d, i) => [String(d.key), { label: String(d.name), color: d.other ? 'var(--muted-foreground)' : `var(--chart-${(i % 5) + 1})` }]));
        // units go into the labels only when the series disagree (the axis label carries a shared one)
    const mixed = new Set(model.series.map((s) => s.unit ?? '')).size > 1;
    return Object.fromEntries(model.series.map((s) => [s.key, { label: mixed && s.unit ? `${s.label} (${s.unit})` : s.label, color: s.color }]));
  }, [model]);

  if (!model.data.length) return <Note>No data to plot.</Note>;

  if (model.kind === 'pie')
    return (
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent className="min-w-36" nameKey="key" hideLabel />} />
          <Pie data={model.data} dataKey="value" nameKey="key" innerRadius="55%" outerRadius="85%" paddingAngle={1} strokeWidth={0} isAnimationActive={false}>
            {model.data.map((d) => (
              <Cell key={String(d.key)} fill={`var(--color-${String(d.key)})`} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="key" className="flex-wrap gap-x-3 gap-y-1 whitespace-nowrap" />} verticalAlign="bottom" />
        </PieChart>
      </ChartContainer>
    );

  const numericX = model.xType !== 'category';
  const many = model.data.length > 60;
  const showLegend = model.series.length > 1;
  const yTick = (v: unknown) => formatNumber(Number(v));
  const yAxisLabel = (value: string | undefined, right = false) =>
    value ? { value, angle: -90, position: right ? ('insideRight' as const) : ('insideLeft' as const), style: { ...AXIS_LABEL, textAnchor: 'middle' as const } } : undefined;
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <ComposedChart accessibilityLayer data={model.data} margin={{ top: 6, right: model.hasRight ? 4 : 10, left: 2, bottom: model.xLabel ? 14 : 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type={numericX && model.kind !== 'bar' ? 'number' : 'category'}
          domain={numericX ? ['dataMin', 'dataMax'] : undefined}
          scale={numericX && model.kind !== 'bar' ? 'linear' : 'auto'}
          tickFormatter={xTickFormatter(model)}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
          label={model.xLabel ? { value: model.xLabel, position: 'insideBottom', offset: -10, style: AXIS_LABEL } : undefined}
        />
        <YAxis
          yAxisId="left"
          scale={log ? 'log' : 'auto'}
          domain={log ? ['auto', 'auto'] : [model.leftZero ? 0 : 'auto', 'auto']}
          allowDataOverflow={log}
          tickFormatter={yTick}
          tickLine={false}
          axisLine={false}
          width={yLabel ? 58 : 46}
          label={yAxisLabel(yLabel)}
        />
        {model.hasRight && (
          <YAxis yAxisId="right" orientation="right" domain={[model.rightZero ? 0 : 'auto', 'auto']} tickFormatter={yTick} tickLine={false} axisLine={false} width={y2Label ? 58 : 46} label={yAxisLabel(y2Label, true)} />
        )}
        <ChartTooltip
          cursor={model.kind === 'bar' ? undefined : { strokeDasharray: '3 3' }}
          content={<ChartTooltipContent className="min-w-40" indicator={model.kind === 'bar' ? 'dot' : 'line'} labelFormatter={(_, payload) => xLabelFormatter(model)(payload?.[0]?.payload?.x)} />}
        />
        {showLegend && <ChartLegend verticalAlign="top" content={<ChartLegendContent className="flex-wrap gap-x-3 gap-y-1 whitespace-nowrap" />} />}
        {model.series.map((s) => {
          const common = { dataKey: s.key, name: s.key, yAxisId: s.axis, isAnimationActive: false } as const;
          const kind = model.kind === 'composed' ? s.kind : model.kind;
          if (kind === 'bar') return <Bar key={s.key} {...common} fill={`var(--color-${s.key})`} stackId={s.stack} radius={s.stack ? 0 : [3, 3, 0, 0]} maxBarSize={48} />;
          if (kind === 'area')
            return (
              <Area
                key={s.key}
                {...common}
                type="linear"
                stroke={`var(--color-${s.key})`}
                fill={`var(--color-${s.key})`}
                fillOpacity={s.stack ? 0.5 : 0.18}
                strokeWidth={1.5}
                stackId={s.stack}
                dot={false}
                connectNulls={false}
              />
            );
          if (kind === 'scatter') return <Scatter key={s.key} {...common} fill={`var(--color-${s.key})`} shape="circle" legendType="circle" />;
          return (
            <Line
              key={s.key}
              {...common}
              type={many ? 'linear' : 'monotone'}
              stroke={`var(--color-${s.key})`}
              strokeWidth={1.5}
              strokeDasharray={s.dashed ? '5 3' : undefined}
              dot={!many && model.data.length <= 24 ? { r: 2.5, strokeWidth: 0, fill: `var(--color-${s.key})` } : false}
              activeDot={{ r: 3.5 }}
              connectNulls={false}
            />
          );
        })}
      </ComposedChart>
    </ChartContainer>
  );
});

/** Resolves a chart's props and data, then draws it inside the toolbar frame. */
function ChartNode({ node, scope }: NodeProps) {
  const rt = useRuntime();
  const src = useRows(node, scope);
  const title = useText(node.title, scope);
  const description = useText(node.description, scope);
  const xLabel = useText(node.xLabel, scope);
  const yLabel = useText(node.yLabel, scope);
  const y2Label = useText(node.y2Label, scope);
  const height = typeof node.height === 'number' ? Math.max(120, Math.min(640, node.height)) : node.kind === 'pie' ? 240 : 260;
  const model = useMemo(
    () => buildChartModel({ ...node, xLabel: xLabel || undefined }, src.rows, src.columns),
    // node is stable while its definition is; rows are stable while their source is
    [node, xLabel, src.rows, src.columns],
  );
  if (rt.streaming && rt.surface.pending.includes(node.id)) return <PendingBlock height={height} title={title} />;
  if (src.missing) return <Note>Dataset “{src.missing}” is not available in this conversation.</Note>;
  const subtitle =
    description ||
    [src.title && src.title !== title ? src.title : '', model.reduced ? `${model.data.length.toLocaleString()} of ${model.total.toLocaleString()} points shown` : ''].filter(Boolean).join(' · ') ||
    undefined;
  const yl = yLabel || (model.series.every((s) => s.axis === 'left') ? model.yUnit : undefined);
  const exportColumns: DatasetColumn[] = src.columns.length ? src.columns : [{ key: String(node.x) }, ...model.series.map((s) => ({ key: s.column }))];
  return (
    <DataFrame title={title || undefined} subtitle={subtitle} rows={src.rows as Rec[]} columns={exportColumns} copyable>
      {(expanded) => <ChartBody model={model} height={expanded ? Math.max(height, Math.round(window.innerHeight * 0.62)) : height} yLabel={yl} y2Label={y2Label || undefined} log={node.yScale === 'log'} />}
    </DataFrame>
  );
}

export { ChartNode as Chart };
