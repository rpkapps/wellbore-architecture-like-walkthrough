/*
 * The assistant kit: an in-app AI assistant for any React app, with no
 * backend. Implement an `AssistantHost` (your tools, context and domain
 * knowledge), create the engine once and mount the panel:
 *
 *   const assistant = createAssistant(myHost);
 *   <AssistantPanel controller={assistant} />
 *
 * Import it lazily (the panel, providers and charts are a few hundred kB)
 * so it costs nothing until it is opened. See README.md.
 */
export { createAssistant, DEFAULT_SETTINGS, type AssistantEngine, type CreateAssistantOptions } from './core/controller';
export type * from './core/types';
export { AssistantPanel, useAssistant, useAssistantSelector, Markdown, type AssistantPanelProps } from './ui';
export { PROVIDER_PRESETS, presetById, configFromPreset, adapterFor, ProviderError } from './providers';
export { A2UISurface, renderUiTool, a2uiPromptGuide, validateMessages, DATA_CATALOG_ID } from './a2ui';
