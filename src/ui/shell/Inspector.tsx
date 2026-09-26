import { Button } from '@tecton/react/components/button';
import { Separator } from '@tecton/react/components/separator';
import { Panel, PanelActions, PanelContent, PanelDescription, PanelFooter, PanelHeader, PanelTitle } from '@tecton/react/tecton/panel';
import { CheckIcon, XIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { App } from '../app';
import { IconButton } from '../icon-button';
import { ProvBadge } from '../prov';
import { useRev, useSignal } from '../signal';
import { CollapseButton, OverlayChip, SURFACE, useCollapsed } from './overlay';

/**
 * Details of the selected object, over the 3D view: shown while the
 * Properties panel is closed (or hidden behind another tab), which otherwise
 * shows them. Closing it clears the selection.
 */
export function InspectorCard({ app }: { app: App }) {
  const v = useSignal(app.inspector);
  // toggle actions (isolate) show the scene's current state
  useRev(app.sceneRev);
  const [collapsed, setCollapsed] = useCollapsed('inspector');
  if (!v) return null;
  const close = (
    <IconButton label="Close" size="icon-xs" onPress={() => app.select(null)}>
      <XIcon />
    </IconButton>
  );
  if (collapsed)
    return (
      <OverlayChip name="details" onExpand={() => setCollapsed(false)} end={close}>
        <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: v.color }} />
        <span className="type-title max-w-48 truncate">{v.title}</span>
      </OverlayChip>
    );
  return (
    <Panel variant="elevated" size="sm" aria-label={v.title} className={`min-h-0 w-80 max-w-full shrink ${SURFACE}`}>
      <PanelHeader className="flex-wrap">
        <span aria-hidden className="mt-0.5 size-3 shrink-0 rounded-[3px]" style={{ background: v.color }} />
        <PanelTitle className="type-title">{v.title}</PanelTitle>
        <PanelActions className="gap-0">
          <CollapseButton collapsed={false} name="details" onChange={setCollapsed} />
          {close}
        </PanelActions>
        <PanelDescription className="type-caption">{v.sub}</PanelDescription>
        {v.badge && (
          <ProvBadge prov={v.badge.prov} className="mt-1">
            {v.badge.text}
          </ProvBadge>
        )}
      </PanelHeader>
      <PanelContent className="flex flex-col gap-3">
        {/* names and values wrap rather than hide behind an ellipsis */}
        <dl className="grid grid-cols-[minmax(5.5rem,1fr)_minmax(0,auto)_auto] items-baseline gap-x-3 gap-y-1">
          {v.rows.map((r, i) => {
            if (r === 'sep') return <Separator key={i} emphasis="subtle" className="col-span-3 my-1" />;
            if (!Array.isArray(r))
              return (
                <dt key={i} className="type-section col-span-3 pt-1.5">
                  {r.h}
                </dt>
              );
            const [k, val, prov] = r;
            return (
              <Fragment key={i}>
                <dt className="type-label leading-snug">{k}</dt>
                <dd className="type-value text-right leading-snug [overflow-wrap:anywhere]">{val}</dd>
                <dd className="flex justify-end self-center">{prov ? <ProvBadge prov={prov} short /> : null}</dd>
              </Fragment>
            );
          })}
        </dl>
        {v.desc && <div className="type-caption leading-relaxed">{v.desc}</div>}
      </PanelContent>
      {v.actions && v.actions.length > 0 && (
        <PanelFooter>
          {v.actions.map((a) => {
            const on = a.pressed?.();
            return (
              <Button key={a.label} size="sm" variant={a.primary ? 'default' : on ? 'secondary' : 'ghost'} aria-pressed={a.pressed ? on : undefined} onPress={a.onPress}>
                {on && <CheckIcon data-icon="inline-start" />}
                {a.label}
              </Button>
            );
          })}
        </PanelFooter>
      )}
    </Panel>
  );
}
