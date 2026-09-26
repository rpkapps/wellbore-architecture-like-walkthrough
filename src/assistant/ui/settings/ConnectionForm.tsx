import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleAlertIcon, CircleCheckIcon, EyeIcon, EyeOffIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon, ZapIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@tecton/react/components/combobox';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@tecton/react/components/input-group';
import { Slider } from '@tecton/react/components/slider';
import { Spinner } from '@tecton/react/components/spinner';
import { Switch } from '@tecton/react/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { Link } from '@tecton/react/tecton/link';
import type { ProviderConfig, ProviderPreset, ReasoningEffort } from '../../core/types';
import { usePanel } from '../context';

const EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

/** URL checks for the form: absolute http(s), no trailing slash needed. */
export function validateConnection(c: ProviderConfig, needsKey: boolean): Partial<Record<'label' | 'baseUrl' | 'model' | 'apiKey' | 'corsProxy' | 'maxOutputTokens', string>> {
  const errors: Partial<Record<'label' | 'baseUrl' | 'model' | 'apiKey' | 'corsProxy' | 'maxOutputTokens', string>> = {};
  if (!c.label.trim()) errors.label = 'Give the connection a name.';
  try {
    const url = new URL(c.baseUrl);
    if (!/^https?:$/.test(url.protocol)) errors.baseUrl = 'Use an http(s) URL.';
  } catch {
    errors.baseUrl = 'Enter a full URL, e.g. https://api.example.com/v1';
  }
  if (!c.model.trim()) errors.model = 'Choose or type a model id.';
  if (needsKey && !c.apiKey?.trim()) errors.apiKey = 'This provider needs an API key.';
  if (c.corsProxy && !/^https?:\/\/\S+$/.test(c.corsProxy)) errors.corsProxy = 'Use an http(s) URL prefix.';
  if (c.maxOutputTokens !== undefined && (!Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens < 1)) errors.maxOutputTokens = 'A whole number above 0.';
  return errors;
}

interface ConnectionFormProps {
  initial: ProviderConfig;
  preset: ProviderPreset | undefined;
  isNew: boolean;
  isActive: boolean;
  onSaved: (config: ProviderConfig) => void;
  onRemoved: () => void;
}

type HeaderRow = { id: number; key: string; value: string };

/** The form of one connection: key, URL, model (with Fetch models), sampling, capabilities, advanced; Test, Save, Remove, Use. */
export function ConnectionForm({ initial, preset, isNew, isActive, onSaved, onRemoved }: ConnectionFormProps) {
  const { controller } = usePanel();
  const uid = useId();
  const [draft, setDraft] = useState<ProviderConfig>(initial);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>(() => [...new Set([initial.model, ...(preset?.models ?? [])].filter(Boolean))]);
  const [fetchState, setFetchState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; message?: string }>({ status: 'idle' });
  const [test, setTest] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; message?: string }>({ status: 'idle' });
  const [showErrors, setShowErrors] = useState(false);
  const [saved, setSaved] = useState(false);
  const headerSeq = useRef(0);
  const [headers, setHeaders] = useState<HeaderRow[]>(() => Object.entries(initial.headers ?? {}).map(([key, value]) => ({ id: headerSeq.current++, key, value })));

  useEffect(() => setSaved(false), [draft, headers]);

  const needsKey = preset?.needsKey ?? false;
  const config: ProviderConfig = useMemo(() => {
    const h = Object.fromEntries(headers.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    const next: ProviderConfig = { ...draft, baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), model: draft.model.trim(), label: draft.label.trim() };
    if (Object.keys(h).length) next.headers = h;
    else delete next.headers;
    if (!next.apiKey) delete next.apiKey;
    if (!next.corsProxy) delete next.corsProxy;
    return next;
  }, [draft, headers]);
  const errors = validateConnection(config, needsKey);
  const valid = Object.keys(errors).length === 0;
  const err = (k: keyof typeof errors) => (showErrors && errors[k] ? [{ message: errors[k] }] : undefined);

  const set = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const fetchModels = async () => {
    setFetchState({ status: 'loading' });
    try {
      const list = await controller.listModels(config);
      setModels((cur) => [...new Set([...list.map((m) => m.id), ...cur])]);
      setFetchState({ status: 'done', message: `${list.length} models available.` });
    } catch (e) {
      setFetchState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const runTest = async () => {
    setShowErrors(true);
    if (!valid) return;
    setTest({ status: 'loading' });
    try {
      const reply = await controller.testProvider(config);
      setTest({ status: 'ok', message: reply.slice(0, 200) });
    } catch (e) {
      setTest({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = (activate: boolean) => {
    setShowErrors(true);
    if (!valid) return;
    controller.saveProvider(config);
    if (activate) controller.updateSettings({ activeProviderId: config.id });
    setSaved(true);
    onSaved(config);
  };

  const id = (name: string) => `${uid}-${name}`;
  const temperatureSet = draft.temperature !== undefined;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save(isNew || isActive);
      }}
      noValidate
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{isNew ? `New ${preset?.label ?? 'connection'}` : draft.label || 'Connection'}</h3>
        {isActive && (
          <Badge variant="success" appearance="outline">
            In use
          </Badge>
        )}
      </div>
      {preset?.note && <p className="-mt-3 text-xs text-muted-foreground">{preset.note}</p>}

      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={id('label')}>Name</FieldLabel>
          <Input id={id('label')} value={draft.label} onChange={(e) => set('label', e.target.value)} aria-invalid={!!err('label')} />
          <FieldError errors={err('label')} />
        </Field>

        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={id('key')}>API key{!needsKey && <span className="font-normal text-muted-foreground"> (optional)</span>}</FieldLabel>
            {preset?.keyUrl && (
              <Link href={preset.keyUrl} target="_blank" rel="noopener noreferrer" variant="primary" size="sm">
                Get a key
              </Link>
            )}
          </div>
          <InputGroup>
            <InputGroupInput
              id={id('key')}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={preset?.keyHint ?? (needsKey ? 'Paste your key' : 'Not needed for a local server')}
              value={draft.apiKey ?? ''}
              onChange={(e) => set('apiKey', e.target.value)}
              aria-invalid={!!err('apiKey')}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">
              <TooltipTrigger>
                <InputGroupButton size="icon-xs" aria-label={showKey ? 'Hide key' : 'Show key'} onPress={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
                <Tooltip>{showKey ? 'Hide key' : 'Show key'}</Tooltip>
              </TooltipTrigger>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>The key stays in this browser and is sent only to {preset?.label ?? 'the provider'}.</FieldDescription>
          <FieldError errors={err('apiKey')} />
        </Field>

        <Field>
          <FieldLabel htmlFor={id('url')}>Base URL</FieldLabel>
          <Input id={id('url')} className="font-mono" spellCheck={false} value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} aria-invalid={!!err('baseUrl')} />
          <FieldError errors={err('baseUrl')} />
        </Field>

        <Field>
          <FieldLabel htmlFor={id('model')}>Model</FieldLabel>
          <div className="flex items-start gap-2">
            <Combobox
              aria-label="Model"
              className="min-w-0 flex-1"
              allowsCustomValue
              allowsEmptyCollection
              menuTrigger="focus"
              inputValue={draft.model}
              onInputChange={(value) => set('model', value)}
              onChange={(key) => key !== null && set('model', String(key))}
              isInvalid={!!err('model')}
            >
              <ComboboxInput id={id('model')} className="font-mono" placeholder="model id" />
              <ComboboxContent>
                <ComboboxList renderEmptyState={() => <ComboboxEmpty>Press Fetch models, or type an id.</ComboboxEmpty>}>
                  {models
                    .filter((m) => !draft.model || m.toLowerCase().includes(draft.model.toLowerCase()) || models.includes(draft.model))
                    .map((m) => (
                      <ComboboxItem key={m} id={m} textValue={m}>
                        <span className="font-mono text-xs">{m}</span>
                      </ComboboxItem>
                    ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <Button variant="outline" onPress={() => void fetchModels()} isDisabled={fetchState.status === 'loading'}>
              {fetchState.status === 'loading' ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              Fetch models
            </Button>
          </div>
          {fetchState.status === 'done' && <FieldDescription>{fetchState.message}</FieldDescription>}
          {fetchState.status === 'error' && <FieldError>{`Could not list the models: ${fetchState.message}`}</FieldError>}
          <FieldError errors={err('model')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor={id('temp-default')}>Temperature</FieldLabel>
              <span className="text-xs text-muted-foreground tabular-nums">{temperatureSet ? draft.temperature?.toFixed(1) : 'Default'}</span>
            </div>
            <Slider
              aria-label="Temperature"
              minValue={0}
              maxValue={2}
              step={0.1}
              isDisabled={!temperatureSet}
              value={draft.temperature ?? 0.7}
              onChange={(v) => set('temperature', Array.isArray(v) ? v[0] : v)}
              className="mt-1"
            />
            <Field orientation="horizontal" className="mt-1">
              <Switch id={id('temp-default')} size="sm" isSelected={!temperatureSet} onChange={(useDefault) => set('temperature', useDefault ? undefined : 0.7)} />
              <FieldLabel htmlFor={id('temp-default')} className="font-normal text-muted-foreground">
                Use the model’s default
              </FieldLabel>
            </Field>
          </Field>
          <Field>
            <FieldLabel htmlFor={id('max')}>Max output tokens</FieldLabel>
            <Input
              id={id('max')}
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="Default"
              value={draft.maxOutputTokens ?? ''}
              onChange={(e) => set('maxOutputTokens', e.target.value === '' ? undefined : Number(e.target.value))}
              aria-invalid={!!err('maxOutputTokens')}
            />
            <FieldError errors={err('maxOutputTokens')} />
          </Field>
        </div>

        <FieldSet>
          <FieldLegend variant="label">Reasoning effort</FieldLegend>
          <ToggleGroup
            variant="outline"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[draft.reasoning ?? 'off']}
            onSelectionChange={(keys) => {
              const [k] = [...keys];
              if (k) set('reasoning', String(k) as ReasoningEffort);
            }}
            aria-label="Reasoning effort"
          >
            {EFFORTS.map((e) => (
              <ToggleGroupItem key={e} id={e} className="capitalize">
                {e}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>For models that think before answering. Higher is slower and costs more.</FieldDescription>
        </FieldSet>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={id('tools')}>Tools</FieldLabel>
              <FieldDescription>Can operate the app.</FieldDescription>
            </FieldContent>
            <Switch id={id('tools')} isSelected={draft.tools !== false} onChange={(v) => set('tools', v)} />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={id('vision')}>Vision</FieldLabel>
              <FieldDescription>Accepts images.</FieldDescription>
            </FieldContent>
            <Switch id={id('vision')} isSelected={!!draft.vision} onChange={(v) => set('vision', v)} />
          </Field>
        </div>

        <Collapsible className="group/adv rounded-lg border border-border-subtle" defaultExpanded={headers.length > 0 || !!initial.corsProxy}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
            Advanced
            <PlusIcon className="size-4 text-muted-foreground transition-transform group-data-expanded/adv:rotate-45" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-4 px-3 pt-1 pb-3">
              <FieldSet>
                <FieldLegend variant="label">Extra headers</FieldLegend>
                {headers.map((row, i) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <Input
                      aria-label={`Header ${i + 1} name`}
                      placeholder="Header"
                      className="font-mono"
                      value={row.key}
                      onChange={(e) => setHeaders((cur) => cur.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                    />
                    <Input
                      aria-label={`Header ${i + 1} value`}
                      placeholder="Value"
                      className="font-mono"
                      value={row.value}
                      onChange={(e) => setHeaders((cur) => cur.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
                    />
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove header ${row.key || i + 1}`} onPress={() => setHeaders((cur) => cur.filter((r) => r.id !== row.id))}>
                      <XIcon />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="xs" className="self-start" onPress={() => setHeaders((cur) => [...cur, { id: headerSeq.current++, key: '', value: '' }])}>
                  <PlusIcon data-icon="inline-start" />
                  Add header
                </Button>
              </FieldSet>
              <Field>
                <FieldLabel htmlFor={id('proxy')}>CORS proxy prefix</FieldLabel>
                <Input
                  id={id('proxy')}
                  className="font-mono"
                  placeholder="https://my-proxy.example/"
                  value={draft.corsProxy ?? ''}
                  onChange={(e) => set('corsProxy', e.target.value || undefined)}
                  aria-invalid={!!err('corsProxy')}
                />
                <FieldDescription>For providers that refuse requests from a browser: the request URL is appended to this prefix.</FieldDescription>
                <FieldError errors={err('corsProxy')} />
              </Field>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>

      {test.status === 'ok' && (
        <Alert variant="success">
          <CircleCheckIcon aria-hidden />
          <AlertTitle>Connected</AlertTitle>
          <AlertDescription>{`The model replied: “${test.message}”`}</AlertDescription>
        </Alert>
      )}
      {test.status === 'error' && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden />
          <AlertTitle>The connection failed</AlertTitle>
          <AlertDescription className="break-words">{test.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
        <Button variant="outline" onPress={() => void runTest()} isDisabled={test.status === 'loading'}>
          {test.status === 'loading' ? <Spinner data-icon="inline-start" /> : <ZapIcon data-icon="inline-start" />}
          Test connection
        </Button>
        {!isNew && (
          <Button
            variant="ghost"
            onPress={() => {
              controller.removeProvider(initial.id);
              onRemoved();
            }}
          >
            <Trash2Icon data-icon="inline-start" />
            Remove
          </Button>
        )}
        <span className="flex-1" />
        {saved && <span className="text-xs text-success" role="status">Saved</span>}
        {!isActive && !isNew && (
          <Button variant="outline" onPress={() => save(true)}>
            Use this connection
          </Button>
        )}
        <Button type="submit">{isNew ? 'Add connection' : 'Save'}</Button>
      </div>
    </form>
  );
}
