import { createContext, useContext } from 'react';
import type { AssistantController } from '../core/types';

/** What the settings dialog opens on. */
export type SettingsTarget = { section: 'connection'; providerId?: string; presetId?: string } | { section: 'general' };

/** Shared by every part of the panel; stable for the panel's life. */
export interface PanelContextValue {
  controller: AssistantController;
  openSettings: (target?: SettingsTarget) => void;
  /** a tool's title for people (the host's `title`, else the humanised name) */
  toolTitle: (name: string) => string;
  /** hands text to the composer (the "edit" of a suggestion card, the /model command) and focuses it */
  focusComposer: () => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

/** The panel's shared context; throws outside `AssistantPanel`. */
export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (!value) throw new Error('usePanel must be used inside <AssistantPanel>.');
  return value;
}
