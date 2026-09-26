import type { ProviderAdapter, ProviderKind } from '../core/types';
import { createAnthropicAdapter } from './anthropic';
import { createGeminiAdapter } from './gemini';
import { createOpenAIAdapter, type AdapterOptions } from './openai';
import { createOpenAIResponsesAdapter } from './openaiResponses';

/** The adapter for a wire protocol (with an optional fetch, e.g. a mock). */
export function adapterFor(kind: ProviderKind, opts: AdapterOptions = {}): ProviderAdapter {
  switch (kind) {
    case 'anthropic':
      return createAnthropicAdapter(opts);
    case 'gemini':
      return createGeminiAdapter(opts);
    case 'openai-responses':
      return createOpenAIResponsesAdapter(opts);
    default:
      return createOpenAIAdapter(opts);
  }
}

export { createAnthropicAdapter, createGeminiAdapter, createOpenAIAdapter, createOpenAIResponsesAdapter, type AdapterOptions };
export { ProviderError, isAbortError, isContextOverflow, toErrorPart, toProviderError, networkError } from './errors';
export { PROVIDER_PRESETS, presetById, configFromPreset, defaultContextWindow, MAX_WORKING_CONTEXT } from './presets';
export { readSSE, readLines, readNDJSON, type SSEMessage } from './sse';
export { request, withProxy, type FetchLike } from './shared';
export { toGeminiSchema } from './gemini';
