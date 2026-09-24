import { FEATURES, type FeatureFlags, type FeatureGroup, type FeatureId, type FeatureModule } from '../features/registry';
import { chip, h } from './dom';
import { I } from './icons';

/** Pop-over listing every optional feature with an on/off switch and its settings. */
export class FeaturesPanel {
  readonly el: HTMLElement;
  private rows = new Map<FeatureId, { input: HTMLInputElement; settings: HTMLElement; row: HTMLElement }>();

  constructor(
    private flags: FeatureFlags,
    private modules: Map<FeatureId, FeatureModule>,
    lowQuality: boolean,
  ) {
    const body = h('div', { class: 'panel-body' });
    const onCount = h('span', { class: 'micro' });
    const updateCount = () => (onCount.textContent = `${FEATURES.filter((f) => flags.on(f.id)).length} of ${FEATURES.length} on`);
    this.el = h(
      'div',
      { class: 'features-pop glass hidden' },
      h(
        'div',
        { class: 'panel-head' },
        h('h3', {}, 'Features'),
        onCount,
        h(
          'div',
          { style: 'display:flex;gap:4px' },
          h('button', { class: 'btn', title: 'Switch every feature on', onclick: () => FEATURES.forEach((f) => flags.set(f.id, true)) }, 'All on'),
          h('button', { class: 'btn', title: 'Switch every feature off', onclick: () => FEATURES.forEach((f) => flags.set(f.id, false)) }, 'All off'),
          h('button', { class: 'btn icon ghost', title: 'Reset to defaults', html: I.reset, onclick: () => flags.resetDefaults(lowQuality) }),
          h('button', { class: 'btn icon ghost', title: 'Close', html: I.close, onclick: () => this.hide() }),
        ),
      ),
      body,
    );
    const groups = new Map<FeatureGroup, HTMLElement>();
    for (const f of FEATURES) {
      if (!groups.has(f.group)) {
        const sec = h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', { class: 'micro' }, f.group)));
        groups.set(f.group, sec);
        body.append(sec);
      }
      const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = flags.on(f.id);
      input.onchange = () => flags.set(f.id, input.checked);
      const settings = h('div', { class: 'feat-settings' });
      const row = h(
        'div',
        { class: `feat${input.checked ? ' on' : ''}`, 'data-id': f.id },
        h(
          'div',
          { class: 'feat-top' },
          h('div', { class: 'feat-name' }, h('b', {}, f.name), f.prov ? h('span', { html: chip(f.prov) }) : null, f.gpu ? h('span', { class: 'feat-gpu', title: 'Uses extra GPU time' }, 'GPU') : null),
          h('label', { class: 'switch' }, input, h('span')),
        ),
        h('div', { class: 'feat-desc' }, f.desc),
        settings,
      );
      groups.get(f.group)!.append(row);
      this.rows.set(f.id, { input, settings, row });
    }
    flags.onAny((id, on) => {
      const r = this.rows.get(id);
      if (r) {
        r.input.checked = on;
        r.row.classList.toggle('on', on);
        this.renderSettings(id);
      }
      updateCount();
    });
    updateCount();
  }

  /** (Re)build the settings block of one feature — modules call this when their options change. */
  renderSettings(id: FeatureId) {
    const r = this.rows.get(id);
    if (!r) return;
    r.settings.innerHTML = '';
    if (!this.flags.on(id)) return;
    const s = this.modules.get(id)?.settings?.();
    if (s) r.settings.append(s);
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  show() {
    for (const id of this.rows.keys()) this.renderSettings(id);
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}
