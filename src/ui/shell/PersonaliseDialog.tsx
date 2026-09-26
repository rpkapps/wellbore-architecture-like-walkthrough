import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { CheckIcon, MonitorIcon, MoonIcon, MountainIcon, SparklesIcon, SunIcon, WavesIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FEATURE_BY_ID, GRAPHICS_IDS, graphicsQuality, labelOf, setGraphicsQuality, type FeatureModule, type GraphicsId, type GraphicsQuality } from '../../features/registry';
import type { App } from '../app';
import { Note, SelectField, SwitchField } from '../controls';
import { useFlags } from '../flags';
import { ACCENTS, DEFAULT_PREFS, prefs, setAllOverlays, setPrefs, type Density, type LabelDensity, type Theme } from '../prefs';
import { ScrubField } from '../scrub';
import { Rev, useRev, useSignal } from '../signal';
import { SwitchGroup, SwitchRow } from '../switchGroup';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="type-section">{title}</h3>
      {children}
    </section>
  );
}

/** Settings: how the workspace looks and moves (density, accent, panel glass, overlays, labels, motion) and the 3D graphics quality. */
export function PersonaliseDialog({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const p = useSignal(prefs);
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Saved in this browser. Changes apply at once.</DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[65vh] flex-col gap-5 overflow-x-hidden overflow-y-auto pr-1">
        <Group title="Appearance">
          <div className="flex h-7 items-center justify-between gap-2">
            <span className="type-label">Theme</span>
            <ToggleGroup
              aria-label="Theme"
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[p.theme]}
              onSelectionChange={(k) => k.size && setPrefs({ theme: String([...k][0]) as Theme })}
            >
              <ToggleGroupItem id="dark">
                <MoonIcon data-icon="inline-start" />
                Dark
              </ToggleGroupItem>
              <ToggleGroupItem id="light">
                <SunIcon data-icon="inline-start" />
                Light
              </ToggleGroupItem>
              <ToggleGroupItem id="system">
                <MonitorIcon data-icon="inline-start" />
                System
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex h-7 items-center justify-between gap-2">
            <span className="type-label">Density</span>
            <ToggleGroup
              aria-label="Density"
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[p.density]}
              onSelectionChange={(k) => k.size && setPrefs({ density: String([...k][0]) as Density })}
            >
              <ToggleGroupItem id="compact">Compact</ToggleGroupItem>
              <ToggleGroupItem id="default">Default</ToggleGroupItem>
              <ToggleGroupItem id="comfortable">Roomy</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex h-8 items-center justify-between gap-2">
            <span className="type-label">Accent</span>
            <div role="radiogroup" aria-label="Accent colour" className="flex items-center gap-1.5">
              {ACCENTS.map((a) => {
                const on = p.accent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={a.label}
                    title={a.label}
                    onClick={() => setPrefs({ accent: a.id })}
                    className={`flex size-6 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring ${on ? 'ring-2 ring-fg-1' : 'hover:scale-110'} transition-transform`}
                    style={{ background: `var(--tecton-palette-${a.step})` }}
                  >
                    {on && <CheckIcon className="size-3.5 text-background" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>
          <ScrubField label="Panel opacity" value={Math.round(p.panelOpacity * 100)} min={55} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => setPrefs({ panelOpacity: v / 100 })} />
          <ScrubField label="Background blur" value={p.panelBlur} min={0} max={20} step={1} format={(v) => `${v} px`} onChange={(v) => setPrefs({ panelBlur: v })} />
          <p className="type-caption">Blur behind panels costs GPU time over a moving 3D view.</p>
        </Group>
        <Group title="Overlays">
          <SwitchField label="Start collapsed to one line" isSelected={p.overlaysCollapsed} onChange={(v) => setPrefs({ overlaysCollapsed: v })} />
          <div className="-ml-2 flex gap-0.5">
            <Button variant="ghost" size="xs" onPress={() => setAllOverlays(true)}>
              Collapse all now
            </Button>
            <Button variant="ghost" size="xs" onPress={() => setAllOverlays(false)}>
              Expand all now
            </Button>
          </div>
        </Group>
        <Group title="3D view">
          <SwitchField
            label="Labels in the scene"
            isSelected={p.labels}
            onChange={(v) => {
              setPrefs({ labels: v });
              app.setDisplay({ labels: v });
            }}
          />
          <SelectField
            label="Label density"
            value={p.labelDensity}
            onChange={(v) => setPrefs({ labelDensity: v as LabelDensity })}
            options={[
              { id: 'all', label: 'All labels' },
              { id: 'near', label: 'Hide distant and overlapping' },
              { id: 'few', label: 'Only the essentials' },
            ]}
          />
          <SwitchField label="Show the task bar for the selection" isSelected={p.taskBar} onChange={(v) => setPrefs({ taskBar: v })} />
        </Group>
        <Group title="Graphics">
          <Graphics app={app} />
        </Group>
        <Group title="Motion">
          <SwitchField label="Reduce motion (no transitions, instant camera moves)" isSelected={p.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} />
        </Group>
      </div>
      <DialogFooter>
        <Button variant="ghost" onPress={() => (setPrefs(DEFAULT_PREFS), app.setDisplay({ labels: DEFAULT_PREFS.labels }))}>
          Reset to defaults
        </Button>
        <Button onPress={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}

const GRAPHICS_ICONS: Record<GraphicsId, ReactNode> = { textures: <MountainIcon />, shadows: <SunIcon />, tunnelFx: <SparklesIcon />, seaFx: <WavesIcon /> };

const QUALITY_NOTE: Record<GraphicsQuality | 'custom', string> = {
  low: 'Procedural materials; no shadows, sea effects or inside-the-hole effects. For integrated GPUs, remote desktops and VMs.',
  medium: 'Photo textures and the sea surface; no shadows or inside-the-hole effects, which cost the most per frame.',
  high: 'Every effect on.',
  custom: 'Choose each effect below.',
};

const noRev = new Rev();

/**
 * Graphics: a Quality preset (Low, Medium, High) for the four GPU-heavy
 * effects, or Custom, which shows a switch for each. The preset shown is the
 * one the switches match, so it stays true whichever way they were set (the
 * palette, `?q=low`, which starts at Low).
 */
function Graphics({ app }: { app: App }) {
  const on = useFlags(app.flags, GRAPHICS_IDS);
  const matched = graphicsQuality((id) => on[GRAPHICS_IDS.indexOf(id)]);
  // Custom stays chosen while the switches are changed, even when they happen to match a preset
  const [custom, setCustom] = useState(matched === 'custom');
  const quality = custom ? 'custom' : matched;
  const low = app.engine.quality === 'low';
  return (
    <>
      <div className="flex h-7 items-center justify-between gap-2">
        <span className="type-label">Quality</span>
        <ToggleGroup
          aria-label="Graphics quality"
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[quality]}
          onSelectionChange={(k) => {
            const q = [...k][0];
            if (q === undefined) return;
            setCustom(q === 'custom');
            if (q !== 'custom') setGraphicsQuality(app.flags, q as GraphicsQuality);
          }}
        >
          <ToggleGroupItem id="low">Low</ToggleGroupItem>
          <ToggleGroupItem id="medium">Medium</ToggleGroupItem>
          <ToggleGroupItem id="high">High</ToggleGroupItem>
          <ToggleGroupItem id="custom">Custom</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p className="type-caption">{QUALITY_NOTE[quality]}</p>
      {custom && (
        <SwitchGroup
          title="Effects"
          noun="effects"
          on={on.filter(Boolean).length}
          total={GRAPHICS_IDS.length}
          onAll={(v) => GRAPHICS_IDS.forEach((id) => app.flags.set(id, v))}
          actionSlots={GRAPHICS_IDS.some((id) => app.modules.get(id)?.settings) ? 1 : 0}
          className="-mx-3 border-t-0"
        >
          {GRAPHICS_IDS.map((id, i) => {
            const m = app.modules.get(id);
            return (
              <SwitchRow
                key={id}
                icon={GRAPHICS_ICONS[id]}
                name={labelOf(id)}
                description={FEATURE_BY_ID.get(id)!.desc}
                badges={
                  <Badge variant="outline" title="Uses extra GPU time" className="h-4! rounded-sm! px-1! text-[0.68rem]! leading-none font-semibold! tracking-wide">
                    GPU
                  </Badge>
                }
                isSelected={on[i]}
                onChange={(v) => app.flags.set(id, v)}
                settings={m?.settings ? () => <EffectSettings m={m} /> : undefined}
              />
            );
          })}
        </SwitchGroup>
      )}
      <Note>{low ? 'Running in performance mode (?q=low in the address): pixel ratio 1, no MSAA, no bloom.' : 'On a slow GPU, add ?q=low to the address for performance mode: pixel ratio 1, no MSAA, no bloom, and Low quality.'}</Note>
    </>
  );
}

/** An effect's own notes (the texture credits); they re-render when it bumps its revision. */
function EffectSettings({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <>{m.settings!()}</>;
}
