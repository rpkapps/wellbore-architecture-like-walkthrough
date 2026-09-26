import type { ChatMessage, ModelRequest, Part, ProviderConfig, StreamEvent } from '../../src/assistant/core/types';

/*
 * Shared helpers for the assistant engine's tests (not a test file itself).
 */

const enc = new TextEncoder();

/** A response body made of the given chunks (strings are UTF-8 encoded). */
export function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

/** Splits a fixture into small chunks at awkward places (inside lines, JSON and multi-byte characters). */
export function chop(text: string, size = 7): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Text, reasoning and tool calls folded from stream events. */
export function fold(events: StreamEvent[]) {
  let text = '';
  let reasoning = '';
  const calls: { id: string; name: string; argsText: string; args?: unknown; argsError?: string; providerMeta?: Record<string, unknown> }[] = [];
  for (const e of events) {
    if (e.type === 'text-delta') text += e.text;
    else if (e.type === 'reasoning-delta') reasoning += e.text;
    else if (e.type === 'tool-call-start') calls.push({ id: e.id, name: e.name, argsText: '', providerMeta: e.providerMeta });
    else if (e.type === 'tool-call-delta') calls.find((c) => c.id === e.id)!.argsText += e.argsText;
    else if (e.type === 'tool-call-end') Object.assign(calls.find((c) => c.id === e.id)!, { args: e.args, argsError: e.argsError });
  }
  const usage = events.find((e) => e.type === 'usage');
  const finish = events.find((e) => e.type === 'finish');
  return { text, reasoning, calls, usage: usage?.type === 'usage' ? usage.usage : undefined, finish: finish?.type === 'finish' ? finish.reason : undefined };
}

export const config = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'c1',
  presetId: 'openai',
  label: 'Test',
  kind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  tools: true,
  ...patch,
});

let n = 0;
export const msg = (role: ChatMessage['role'], parts: Part[], patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${++n}`, role, parts, createdAt: 0, ...patch });

/** A transcript with one earlier tool-using turn and a new question. */
export function sampleRequest(cfg: ProviderConfig, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    config: cfg,
    system: 'You are a test.',
    tools: [{ name: 'view__color_by', description: 'Colours the well.', parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] } }],
    signal: new AbortController().signal,
    messages: [
      msg('user', [
        { type: 'context', items: [{ id: 'sel', label: 'Hugin Fm.', data: { top: 3050 } }] },
        { type: 'text', text: 'Colour by GR' },
      ]),
      msg('assistant', [
        { type: 'reasoning', text: 'The person wants GR.', signature: 'sig-1' },
        { type: 'text', text: 'Switching.' },
        { type: 'tool-call', id: 'call_1', name: 'view__color_by', args: { mode: 'gr' }, state: 'done', result: { ok: true } },
        { type: 'text', text: 'Done: coloured by gamma ray.' },
      ]),
      msg('user', [
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'text', text: 'What is this?' },
      ]),
    ],
    ...extra,
  };
}
