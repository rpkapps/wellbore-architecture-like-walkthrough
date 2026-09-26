import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Kbd, KbdGroup } from '@tecton/react/components/kbd';
import { Separator } from '@tecton/react/components/separator';
import type { ReactNode } from 'react';
import type { App } from '../app';
import { Note, Section } from '../controls';
import { PROV_DESCRIPTION, ProvBadge, type Provenance } from '../prov';

function Row({ label, keys }: { label: string; keys: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <KbdGroup>{keys}</KbdGroup>
    </div>
  );
}

const k = (...keys: string[]) => keys.map((x) => <Kbd key={x}>{x}</Kbd>);
const text = (s: string) => <span className="text-xs text-muted-foreground">{s}</span>;

/** Keyboard and mouse controls, the provenance legend and the data notes. */
export function HelpDialog({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const m = app.field.meta;
  const provs: Provenance[] = ['measured', 'interpreted', 'calculated', 'reconstructed', 'schematic'];
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Controls & data notes</DialogTitle>
        <DialogDescription>
          Depths MD / TVD from {m.datum} (+{m.datumElevation} m MSL); TVDSS below MSL.
        </DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[65vh] gap-6 overflow-y-auto">
        <div className="grid gap-6 sm:grid-cols-2">
          <Section title="Guided walkthrough">
            <Row label="Play / pause" keys={k('Space')} />
            <Row label="Step along hole" keys={k('Wheel', '[', ']')} />
            <Row label="Next / previous chapter" keys={k('N', 'P')} />
            <Row label="Inside · Chase · Orbit" keys={k('1', '2', '3')} />
            <Row label="Toggle property view" keys={k('V')} />
          </Section>
          <Section title="Free explore">
            <Row label="Look (Fly)" keys={text('drag')} />
            <Row label="Move" keys={k('W', 'A', 'S', 'D')} />
            <Row label="Up / down" keys={k('E', 'Q')} />
            <Row label="Boost" keys={k('Shift')} />
            <Row label="Focus point" keys={text('double-click')} />
            <Row label="Select (Properties)" keys={text('click anything')} />
            <Row label="Its actions" keys={text('right-click')} />
            <Row label="Clear the selection" keys={k('Esc')} />
          </Section>
        </div>
        <Separator emphasis="subtle" />
        <Section title="Provenance legend">
          <ul className="flex flex-col gap-2 text-sm">
            {provs.map((p) => (
              <li key={p} className="flex items-baseline gap-2">
                <ProvBadge prov={p} className="shrink-0" />
                <span className="text-muted-foreground">{p === 'measured' ? `${PROV_DESCRIPTION[p]}: ${m.operator}.` : `${PROV_DESCRIPTION[p]}.`}</span>
              </li>
            ))}
          </ul>
          <Note>
            Coordinates: {m.crs}, local origin E {m.originE} / N {m.originN}. Near-well geometry is radially exaggerated for legibility; along-hole and vertical geometry are true scale.
          </Note>
          <Note>{m.licence}</Note>
        </Section>
      </div>
    </Dialog>
  );
}
