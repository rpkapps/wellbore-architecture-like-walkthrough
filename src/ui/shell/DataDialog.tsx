import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tecton/react/components/accordion';
import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@tecton/react/components/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@tecton/react/components/item';
import { RadioGroup, RadioGroupItem } from '@tecton/react/components/radio-group';
import { Separator } from '@tecton/react/components/separator';
import { Link } from '@tecton/react/tecton/link';
import { CircleCheckIcon, CircleXIcon, DownloadIcon, InfoIcon, RadioTowerIcon, UploadIcon } from 'lucide-react';
import { Fragment, useId, type ReactNode } from 'react';
import { DropZone, FileTrigger } from 'react-aria-components';
import type { App } from '../app';
import { Note, Section } from '../controls';
import type { DepthUnit, Target } from '../dataImport';
import { download } from '../dom';
import { GUIDE, TEMPLATES } from '../importGuide';
import { ProvBadge, isProvenance, type Provenance } from '../prov';
import { useRev, useSignal } from '../signal';

const ACCEPT = ['.las', '.LAS', '.csv', '.txt', '.asc', '.xlsx', '.bwsim', '.gz'];

/** Static guide text carries <code> and <b> spans. */
function rich(s: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /<(code|b)>(.*?)<\/\1>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, m.index));
    out.push(
      m[1] === 'code' ? (
        <code key={m.index} className="rounded-sm bg-muted px-1 font-mono text-xs text-foreground">
          {m[2]}
        </code>
      ) : (
        <b key={m.index} className="font-medium text-foreground">
          {m[2]}
        </b>
      ),
    );
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out.map((x, i) => (typeof x === 'string' ? <Fragment key={`t${i}`}>{x}</Fragment> : x));
}

/** The data behind the active well, uploads, and where to get more real data. */
export function DataDialog({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Data manager</DialogTitle>
        <DialogDescription>Preloaded public data · your uploads stay in this browser</DialogDescription>
      </DialogHeader>
      <div className="-mx-6 flex max-h-[70vh] flex-col gap-6 overflow-y-auto px-6">
        <ActiveDataset app={app} />
        <Upload app={app} />
        <Section title="Live and streamed data">
          <p className="type-caption">
            Connect APIs, WebSockets, MQTT, or — through the BoreWalk relay — Kafka, WITSML stores, ETP servers, OSDU and WITS rig feeds. Data is read in the background, previewed first, and wells
            grow as it arrives. Large files can be read this way too, in any of the supported formats (DLIS, WITSML, Parquet, Arrow, Avro and more).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onPress={() => {
                app.dataOpen.set(false);
                app.connectRequest.set({});
              }}
            >
              <RadioTowerIcon data-icon="inline-start" />
              Connect a source…
            </Button>
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                app.dataOpen.set(false);
                void app.actions.run('data.replay', { speed: 60 });
              }}
            >
              Replay a well live
            </Button>
          </div>
        </Section>
        <Separator emphasis="subtle" />
        <ImportGuide />
        <Section title="Sources & licence">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {app.field.meta.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <Note>{app.field.meta.licence}</Note>
        </Section>
      </div>
    </Dialog>
  );
}

function ActiveDataset({ app }: { app: App }) {
  useRev(app.wellRev);
  const w = app.engine.activeWell;
  const f = app.field;
  const rows: [string, string, Provenance][] = [];
  rows.push([
    w.logs?.source ?? '—',
    w.logs ? `${w.logs.curves.size} curves · ${w.logs.depth[0].toFixed(1)}–${w.logs.depth[w.logs.depth.length - 1].toFixed(1)} m MD` : 'no logs',
    provOf(w.logs?.provenance, 'measured'),
  ]);
  if (w.cpi) rows.push([w.cpi.source, `${w.cpi.curves.size} curves (SW, PHIF, VSH, KLOGH…)`, 'interpreted']);
  rows.push([w.trajectory.source, w.trajectory.note, w.trajectory.status === 'reconstructed' ? 'reconstructed' : w.trajectory.status === 'user' ? 'user' : 'measured']);
  rows.push([
    [...new Set(w.tops.map((t) => t.source))].join(', ') || 'no formation tops',
    `${w.tops.length} tops for this wellbore · regional model uses ${f.picks.length} picks across ${new Set(f.picks.map((p) => p.well)).size} wellbores`,
    provOf(w.tops[0]?.provenance, 'interpreted'),
  ]);
  if (w.production) rows.push([w.production.source, `${w.production.records.length} ${w.production.period} records`, provOf(w.production.provenance, 'measured')]);
  rows.push(['Structural surfaces', `${f.horizons.length} horizons interpolated from picks`, 'interpreted']);
  rows.push(['Casing & hole geometry', 'inferred from bit-size log', 'reconstructed']);
  rows.push(['Natural fractures', 'illustrative — no image log in package', 'schematic']);
  return (
    <Section title={`Active dataset — ${w.name}`} aside={<span className="text-xs text-muted-foreground">{f.meta.crs}</span>}>
      <ItemGroup aria-label="Files of the active well" className="gap-1.5">
        {rows.map(([file, detail, prov], i) => (
          <Item key={i} variant="outline" size="xs" role="listitem">
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full">
                <span className="truncate">{file}</span>
              </ItemTitle>
              <ItemDescription>{detail}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ProvBadge prov={prov} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Section>
  );
}

function provOf(p: string | undefined, fallback: Provenance): Provenance {
  return isProvenance(p) ? p : fallback;
}

function Choice<T extends string>({ legend, value, onChange, options }: { legend: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  const id = useId();
  return (
    <FieldSet className="gap-2">
      {/* a small uppercase heading, distinct from the options below it */}
      <FieldLegend variant="label" className="type-section mb-0!">
        {legend}
      </FieldLegend>
      <RadioGroup aria-label={legend} orientation="horizontal" value={value} onChange={(v) => onChange(v as T)} className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map(([v, l]) => (
          <Field key={v} orientation="horizontal" className="w-auto gap-2">
            <RadioGroupItem id={`${id}-${v}`} value={v} aria-label={l} />
            <FieldLabel htmlFor={`${id}-${v}`}>{l}</FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

function Upload({ app }: { app: App }) {
  useRev(app.wellRev);
  const imp = app.importer;
  const target = useSignal(imp.target);
  const unit = useSignal(imp.depthUnit);
  const log = useSignal(imp.log);
  const name = app.engine.activeWell.name;
  const take = (files: File[]) => files.length && void imp.handleFiles(files);
  return (
    <Section title="Upload">
      <div className="flex flex-col gap-5 pb-1">
        <Choice<Target>
          legend="Target"
          value={target}
          onChange={(v) => imp.target.set(v)}
          options={[
            ['supplement', `Supplement ${name}`],
            ['replace', `Replace in ${name}`],
            ['new', 'Create new well'],
          ]}
        />
        <Choice<DepthUnit>
          legend="Depth units for CSV / XLSX"
          value={unit}
          onChange={(v) => imp.depthUnit.set(v)}
          options={[
            ['auto', 'Auto (from header)'],
            ['m', 'Metres'],
            ['ft', 'Feet'],
          ]}
        />
      </div>
      <DropZone
        aria-label="Drop LAS, CSV or XLSX files"
        className="rounded-lg border border-dashed border-border outline-none data-[drop-target]:border-primary data-[drop-target]:bg-accent data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
        onDrop={async (e) => {
          const files = await Promise.all(e.items.filter((i) => i.kind === 'file').map((i) => (i as { getFile: () => Promise<File> }).getFile()));
          take(files);
        }}
      >
        <Empty className="p-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UploadIcon />
            </EmptyMedia>
            <EmptyTitle>Drop LAS / CSV / XLSX files here</EmptyTitle>
            <EmptyDescription>
              Several files at once is fine — the type of each is detected automatically. See “What you can import” below for the columns each file needs and where to get real data.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <FileTrigger allowsMultiple acceptedFileTypes={ACCEPT} onSelect={(l) => l && take([...l])}>
              <Button variant="outline">Browse files</Button>
            </FileTrigger>
          </EmptyContent>
        </Empty>
      </DropZone>
      {log.length > 0 && (
        <ul role="log" aria-label="Import messages" className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
          {log.map((m) => (
            <li key={m.id} className="flex items-start gap-2">
              {m.kind === 'ok' ? (
                <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-success" />
              ) : m.kind === 'err' ? (
                <CircleXIcon className="mt-px size-3.5 shrink-0 text-destructive" />
              ) : (
                <InfoIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={m.kind === 'err' ? 'text-destructive' : undefined}>{m.text.replace(/^[✓✕•]\s*/, '')}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ImportGuide() {
  return (
    <Section title="What you can import" aside={<span className="text-xs text-muted-foreground">with open sources of real data</span>}>
      <Accordion defaultExpandedKeys={['0']} className="rounded-md border border-border-subtle">
        {GUIDE.map((g, i) => (
          <AccordionItem key={g.title} id={String(i)}>
            <AccordionTrigger>
              <span className="flex flex-1 flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{g.title}</span>
                <span className="text-xs text-muted-foreground">{g.formats}</span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
                <dt className="font-medium text-foreground">Required</dt>
                <dd>{rich(g.needs)}</dd>
                <dt className="font-medium text-foreground">Optional</dt>
                <dd>{rich(g.optional)}</dd>
                <dt className="font-medium text-foreground">Notes</dt>
                <dd>{rich(g.notes)}</dd>
                {g.template && (
                  <>
                    <dt className="font-medium text-foreground">Template</dt>
                    <dd>
                      <Button variant="outline" size="xs" onPress={() => download(g.template!, TEMPLATES[g.template!], 'text/csv')}>
                        <DownloadIcon data-icon="inline-start" />
                        {g.template}
                      </Button>
                    </dd>
                  </>
                )}
                <dt className="font-medium text-foreground">Real data</dt>
                <dd>
                  <ul className="flex flex-col gap-2">
                    {g.sources.map((s) => (
                      <li key={s.url} className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <Link href={s.url} target="_blank" rel="noopener noreferrer" isExternal>
                            {s.label}
                          </Link>
                          <Badge variant={s.direct ? 'success' : 'outline'}>{s.direct ? 'direct download' : 'data portal'}</Badge>
                        </span>
                        <span>{s.note}</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <Note>
        On GitHub pages, use “Download raw file” to save the actual file. Recommended combination to try: 15-9-19_SR_COMP.las + 15_9_19_SR_TOPS_NPD.csv with target “Create new well”; or Volve
        production data.xlsx while 15/9-F-12 is active.
      </Note>
    </Section>
  );
}
