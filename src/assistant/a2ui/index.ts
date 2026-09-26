/*
 * The public surface of `a2ui/`: an A2UI v0.9 renderer for generated UI in
 * chat messages. The UI renders `UIPart`s with `A2UISurface`; the controller
 * adds `renderUiTool()` to the host's tools and `a2uiPromptGuide()` to the
 * system prompt, and pulls ```a2ui fences out of streamed text with
 * `extractA2UIFences`. The processor and validator are framework-free.
 */
import type { Dataset, UIEventPart } from '../core/types';

export interface A2UISurfaceProps {
  /** the A2UI messages of one UIPart, in order */
  messages: unknown[];
  /** the thread's datasets, for charts and tables bound to `dataset: "ds_1"` */
  datasets: Record<string, Dataset>;
  /** a button or form action: sent to the model as the next user turn */
  onAction: (event: Omit<UIEventPart, 'type'>) => void;
  /** the messages may still be arriving (partial JSON): render what is complete, no errors yet */
  streaming?: boolean;
}

export { A2UISurface } from './Surface';
export { renderUiTool, renderUiMessages } from './tool';
export { a2uiPromptGuide, PROMPT_EXAMPLE } from './prompt';
export { extractA2UIFences } from './fences';
export { applyMessages, resolveRoot, surfaceKey, type ApplyOptions } from './processor';
export { validateMessages, type ValidateOptions } from './validate';
export { normalizeMessages, parseMessagesText } from './normalize';
export { COMPONENTS as CATALOG_SCHEMA } from './catalog/schema';
export { BASIC_CATALOG_ID, BASIC_CATALOG_ID_091, DATA_CATALOG_ID, SUPPORTED_CATALOG_IDS } from './types';
export type { A2UIMessage, A2UIComponent, A2UIClientAction, SurfaceState, DynamicValue, ChildList, Action } from './types';

/** The v0.9 client `action` message for an action event (for transports that speak A2UI to a server). */
export function toClientAction(event: Omit<UIEventPart, 'type'>, timestamp = new Date().toISOString()) {
  return {
    version: 'v0.9' as const,
    action: { name: event.name, surfaceId: event.surfaceId, sourceComponentId: event.sourceComponentId ?? '', timestamp, context: event.context ?? {} },
  };
}
