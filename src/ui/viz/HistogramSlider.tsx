import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

const H = 34;
const BARS_H = 22;
const TRACK_Y = H - 5;
const BINS = 44;
const PAD = 6;

/**
 * A slider drawn over the distribution of the data it acts on: the bars are
 * the well's samples binned over the slider's range, and the ones on the
 * passing side of the value are highlighted, so moving a cut-off shows at
 * once how much of the well it keeps.
 */
export function HistogramSlider({
  label,
  values,
  min,
  max,
  value,
  step,
  onChange,
  keep,
  tone = 'pay',
  format = (v) => String(v),
}: {
  label: string;
  values: ArrayLike<number> | null;
  min: number;
  max: number;
  value: number;
  step: number;
  onChange: (v: number) => void;
  /** which side of the value is kept (highlighted) */
  keep: 'below' | 'above';
  tone?: 'pay' | 'shale';
  format?: (v: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const bins = useMemo(() => {
    const c = new Float64Array(BINS);
    if (!values) return c;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      const b = Math.floor(((v - min) / (max - min)) * BINS);
      if (b >= 0 && b < BINS) c[b]++;
    }
    // square root keeps the thin tails visible next to the main mode
    let top = 0;
    for (let i = 0; i < BINS; i++) top = Math.max(top, (c[i] = Math.sqrt(c[i])));
    if (top > 0) for (let i = 0; i < BINS; i++) c[i] /= top;
    return c;
  }, [values, min, max]);

  const span = Math.max(1, W - 2 * PAD);
  const x = (v: number) => PAD + ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * span;
  const snap = (v: number) => {
    const s = Math.round(v / step) * step;
    return Number(Math.max(min, Math.min(max, s)).toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
  };
  const at = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    onChange(snap(min + ((ev.clientX - r.left - PAD) / span) * (max - min)));
  };
  const key = (e: KeyboardEvent) => {
    const big = (max - min) / 10;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'PageUp' ? big : e.key === 'PageDown' ? -big : 0;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      onChange(e.key === 'Home' ? min : max);
      return;
    }
    if (!d) return;
    e.preventDefault();
    onChange(snap(value + d));
  };

  const vx = x(value);
  const bw = span / BINS;
  const kept = tone === 'pay' ? 'fill-saffron-560' : 'fill-graphite-460';
  return (
    <div ref={box} className="w-full" style={{ height: H }}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={format(value)}
          onKeyDown={key}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            at(e);
          }}
          onPointerMove={(e) => e.buttons && at(e)}
          className="group/hs block cursor-ew-resize touch-none rounded-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {Array.from(bins, (b, i) => {
            const cx = PAD + (i + 0.5) * bw;
            const on = keep === 'below' ? cx <= vx : cx >= vx;
            const h = b > 0 ? Math.max(1.5, b * BARS_H) : 0;
            return <rect key={i} x={PAD + i * bw + 0.5} y={TRACK_Y - 3 - h} width={Math.max(1, bw - 1)} height={h} rx={0.75} className={on ? kept : 'fill-muted-foreground/30'} />;
          })}
          <rect x={PAD} y={TRACK_Y - 1} width={span} height={2} rx={1} className="fill-muted" />
          <rect x={keep === 'below' ? PAD : vx} y={TRACK_Y - 1} width={keep === 'below' ? vx - PAD : PAD + span - vx} height={2} rx={1} className={kept} />
          <line x1={vx} x2={vx} y1={2} y2={TRACK_Y} strokeWidth={1.5} className="stroke-foreground" />
          <circle cx={vx} cy={TRACK_Y} r={5} strokeWidth={2} className="fill-foreground stroke-card" />
        </svg>
      )}
    </div>
  );
}
