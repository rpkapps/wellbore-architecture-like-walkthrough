/** The assistant engine: the controller, the agent loop and their helpers. */
export { createAssistant, DEFAULT_SETTINGS, type AssistantEngine, type CreateAssistantOptions } from './controller';
export { runTurn, finalizeStopped, needsApproval, uiMessagesFromArgs, type TurnOptions, type TurnResult } from './agent';
export { builtinTools, queryDataset, queryDatasetTool, QUERY_DATASET, RENDER_UI } from './builtinTools';
export { capToolResult, isToolOutput, registerDatasets, summariseDataset, type DatasetSummary } from './datasets';
export { parsePartialJson, safeJsonStringify } from './json';
export { buildSystemPrompt } from './systemPrompt';
export { buildToolNameMap, sanitizeToolName, type ToolNameMap } from './toolNames';
export { createStore, titleFrom, type Store } from './store';
export { createPersistence, type Persistence, type ThreadMeta } from './persistence';
export { newId } from './ids';
export type * from './types';
