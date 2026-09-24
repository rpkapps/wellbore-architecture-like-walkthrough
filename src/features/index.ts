import type { App } from '../ui/app';
import { ContactsFeature } from './contacts';
import { CurtainFeature } from './curtain';
import { GeosteerFeature } from './geosteer';
import { MeasureFeature } from './measure';
import type { FeatureModule } from './registry';
import { SectionFeature } from './section';
import { ExtraWellsFeature, RopFeature, SeaFxFeature, ShadowsFeature, TunnelFxFeature } from './simple';
import { SimulationFeature } from './simulation';
import { SnapshotFeature } from './snapshot';
import { UncertaintyFeature } from './uncertainty';
import { ViewsFeature } from './views';

/** One instance of every optional feature; the Features panel switches them on and off. */
export function createFeatureModules(app: App): FeatureModule[] {
  return [
    new GeosteerFeature(app),
    new CurtainFeature(app),
    new SectionFeature(app),
    new ContactsFeature(app),
    new RopFeature(app),
    new UncertaintyFeature(app),
    new ExtraWellsFeature(app),
    new SimulationFeature(app),
    new ShadowsFeature(app),
    new TunnelFxFeature(app),
    new SeaFxFeature(app),
    new MeasureFeature(app),
    new ViewsFeature(app),
    new SnapshotFeature(app),
  ];
}
