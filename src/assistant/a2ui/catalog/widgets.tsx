/*
 * The data catalog's small pieces: Metric (a KPI tile with an optional
 * sparkline) and MetricGroup, KeyValue, Badge, Callout, Progress and Code.
 */
import { useMemo } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Badge } from '@tecton/react/components/badge';
import { CopyButton } from '@tecton/react/tecton/copy-button';
import { Meter } from '@tecton/react/tecton/meter';
import { Stat, StatDelta, StatGroup, StatHelp, StatLabel, StatValue } from '@tecton/react/tecton/stat';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { formatExact, formatNumber, lttbIndices, num } from '../data';
import { resolveText, resolveValue } from '../functions';
import { InlineMarkdown } from '../markdown';
import { useEval, useRows, useText, useValue, type NodeProps } from '../runtime';
import { Children } from './basic';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A value for display: numbers formatted (compact when large), anything else as text. */
function display(v: unknown, digits?: number): string {
  const n = typeof v === 'number' ? v : null;
  if (n !== null) return Math.abs(n) >= 1e5 && digits === undefined ? formatNumber(n) : formatExact(n, digits);
  if (v === null || v === undefined) return '–';
  return String(v);
}

function Sparkline({ spec, scope }: { spec: Rec; scope: string }) {
  const src = useRows(spec, scope);
  const column = typeof spec.column === 'string' ? spec.column : '';
  const x = typeof spec.x === 'string' ? spec.x : undefined;
  const path = useMemo(() => {
    const pts: [number, number][] = [];
    src.rows.forEach((r, i) => {
      const y = num(r[column]);
      const xv = x ? num(r[x]) : i;
      if (y !== null && xv !== null) pts.push([xv, y]);
    });
    if (pts.length < 2) return null;
    if (x) pts.sort((a, b) => a[0] - b[0]);
    const keep = lttbIndices(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
      120,
    ).map((i) => pts[i]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of keep) {
      x0 = Math.min(x0, a);
      x1 = Math.max(x1, a);
      y0 = Math.min(y0, b);
      y1 = Math.max(y1, b);
    }
    const w = 100;
    const h = 28;
    const sx = (v: number) => ((v - x0) / (x1 - x0 || 1)) * w;
    const sy = (v: number) => h - 2 - ((v - y0) / (y1 - y0 || 1)) * (h - 4);
    const line = keep.map(([a, b], i) => `${i ? 'L' : 'M'}${sx(a).toFixed(2)},${sy(b).toFixed(2)}`).join('');
    return { line, area: `${line}L${w},${h}L0,${h}Z` };
  }, [src.rows, column, x]);
  if (!path) return null;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="mt-1 h-7 w-full" aria-hidden="true">
      <path d={path.area} fill="var(--chart-1)" fillOpacity={0.12} />
      <path d={path.line} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ node, scope }: NodeProps) {
  const ctx = useEval(scope);
  const label = useText(node.label, scope);
  const value = useValue(node.value, scope);
  const unit = useText(node.unit, scope);
  const caption = useText(node.caption, scope);
  const deltaRaw = node.delta === undefined ? undefined : resolveValue(node.delta, ctx);
  const digits = typeof node.digits === 'number' ? node.digits : undefined;
  const deltaNum = typeof deltaRaw === 'number' ? deltaRaw : typeof deltaRaw === 'string' ? parseFloat(deltaRaw.replace(/[^\d.+-]/g, '')) : NaN;
  const trend = node.trend === 'up' || node.trend === 'down' || node.trend === 'flat' ? node.trend : Number.isNaN(deltaNum) || deltaNum === 0 ? 'flat' : deltaNum > 0 ? 'up' : 'down';
  const tone = node.deltaTone === 'good' ? 'positive' : node.deltaTone === 'bad' ? 'negative' : node.deltaTone === 'neutral' ? 'neutral' : undefined;
  const deltaText = typeof deltaRaw === 'number' ? `${deltaRaw > 0 ? '+' : ''}${formatExact(deltaRaw)}` : deltaRaw === undefined || deltaRaw === null ? '' : String(deltaRaw);
  const size = node.size === 'sm' || node.size === 'lg' ? node.size : 'md';
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border-subtle bg-card p-3">
      <Stat size={size}>
        <StatLabel>{label}</StatLabel>
        <StatValue unit={unit || undefined}>{display(value, digits)}</StatValue>
        {deltaText && (
          <StatDelta trend={trend} tone={tone}>
            {deltaText}
          </StatDelta>
        )}
        {caption && <StatHelp>{caption}</StatHelp>}
      </Stat>
      {isRec(node.sparkline) && <Sparkline spec={node.sparkline} scope={scope} />}
    </div>
  );
}

function MetricGroup({ node, scope, trail }: NodeProps) {
  return (
    <StatGroup className="gap-2">
      <Children list={node.children} scope={scope} trail={trail} />
    </StatGroup>
  );
}

function KeyValue({ node, scope }: NodeProps) {
  const ctx = useEval(scope);
  const title = useText(node.title, scope);
  const items = (Array.isArray(node.items) ? node.items : []).filter(isRec);
  const two = node.columns === 2 && items.length > 3;
  return (
    <div className="flex flex-col gap-1.5">
      {title && <span className="text-sm font-semibold text-foreground">{title}</span>}
      <dl className={two ? 'grid grid-cols-1 gap-x-6 sm:grid-cols-2' : 'grid grid-cols-1'}>
        {items.map((it, i) => {
          const v = resolveValue(it.value, ctx);
          const unit = resolveText(it.unit, ctx);
          return (
            <div key={i} className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-1.5 text-sm last:border-b-0">
              <dt className="min-w-0 truncate text-muted-foreground">{resolveText(it.label, ctx)}</dt>
              <dd className="text-right font-medium text-foreground tabular-nums">
                {typeof v === 'number' ? display(v) : <InlineMarkdown text={display(v)} />}
                {unit && <span className="ml-1 font-normal text-muted-foreground">{unit}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

const BADGE_VARIANT = { neutral: 'secondary', info: 'info', success: 'success', warning: 'warning', danger: 'destructive' } as const;
type Tone = keyof typeof BADGE_VARIANT;
const toneOf = (v: unknown): Tone => (typeof v === 'string' && v in BADGE_VARIANT ? (v as Tone) : 'neutral');

function BadgeNode({ node, scope }: NodeProps) {
  const text = useText(node.text, scope);
  return (
    <span className="inline-flex">
      <Badge variant={BADGE_VARIANT[toneOf(node.tone)]}>{text}</Badge>
    </span>
  );
}

const ALERT_VARIANT = { neutral: 'default', info: 'info', success: 'success', warning: 'warning', danger: 'destructive' } as const;
const ALERT_ICON = { neutral: Info, info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const;

function Callout({ node, scope }: NodeProps) {
  const title = useText(node.title, scope);
  const text = useText(node.text, scope);
  const tone = toneOf(node.tone);
  const Icon = ALERT_ICON[tone];
  return (
    <Alert variant={ALERT_VARIANT[tone]}>
      <Icon />
      {title && <AlertTitle>{title}</AlertTitle>}
      {text && (
        <AlertDescription>
          <InlineMarkdown text={text} />
        </AlertDescription>
      )}
    </Alert>
  );
}

const METER_COLOR = { neutral: 'default', info: 'info', success: 'success', warning: 'warning', danger: 'error' } as const;

function Progress({ node, scope }: NodeProps) {
  const value = Number(useValue(node.value, scope)) || 0;
  const maxRaw = Number(useValue(node.max, scope));
  const max = maxRaw > 0 ? maxRaw : 100;
  const label = useText(node.label, scope);
  const pct = Math.round((Math.min(max, Math.max(0, value)) / max) * 100);
  return (
    <Meter
      label={label || undefined}
      aria-label={label ? undefined : 'Progress'}
      value={Math.min(max, Math.max(0, value))}
      minValue={0}
      maxValue={max}
      segments={1}
      color={METER_COLOR[toneOf(node.tone)]}
      showValue={node.showValue !== false}
      valueLabel={max === 100 ? `${pct}%` : `${formatExact(value)} / ${formatExact(max)}`}
    />
  );
}

function Code({ node, scope }: NodeProps) {
  const code = useText(node.code, scope);
  const title = useText(node.title, scope);
  const language = typeof node.language === 'string' ? node.language : '';
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-muted">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle py-1 pr-1 pl-3">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{title || language || 'code'}</span>
        <CopyButton value={code} variant="ghost" size="icon-xs" aria-label="Copy code" />
      </div>
      <pre className="max-h-80 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The data catalog's small components, by type name. */
export const WIDGET_COMPONENTS = { Metric, MetricGroup, KeyValue, Badge: BadgeNode, Callout, Progress, Code };
