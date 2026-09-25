import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@tecton/react/components/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import { Field, FieldLabel } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { Spinner } from '@tecton/react/components/spinner';
import { Switch } from '@tecton/react/components/switch';
import {
  CableIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileUpIcon,
  LinkIcon,
  PlayIcon,
  PlusIcon,
  PuzzleIcon,
  RadioIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  Trash2Icon,
  UploadIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button as AriaButton, DropZone, FileTrigger, ListBox, ListBoxItem } from 'react-aria-components';
import { formatPresets, pluginModules, saveFormat, addPlugin, removePlugin } from '../../connect/library';
import type { ConnectorInput } from '../../connect/pipeline';
import { REPLAY_OFFSETS } from '../../connect/offsets';
import type { PreviewResult } from '../../connect/worker';
import type { App } from '../app';
import { CompactSelect } from '../controls';
import { IconButton } from '../icon-button';
import { defaults, humanize, SchemaForm, type JsonSchema } from '../schemaForm';
import { useSignal } from '../signal';
import { SortableList } from '../sortable';

/** Who opens the dialog: a fresh connection, an edit of one, or a start with files or settings filled in. */
export interface ConnectRequest {
  edit?: string;
  draft?: Partial<ConnectorInput>;
  files?: File[];
}

interface Described {
  kind: 'codec' | 'transform' | 'transport';
  id: string;
  label: string;
  description: string;
  live?: boolean;
  relay?: boolean;
  extensions?: string[];
  options: JsonSchema;
}

interface Step {
  key: string;
  id: string;
  options: Record<string, unknown>;
  enabled: boolean;
  open?: boolean;
}

interface Draft {
  id?: string;
  name: string;
  transport: string;
  options: Record<string, Record<string, unknown>>;
  format: string;
  formatOptions: Record<string, unknown>;
  steps: Step[];
  target: { mode: 'auto' | 'active' | 'well' | 'new'; well: string };
  plugins: string[];
}

const ICONS: Record<string, ReactNode> = {
  file: <FileUpIcon />,
  url: <LinkIcon />,
  poll: <RefreshCwIcon />,
  sse: <RadioIcon />,
  websocket: <CableIcon />,
  mqtt: <RadioTowerIcon />,
  relay: <ServerIcon />,
  replay: <PlayIcon />,
};
const ORDER = ['replay', 'file', 'url', 'poll', 'sse', 'websocket', 'mqtt', 'relay'];
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
/** the steps a new connection starts with */
const DEFAULT_STEPS = (): Step[] => [
  { key: 's-map', id: 'map', options: {}, enabled: true },
  { key: 's-units', id: 'units', options: {}, enabled: true },
];
const REPLAY_STEPS = (): Step[] => [...DEFAULT_STEPS(), { key: 's-t2d', id: 'time-to-depth', options: { offsets: REPLAY_OFFSETS, step: 0.1524 }, enabled: true }];

let described: Promise<Described[]> | null = null;
let describedFor = '';

function useDescribed(app: App, plugins: string[]) {
  const [list, setList] = useState<Described[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const k = plugins.join('\n');
  useEffect(() => {
    let live = true;
    if (!described || describedFor !== k) {
      describedFor = k;
      described = app.hub.describe(plugins).then((r) => {
        if (r.error) setError(r.error);
        return r.plugins as Described[];
      });
    }
    void described.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [app, k]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, error };
}

function fromConfig(c: Partial<ConnectorInput> | undefined, plugins: string[]): Draft {
  const transport = c?.transport?.id ?? 'replay';
  return {
    id: c?.id,
    name: c?.name ?? '',
    transport,
    options: { [transport]: (c?.transport?.options as Record<string, unknown>) ?? {} },
    format: c?.format?.id ?? 'auto',
    formatOptions: (c?.format?.options as Record<string, unknown>) ?? {},
    steps: c?.steps
      ? c.steps.map((s, i) => ({ key: `s${i}-${s.id}`, id: s.id, options: (s.options as Record<string, unknown>) ?? {}, enabled: s.enabled ?? true }))
      : transport === 'replay'
        ? REPLAY_STEPS()
        : DEFAULT_STEPS(),
    target: { mode: c?.target?.mode ?? 'auto', well: c?.target?.well ?? '' },
    plugins: c?.plugins ?? plugins,
  };
}

function toConfig(d: Draft, list: Described[]): ConnectorInput {
  const t = list.find((x) => x.kind === 'transport' && x.id === d.transport);
  const preset = d.format.startsWith('preset:') ? formatPresets.value.find((p) => `preset:${p.id}` === d.format) : undefined;
  return {
    id: d.id ?? '',
    name: d.name.trim() || (d.transport === 'relay' ? (d.options.relay?.sourceLabel as string | undefined) : undefined) || t?.label || d.transport,
    transport: { id: d.transport, options: { ...defaults(t?.options), ...(d.options[d.transport] ?? {}) } },
    format: preset ? preset.format : { id: d.format, options: d.formatOptions },
    steps: [...(preset?.steps ?? []), ...d.steps.map((s) => ({ id: s.id, options: s.options, enabled: s.enabled }))],
    target: d.target,
    plugins: [...new Set([...d.plugins, ...(preset?.plugins ?? [])])],
  };
}

/**
 * Connect a data source: where the data comes from, how it is written, the
 * steps that make it usable, and where it goes — with a preview of what it
 * will produce before anything touches a well.
 */
export function ConnectDialog({ app }: { app: App }) {
  const req = useSignal(app.connectRequest);
  return (
    <Dialog isOpen={!!req} onOpenChange={(o) => !o && app.connectRequest.set(null)} className="sm:max-w-5xl">
      {req && <ConnectForm key={req.edit ?? 'new'} app={app} req={req} />}
    </Dialog>
  );
}

function ConnectForm({ app, req }: { app: App; req: ConnectRequest }) {
  const plugins = useSignal(pluginModules);
  const presets = useSignal(formatPresets);
  const editing = req.edit ? app.hub.get(req.edit) : undefined;
  const [d, setD] = useState<Draft>(() => fromConfig(editing?.config ?? req.draft, plugins));
  const [files, setFiles] = useState<File[]>(req.files ?? []);
  const { list, error: pluginError } = useDescribed(app, d.plugins);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [nameTyped, setNameTyped] = useState(!!editing);
  const transports = useMemo(() => (list ?? []).filter((p) => p.kind === 'transport').sort((a, b) => rank(a.id) - rank(b.id)), [list]);
  const codecs = useMemo(() => (list ?? []).filter((p) => p.kind === 'codec'), [list]);
  const transforms = useMemo(() => (list ?? []).filter((p) => p.kind === 'transform'), [list]);
  const t = transports.find((x) => x.id === d.transport);
  const codec = codecs.find((c) => c.id === d.format);
  const patch = (p: Partial<Draft>) => {
    setD((x) => ({ ...x, ...p }));
    setPreview(null);
  };
  const config = () => toConfig(d, list ?? []);
  const needsFiles = d.transport === 'file' && !files.length;

  const previewRef = useRef<HTMLDivElement>(null);
  const runPreview = async () => {
    setPreviewing(true);
    requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    setPreview(await app.hub.preview(config(), d.transport === 'file' ? files : undefined, { rows: 300, timeoutMs: d.transport === 'replay' ? 8000 : 6000 }));
    setPreviewing(false);
  };
  const connect = () => {
    const id = app.hub.connect({ ...config(), id: req.edit ?? '' }, d.transport === 'file' ? files : undefined, { focus: d.transport === 'replay' });
    app.connectRequest.set(null);
    app.openSources(id);
  };

  if (!list)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Connect data</DialogTitle>
        </DialogHeader>
        <div className="flex h-60 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading connectors…
        </div>
      </>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? `Edit “${editing.config.name}”` : 'Connect data'}</DialogTitle>
        <DialogDescription>Files, APIs, streams and brokers — read in the background, previewed before anything changes.</DialogDescription>
      </DialogHeader>
      <div className="-mx-6 grid max-h-[72vh] min-h-0 grid-cols-[14rem_minmax(0,1fr)] border-y border-border-subtle">
        {/* where the data comes from */}
        <ListBox
          aria-label="Source type"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[d.transport]}
          onSelectionChange={(k) => {
            const id = [...k][0] as string;
            if (!id || id === d.transport) return;
            patch({ transport: id, name: nameTyped ? d.name : '', steps: id === 'replay' ? REPLAY_STEPS() : d.transport === 'replay' ? DEFAULT_STEPS() : d.steps });
          }}
          className="flex flex-col gap-0.5 overflow-y-auto border-r border-border-subtle p-2 outline-none"
        >
          {transports.map((x) => (
            <ListBoxItem
              key={x.id}
              id={x.id}
              textValue={x.label}
              className="group flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring data-hovered:bg-ghost-hover data-selected:bg-ghost-active"
            >
              <span className="mt-0.5 text-fg-3 group-data-selected:text-ui-accent [&_svg]:size-4">{ICONS[x.id] ?? <PuzzleIcon />}</span>
              <span className="flex min-w-0 flex-col">
                <span className="type-label text-fg-1">{x.label}</span>
                <span className="type-caption">{x.relay ? 'through the relay' : x.live ? 'live' : 'one-off'}</span>
              </span>
            </ListBoxItem>
          ))}
        </ListBox>

        <div className="@container flex min-h-0 min-w-0 flex-col gap-6 overflow-x-hidden overflow-y-auto p-5">
          <Block title={t?.label ?? d.transport} description={t?.description}>
            <Field className="gap-1">
              <FieldLabel className="type-label" htmlFor="conn-name">
                Name
              </FieldLabel>
              <Input
                id="conn-name"
                value={d.name}
                placeholder={t?.label}
                onChange={(e) => {
                  setNameTyped(true);
                  patch({ name: e.target.value });
                }}
              />
            </Field>
            {d.transport === 'file' ? (
              <FilePicker files={files} onFiles={(f) => (setFiles(f), setPreview(null))} codecs={codecs} />
            ) : d.transport === 'relay' ? (
              <RelayPicker value={d.options.relay ?? {}} onChange={(v) => patch({ options: { ...d.options, relay: v } })} schema={t?.options} />
            ) : (
              <SchemaForm
                schema={t?.options}
                hide={['baseUrl', 'files']}
                choices={
                  d.transport === 'replay'
                    ? { well: [{ id: '', label: `Main well (${app.field.primary.name})` }, ...app.field.wells.filter((w) => w.lasFile).map((w) => ({ id: w.id, label: w.name }))] }
                    : undefined
                }
                value={d.options[d.transport] ?? {}}
                onChange={(v) => patch({ options: { ...d.options, [d.transport]: v } })}
              />
            )}
          </Block>

          <Block
            title="Format"
            description={
              d.format === 'auto'
                ? 'Recognised from the first bytes, the file name or what the source announces.'
                : (codec?.description ?? presets.find((p) => `preset:${p.id}` === d.format)?.description)
            }
          >
            <CompactSelect
              label="Format"
              appearance="field"
              value={d.format}
              onChange={(v) => patch({ format: v, formatOptions: {} })}
              className="w-72 max-w-full"
              options={[
                { id: 'auto', label: 'Detect automatically' },
                { label: 'Formats', options: codecs.map((c) => ({ id: c.id, label: c.label })) },
                ...(presets.length ? [{ label: 'Your formats', options: presets.map((p) => ({ id: `preset:${p.id}`, label: p.name })) }] : []),
              ]}
            />
            {codec && Object.keys(codec.options.properties ?? {}).length > 0 && (
              <Fold label="Format options">
                <SchemaForm schema={codec.options} value={d.formatOptions} onChange={(v) => patch({ formatOptions: v })} />
              </Fold>
            )}
          </Block>

          <Block
            title="Steps"
            description="Applied in order to every batch as it arrives. Drag to reorder."
            aside={
              <DropdownMenuTrigger>
                <Button variant="outline" size="xs">
                  <PlusIcon data-icon="inline-start" />
                  Add step
                </Button>
                <DropdownMenu
                  placement="bottom end"
                  className="w-max max-w-96"
                  onAction={(k) => patch({ steps: [...d.steps, { key: `s${Date.now()}`, id: String(k), options: {}, enabled: true, open: true }] })}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Transforms</DropdownMenuLabel>
                    {transforms.map((x) => (
                      <DropdownMenuItem key={x.id} id={x.id} textValue={x.label}>
                        <span className="flex flex-col">
                          <span>{x.label}</span>
                          <span className="type-caption max-w-80 whitespace-normal">{x.description}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenu>
              </DropdownMenuTrigger>
            }
          >
            <StepList steps={d.steps} transforms={transforms} onChange={(steps) => patch({ steps })} />
          </Block>

          <Block title="Destination" description="Rows that name a well go to that well (a new one is created if BoreWalk does not have it). Rows without one go here.">
            <div className="flex flex-wrap items-center gap-2">
              <CompactSelect
                label="Rows without a well name"
                appearance="field"
                value={d.target.mode}
                onChange={(v) => patch({ target: { ...d.target, mode: v as Draft['target']['mode'] } })}
                className="w-64"
                options={[
                  { id: 'auto', label: 'The active well' },
                  { id: 'well', label: 'A well I choose' },
                  { id: 'new', label: 'A new well' },
                  { id: 'active', label: 'Always the active well (ignore names)' },
                ]}
              />
              {d.target.mode === 'well' && (
                <CompactSelect
                  label="Well"
                  appearance="field"
                  value={d.target.well || null}
                  placeholder="Choose a well"
                  onChange={(v) => patch({ target: { ...d.target, well: v } })}
                  className="w-56"
                  options={app.field.wells.map((w) => ({ id: w.id, label: w.name }))}
                />
              )}
            </div>
          </Block>

          <PluginBlock plugins={d.plugins} error={pluginError} onChange={(p) => patch({ plugins: p })} />

          <div ref={previewRef} className="scroll-mt-4" />
          <PreviewBlock preview={preview} previewing={previewing} codecs={codecs} steps={d.steps} onAddStep={(s) => patch({ steps: [...d.steps, s] })} />
        </div>
      </div>
      <DialogFooter className="items-center">
        {saveName === null ? (
          <Button variant="ghost" size="sm" className="mr-auto" onPress={() => setSaveName(d.name || '')} isDisabled={d.format === 'auto' && !d.steps.length}>
            <SaveIcon data-icon="inline-start" />
            Save format and steps…
          </Button>
        ) : (
          <form
            className="mr-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saveName.trim()) return;
              const c = config();
              const p = saveFormat({
                name: saveName.trim(),
                description: `${codecs.find((x) => x.id === c.format?.id)?.label ?? 'Detected'} with ${c.steps?.length ?? 0} step(s)`,
                format: c.format as never,
                steps: c.steps as never,
                plugins: c.plugins ?? [],
              });
              patch({ format: `preset:${p.id}`, steps: [] });
              setSaveName(null);
              app.toast(`Saved “${p.name}”: pick it as a format for other connections`);
            }}
          >
            <Input aria-label="Name of the format" autoFocus value={saveName} placeholder="e.g. ACME rig feed" onChange={(e) => setSaveName(e.target.value)} className="w-52" />
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setSaveName(null)}>
              Cancel
            </Button>
          </form>
        )}
        <Button variant="outline" onPress={() => void runPreview()} isDisabled={previewing || needsFiles}>
          {previewing ? <Spinner data-icon="inline-start" /> : <WandSparklesIcon data-icon="inline-start" />}
          Preview
        </Button>
        <Button onPress={connect} isDisabled={needsFiles}>
          {editing ? 'Save and reconnect' : d.transport === 'file' ? 'Import' : 'Connect'}
        </Button>
      </DialogFooter>
    </>
  );
}

function Block({ title, description, aside, children }: { title: string; description?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="type-section">{title}</h3>
          {description && <p className="type-caption">{description}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Fold({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="type-label flex w-max items-center gap-1 rounded-sm text-fg-2 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
      >
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        {label}
      </button>
      {open && <div className="border-l border-border-subtle pl-4">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ files

function FilePicker({ files, onFiles, codecs }: { files: File[]; onFiles: (f: File[]) => void; codecs: Described[] }) {
  const ext = [...new Set(codecs.flatMap((c) => c.extensions ?? []))];
  const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
  return (
    <DropZone
      aria-label="Drop files"
      className="rounded-lg border border-dashed border-border outline-none data-[drop-target]:border-primary data-[drop-target]:bg-accent data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
      onDrop={async (e) => onFiles([...files, ...(await Promise.all(e.items.filter((i) => i.kind === 'file').map((i) => (i as { getFile: () => Promise<File> }).getFile())))])}
    >
      <Empty className="gap-3 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UploadIcon />
          </EmptyMedia>
          <EmptyTitle>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Drop files here'}</EmptyTitle>
          <EmptyDescription>Read in the background in pieces, so large files do not freeze the page. {ext.map((x) => `.${x}`).join(' ')}</EmptyDescription>
        </EmptyHeader>
        {files.length > 0 && (
          <ul className="flex w-full flex-col gap-1 text-left">
            {files.map((f, i) => (
              <li key={`${f.name}${i}`} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="type-caption tabular-nums">{size(f.size)}</span>
                <IconButton label={`Remove ${f.name}`} size="icon-xs" onPress={() => onFiles(files.filter((_, j) => j !== i))}>
                  <Trash2Icon />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <EmptyContent>
          <FileTrigger allowsMultiple onSelect={(l) => l && onFiles([...files, ...l])}>
            <Button variant="outline" size="sm">
              Browse files
            </Button>
          </FileTrigger>
        </EmptyContent>
      </Empty>
    </DropZone>
  );
}

// ------------------------------------------------------------------ relay

interface RelaySource {
  id: string;
  type: string;
  label: string;
  adapter: string;
  params: JsonSchema;
  info: Record<string, unknown>;
}

function RelayPicker({ value, onChange, schema }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; schema?: JsonSchema }) {
  const [sources, setSources] = useState<RelaySource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const url = String(value.url ?? '');
  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const http = url.replace(/^ws/, 'http').replace(/\/$/, '');
      const r = await fetch(`${http}/sources`, { headers: value.token ? { Authorization: `Bearer ${value.token}` } : {} });
      if (r.status === 401) throw new Error('The relay did not accept the token.');
      if (!r.ok) throw new Error(`The relay answered ${r.status}.`);
      setSources((await r.json()) as RelaySource[]);
    } catch (e) {
      setErr(e instanceof TypeError ? 'Could not reach the relay (is it running, and does it allow this page’s origin?).' : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  const src = sources?.find((s) => s.id === value.source);
  return (
    <div className="flex flex-col gap-3">
      <SchemaForm schema={schema} hide={['source', 'params']} value={value} onChange={onChange} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onPress={() => void load()} isDisabled={!/^wss?:\/\//.test(url) || loading}>
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {sources ? 'Reload sources' : 'Load sources'}
        </Button>
        {sources && (
          <CompactSelect
            label="Source"
            appearance="field"
            value={(value.source as string) || null}
            placeholder="Choose a source"
            onChange={(v) => onChange({ ...value, source: v, params: {}, sourceLabel: sources.find((s) => s.id === v)?.label })}
            className="w-72"
            options={sources.map((s) => ({ id: s.id, label: s.label }))}
          />
        )}
        {!sources && (
          <Input
            aria-label="Source id"
            placeholder="source id"
            value={String(value.source ?? '')}
            onChange={(e) => onChange({ ...value, source: e.target.value })}
            className="w-48 font-mono text-xs"
          />
        )}
      </div>
      {err && <p className="type-caption text-destructive!">{err}</p>}
      {src && (
        <div className="flex flex-col gap-3 rounded-md border border-border-subtle p-3">
          <p className="type-caption">
            {src.adapter} ·{' '}
            {Object.entries(src.info)
              .map(([k, v]) => `${humanize(k)}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
              .join(' · ')}
          </p>
          <SchemaForm schema={src.params} value={(value.params as Record<string, unknown>) ?? {}} onChange={(p) => onChange({ ...value, params: p })} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ steps

function StepList({ steps, transforms, onChange }: { steps: Step[]; transforms: Described[]; onChange: (s: Step[]) => void }) {
  const label = (s: Step) => transforms.find((x) => x.id === s.id)?.label ?? s.id;
  const set = (key: string, p: Partial<Step>) => onChange(steps.map((s) => (s.key === key ? { ...s, ...p } : s)));
  if (!steps.length) return <p className="type-caption">No steps: the data is used as it is decoded.</p>;
  return (
    <SortableList
      label="Steps"
      items={steps.map((step) => ({ id: step.key, step }))}
      itemLabel={(x) => label(x.step)}
      deps={[steps, transforms]}
      onReorder={(ids) => onChange(ids.map((k) => steps.find((s) => s.key === k)!))}
      below={({ step: s }) =>
        s.open ? (
          <div className="@container mb-2 ml-6 border-l border-border-subtle pt-1 pr-1 pl-4">
            <p className="type-caption mb-3">{transforms.find((x) => x.id === s.id)?.description}</p>
            <SchemaForm schema={transforms.find((x) => x.id === s.id)?.options} value={s.options} onChange={(o) => set(s.key, { options: o })} />
          </div>
        ) : null
      }
    >
      {({ step: s }) => (
        <>
          <AriaButton
            className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring"
            onPress={() => set(s.key, { open: !s.open })}
            aria-expanded={!!s.open}
          >
            {s.open ? <ChevronDownIcon className="size-3.5 shrink-0 text-fg-3" /> : <ChevronRightIcon className="size-3.5 shrink-0 text-fg-3" />}
            <span className={`type-label truncate ${s.enabled ? 'text-fg-1' : 'text-fg-3 line-through'}`}>{label(s)}</span>
            <span className="type-caption truncate">{summary(s)}</span>
          </AriaButton>
          <Switch aria-label={`${label(s)} on`} isSelected={s.enabled} onChange={(on) => set(s.key, { enabled: on })} />
          <IconButton label={`Remove ${label(s)}`} size="icon-xs" onPress={() => onChange(steps.filter((x) => x.key !== s.key))}>
            <Trash2Icon />
          </IconButton>
        </>
      )}
    </SortableList>
  );
}

function summary(s: Step): string {
  const o = s.options;
  switch (s.id) {
    case 'map':
      return o.index ? `index ${o.index}` : 'automatic';
    case 'units':
      return o.metric === false ? 'as given' : 'to metric';
    case 'time-to-depth':
      return `${o.step ?? 0.1} m steps${o.offsets && Object.keys(o.offsets).length ? `, ${Object.keys(o.offsets).length} sensor offsets` : ''}`;
    case 'derive':
      return o.name ? `${o.name} = ${o.expression ?? ''}` : '';
    case 'filter':
      return String(o.expression ?? '');
    case 'resample':
      return o.step ? `every ${o.step}` : '';
    default:
      return '';
  }
}

// ------------------------------------------------------------------ custom plugins

function PluginBlock({ plugins, error, onChange }: { plugins: string[]; error: string | null; onChange: (p: string[]) => void }) {
  const known = useSignal(pluginModules);
  const [url, setUrl] = useState('');
  const id = useId();
  return (
    <Fold label={`Custom plugins${plugins.length ? ` (${plugins.length})` : ''}`} defaultOpen={plugins.length > 0}>
      <div className="flex flex-col gap-3">
        <p className="type-caption">
          An ES module whose default export is a codec, a step or a transport — or a function receiving{' '}
          <code className="font-mono">{'{ defineCodec, defineTransform, defineTransport, z, batch }'}</code>. It runs in this connection’s worker, with no access to the page. Only add modules you
          trust.
        </p>
        {known.map((u) => (
          <div key={u} className="flex items-center gap-2">
            <Switch aria-label={`Use ${u}`} isSelected={plugins.includes(u)} onChange={(on) => onChange(on ? [...plugins, u] : plugins.filter((x) => x !== u))} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{u}</span>
            <IconButton
              label="Forget this plugin"
              size="icon-xs"
              onPress={() => {
                removePlugin(u);
                onChange(plugins.filter((x) => x !== u));
              }}
            >
              <Trash2Icon />
            </IconButton>
          </div>
        ))}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const u = new URL(url, location.href).href;
              addPlugin(u);
              onChange([...plugins, u]);
              setUrl('');
            } catch {
              /* not a URL */
            }
          }}
        >
          <Field className="flex-1 gap-1">
            <FieldLabel htmlFor={id} className="type-label">
              Module URL
            </FieldLabel>
            <Input id={id} value={url} placeholder="https://example.com/acme-rig-codec.js" className="font-mono text-xs" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline" size="sm" isDisabled={!url.trim()}>
            Add
          </Button>
        </form>
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>A plugin did not load</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Fold>
  );
}

// ------------------------------------------------------------------ preview

const fmtRange = (kind: string, index: string | undefined, a?: number, b?: number) => {
  if (a === undefined || b === undefined || !Number.isFinite(a)) return '';
  if (index === 'time' || kind === 'production') {
    const f = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
    return `${f(a)} → ${f(b).slice(11)}`;
  }
  return `${a.toFixed(1)} – ${b.toFixed(1)} m`;
};

function PreviewBlock({ preview, previewing, codecs, steps, onAddStep }: { preview: PreviewResult | null; previewing: boolean; codecs: Described[]; steps: Step[]; onAddStep: (s: Step) => void }) {
  if (!preview && !previewing)
    return (
      <Block title="Preview" description="Run the connection for a few seconds and see the columns it reads and the data it would add — nothing changes until you connect.">
        {null}
      </Block>
    );
  if (!preview)
    return (
      <Block title="Preview">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Reading the first data…
        </div>
      </Block>
    );
  const raw = preview.raw[0];
  const names = raw?.columns.map((c) => c.name.toUpperCase()) ?? [];
  const hasBit = names.some((n) => /^(DBTM|BITDEP|BDEP|BIT[_ ]?DEPTH)/.test(n));
  const timeIndexed = preview.frames.some((f) => f.index === 'time');
  const suggestions: { label: string; step: Step }[] = [];
  if (hasBit && timeIndexed && !steps.some((s) => s.id === 'time-to-depth'))
    suggestions.push({ label: 'Put the readings on depth (time to depth)', step: { key: `s${Date.now()}`, id: 'time-to-depth', options: {}, enabled: true, open: true } });
  if (timeIndexed && !steps.some((s) => s.id === 'order')) suggestions.push({ label: 'Drop repeated and late readings', step: { key: `s${Date.now() + 1}`, id: 'order', options: {}, enabled: true } });
  return (
    <Block title="Preview" aside={preview.codec && <Badge variant="info">{codecs.find((c) => c.id === preview.codec)?.label ?? preview.codec}</Badge>}>
      {preview.error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not read the data</AlertTitle>
          <AlertDescription>{preview.error}</AlertDescription>
        </Alert>
      )}
      {raw && (
        <div className="flex flex-col gap-1">
          <span className="type-caption">As read ({raw.columns.length} columns, first rows)</span>
          <div className="max-w-full overflow-x-auto rounded-md border border-border-subtle">
            {/* a static sample: a plain table (the data grid component is for interactive tables) */}
            <table className="w-full text-xs" aria-label="First rows as read">
              <thead className="border-b border-border-subtle bg-muted/40">
                <tr>
                  {raw.columns.map((c) => (
                    <th key={c.name} scope="col" className={`h-7 px-2 font-medium whitespace-nowrap text-fg-1 ${c.numeric ? 'text-right' : 'text-left'}`}>
                      {c.name}
                      {c.unit && c.unit !== 'ms' ? <span className="ml-1 font-normal text-fg-3">{c.unit}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {raw.rows.slice(0, 6).map((r, i) => (
                  <tr key={i} className="border-b border-border-subtle last:border-0">
                    {r.map((v, k) => (
                      <td key={k} className={`px-2 py-1 whitespace-nowrap text-fg-2 ${raw.columns[k]?.numeric ? 'text-right font-mono tabular-nums' : ''}`}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {preview.frames.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="type-caption">What it adds</span>
          <ul className="flex flex-col gap-1">
            {preview.frames.map((f, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <Badge variant={f.kind === 'log' ? 'secondary' : 'outline'}>{f.kind === 'log' ? (f.index === 'time' ? 'readings by time' : 'log by depth') : f.kind}</Badge>
                <span className="text-fg-1">{f.well ?? 'destination well'}</span>
                <span className="type-caption">
                  {f.rows} rows{f.channels ? ` · ${f.channels.length} channels (${f.channels.slice(0, 6).join(', ')}${f.channels.length > 6 ? '…' : ''})` : ''} ·{' '}
                  {fmtRange(f.kind, f.index, f.from, f.to)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <Button key={s.label} variant="outline" size="xs" onPress={() => onAddStep(s.step)}>
              <PlusIcon data-icon="inline-start" />
              {s.label}
            </Button>
          ))}
        </div>
      )}
      {preview.logs.filter((l) => l.level !== 'info' && l.text !== preview.error).length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {preview.logs
            .filter((l) => l.level !== 'info' && l.text !== preview.error)
            .slice(0, 6)
            .map((l, i) => (
              <li key={i} className={l.level === 'error' ? 'text-destructive' : 'text-warning'}>
                {l.text}
              </li>
            ))}
        </ul>
      )}
    </Block>
  );
}
