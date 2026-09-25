import { Panel } from '@tecton/react/tecton/panel';
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import { startTransition, useEffect, useState, ViewTransition, type ReactNode } from 'react';
import { overlayBroadcast, overlayState, prefs } from '../prefs';
import { useSignal } from '../signal';
import { IconButton } from '../icon-button';

/**
 * The surface of everything that floats over the 3D view: the app background
 * (with the opacity and blur the personalisation sets), a hairline border and
 * a soft drop shadow.
 */
export const SURFACE = 'rounded-lg! border-border-subtle! bg-panel! shadow-[0_10px_28px_-10px_rgb(0_0_0/0.65)]! backdrop-blur-(--panel-blur)';

/**
 * Widgets floating over the 3D view collapse to a one-line chip that keeps
 * their key numbers. The choice is remembered per widget in this browser.
 */
export function useCollapsed(id: string): [boolean, (v: boolean) => void] {
  const key = `bw.overlay.${id}`;
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? prefs.value.overlaysCollapsed : s === '1';
    } catch {
      return prefs.value.overlaysCollapsed;
    }
  });
  // "collapse / expand all" in the personalisation dialog
  const broadcast = useSignal(overlayBroadcast);
  useEffect(() => {
    if (broadcast) startTransition(() => setV(overlayState.collapsed));
  }, [broadcast]);
  const set = (on: boolean) => {
    // the panel and its chip morph into each other (view transition)
    startTransition(() => setV(on));
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* storage blocked: keep it for this session */
    }
  };
  return [v, set];
}

/** Wraps an overlay so its full and collapsed forms morph into each other. */
export function Morph({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ViewTransition name={`overlay-${name}`} share="overlay-morph" update="overlay-morph">
      {children}
    </ViewTransition>
  );
}

export function CollapseButton({ collapsed, onChange, name }: { collapsed: boolean; onChange: (v: boolean) => void; name: string }) {
  return (
    <IconButton label={collapsed ? `Expand ${name}` : `Collapse ${name}`} size="icon-xs" onPress={() => onChange(!collapsed)}>
      {collapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
    </IconButton>
  );
}

/** The collapsed form of an overlay: its essentials on one line, with the expand button at the end. */
export function OverlayChip({ name, onExpand, children, end }: { name: string; onExpand: () => void; children: ReactNode; end?: ReactNode }) {
  return (
    <Panel variant="elevated" size="sm" aria-label={name} className={`w-fit max-w-full ${SURFACE}`}>
      <div className="flex min-w-0 items-center gap-2 py-1 pr-1 pl-2">
        {children}
        <div className="flex shrink-0 items-center">
          {end}
          <CollapseButton collapsed name={name} onChange={() => onExpand()} />
        </div>
      </div>
    </Panel>
  );
}
