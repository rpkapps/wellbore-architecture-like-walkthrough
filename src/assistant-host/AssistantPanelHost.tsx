import { useEffect, useRef } from 'react';
import { createAssistant } from '../assistant/core/controller';
import type { AssistantController } from '../assistant/core/types';
import { AssistantPanel } from '../assistant/ui';
import type { App } from '../ui/app';
import { borewalkHost } from './host';
import { closeAssistant, composerFocus } from './lazy';

/*
 * The assistant's chunk: loaded the first time the panel opens (or a question
 * is asked from the palette or a menu), never by the main bundle.
 */

const controllers = new WeakMap<App, AssistantController>();

/** The app's assistant, created once: it outlives the panel, so closing and reopening keeps the conversation (and a streaming answer). */
export function ensureAssistant(app: App): AssistantController {
  let c = controllers.get(app);
  if (!c) {
    c = createAssistant(borewalkHost(app));
    controllers.set(app, c);
  }
  return c;
}

/** Moves focus to the composer's text field inside `root`, when a focus was asked for. */
function takeFocus(root: HTMLElement | null) {
  if (!composerFocus.pending || !root) return;
  const field = root.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
  if (!field) return;
  composerFocus.pending = false;
  field.focus();
}

/** The Assistant panel's body. */
export default function AssistantPanelHost({ app }: { app: App }) {
  const controller = ensureAssistant(app);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // the panel may render its composer a frame after mounting (settings first, a lazy part)
    const focus = () => requestAnimationFrame(() => takeFocus(root.current));
    focus();
    return composerFocus.rev.subscribe(focus);
  }, []);
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <AssistantPanel controller={controller} onClose={() => closeAssistant(app)} />
    </div>
  );
}
