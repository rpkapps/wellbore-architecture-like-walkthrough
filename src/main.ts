import './ui/styles.css';
import { loadVolve } from './data/dataset';
import { Engine } from './scene/engine';
import { App } from './ui/app';
import { h } from './ui/dom';
import { LOGO } from './ui/icons';

async function boot() {
  const root = document.getElementById('app')!;
  const bar = h('i');
  const status = h('div', { class: 'status' }, 'Initialising…');
  const loader = h(
    'div',
    { class: 'loader' },
    h(
      'div',
      { class: 'loader-inner' },
      h('div', { class: 'brand-mark', style: 'width:40px;height:40px;border-radius:11px', html: LOGO.replace(/18/g, '24') }),
      h('h1', {}, 'BoreWalk'),
      h('p', {}, 'Walk a real wellbore in 3D. Loading the preloaded Equinor Volve open dataset — well logs, directional surveys, formation picks, operator interpretation and production history.'),
      h('div', { class: 'bar' }, bar),
      status,
      h(
        'div',
        { class: 'credits' },
        'Data: Equinor ASA and the Volve licence partners (ExxonMobil E&P Norway, Bayerngas Norge), released under the Equinor Open Data Licence. Values shown are as published; calculated and reconstructed quantities are labelled throughout.',
      ),
    ),
  );
  document.body.append(loader);
  const progress = (msg: string, f: number) => {
    status.textContent = msg;
    bar.style.width = `${Math.round(f * 100)}%`;
  };
  try {
    const field = await loadVolve('./data/volve/', progress);
    const viewport = h('div', { class: 'viewport' });
    root.append(viewport);
    progress('Building geological model and wellbore geometry', 0.86);
    await new Promise((r) => setTimeout(r, 30));
    const engine = new Engine(viewport, field);
    const app = new App(field, engine, root);
    app.init();
    await app.ready;
    // cinematic start: high establishing shot, then settle on the field overview
    const o = engine.overviewPose();
    engine.rig.setMode('explore');
    engine.rig.setExploreView('orbit');
    engine.camera.position.copy(o.pos).multiplyScalar(1.8).setY(o.pos.y + 3500);
    engine.camera.lookAt(o.target);
    engine.rig.orbit.target.copy(o.target);
    engine.start();
    progress('Ready', 1);
    setTimeout(() => {
      loader.classList.add('done');
      engine.rig.flyTo(o.pos, o.target, 3.2);
      setTimeout(() => loader.remove(), 1200);
    }, 350);
    (window as unknown as Record<string, unknown>).twin = { engine, app, field };
  } catch (e) {
    console.error(e);
    status.innerHTML = `<span style="color:#ff8a8a">Failed to load: ${(e as Error).message}</span>`;
  }
}

boot();
