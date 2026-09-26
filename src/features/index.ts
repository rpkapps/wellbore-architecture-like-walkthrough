import type { App } from '../ui/app';
import { ContactsFeature } from './contacts';
import { CorrelationFeature } from './correlation';
import { CrossplotFeature } from './crossplot';
import { CurtainFeature } from './curtain';
import { GeosteerFeature } from './geosteer';
import { MapViewFeature } from './mapview';
import { MeasureFeature } from './measure';
import type { FeatureModule } from './registry';
import { SectionFeature } from './section';
import { ExtraWellsFeature, RopFeature, SeaFxFeature, ShadowsFeature, TexturesFeature, TunnelFxFeature } from './simple';
import { SimulationFeature } from './simulation';
import { SnapshotFeature } from './snapshot';
import { UncertaintyFeature } from './uncertainty';
import { ViewsFeature } from './views';

/** One instance of every optional feature; each is switched where it lives (its `home` in the registry). */
export function createFeatureModules(app: App): FeatureModule[] {
  return [
    new GeosteerFeature(app),
    new CurtainFeature(app),
    new SectionFeature(app),
    new CorrelationFeature(app),
    new CrossplotFeature(app),
    new ContactsFeature(app),
    new RopFeature(app),
    new UncertaintyFeature(app),
    new ExtraWellsFeature(app),
    new SimulationFeature(app),
    new MapViewFeature(app),
    new TexturesFeature(app),
    new ShadowsFeature(app),
    new TunnelFxFeature(app),
    new SeaFxFeature(app),
    new MeasureFeature(app),
    new ViewsFeature(app),
    new SnapshotFeature(app),
  ];
}
