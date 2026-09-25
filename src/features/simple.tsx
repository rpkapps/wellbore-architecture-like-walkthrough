import { Button } from '@tecton/react/components/button';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import type { App } from '../ui/app';
import { Note } from '../ui/controls';
import type { FeatureModule } from './registry';
import { REAL, loadRealisticTextures, texturesLoaded } from '../scene/textures';

/** Sun shadows + log-depth ambient occlusion. */
export class ShadowsFeature implements FeatureModule {
  readonly id = 'shadows' as const;
  constructor(private app: App) {}
  enable() {
    this.app.engine.setShadows(true);
  }
  disable() {
    this.app.engine.setShadows(false);
  }
}

/** CC0 photo textures ⇄ procedural materials, switched live through one shared uniform. */
export class TexturesFeature implements FeatureModule {
  readonly id = 'textures' as const;
  private want = false;
  constructor(private app: App) {}
  enable() {
    this.want = true;
    if (!texturesLoaded) this.app.toast('Loading photo textures …');
    loadRealisticTextures()
      .then(() => {
        if (this.want) REAL.uRealistic.value = 1;
      })
      .catch((err) => this.app.toast(`Textures failed to load: ${(err as Error).message}`));
  }
  disable() {
    this.want = false;
    REAL.uRealistic.value = 0;
  }
  settings() {
    return (
      <Note>
        Poly Haven CC0 textures: sandstone <i>rock_06</i>, claystone <i>excavated_soil_wall</i>, chalk and marl <i>marble_cliff_03/02</i>, shales <i>dark_rock_02 / dark_rock</i>, Sleipner <i>cliff_side</i>, red beds <i>rock_boulder_cracked</i>, seabed <i>damp_sand</i>, casing <i>rusty_metal_sheet</i>, cement{' '}
        <i>concrete_floor_worn_001</i>. Photos are tinted to each formation’s colour and keep the modelled bedding. Full list: <code className="font-mono">public/textures/CREDITS.md</code>.
      </Note>
    );
  }
}

/** Lens blur + drilling-fluid particles in the Inside view. */
export class TunnelFxFeature implements FeatureModule {
  readonly id = 'tunnelFx' as const;
  constructor(private app: App) {}
  enable() {
    this.app.engine.setTunnelFx(true);
  }
  disable() {
    this.app.engine.setTunnelFx(false);
  }
}

/** Reflective sea surface + seabed ripples. */
export class SeaFxFeature implements FeatureModule {
  readonly id = 'seaFx' as const;
  constructor(private app: App) {}
  enable() {
    this.app.engine.setSeaFx(true);
  }
  disable() {
    this.app.engine.setSeaFx(false);
  }
}

/** Rate-of-penetration colouring mode. */
export class RopFeature implements FeatureModule {
  readonly id = 'rop' as const;
  constructor(private app: App) {}
  enable() {
    this.app.setPropertyAvailable('rop', true);
  }
  disable() {
    this.app.setPropertyAvailable('rop', false);
    if (this.app.engine.mode === 'rop') this.app.setProperty('resistivity');
  }
}

/** Additional logged Volve wellbores in the selector and as detailed paths. */
export class ExtraWellsFeature implements FeatureModule {
  readonly id = 'extraWells' as const;
  private announced = false;
  constructor(private app: App) {}
  enable() {
    const e = this.app.engine;
    e.paths.showExtra = true;
    e.paths.rebuild();
    this.app.wellRev.bump();
    const names = this.app.field.wells.filter((w) => w.extra).map((w) => w.name.replace('15/9-', ''));
    if (this.announced) this.app.toast(`${names.length} more Volve wells with logs: ${names.join(', ')} — pick one in the well selector`);
    this.announced = true;
    this.app.notifyFeatures();
  }
  disable() {
    const e = this.app.engine;
    if (e.activeWell?.extra) this.app.selectWell(this.app.field.primary.id);
    e.paths.showExtra = false;
    e.paths.rebuild();
    this.app.wellRev.bump();
    this.announced = true;
    this.app.notifyFeatures();
  }
  settings() {
    return (
      <div className="flex flex-wrap gap-1.5">
        {this.app.field.wells
          .filter((x) => x.extra)
          .map((w) => (
            <TooltipTrigger key={w.id} delay={400}>
              <Button variant="ghost" size="xs" onPress={() => this.app.selectWell(w.id)}>
                {w.name}
              </Button>
              <Tooltip>{w.summary}</Tooltip>
            </TooltipTrigger>
          ))}
      </div>
    );
  }
}
