import { Button } from '@tecton/react/components/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { App } from '../app';
import { SelectField, SwitchField } from '../controls';
import { ACCENTS, DEFAULT_PREFS, prefs, setAllOverlays, setPrefs, type Density, type LabelDensity, type Theme } from '../prefs';
import { ScrubField } from '../scrub';
import { useSignal } from '../signal';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="type-section">{title}</h3>
      {children}
    </section>
  );
}

/** How the workspace looks and moves: density, accent, panel glass, overlays, labels, motion. */
export function PersonaliseDialog({ app, isOpen, onOpenChange }: { app: App; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const p = useSignal(prefs);
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Personalise</DialogTitle>
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
