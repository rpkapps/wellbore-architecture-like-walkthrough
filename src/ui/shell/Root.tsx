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
    loadVolve('./data/volve/', (msg, f) => setProgress({ msg, f }))
      .then((field) => {
        if (cancelled) return;
        setProgress({ msg: 'Building geological model and wellbore geometry', f: 0.86 });
        const app = new App(field);
        app.actions.register(...appActions());
        const twin = { app, field, engine: undefined as unknown, actions: app.actions };
        (window as unknown as Record<string, unknown>).twin = twin;
        void app.whenReady.then(() => {
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
          setTimeout(() => {
            // the particles burst, then the loader leaves in a view transition
            // (its logo flies into the top bar) while the camera sweeps down
            setLoader('leaving');
            setTimeout(() => {
              // started by hand, once, before any of React's own transitions:
              // the loader and the logo carry transition names only meanwhile
              const done = () => flushSync(() => setLoader('gone'));
              const html = document.documentElement;
              const vt = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
              if (vt && !html.hasAttribute('data-reduce-motion')) {
                html.setAttribute('data-vt-loader', '');
                vt.call(document, done).finished.finally(() => html.removeAttribute('data-vt-loader'));
              } else done();
              e.rig.flyTo(o.pos, o.target, 3.2);
            }, 520);
          }, 300);
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
