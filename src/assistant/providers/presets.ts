import type { ProviderConfig, ProviderPreset } from '../core/types';

/*
 * The connections the settings form offers. Model lists are suggestions
 * shown before the provider's own list is fetched (`listModels`); the first
 * is the default.
 */

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    keyHint: 'sk-…',
    vision: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    keyHint: 'sk-ant-…',
    vision: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    keyHint: 'AIza…',
    vision: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    keyHint: 'sk-…',
    note: 'DeepSeek may not accept requests made directly from a browser: if the connection test fails to reach it, set a CORS proxy.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-v4-flash', 'anthropic/claude-sonnet-5', 'google/gemini-3.5-flash', 'openai/gpt-6-luna'],
    keyUrl: 'https://openrouter.ai/settings/keys',
    needsKey: true,
    keyHint: 'sk-or-…',
    note: 'One key for hundreds of models from every provider; allows browser requests.',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    keyHint: 'gsk_…',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    needsKey: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.7', 'grok-4.6'],
    keyUrl: 'https://console.x.ai',
    needsKey: true,
    keyHint: 'xai-…',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['deepseek-ai/DeepSeek-V4-Pro-0813', 'moonshotai/Kimi-K3'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
    needsKey: true,
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: [],
    keyUrl: 'https://fireworks.ai/account/api-keys',
    needsKey: true,
    keyHint: 'fw_…',
    note: 'Model ids look like accounts/fireworks/models/<name>: load the list after entering the key.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['gpt-oss-120b', 'llama-4-scout-17b-16e-instruct'],
    keyUrl: 'https://cloud.cerebras.ai',
    needsKey: true,
    keyHint: 'csk-…',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    needsKey: false,
    note: 'Runs on this computer. If this page is not served from localhost, start Ollama with OLLAMA_ORIGINS=* so the browser may call it. Pick a model that supports tools.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    needsKey: false,
    note: 'Start the local server with CORS enabled (Developer › Settings, or `lms server start --cors`).',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    models: [],
    needsKey: false,
    note: 'Any server that implements POST /chat/completions with streaming and tools (vLLM, llama.cpp, LiteLLM, a company gateway…).',
  },
];

/** A preset by id. */
export const presetById = (id: string): ProviderPreset | undefined => PROVIDER_PRESETS.find((p) => p.id === id);

/** A new connection from a preset, with the person's choices on top. */
export function configFromPreset(preset: ProviderPreset, partial: Partial<ProviderConfig> = {}): ProviderConfig {
  const id = partial.id ?? `${preset.id}-${Math.random().toString(36).slice(2, 8)}`;
  const config: ProviderConfig = {
    id,
    presetId: preset.id,
    label: preset.label,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.models[0] ?? '',
    tools: true,
    vision: !!preset.vision,
    ...partial,
  };
  const headers = { ...(preset.headers ?? {}), ...(partial.headers ?? {}) };
  if (Object.keys(headers).length) config.headers = headers;
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}
