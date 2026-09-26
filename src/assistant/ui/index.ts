/*
 * The assistant kit's chat panel. Mount `<AssistantPanel controller={…} />`
 * in a container that gives it a height (a docked side panel, a floating
 * window); the controller comes from `createAssistant(host)` in `core/`.
 */
export { AssistantPanel, type AssistantPanelProps } from './AssistantPanel';
export { useAssistant, useAssistantSelector, shallowEqual } from './useAssistant';
export { Markdown, type MarkdownProps } from './markdown/Markdown';
