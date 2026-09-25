import { fmt } from '../dom';

/**
 * Pore space in the pay as a ring: oil (So) against water (Sw), with the
 * average porosity as the inner arc.
 */
export function FluidDonut({ sw, phi, size = 76 }: { sw: number; phi: number; size?: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const so = Number.isFinite(sw) ? Math.max(0, Math.min(1, 1 - sw)) : 0;
  const ri = 22;
  const ci = 2 * Math.PI * ri;
  const p = Number.isFinite(phi) ? Math.max(0, Math.min(1, phi / 0.35)) : 0;
  return (
    <svg
      viewBox="0 0 76 76"
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label={`Pore space in pay: ${fmt.pct(so, 0)} oil, ${fmt.pct(sw, 0)} water; average porosity ${fmt.pct(phi, 1)}`}
    >
      <g transform="rotate(-90 38 38)">
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="7" className="stroke-azure-460" />
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="7" strokeDasharray={`${so * c} ${c}`} className="stroke-saffron-560" />
        <circle cx="38" cy="38" r={ri} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle cx="38" cy="38" r={ri} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${p * ci} ${ci}`} className="stroke-foreground/70" />
      </g>
      <text x="38" y="37" textAnchor="middle" fontSize="13" fontWeight="600" className="fill-foreground font-mono">
        {fmt.pct(so, 0)}
      </text>
      <text x="38" y="48" textAnchor="middle" fontSize="7.5" fontWeight="600" letterSpacing=".08em" className="fill-saffron-560">
        OIL
      </text>
    </svg>
  );
}
