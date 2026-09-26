import type { FinishReason, JSONSchema, ModelInfo, ModelRequest, ProviderAdapter, ProviderConfig, StreamEvent, Usage } from '../core/types';
import { ProviderError, errorFromStatus } from './errors';
import type { AdapterOptions } from './openai';
import { readSSE } from './sse';
import { IMAGE_OMITTED, assistantSteps, joinUrl, replayArgs, request, stepText, toolResultFor, userPartText } from './shared';

/*
 * The native Gemini API (`streamGenerateContent?alt=sse`). Gemini function
 * calls carry no ids, so the adapter makes them up; Gemini 3 attaches a
 * `thoughtSignature` to a step's first function call, which must come back
 * with it (kept in the call's `providerMeta.gemini`).
 */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type GPart = Record<string, unknown>;
export interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

const ALLOWED = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
  'propertyOrdering',
]);
const STRING_FORMATS = new Set(['enum', 'date-time']);
const NUMBER_FORMATS = new Set(['int32', 'int64', 'float', 'double']);

/**
 * A JSON Schema in the OpenAPI subset Gemini accepts: `$ref`s inlined,
 * `const` as a one-value enum, `type: [x, 'null']` as `nullable`, `oneOf` as
 * `anyOf`, `allOf` merged, exclusive bounds as inclusive ones, and every
 * keyword Gemini rejects (`$schema`, `additionalProperties`, `default`…) dropped.
 */
export function toGeminiSchema(schema: JSONSchema, root: JSONSchema = schema, depth = 0): JSONSchema {
  if (!schema || typeof schema !== 'object' || depth > 12) return { type: 'object' };
  let s: Record<string, unknown> = { ...schema };
  if (typeof s.$ref === 'string') {
    const target = resolveRef(root, s.$ref);
    const rest = { ...s };
    delete rest.$ref;
    s = { ...(target ?? { type: 'object' }), ...rest };
    if (depth > 8) return { type: 'object', ...(typeof s.description === 'string' ? { description: s.description } : {}) };
  }
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = { ...s };
    delete merged.allOf;
    for (const sub of s.allOf as JSONSchema[]) {
      const r = typeof sub?.$ref === 'string' ? (resolveRef(root, sub.$ref as string) ?? {}) : sub;
      for (const [k, v] of Object.entries(r ?? {})) {
        if (k === 'properties') merged.properties = { ...((merged.properties as object) ?? {}), ...(v as object) };
        else if (k === 'required') merged.required = [...new Set([...((merged.required as string[]) ?? []), ...(v as string[])])];
        else if (!(k in merged)) merged[k] = v;
      }
    }
    s = merged;
  }
  if (s.oneOf && !s.anyOf) s.anyOf = s.oneOf;
  if ('const' in s) {
    const c = s.const;
    if (typeof c === 'string') {
      s.enum = [c];
      s.type ??= 'string';
    } else if (c !== undefined) s.description = `${typeof s.description === 'string' ? `${s.description} ` : ''}(always ${JSON.stringify(c)})`;
  }
  if (typeof s.exclusiveMinimum === 'number' && s.minimum === undefined) s.minimum = s.exclusiveMinimum;
  if (typeof s.exclusiveMaximum === 'number' && s.maximum === undefined) s.maximum = s.exclusiveMaximum;

  const out: Record<string, unknown> = {};
  // type: ['string', 'null'] → nullable; several real types → anyOf
  if (Array.isArray(s.type)) {
    const types = (s.type as string[]).filter((t) => t !== 'null');
    if (types.length < s.type.length) out.nullable = true;
    if (types.length === 1) s.type = types[0];
    else {
      const base = { ...s };
      delete base.type;
      return { ...(out.nullable ? { nullable: true } : {}), anyOf: types.map((t) => toGeminiSchema({ ...base, type: t }, root, depth + 1)) };
    }
  }
  if (s.type === 'null') return { type: 'string', nullable: true };
  for (const [k, v] of Object.entries(s)) {
    if (!ALLOWED.has(k) || v === undefined) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, JSONSchema>)) props[pk] = toGeminiSchema(pv, root, depth + 1);
      out.properties = props;
    } else if (k === 'items') {
      out.items = Array.isArray(v) ? toGeminiSchema((v[0] as JSONSchema) ?? {}, root, depth + 1) : toGeminiSchema(v as JSONSchema, root, depth + 1);
    } else if (k === 'anyOf' && Array.isArray(v)) {
      const subs = (v as JSONSchema[]).filter((x) => !(x && x.type === 'null'));
      if (subs.length < v.length) out.nullable = true;
      if (subs.length === 1) Object.assign(out, toGeminiSchema(subs[0], root, depth + 1));
      else out.anyOf = subs.map((x) => toGeminiSchema(x, root, depth + 1));
    } else if (k === 'enum' && Array.isArray(v)) {
      // Gemini enums are strings only: a numeric enum becomes a hint in the description
      const vals = v.filter((x) => x !== null);
      if (v.includes(null)) out.nullable = true;
      if (s.type === 'number' || s.type === 'integer' || s.type === 'boolean') {
        const hint = `One of: ${vals.map((x) => JSON.stringify(x)).join(', ')}.`;
        out.description = typeof s.description === 'string' ? `${s.description} ${hint}` : hint;
      } else if (vals.length) {
        out.enum = vals.map((x) => String(x));
        out.type = 'string';
      }
    } else if (k === 'format') {
      if ((s.type === 'string' && STRING_FORMATS.has(v as string)) || ((s.type === 'number' || s.type === 'integer') && NUMBER_FORMATS.has(v as string))) out.format = v;
    } else if (k === 'nullable') {
      if (v) out.nullable = true;
    } else if (!(k in out)) out[k] = v;
  }
  if (Array.isArray(out.required)) {
    const props = (out.properties ?? {}) as Record<string, unknown>;
    const req = (out.required as string[]).filter((r) => r in props);
    if (req.length) out.required = req;
    else delete out.required;
  }
  if (!out.type && !out.anyOf) {
    if (out.properties) out.type = 'object';
    else if (out.items) out.type = 'array';
  }
  return out;
}

function resolveRef(root: JSONSchema, ref: string): JSONSchema | undefined {
  if (!ref.startsWith('#')) return undefined;
  let cur: unknown = root;
  for (const seg of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === 'object' ? (cur as JSONSchema) : undefined;
}

const geminiMeta = (meta: Record<string, unknown> | undefined) => (meta?.gemini ?? undefined) as { thoughtSignature?: string } | undefined;

/** The transcript as Gemini `contents` (roles alternate; function responses answer the calls of the model turn before them). */
export function toGeminiContents(req: Pick<ModelRequest, 'config' | 'messages'>): GContent[] {
  const out: GContent[] = [];
  const push = (role: GContent['role'], parts: GPart[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  const vision = !!req.config.vision;
  for (const m of req.messages) {
    if (m.role === 'user') {
      const parts: GPart[] = [];
      for (const p of m.parts) {
        if (p.type === 'image') {
          parts.push(vision ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: IMAGE_OMITTED });
          continue;
        }
        const t = userPartText(p);
        if (t && t.trim()) parts.push({ text: t });
      }
      push('user', parts);
      continue;
    }
    for (const step of assistantSteps(m)) {
      const parts: GPart[] = [];
      const text = stepText(step);
      if (text.trim()) parts.push({ text });
      for (const c of step.calls) {
        const part: GPart = { functionCall: { name: c.name, args: replayArgs(c) } };
        const sig = geminiMeta(c.providerMeta)?.thoughtSignature;
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      }
      push('model', parts);
      if (step.calls.length) {
        push(
          'user',
          step.calls.map((c) => {
            const { value, isError } = toolResultFor(c);
            return { functionResponse: { name: c.name, response: isError ? { error: value } : { result: value } } };
          }),
        );
      }
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const THINKING_BUDGET = { low: 1024, medium: 8192, high: 24576 } as const;

/** The request body (exported for tests). */
export function buildGeminiBody(req: ModelRequest): Record<string, unknown> {
  const { config } = req;
  const body: Record<string, unknown> = { contents: toGeminiContents(req) };
  if (req.system.trim()) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const params = toGeminiSchema(t.parameters);
          const hasParams = params.properties && Object.keys(params.properties as object).length > 0;
          return { name: t.name, description: t.description, ...(hasParams ? { parameters: params } : {}) };
        }),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  const gen: Record<string, unknown> = {};
  if (config.temperature !== undefined) gen.temperature = config.temperature;
  if (config.maxOutputTokens) gen.maxOutputTokens = config.maxOutputTokens;
  const r = config.reasoning;
  const g3 = /gemini-(\d+)/.exec(config.model);
  const gen3 = g3 ? Number(g3[1]) >= 3 : false;
  if (r && r !== 'off') gen.thinkingConfig = gen3 ? { thinkingLevel: r === 'low' ? 'low' : 'high', includeThoughts: true } : { thinkingBudget: THINKING_BUDGET[r], includeThoughts: true };
  else if (r === 'off' && !gen3 && /flash/.test(config.model)) gen.thinkingConfig = { thinkingBudget: 0 };
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

const modelPath = (model: string) => model.replace(/^models\//, '');

function headers(config: ProviderConfig): Record<string, string> {
  return config.apiKey ? { 'x-goog-api-key': config.apiKey } : {};
}

const FINISH: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content-filter',
  RECITATION: 'content-filter',
  BLOCKLIST: 'content-filter',
  PROHIBITED_CONTENT: 'content-filter',
  SPII: 'content-filter',
  IMAGE_SAFETY: 'content-filter',
};

let callCounter = 0;

/** Parses a Gemini SSE stream into kit stream events (exported for tests). */
export async function* parseGeminiStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal, config?: ProviderConfig): AsyncGenerator<StreamEvent> {
  const turn = Math.random().toString(36).slice(2, 8);
  let calls = 0;
  let finish: string | undefined;
  let usage: Usage | undefined;
  for await (const ev of readSSE(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.error) {
      const e = data.error as { code?: number };
      throw errorFromStatus(typeof e.code === 'number' ? e.code : 500, JSON.stringify(data), undefined, config);
    }
    const um = data.usageMetadata as Record<string, number> | undefined;
    if (um) {
      const thoughts = um.thoughtsTokenCount ?? 0;
      usage = { inputTokens: um.promptTokenCount ?? 0, outputTokens: (um.candidatesTokenCount ?? 0) + thoughts };
      if (thoughts) usage.reasoningTokens = thoughts;
      if (um.cachedContentTokenCount) usage.cachedInputTokens = um.cachedContentTokenCount;
    }
    const cand = (data.candidates as Record<string, unknown>[] | undefined)?.[0];
    const block = (data.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
    if (!cand) {
      if (block) finish = 'SAFETY';
      continue;
    }
    const parts = ((cand.content as { parts?: GPart[] } | undefined)?.parts ?? []) as GPart[];
    for (const p of parts) {
      const sig = typeof p.thoughtSignature === 'string' ? p.thoughtSignature : undefined;
      if (p.functionCall && typeof p.functionCall === 'object') {
        const fc = p.functionCall as { name?: string; args?: unknown; id?: string };
        const id = fc.id || `gem_${turn}_${++calls}_${++callCounter}`;
        const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
        yield sig ? { type: 'tool-call-start', id, name: fc.name ?? 'unknown', providerMeta: { gemini: { thoughtSignature: sig } } } : { type: 'tool-call-start', id, name: fc.name ?? 'unknown' };
        yield { type: 'tool-call-delta', id, argsText: JSON.stringify(args) };
        yield { type: 'tool-call-end', id, args };
      } else if (typeof p.text === 'string' && p.text) {
        yield p.thought ? { type: 'reasoning-delta', text: p.text } : { type: 'text-delta', text: p.text };
      }
    }
    if (typeof cand.finishReason === 'string' && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') finish = cand.finishReason;
  }
  if (usage) yield { type: 'usage', usage };
  let reason: FinishReason = finish ? (FINISH[finish] ?? 'other') : calls ? 'tool-calls' : 'other';
  if (calls && reason === 'stop') reason = 'tool-calls';
  yield { type: 'finish', reason };
}

/** The Gemini adapter. */
export function createGeminiAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  return {
    kind: 'gemini',
    async *stream(req) {
      const { config, signal } = req;
      const base = config.baseUrl || GEMINI_BASE_URL;
      const res = await request(config, joinUrl(base, `models/${modelPath(config.model)}:streamGenerateContent?alt=sse`), {
        body: buildGeminiBody(req),
        signal,
        fetch: opts.fetch,
        headers: { ...headers(config), accept: 'text/event-stream' },
      });
      if (!res.body) throw new ProviderError('The provider sent an empty response.', { retryable: true });
      yield* parseGeminiStream(res.body, signal, config);
    },
    async listModels(config, signal) {
      const base = config.baseUrl || GEMINI_BASE_URL;
      const out: ModelInfo[] = [];
      let token = '';
      for (let page = 0; page < 5; page++) {
        const url = joinUrl(base, `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        const res = await request(config, url, { signal, fetch: opts.fetch, headers: headers(config) });
        const json = (await res.json()) as {
          models?: { name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[];
          nextPageToken?: string;
        };
        for (const m of json.models ?? []) {
          if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes('generateContent')) continue;
          const info: ModelInfo = { id: modelPath(m.name) };
          if (m.displayName) info.label = m.displayName;
          if (m.inputTokenLimit) info.contextWindow = m.inputTokenLimit;
          out.push(info);
        }
        if (!json.nextPageToken) break;
        token = json.nextPageToken;
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
