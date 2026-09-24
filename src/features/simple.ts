import type { App } from '../ui/app';
import { h } from '../ui/dom';
import type { FeatureModule } from './registry';

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
    this.app.refreshWellOptions();
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
    this.app.refreshWellOptions();
    this.announced = true;
    this.app.notifyFeatures();
  }
  settings() {
    const list = h('div', { class: 'feat-list' });
    for (const w of this.app.field.wells.filter((x) => x.extra)) {
      const b = h('button', { class: 'btn', title: w.summary }, w.name);
      b.onclick = () => this.app.selectWell(w.id);
      list.append(b);
    }
    return list;
  }
}
