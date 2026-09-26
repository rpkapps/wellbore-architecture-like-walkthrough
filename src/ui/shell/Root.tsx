import { Toaster } from '@tecton/react/components/sonner';
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { loadVolve } from '../../data/dataset';
import { loadRealisticTextures } from '../../scene/textures';
import { appActions } from '../../actions/appActions';
import { App } from '../app';
import { prefs, resolvedTheme } from '../prefs';
import { useSignal } from '../signal';
import { Loader } from './Loader';
import { Workspace } from './Workspace';

/** The loader stays at least this long before it starts to leave, so a fast load never flashes it. */
const LOADER_MIN_MS = 2000;
/** How long the loader takes to fade away over the workspace (the CSS of .loader[data-leaving] and .app-reveal). */
const LOADER_FADE_MS = 1600;
/** The intro's camera sweep from the establishing shot down to the field overview (s). */
const INTRO_FLIGHT_S = 6.5;
/** Input that ends the intro: the workspace comes in at once. */
const INPUTS = ['pointerdown', 'wheel', 'keydown'] as const;

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
          // cinematic start: a high establishing shot off to one side of the field, from which
          // the camera sweeps down around it to the overview
          const o = e.overviewPose();
          e.rig.setMode('explore');
          e.rig.setExploreView('orbit');
          // the view toolbar shows the navigation mode from the view revision
          app.viewRev.bump();
          const end = new THREE.Spherical().setFromVector3(o.pos.clone().sub(o.target));
          e.camera.position.setFromSpherical(new THREE.Spherical(end.radius * 2.4, end.phi * 0.55, end.theta - 0.95)).add(o.target);
          e.camera.lookAt(o.target);
          e.rig.orbit.target.copy(o.target);
          e.start();
          // the loader goes once the view has drawn, with its photo textures (8 s at most), so
          // nothing pops in under the fade
          setProgress({ msg: 'Drawing the first frames', f: 0.97 });
          await Promise.race([
            (async () => {
              await e.whenDrawn(2);
              if (app.flags.on('textures')) {
                await loadRealisticTextures();
                await e.whenDrawn(2);
              }
            })(),
            wait(8000),
          ]);
          setProgress({ msg: 'Ready', f: 1 });
          // the line fills, and the loader has been up for at least LOADER_MIN_MS
          await wait(Math.max(700, LOADER_MIN_MS - (performance.now() - shownAt)));
          // The intro: the loader fades away onto the 3D view alone, high above the field, and the
          // camera sweeps down around it to the overview; as it settles, the workspace (top bar,
          // rail, panels, timeline, overlays) fades in around it. Any input brings it in at once.
          const html = document.documentElement;
          const motion = !html.hasAttribute('data-reduce-motion');
          if (motion) html.setAttribute('data-intro', 'scene');
          let chromeShown = false;
          const showChrome = () => {
            if (chromeShown) return;
            chromeShown = true;
            for (const t of INPUTS) window.removeEventListener(t, showChrome, true);
            html.setAttribute('data-intro', 'chrome');
            setTimeout(() => html.removeAttribute('data-intro'), 1400);
            // messages held back while the loader showed
            app.releaseToasts();
          };
          for (const t of INPUTS) window.addEventListener(t, showChrome, true);
          setLoader('leaving');
          e.rig.flyTo(o.pos, o.target, INTRO_FLIGHT_S, undefined, { around: true });
          await wait(LOADER_FADE_MS);
          setLoader('gone');
          if (motion) setTimeout(showChrome, INTRO_FLIGHT_S * 1000 * 0.62 - LOADER_FADE_MS);
          else showChrome();
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
      {boot.stage === 'running' && (
        // hidden under the loader while it builds, then faded up as the loader fades away
        <div className="app-reveal h-svh w-full" data-veiled={loader === 'shown' || undefined}>
          <Workspace app={boot.app} />
        </div>
      )}
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
