import { Badge } from '@tecton/react/components/badge';
import { cn } from 'cn';
import type { ReactNode } from 'react';

/** Where a value comes from; every value on screen carries one. */
export type Provenance = 'measured' | 'calculated' | 'interpreted' | 'reconstructed' | 'definitive' | 'schematic' | 'user';

const LABEL: Record<Provenance, string> = {
  measured: 'Measured',
  calculated: 'Calculated',
  interpreted: 'Operator interp.',
  reconstructed: 'Reconstructed',
  definitive: 'Definitive',
  schematic: 'Schematic',
  user: 'Uploaded',
};

const SHORT: Record<Provenance, string> = {
  measured: 'M',
  calculated: 'C',
  interpreted: 'I',
  reconstructed: 'R',
  definitive: 'M',
  schematic: 'S',
  user: 'U',
};

export const PROV_DESCRIPTION: Record<Provenance, string> = {
  measured: 'Acquired by logging / survey tools or gauges, as delivered by the operator',
  definitive: 'Definitive directional survey, as delivered by the operator',
  interpreted: 'Operator interpretation: formation picks, Equinor CPI',
  calculated: 'Computed live in this app from measured inputs and editable parameters',
  reconstructed: 'Geometry derived from other data (trajectories through pick coordinates, casing from bit size)',
  schematic: 'Illustrative only (natural fractures, cement placement, platform model)',
  user: 'Uploaded in this browser',
};

/** Tecton palette pairs for the provenance categories (a category colour no Badge variant carries). */
const TONE: Record<Provenance, string> = {
  measured: 'bg-azure-120 text-azure-830',
  definitive: 'bg-azure-120 text-azure-830',
  calculated: 'bg-saffron-120 text-saffron-830',
  interpreted: 'bg-violet-120 text-violet-830',
  reconstructed: 'bg-green-120 text-green-830',
  schematic: 'bg-graphite-120 text-graphite-830',
  user: 'bg-pink-120 text-pink-830',
};

/** Solid palette step per provenance, for dots and key marks next to a value. */
export const PROV_DOT: Record<Provenance, string> = {
  measured: 'bg-azure-560',
  definitive: 'bg-azure-560',
  calculated: 'bg-saffron-560',
  interpreted: 'bg-violet-560',
  reconstructed: 'bg-green-560',
  schematic: 'bg-graphite-560',
  user: 'bg-pink-560',
};

export function isProvenance(p: string | undefined): p is Provenance {
  return !!p && p in LABEL;
}

/** Provenance label. `short` prints the one-letter code (M, C, I …) for dense rows. */
export function ProvBadge({ prov, short, children, className }: { prov: Provenance; short?: boolean; children?: ReactNode; className?: string }) {
  // quiet: a small tinted tag, never louder than the data it qualifies
  return (
    <Badge
      variant="secondary"
      className={cn(TONE[prov], 'h-4! rounded-sm! px-1! text-[0.68rem]! leading-none font-semibold! tracking-wide', short && 'w-4! justify-center px-0!', className)}
      title={PROV_DESCRIPTION[prov]}
    >
      {children ?? (short ? SHORT[prov] : LABEL[prov])}
    </Badge>
  );
}
