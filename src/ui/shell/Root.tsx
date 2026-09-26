import { Toaster } from '@tecton/react/components/sonner';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { loadVolve } from '../../data/dataset';
import { appActions } from '../../actions/appActions';
import { App } from '../app';
import { prefs, resolvedTheme } from '../prefs';
import { useSignal } from '../signal';
import { Loader } from './Loader';
import { Workspace } from './Workspace';

/** The loader stays at least this long before it starts to leave, so a fast load never flashes it. */
const LOADER_MIN_MS = 2000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** After the next frame is painted. */
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

type Boot = { stage: 'loading'; msg: string; f: number } | { stage: 'failed'; msg: string } | { stage: 'running'; app: App };

/**
 * Loads the preloaded Volve dataset behind a progress screen, then mounts the
 * workspace and flies from a high establishing shot down to the field.
 */
export function Root() {
  const [boot, setBoot] = useState<Boot>({ stage: 'loading', msg: 'Initialising…', f: 0 });
  const [progress, setProgress] = useState({ msg: 'Initialising…', f: 0 });
  const [loader, setLoader] = useState<'shown' | 'leaving' | 'gone'>('shown');

  useEffect(() => {
    let cancelled = false;
    const shownAt = performance.now();
    loadVolve('./data/volve/', (msg, f) => setProgress({ msg, f }))
      .then(async (field) => {
        if (cancelled) return;
        // the model is built in one go: show the step before it starts
        setProgress({ msg: 'Building the geological model', f: 0.82 });
        await paint();
        const app = new App(field);
        app.onBootStep = (msg, f) => setProgress({ msg, f });
        app.actions.register(...appActions());
        const twin = { app, field, engine: undefined as unknown, actions: app.actions };
        (window as unknown as Record<string, unknown>).twin = twin;
        void app.whenReady.then(async () => {
          const e = app.engine;
          twin.engine = e;
          // cinematic start: high establishing shot, then settle on the field overview
          const o = e.overviewPose();
          e.rig.setMode('explore');
          e.rig.setExploreView('orbit');
          // the view toolbar shows the navigation mode from the view revision
          app.viewRev.bump();
          e.camera.position
            .copy(o.pos)
            .multiplyScalar(1.8)
            .setY(o.pos.y + 3500);
          e.camera.lookAt(o.target);
          e.rig.orbit.target.copy(o.target);
          e.start();
          setProgress({ msg: 'Ready', f: 1 });
          // the line fills, and the loader has been up for at least LOADER_MIN_MS
          await wait(Math.max(700, LOADER_MIN_MS - (performance.now() - shownAt)));
          // the words lift away and the particles burst
          setLoader('leaving');
          await wait(650);
          // then the loader opens from the middle onto the scene (a view transition started by
          // hand, once, before any of React's own: the loader and the logo carry transition
          // names only meanwhile), the logo flies into the top bar, the camera sweeps down,
          // and the workspace settles in around it
          const html = document.documentElement;
          const done = () =>
            flushSync(() => {
              html.setAttribute('data-intro', '');
              setLoader('gone');
            });
          const vt = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
          if (vt && !html.hasAttribute('data-reduce-motion')) {
            html.setAttribute('data-vt-loader', '');
            vt.call(document, done).finished.finally(() => html.removeAttribute('data-vt-loader'));
          } else done();
          e.rig.flyTo(o.pos, o.target, 5);
          setTimeout(() => html.removeAttribute('data-intro'), 2600);
        });
        setBoot({ stage: 'running', app });
      })
      .catch((err: Error) => {
        console.error(err);
        if (!cancelled) setBoot({ stage: 'failed', msg: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {boot.stage === 'running' && <Workspace app={boot.app} brand={loader === 'gone'} />}
      {loader !== 'gone' && <Loader progress={progress} failed={boot.stage === 'failed' ? boot.msg : null} leaving={loader === 'leaving'} />}
      <Toasts />
    </>
  );
}

/** The toaster follows the theme; subscribing here keeps a preference change from re-rendering the app. */
function Toasts() {
  const theme = resolvedTheme(useSignal(prefs));
  return <Toaster theme={theme} position="top-center" offset={56} />;
}
