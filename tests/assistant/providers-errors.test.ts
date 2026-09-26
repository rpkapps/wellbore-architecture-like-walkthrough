import { describe, expect, it } from 'vitest';
import { ProviderError, errorFromStatus, networkError, parseRetryAfter, toErrorPart, toProviderError } from '../../src/assistant/providers/errors';
import { PROVIDER_PRESETS, configFromPreset, presetById } from '../../src/assistant/providers/presets';
import { request, withProxy } from '../../src/assistant/providers/shared';
import { adapterFor } from '../../src/assistant/providers';
import { config } from './core-helpers';

describe('provider errors', () => {
  it('explains a rejected key, a missing model, and a quota problem', async () => {
    const e401 = await toProviderError(new Response('{"error":{"message":"invalid x-api-key","type":"authentication_error"}}', { status: 401 }), { label: 'Anthropic', model: 'm', baseUrl: '' });
    expect(e401.message).toBe('The API key was rejected (401). Check the key for Anthropic in Settings.');
    expect(e401).toMatchObject({ config: true, retryable: false, detail: 'HTTP 401: invalid x-api-key' });
    const e404 = errorFromStatus(404, '{"error":{"message":"The model `gpt-9` does not exist"}}', undefined, { model: 'gpt-9', label: 'OpenAI', baseUrl: '' });
    expect(e404.message).toBe('Model not found: “gpt-9”. Pick another model in Settings.');
    expect(errorFromStatus(404, 'Not Found').message).toContain('Check the base URL');
    expect(errorFromStatus(402, '{"error":{"message":"Insufficient Balance"}}').message).toContain('out of credit');
  });

  it('reads retry-after (seconds, ms, date) and Gemini retryDelay', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '7' }))).toBe(7000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(parseRetryAfter(new Headers(), '{"details":[{"retryDelay":"31s"}]}')).toBe(31000);
    const e = errorFromStatus(429, '{}', new Headers({ 'retry-after': '12' }));
    expect(e.message).toBe('Rate limited — retry in 12s.');
    expect(e).toMatchObject({ retryable: true, retryAfterMs: 12000 });
  });

  it('marks server errors and overload retryable, context overflows not', () => {
    expect(errorFromStatus(503, '')).toMatchObject({ retryable: true });
    expect(errorFromStatus(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').message).toContain('overloaded');
    const ctx = errorFromStatus(400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}');
    expect(ctx).toMatchObject({ retryable: false });
    expect(ctx.message).toContain('too long');
  });

  it('explains a network failure as a likely CORS or local-server problem', () => {
    const cors = networkError(new TypeError('Failed to fetch'), 'https://api.deepseek.com/chat/completions', { label: 'DeepSeek', baseUrl: '' });
    expect(cors.message).toContain('Could not reach api.deepseek.com');
    expect(cors.message).toContain('CORS proxy');
    const local = networkError(new TypeError('Failed to fetch'), 'http://localhost:11434/v1/chat/completions');
    expect(local.message).toContain('OLLAMA_ORIGINS=*');
    expect(toErrorPart(local)).toMatchObject({ type: 'error', config: true, retryable: true });
  });

  it('request() wraps fetch failures, passes aborts through, and applies the proxy', async () => {
    await expect(request(config(), 'https://x.test/a', { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })).rejects.toBeInstanceOf(ProviderError);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(request(config(), 'https://x.test/a', { fetch: async () => Promise.reject(abort) })).rejects.toBe(abort);
    expect(withProxy('https://a.test/x?y=1', 'https://p.test/?url={url}')).toBe('https://p.test/?url=https%3A%2F%2Fa.test%2Fx%3Fy%3D1');
    expect(withProxy('https://a.test/x', '')).toBe('https://a.test/x');
  });
});

describe('presets', () => {
  it('covers the providers, with unique ids and a protocol each', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'ollama', 'lmstudio', 'custom'])
      expect(presetById(id), id).toBeDefined();
    expect(presetById('deepseek')!.models[0]).toBe('deepseek-v4-flash');
    expect(presetById('ollama')).toMatchObject({ needsKey: false, baseUrl: 'http://localhost:11434/v1' });
    expect(presetById('anthropic')!.kind).toBe('anthropic');
  });

  it('makes a connection from a preset', () => {
    const c = configFromPreset(presetById('groq')!, { apiKey: 'gsk_1', baseUrl: 'https://api.groq.com/openai/v1/' });
    expect(c).toMatchObject({ presetId: 'groq', kind: 'openai', model: 'openai/gpt-oss-120b', apiKey: 'gsk_1', baseUrl: 'https://api.groq.com/openai/v1', tools: true });
    expect(c.id).toMatch(/^groq-/);
    expect(adapterFor('gemini').kind).toBe('gemini');
    expect(adapterFor('openai').kind).toBe('openai');
  });
});
