import { Badge } from '@tecton/react/components/badge';
import { Button } from '@tecton/react/components/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@tecton/react/components/field';
import { Separator } from '@tecton/react/components/separator';
import { Switch } from '@tecton/react/components/switch';
import { RotateCcwIcon } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { FEATURES, type FeatureGroup, type FeatureId, type FeatureModule } from '../../features/registry';
import { PanelAccordion, PanelSection } from '../section';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { ProvBadge } from '../prov';
import { Rev, useRev } from '../signal';

const GROUPS: FeatureGroup[] = [...new Set(FEATURES.map((f) => f.group))];
const noRev = new Rev();

/** Every optional feature with its on/off switch and, while on, its settings. */
export function FeaturesPanel({ app }: { app: App }) {
  const [, setTick] = useState(0);
  useEffect(() => app.flags.onAny(() => setTick((t) => t + 1)), [app]);
  const flags = app.flags;
  const low = app.engine.quality === 'low';
  const on = FEATURES.filter((f) => flags.on(f.id)).length;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {on} of {FEATURES.length} on
        </span>
        <Button variant="ghost" size="xs" onPress={() => FEATURES.forEach((f) => flags.set(f.id, true))}>
          All on
        </Button>
        <Button variant="ghost" size="xs" onPress={() => FEATURES.forEach((f) => flags.set(f.id, false))}>
          All off
        </Button>
        <IconButton label="Reset to defaults" size="icon-xs" onPress={() => flags.resetDefaults(low)}>
          <RotateCcwIcon />
        </IconButton>
      </div>
      <PanelAccordion defaultExpandedKeys={GROUPS}>
        {GROUPS.map((g) => {
          const list = FEATURES.filter((f) => f.group === g);
          return (
            <PanelSection
              key={g}
              id={g}
              title={g}
              aside={
                <span className="type-unit ml-auto pr-1 normal-case tracking-normal">
                  {list.filter((f) => flags.on(f.id)).length}/{list.length}
                </span>
              }
            >
              <div className="flex flex-col gap-2">
                {list.map((f, i) => (
                  <Fragment key={f.id}>
                    {i > 0 && <Separator emphasis="subtle" />}
                    <FeatureRow app={app} id={f.id} />
                  </Fragment>
                ))}
              </div>
            </PanelSection>
          );
        })}
      </PanelAccordion>
    </div>
  );
}

function FeatureRow({ app, id }: { app: App; id: FeatureId }) {
  const f = FEATURES.find((x) => x.id === id)!;
  const on = app.flags.on(id);
  const m = app.modules.get(id);
  const sid = `feature-${id}`;
  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal" className="gap-2">
        <FieldContent>
          <FieldLabel htmlFor={sid} className="flex-wrap text-[0.857rem]! font-medium! text-fg-1!">
            {f.name}
            {f.prov && <ProvBadge prov={f.prov} />}
            {f.gpu && (
              <Badge variant="outline" title="Uses extra GPU time">
                GPU
              </Badge>
            )}
          </FieldLabel>
          <FieldDescription className="type-caption! line-clamp-2" title={f.desc}>
            {f.desc}
          </FieldDescription>
        </FieldContent>
        <Switch id={sid} size="sm" isSelected={on} onChange={(v) => app.flags.set(id, v)} />
      </Field>
      {on && m?.settings && <Settings m={m} />}
    </div>
  );
}

function Settings({ m }: { m: FeatureModule }) {
  useRev(m.rev ?? noRev);
  return <div className="flex flex-col gap-1.5 border-l border-border-subtle pl-2.5">{m.settings!()}</div>;
}
