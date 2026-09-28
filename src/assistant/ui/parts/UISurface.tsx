import { Component, memo, useCallback, type ErrorInfo, type ReactNode } from 'react';
import { LayoutDashboardIcon } from 'lucide-react';
import { A2UISurface } from '../../a2ui';
import type { UIEventPart, UIPart } from '../../core/types';
import { usePanel } from '../context';
import { useAssistantSelector } from '../useAssistant';

class SurfaceBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { failed: boolean; resetKey: unknown }> {
  state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { failed: boolean; resetKey: unknown }) {
    // new messages for the surface: try again
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('[assistant] a generated interface failed to render', error, info.componentStack);
  }
  render() {
    if (this.state.failed)
      return (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <LayoutDashboardIcon className="size-3.5" aria-hidden />
          This interface could not be displayed.
        </div>
      );
    return this.props.children;
  }
}

/** A generated interface (A2UI) in the transcript, guarded so a broken surface never takes the panel down. */
export const UISurface = memo(function UISurface({ part, streaming }: { part: UIPart; streaming: boolean }) {
  const { controller } = usePanel();
  // only the surfaces re-render when a tool adds a dataset
  const datasets = useAssistantSelector(controller, (s) => s.thread.datasets);
  const onAction = useCallback((event: Omit<UIEventPart, 'type'>) => controller.uiAction(event), [controller]);
  return (
    <div data-slot="assistant-ui-part" className="min-w-0">
      <SurfaceBoundary resetKey={part.messages}>
        <A2UISurface messages={part.messages} datasets={datasets} onAction={onAction} streaming={streaming} />
      </SurfaceBoundary>
    </div>
  );
});
