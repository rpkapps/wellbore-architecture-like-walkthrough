import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tecton/react/components/tabs';
import { XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { IconButton } from '../icon-button';
import { ProvBadge } from '../prov';
import { useRev, useSignal } from '../signal';
import { activeWindow, openWindows, type ToolWindow } from '../toolWindow';

/**
 * The tool windows of the optional features, as tabs under the 3D view. The
 * active tab's own controls sit at the end of the tab bar.
 */
export function Dock() {
  const open = useSignal(openWindows);
  const active = useSignal(activeWindow);
  const current = open.find((p) => p.opts.id === active) ?? open[0];
  if (!current) return null;
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
      <Tabs selectedKey={current.opts.id} onSelectionChange={(k) => activeWindow.set(String(k))} className="min-h-0 flex-1 gap-0">
        <div className="flex min-w-0 shrink-0 items-center border-b border-border-subtle py-1 pr-9 pl-1.5">
          <TabsList aria-label="Tool windows" className="h-8 min-w-0 shrink overflow-x-auto p-0.5">
            {open.map((p) => (
              <TabsTrigger key={p.opts.id} id={p.opts.id}>
                {p.opts.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {open.map((p) => (
          <TabsContent key={p.opts.id} id={p.opts.id} className="flex min-h-0 flex-col">
            <Header win={p} />
            <Body win={p} />
          </TabsContent>
        ))}
      </Tabs>
      {/* outside Tabs: React Aria renders everything inside it once more while it collects the tabs */}
      <div className="absolute top-1.5 right-1">
        <IconButton label={`Close ${current.opts.title}`} size="icon-xs" onPress={() => current.close()}>
          <XIcon />
        </IconButton>
      </div>
    </div>
  );
}

/** The active window's provenance and its own controls, on a row under the tabs. */
function Header({ win }: { win: ToolWindow }) {
  useRev(win.rev);
  if (!win.opts.badge && !win.opts.header) return null;
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-2 py-1">
      {win.opts.badge && <ProvBadge prov={win.opts.badge} />}
      {win.opts.header?.()}
    </div>
  );
}

function Body({ win }: { win: ToolWindow }) {
  useRev(win.rev);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => win.onResize?.());
    ro.observe(node);
    return () => ro.disconnect();
  }, [win]);
  return (
    <div ref={el} className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
      {win.opts.body()}
    </div>
  );
}
