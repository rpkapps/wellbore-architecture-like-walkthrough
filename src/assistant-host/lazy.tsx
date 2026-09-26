import { Spinner } from '@tecton/react/components/spinner';
import { lazy, Suspense } from 'react';
import type { App } from '../ui/app';
import { Rev } from '../ui/signal';
import { withTransition } from '../ui/transition';

/*
 * The only part of the assistant in the main bundle: the panel's lazy body,
 * a prefetch for the top-bar button, and opening, closing and focusing the
 * panel. The kit (chat, providers, generated UI) and everything else in
 * `assistant-host/` load as a separate chunk the first time the panel opens.
 */

/** The panel's id in the workspace. */
export const ASSISTANT_PANEL = 'assistant';

type Chunk = typeof import('./AssistantPanelHost');
let chunk: Promise<Chunk> | null = null;

/** Loads the assistant's chunk (once; a failed load can be retried). */
export function loadAssistant(): Promise<Chunk> {
  chunk ??= import('./AssistantPanelHost').catch((err: unknown) => {
    chunk = null;
    throw err;
  });
  return chunk;
}

/** Starts loading the chunk ahead of a likely open (the pointer over the top-bar button). */
export const prefetchAssistant = () => void loadAssistant().catch(() => undefined);

const Body = lazy(loadAssistant);

/** The panel's body: the assistant once its chunk is in, a quiet spinner meanwhile. */
export function AssistantPanelBody({ app }: { app: App }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      }
    >
      <Body app={app} />
    </Suspense>
  );
}

/**
 * Requests to move focus to the composer (⌘I, "Ask about this"), counted:
 * the panel takes a new one when it has mounted, or at once if it already has.
 */
export const composerFocus = new Rev();

/** Is the assistant panel open and in front? */
export const assistantShown = (app: App) => app.workspace.isShown(ASSISTANT_PANEL);

/** Brings the assistant panel into view (showing hidden panels), and asks for the composer's focus. */
export function openAssistant(app: App) {
  withTransition(() => {
    if (app.workspace.hidden.value) app.workspace.hidden.set(false);
    app.workspace.open(ASSISTANT_PANEL);
  });
  composerFocus.bump();
}

/** Closes the assistant panel (its conversation stays; reopening shows it again). */
export function closeAssistant(app: App) {
  withTransition(() => app.workspace.close(ASSISTANT_PANEL));
}
