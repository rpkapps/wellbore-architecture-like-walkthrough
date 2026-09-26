import { useEffect, useId, useState } from 'react';
import { cn } from 'cn';
import { PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { RadioGroup, RadioGroupItem } from '@tecton/react/components/radio-group';
import { Switch } from '@tecton/react/components/switch';
import type { AutonomyMode, ProviderConfig, ProviderPreset } from '../../core/types';
import { AUTONOMY } from '../AssistantComposer';
import { usePanel, type SettingsTarget } from '../context';
import { PROVIDER_PRESETS } from '../presetsShim';
import { useAssistant } from '../useAssistant';
import { ConnectionForm } from './ConnectionForm';

/** One line under each preset's name in the pickers. */
export const PRESET_TAGLINES: Record<string, string> = {
  openai: 'GPT-5 and o-series models',
  anthropic: 'Claude models',
  gemini: 'Gemini, with a free tier',
  google: 'Gemini, with a free tier',
  deepseek: 'Fast and inexpensive',
  openrouter: 'Hundreds of models, one key',
  groq: 'Very fast open models',
  mistral: 'Mistral and Codestral',
  xai: 'Grok models',
  together: 'Open models at scale',
  fireworks: 'Fast open models',
  cerebras: 'Very fast open models',
  ollama: 'Runs on this computer',
  lmstudio: 'Runs on this computer',
  'lm-studio': 'Runs on this computer',
  custom: 'Any OpenAI-compatible API',
};

/** A preset's tagline: the known one, else its first model. */
export function presetTagline(p: ProviderPreset): string {
  return PRESET_TAGLINES[p.id] ?? (p.needsKey ? (p.models[0] ?? p.kind) : 'Local server, no key');
}

/** A fresh connection from a preset. */
export function connectionFromPreset(p: ProviderPreset): ProviderConfig {
  return {
    id: `${p.id}-${Date.now().toString(36)}`,
    presetId: p.id,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.models[0] ?? '',
    ...(p.headers ? { headers: { ...p.headers } } : {}),
    tools: true,
    vision: p.vision ?? false,
  };
}

/** The presets onboarding shows first; the rest behind "More providers". */
const FEATURED = ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'groq', 'ollama', 'lmstudio', 'custom'];

/** The grid of presets, for onboarding and "Add connection" (`featured`: the common ones first, the rest on demand). */
export function PresetGrid({ onPick, className, featured = false }: { onPick: (preset: ProviderPreset) => void; className?: string; featured?: boolean }) {
  const [all, setAll] = useState(!featured);
  const list = all ? PROVIDER_PRESETS : PROVIDER_PRESETS.filter((p) => FEATURED.includes(p.id));
  const hidden = PROVIDER_PRESETS.length - list.length;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <ul className="grid grid-cols-1 gap-1.5 @xs:grid-cols-2">
        {list.map((p) => (
          <li key={p.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(p)}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border border-border-subtle bg-card px-3 py-2 text-left outline-none transition-colors hover:border-border hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="w-full truncate text-sm font-medium">{p.label}</span>
              <span className="w-full truncate text-xs text-muted-foreground">{presetTagline(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="xs" className="self-center" onPress={() => setAll(true)}>
          {`More providers (${hidden})`}
        </Button>
      )}
    </div>
  );
}

function GeneralSettings() {
  const { controller } = usePanel();
  const { settings } = useAssistant(controller);
  const uid = useId();
  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-sm font-semibold">General</h3>
      <FieldGroup className="gap-5">
        <FieldSet>
          <FieldLegend variant="label">What the assistant may do by default</FieldLegend>
          <RadioGroup value={settings.autonomy} onChange={(v) => controller.updateSettings({ autonomy: v as AutonomyMode })} aria-label="Autonomy">
            {AUTONOMY.map((m) => (
              <Field key={m.id} orientation="horizontal">
                <RadioGroupItem value={m.id} id={`${uid}-${m.id}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`${uid}-${m.id}`}>
                    <m.icon className="size-3.5 text-muted-foreground" aria-hidden />
                    {m.label}
                  </FieldLabel>
                  <FieldDescription>{m.description}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${uid}-remember`}>Remember API keys</FieldLabel>
            <FieldDescription>Keeps keys in this browser’s local storage. Off: they are forgotten when you close the tab.</FieldDescription>
          </FieldContent>
          <Switch id={`${uid}-remember`} isSelected={settings.rememberKeys} onChange={(v) => controller.updateSettings({ rememberKeys: v })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${uid}-reasoning`}>Show reasoning</FieldLabel>
            <FieldDescription>Shows the model’s thinking above its answers, collapsed.</FieldDescription>
          </FieldContent>
          <Switch id={`${uid}-reasoning`} isSelected={settings.showReasoning} onChange={(v) => controller.updateSettings({ showReasoning: v })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`${uid}-steps`}>Max steps per turn</FieldLabel>
            <FieldDescription>How many model round-trips one question may take before the assistant stops and asks.</FieldDescription>
          </FieldContent>
          <Input
            id={`${uid}-steps`}
            type="number"
            min={1}
            max={50}
            className="w-20"
            value={settings.maxSteps}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 50) controller.updateSettings({ maxSteps: n });
            }}
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

type View = { kind: 'connection'; id: string } | { kind: 'new'; config: ProviderConfig } | { kind: 'add' } | { kind: 'general' };

function initialView(target: SettingsTarget | undefined, providers: ProviderConfig[], activeId: string | null): View {
  if (target?.section === 'general') return { kind: 'general' };
  if (target?.presetId) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === target.presetId);
    if (preset) return { kind: 'new', config: connectionFromPreset(preset) };
  }
  const id = target?.providerId ?? activeId ?? providers[0]?.id;
  if (id && providers.some((p) => p.id === id)) return { kind: 'connection', id };
  return { kind: 'add' };
}

/**
 * The settings: connections on the left (and Add connection), the selected
 * one's form on the right, and the general options. Modal; focus returns to
 * what opened it.
 */
export function SettingsDialog({ isOpen, onOpenChange, target }: { isOpen: boolean; onOpenChange: (open: boolean) => void; target?: SettingsTarget }) {
  const { controller } = usePanel();
  const { settings } = useAssistant(controller);
  const [view, setView] = useState<View>(() => initialView(target, settings.providers, settings.activeProviderId));

  useEffect(() => {
    if (isOpen) setView(initialView(target, settings.providers, settings.activeProviderId));
    // only when it opens or is re-targeted, not on every settings change
  }, [isOpen, target]);

  const navClass = (active: boolean) =>
    cn(
      'flex min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:w-full',
      active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
    );

  const selectedConnection = view.kind === 'connection' ? settings.providers.find((p) => p.id === view.id) : undefined;

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="gap-0 p-0 sm:max-w-3xl" aria-label="Assistant settings">
      <div className="flex max-h-[min(760px,calc(100dvh-2rem))] min-w-0 flex-col gap-4">
      <DialogHeader className="px-5 pt-5 pe-12">
        <DialogTitle>Assistant settings</DialogTitle>
        <DialogDescription>Connect a model with your own key. Requests go straight from this browser to the provider.</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border-subtle sm:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-subtle p-2 sm:w-52 sm:flex-col sm:overflow-y-auto sm:border-e sm:border-b-0">
          <span className="hidden px-2.5 pt-1 pb-1 text-xs font-medium text-muted-foreground sm:block">Connections</span>
          {settings.providers.map((p) => {
            const selected = view.kind === 'connection' && view.id === p.id;
            return (
              <button key={p.id} type="button" aria-current={selected || undefined} onClick={() => setView({ kind: 'connection', id: p.id })} className={navClass(selected)}>
                <span className={cn('size-1.5 shrink-0 rounded-full', p.id === settings.activeProviderId ? 'bg-success' : 'bg-transparent')} aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">{p.label}</span>
                  <span className="hidden truncate font-mono text-xs sm:block">{p.model}</span>
                </span>
                {p.id === settings.activeProviderId && <span className="sr-only">(in use)</span>}
              </button>
            );
          })}
          <button type="button" onClick={() => setView({ kind: 'add' })} aria-current={view.kind === 'add' || view.kind === 'new' || undefined} className={navClass(view.kind === 'add' || view.kind === 'new')}>
            <PlusIcon className="size-3.5 shrink-0" aria-hidden />
            Add connection
          </button>
          <span className="mx-1 my-1 hidden border-t border-border-subtle sm:block" />
          <button type="button" aria-current={view.kind === 'general' || undefined} onClick={() => setView({ kind: 'general' })} className={navClass(view.kind === 'general')}>
            <SlidersHorizontalIcon className="size-3.5 shrink-0" aria-hidden />
            General
          </button>
        </nav>
        <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
          {view.kind === 'general' && <GeneralSettings />}
          {view.kind === 'add' && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">Add a connection</h3>
                <p className="text-xs text-muted-foreground">Pick a provider. Local servers (Ollama, LM Studio) need no key.</p>
              </div>
              <PresetGrid onPick={(p) => setView({ kind: 'new', config: connectionFromPreset(p) })} />
              {settings.providers.length > 0 && (
                <Button variant="ghost" size="sm" className="self-start" onPress={() => setView(initialView(undefined, settings.providers, settings.activeProviderId))}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          {view.kind === 'new' && (
            <ConnectionForm
              key={view.config.id}
              initial={view.config}
              preset={PROVIDER_PRESETS.find((p) => p.id === view.config.presetId)}
              isNew
              isActive={false}
              onSaved={(c) => setView({ kind: 'connection', id: c.id })}
              onRemoved={() => setView({ kind: 'add' })}
            />
          )}
          {view.kind === 'connection' && selectedConnection && (
            <ConnectionForm
              key={selectedConnection.id}
              initial={selectedConnection}
              preset={PROVIDER_PRESETS.find((p) => p.id === selectedConnection.presetId)}
              isNew={false}
              isActive={selectedConnection.id === settings.activeProviderId}
              onSaved={() => undefined}
              onRemoved={() => setView({ kind: 'add' })}
            />
          )}
        </div>
      </div>
      </div>
    </Dialog>
  );
}
