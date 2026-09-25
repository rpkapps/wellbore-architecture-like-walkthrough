import { ToggleGroup, ToggleGroupItem } from '@tecton/react/components/toggle-group';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { TrajectoryIcon } from '@tecton/react/icons';
import { Panel } from '@tecton/react/tecton/panel';
import { CircleDotIcon, OrbitIcon, PlaneIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GuidedView } from '../../scene/cameraRig';
import type { App } from '../app';
import { useRev } from '../signal';
import { SURFACE } from './overlay';

/** The camera for the current navigation mode, floating in the corner of the 3D view. */
export function ViewControls({ app }: { app: App }) {
  useRev(app.viewRev, app.wellRev);
  const rig = app.engine.rig;
  const guided = rig.mode === 'guided';
  const views: [string, string, ReactNode][] = guided
    ? [
        ['tunnel', 'Inside the hole', <CircleDotIcon />],
        ['chase', 'Chase the bit', <TrajectoryIcon />],
        ['orbit', 'Orbit the bit', <OrbitIcon />],
      ]
    : [
        ['fly', 'Fly (WASD + drag)', <PlaneIcon />],
        ['orbit', 'Orbit', <OrbitIcon />],
      ];
  const view = guided ? rig.guidedView : rig.exploreView;
  return (
    <Panel variant="elevated" size="sm" aria-label="Camera" className={`w-fit ${SURFACE}`}>
      <div className="p-1">
        <ToggleGroup
          aria-label="Camera"
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[view]}
          onSelectionChange={(k) => {
            const v = k.size ? String([...k][0]) : null;
            if (!v) return;
            if (guided) app.setGuidedView(v as GuidedView);
            else app.setExploreView(v as 'fly' | 'orbit');
          }}
        >
          {views.map(([id, label, icon]) => (
            <TooltipTrigger key={id} delay={400}>
              <ToggleGroupItem id={id} aria-label={label}>
                {icon}
              </ToggleGroupItem>
              <Tooltip placement="top">{label}</Tooltip>
            </TooltipTrigger>
          ))}
        </ToggleGroup>
      </div>
    </Panel>
  );
}
