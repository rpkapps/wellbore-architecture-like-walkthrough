import { describe, expect, it } from 'vitest';
import { buildGeminiBody, createGeminiAdapter, parseGeminiStream, toGeminiContents, toGeminiSchema } from '../../src/assistant/providers/gemini';
import { chop, collect, config, fold, msg, sampleRequest, streamOf } from './core-helpers';

const data = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;

/** Gemini `alt=sse`: thought parts, text, then two function calls (the first with a thought signature), usage on the last chunk. */
const FIXTURE = [
  data({ candidates: [{ content: { role: 'model', parts: [{ text: 'Checking the logs available…', thought: true }] }, index: 0 }], modelVersion: 'gemini-3.5-flash' }),
  data({ candidates: [{ content: { role: 'model', parts: [{ text: 'Let me load ' }] }, index: 0 }] }),
  data({ candidates: [{ content: { role: 'model', parts: [{ text: 'the GR log.' }] }, index: 0 }] }),
  data({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'data__read_log', args: { well: 'F-11 A', log: 'GR' } }, thoughtSignature: 'CiQBVKhc7' },
            { functionCall: { name: 'view__color_by', args: { mode: 'gr' } } },
          ],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 40, thoughtsTokenCount: 120, cachedContentTokenCount: 1024, totalTokenCount: 1660 },
  }),
].join('');

describe('Gemini stream parsing', () => {
  it('reads thoughts, text and id-less function calls (with their thought signature)', async () => {
    const r = fold(await collect(parseGeminiStream(streamOf(chop(FIXTURE, 13)))));
    expect(r.reasoning).toBe('Checking the logs available…');
    expect(r.text).toBe('Let me load the GR log.');
    expect(r.calls.map((c) => [c.name, c.args])).toEqual([
      ['data__read_log', { well: 'F-11 A', log: 'GR' }],
      ['view__color_by', { mode: 'gr' }],
    ]);
    expect(r.calls[0].id).toMatch(/^gem_/);
    expect(r.calls[0].id).not.toBe(r.calls[1].id);
    expect(r.calls[0].providerMeta).toEqual({ gemini: { thoughtSignature: 'CiQBVKhc7' } });
    expect(r.finish).toBe('tool-calls');
    expect(r.usage).toEqual({ inputTokens: 1500, outputTokens: 160, reasoningTokens: 120, cachedInputTokens: 1024 });
  });

  it('maps MAX_TOKENS and SAFETY, and a blocked prompt', async () => {
    const len = fold(await collect(parseGeminiStream(streamOf([data({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] })]))));
    expect(len.finish).toBe('length');
    const safety = fold(await collect(parseGeminiStream(streamOf([data({ candidates: [{ finishReason: 'SAFETY' }] })]))));
    expect(safety.finish).toBe('content-filter');
    const blocked = fold(await collect(parseGeminiStream(streamOf([data({ promptFeedback: { blockReason: 'SAFETY' } })]))));
    expect(blocked.finish).toBe('content-filter');
  });

  it('throws on an error object in the stream', async () => {
    await expect(collect(parseGeminiStream(streamOf([data({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } })])))).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });
});

describe('toGeminiSchema', () => {
  it('strips unsupported keywords, inlines refs, converts const, nullable types, oneOf and exclusive bounds', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      $defs: { Depth: { type: 'number', exclusiveMinimum: 0, description: 'm MD' } },
      properties: {
        md: { $ref: '#/$defs/Depth' },
        unit: { const: 'm' },
        note: { type: ['string', 'null'], default: 'x' },
        mode: { oneOf: [{ type: 'string', enum: ['gr', 'res'] }, { type: 'null' }] },
        level: { type: 'integer', enum: [1, 2, 3] },
        tags: { type: 'array', items: { type: 'string', format: 'uri' } },
        when: { type: 'string', format: 'date-time' },
      },
      required: ['md', 'ghost'],
    };
    expect(toGeminiSchema(schema)).toEqual({
      type: 'object',
      properties: {
        md: { type: 'number', minimum: 0, description: 'm MD' },
        unit: { type: 'string', enum: ['m'] },
        note: { type: 'string', nullable: true },
        mode: { type: 'string', enum: ['gr', 'res'], nullable: true },
        level: { type: 'integer', description: 'One of: 1, 2, 3.' },
        tags: { type: 'array', items: { type: 'string' } },
        when: { type: 'string', format: 'date-time' },
      },
      required: ['md'],
    });
  });

  it('turns several types into anyOf and survives recursive refs', () => {
    expect(toGeminiSchema({ type: ['number', 'string'] })).toEqual({ anyOf: [{ type: 'number' }, { type: 'string' }] });
    const rec = { $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }, $ref: '#/$defs/Node' };
    expect(() => toGeminiSchema(rec)).not.toThrow();
  });
});

describe('Gemini request conversion', () => {
  const cfg = config({ presetId: 'gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash', vision: true });

  it('maps roles and parts, replays thought signatures and answers calls with functionResponse', () => {
    const req = sampleRequest(cfg);
    const withSig = msg('assistant', [
      { type: 'tool-call', id: 'gem_1', name: 'view__color_by', args: { mode: 'res' }, state: 'denied', providerMeta: { gemini: { thoughtSignature: 'SIG' } } },
    ]);
    const out = toGeminiContents({ ...req, messages: [...req.messages, withSig] });
    expect(out.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user']);
    expect(out[1].parts).toEqual([{ text: 'Switching.' }, { functionCall: { name: 'view__color_by', args: { mode: 'gr' } } }]);
    expect(out[2].parts).toEqual([{ functionResponse: { name: 'view__color_by', response: { result: { ok: true } } } }]);
    expect(out[4].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(out[5].parts[0]).toEqual({ functionCall: { name: 'view__color_by', args: { mode: 'res' } }, thoughtSignature: 'SIG' });
    expect(out[6].parts[0]).toEqual({ functionResponse: { name: 'view__color_by', response: { result: { denied: true, message: 'The person declined this action.' } } } });
  });

  it('builds the body with system instruction, declarations and thinking config per generation', () => {
    const body = buildGeminiBody(sampleRequest({ ...cfg, reasoning: 'high', maxOutputTokens: 2048 }));
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a test.' }] });
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'view__color_by', description: 'Colours the well.', parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] } }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } });
    const g25 = buildGeminiBody(sampleRequest({ ...cfg, model: 'gemini-2.5-flash', reasoning: 'low' }));
    expect(g25.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } });
    const noParams = buildGeminiBody({ ...sampleRequest(cfg), tools: [{ name: 'refresh', description: 'Refresh', parameters: { type: 'object', properties: {} } }] });
    expect((noParams.tools as { functionDeclarations: object[] }[])[0].functionDeclarations[0]).toEqual({ name: 'refresh', description: 'Refresh' });
  });

  it('streams from :streamGenerateContent?alt=sse with the key header, and lists generateContent models', async () => {
    const urls: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('sk-test');
      if (url.includes('/models?'))
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
              { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
        );
      return new Response(streamOf([FIXTURE]));
    };
    const adapter = createGeminiAdapter({ fetch });
    expect(fold(await collect(adapter.stream(sampleRequest({ ...cfg, model: 'models/gemini-3.5-flash' })))).calls).toHaveLength(2);
    expect(urls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    expect(await adapter.listModels!(cfg)).toEqual([{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1048576 }]);
  });
});
