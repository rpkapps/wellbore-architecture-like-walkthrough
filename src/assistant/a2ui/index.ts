/*
 * CONTRACT STUB (owned by the A2UI work): the public surface of `a2ui/`.
 * The UI renders `UIPart`s with `A2UISurface`; the controller adds
 * `renderUiTool()` to the host's tools and `a2uiPromptGuide()` to the system
 * prompt, and pulls ```a2ui fences out of streamed text with `extractA2UIFences`.
 */
import type { ComponentType } from 'react';
import type { AssistantTool, Dataset, UIEventPart } from '../core/types';

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

export declare const A2UISurface: ComponentType<A2UISurfaceProps>;
/** The built-in `render_ui` tool: validates the A2UI messages and reports problems back to the model. */
export declare function renderUiTool(): AssistantTool;
/** The part of the system prompt that teaches the model the protocol and the catalog. */
export declare function a2uiPromptGuide(): string;
/** Splits ```a2ui fenced blocks (JSON array or JSONL of A2UI messages) out of assistant text. */
export declare function extractA2UIFences(text: string): { text: string; blocks: unknown[][] };
