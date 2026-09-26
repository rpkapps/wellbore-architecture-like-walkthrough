import { createAssistant } from '../assistant/core/controller';
import type { AssistantController } from '../assistant/core/types';
import { AssistantPanel } from '../assistant/ui';
import type { App } from '../ui/app';
import { useSignal } from '../ui/signal';
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

/** The Assistant panel's body: it takes each focus request (⌘I, "Ask about this") the panel has not taken yet. */
export default function AssistantPanelHost({ app }: { app: App }) {
  const controller = ensureAssistant(app);
  const focusRequest = useSignal(composerFocus);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AssistantPanel controller={controller} onClose={() => closeAssistant(app)} focusRequest={focusRequest || undefined} />
    </div>
  );
}
