import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Progress, ProgressLabel, ProgressValue } from '@tecton/react/components/progress';
import { Toaster } from '@tecton/react/components/sonner';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { loadVolve } from '../../data/dataset';
import { App } from '../app';
import { Logo } from '../logo';
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
        const twin = { app, field, engine: undefined as unknown };
        (window as unknown as Record<string, unknown>).twin = twin;
        void app.whenReady.then(() => {
          const e = app.engine;
          twin.engine = e;
          // cinematic start: high establishing shot, then settle on the field overview
          const o = e.overviewPose();
          e.rig.setMode('explore');
          e.rig.setExploreView('orbit');
          e.camera.position.copy(o.pos).multiplyScalar(1.8).setY(o.pos.y + 3500);
          e.camera.lookAt(o.target);
          e.rig.orbit.target.copy(o.target);
          e.start();
          setProgress({ msg: 'Ready', f: 1 });
          setTimeout(() => {
            setLoader('leaving');
            e.rig.flyTo(o.pos, o.target, 3.2);
            setTimeout(() => setLoader('gone'), 1200);
          }, 350);
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
      {boot.stage === 'running' && <Workspace app={boot.app} />}
      {loader !== 'gone' && <Loader progress={progress} failed={boot.stage === 'failed' ? boot.msg : null} leaving={loader === 'leaving'} />}
      <Toaster theme="dark" position="top-center" />
    </>
  );
}

function Loader({ progress, failed, leaving }: { progress: { msg: string; f: number }; failed: string | null; leaving: boolean }) {
  return (
    <div className={cn('fixed inset-0 z-50 grid place-items-center bg-background transition-opacity duration-1000', leaving && 'pointer-events-none opacity-0')}>
      <div className="flex w-full max-w-md flex-col gap-6 px-6">
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <h1 className="text-2xl font-medium">BoreWalk</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Walk a real wellbore in 3D. Loading the preloaded Equinor Volve open dataset — well logs, directional surveys, formation picks, operator interpretation and production history.
        </p>
        {failed ? (
          <Alert variant="destructive">
            <AlertTitle>The dataset failed to load</AlertTitle>
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        ) : (
          <Progress value={Math.round(progress.f * 100)} className="w-full">
            <ProgressLabel>{progress.msg}</ProgressLabel>
            <ProgressValue />
          </Progress>
        )}
        <p className="text-xs text-muted-foreground">
          Data: Equinor ASA and the Volve licence partners (ExxonMobil E&amp;P Norway, Bayerngas Norge), released under the Equinor Open Data Licence. Values shown are as published; calculated and reconstructed quantities are labelled throughout.
        </p>
      </div>
    </div>
  );
}
