import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const BINS = 40;

export interface ScrubHistogram {
  values: ArrayLike<number> | null;
  /** which side of the value is kept (drawn in the accent) */
  keep: 'below' | 'above';
  tone?: 'pay' | 'shale';
}

/**
 * A number as one compact bar (Figma / Blender style): the label on the left,
 * the value on the right and a fill showing where it sits in its range. Drag
 * sideways anywhere on it to scrub (Shift for fine steps), click it to type a
 * value, or use the arrow keys (Shift: ×10). With `histogram`, the samples the
 * value acts on are drawn faintly inside the bar.
 */
export function ScrubField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  log,
  format = (v) => String(v),
  unit,
  histogram,
  isDisabled,
  end,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  /** logarithmic range */
  log?: boolean;
  format?: (v: number) => string;
  unit?: string;
  histogram?: ScrubHistogram;
  isDisabled?: boolean;
  /** shown after the bar, e.g. an info button */
  end?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; t: number; w: number; moved: boolean } | null>(null);
  const dec = Math.max(0, -Math.floor(Math.log10(step)));
  const toT = (v: number) => {
    const c = Math.max(min, Math.min(max, v));
    return log ? (Math.log10(c) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)) : (c - min) / (max - min);
  };
  const fromT = (t: number) => {
    const u = Math.max(0, Math.min(1, t));
    const v = log ? Math.pow(10, Math.log10(min) + u * (Math.log10(max) - Math.log10(min))) : min + u * (max - min);
    return snap(v);
  };
  const snap = (v: number) => {
    const s = log ? Number(v.toPrecision(3)) : Math.round(v / step) * step;
    return Number(Math.max(min, Math.min(max, s)).toFixed(log ? Math.max(dec, 4) : dec));
  };
  const t = toT(value);
  // pointer moves arrive faster than frames: apply the latest one per frame
  const emit = useFrameThrottle(onChange);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDisabled || editing || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // the width once per gesture: reading layout on every move can force it while the page restyles
    drag.current = { x: e.clientX, t, w: e.currentTarget.clientWidth || 1, moved: false };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    emit.push(fromT(d.t + (dx / d.w) * (e.shiftKey ? 0.1 : 1)));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    emit.flush();
    if (d && !d.moved) setEditing(true);
  };
  const key = (e: KeyboardEvent) => {
    if (isDisabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      setEditing(true);
      return;
    }
    const k = e.shiftKey ? 10 : 1;
    const inc = log ? (v: number, d: number) => fromT(toT(v) + d * 0.01 * k) : (v: number, d: number) => snap(v + d * step * k);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? inc(value, 1) : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? inc(value, -1) : e.key === 'Home' ? min : e.key === 'End' ? max : null;
    if (to === null) return;
    e.preventDefault();
    onChange(to);
  };

  return (
    <div className="flex min-w-0 items-center gap-1" data-disabled={isDisabled || undefined}>
      <div
        ref={bar}
        role="slider"
        tabIndex={isDisabled ? -1 : 0}
        aria-label={typeof label === 'string' ? label : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${format(value)}${unit ? ` ${unit}` : ''}`}
        aria-disabled={isDisabled || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = null;
          emit.flush();
        }}
        onKeyDown={key}
        className="group/scrub relative h-7 min-w-0 flex-1 cursor-ew-resize touch-none overflow-hidden rounded-md bg-muted/70 outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:opacity-50"
      >
        {histogram && <Bars h={histogram} min={min} max={max} t={t} />}
        <div aria-hidden className="absolute inset-y-0 left-0 bg-fg-1/[0.07] group-hover/scrub:bg-fg-1/[0.1]" style={{ width: `${t * 100}%` }} />
        <div aria-hidden className="absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ui-accent" style={{ left: `max(1px, min(calc(100% - 1px), ${t * 100}%))` }} />
        <div className="relative flex h-full items-center justify-between gap-2 px-2">
          <span className="type-label min-w-0 truncate">{label}</span>
          {editing ? (
            <Editor
              value={value}
              onDone={(v) => {
                setEditing(false);
                if (v !== null) onChange(Math.max(min, Math.min(max, v)));
                bar.current?.focus();
              }}
            />
          ) : (
            <span className="type-value shrink-0">
              {format(value)}
              {unit && <span className="type-unit ml-1">{unit}</span>}
            </span>
          )}
        </div>
      </div>
      {end}
    </div>
  );
}

function Editor({ value, onDone }: { value: number; onDone: (v: number | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(value));
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const v = parseFloat(text);
    onDone(Number.isFinite(v) ? v : null);
  };
  return (
    <input
      ref={ref}
      value={text}
      inputMode="decimal"
      aria-label="Value"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone(null);
      }}
      className="type-value w-20 rounded-sm bg-background px-1 text-right outline-none ring-1 ring-ui-accent"
    />
  );
}

/** The samples the value acts on, binned over the range; the kept side in the accent. */
function Bars({ h, min, max, t }: { h: ScrubHistogram; min: number; max: number; t: number }) {
  const bins = useMemo(() => {
    const c = new Float64Array(BINS);
    const vs = h.values;
    if (!vs) return c;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (!Number.isFinite(v)) continue;
      const b = Math.floor(((v - min) / (max - min)) * BINS);
      if (b >= 0 && b < BINS) c[b]++;
    }
    let top = 0;
    for (let i = 0; i < BINS; i++) top = Math.max(top, (c[i] = Math.sqrt(c[i])));
    if (top > 0) for (let i = 0; i < BINS; i++) c[i] /= top;
    return c;
  }, [h.values, min, max]);
  const kept = h.tone === 'shale' ? 'fill-fg-2/35' : 'fill-saffron-560/55';
  return (
    <svg aria-hidden viewBox={`0 0 ${BINS} 1`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-full w-full">
      {Array.from(bins, (b, i) => {
        const on = h.keep === 'below' ? (i + 0.5) / BINS <= t : (i + 0.5) / BINS >= t;
        return b > 0 ? <rect key={i} x={i + 0.12} y={1 - b * 0.85} width={0.76} height={b * 0.85} className={on ? kept : 'fill-fg-3/18'} /> : null;
      })}
    </svg>
  );
}

/**
 * A scrub bar small enough to sit inside a list row (opacity of a layer):
 * the value as text over a fill; drag sideways or use the arrow keys.
 */
export function ScrubChip({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const drag = useRef<{ x: number; v: number } | null>(null);
  const emit = useFrameThrottle(onChange);
  const t = (Math.max(min, Math.min(max, value)) - min) / (max - min);
  const snap = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format(value)}
      title={`${label}: drag to change`}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // the whole range over ~140 px of travel
        emit.push(snap(d.v + ((e.clientX - d.x) / 140) * (max - min) * (e.shiftKey ? 0.2 : 1)));
      }}
      onPointerUp={() => {
        drag.current = null;
        emit.flush();
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const k = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!k) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(snap(value + k * step * (e.shiftKey ? 5 : 1)));
      }}
      className="relative h-[18px] w-11 shrink-0 cursor-ew-resize touch-none overflow-hidden rounded-sm bg-muted/80 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div aria-hidden className="absolute inset-y-0 left-0 border-r-2 border-ui-accent bg-fg-1/[0.09]" style={{ width: `${t * 100}%` }} />
      <span className="type-value relative flex h-full items-center justify-center text-[0.72rem]! leading-none!">{format(value)}</span>
    </div>
  );
}

/** Calls `fn` with the latest pushed value at most once per animation frame; `flush` applies a pending one now. */
function useFrameThrottle(fn: (v: number) => void) {
  const ref = useRef({ fn, raf: 0, pending: null as number | null });
  ref.current.fn = fn;
  return useMemo(() => {
    const st = ref.current;
    const run = () => {
      st.raf = 0;
      const v = st.pending;
      st.pending = null;
      if (v !== null) st.fn(v);
    };
    return {
      push(v: number) {
        st.pending = v;
        if (!st.raf) st.raf = requestAnimationFrame(run);
      },
      flush() {
        if (st.raf) cancelAnimationFrame(st.raf);
        run();
      },
    };
  }, []);
}
