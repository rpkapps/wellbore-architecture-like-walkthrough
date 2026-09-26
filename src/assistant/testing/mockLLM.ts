/*
 * A scripted language model for tests and end-to-end demos. It answers
 * requests in each provider's exact streaming wire format (OpenAI Chat
 * Completions, Anthropic Messages, Gemini streamGenerateContent), so the
 * real adapters and the whole agent loop run against it. Use
 * `createMockFetch` in place of `fetch`, or `mockServerHandler` behind a
 * Node HTTP server.
 */

export type MockProtocol = 'openai' | 'anthropic' | 'gemini';

/** What the script is told about a request. */
export interface MockRequest {
  protocol: MockProtocol;
  url: string;
  /** the parsed request body */
  body: Record<string, unknown>;
  system: string;
  /** the tool names offered (wire names) */
  toolNames: string[];
  /** the text of the last message the person wrote (tool results are not counted) */
  lastUserText: string;
  /** the tool results sent back since the model's last answer */
  toolResults: { id?: string; name?: string; content: unknown }[];
  /** assistant (model) messages in the request: 0 on the first request of a thread */
  turnIndex: number;
  /** assistant messages since the person's last message: 0 on the first step of a turn */
  stepIndex: number;
  /** the request's size in tokens, as the mock counts them (4 characters of the JSON body per token): report it as `usage.input` */
  inputTokens: number;
}

/** What the model "says". */
export interface MockTurn {
  reasoning?: string;
  text?: string;
  /** calls to make (wire names) */
  toolCalls?: { name: string; args: unknown; id?: string }[];
  /** answer with an HTTP error instead */
  error?: { status: number; body?: unknown; headers?: Record<string, string> };
  usage?: { input?: number; output?: number };
  /** the finish reason in kit terms (default: tool-calls when calling tools, else stop) */
  finish?: 'stop' | 'length' | 'content-filter';
}

export type MockScript = (req: MockRequest) => MockTurn | Promise<MockTurn>;

export interface MockOptions {
  /** characters per streamed text piece (default 6) */
  chunkSize?: number;
  /** delay between chunks in ms (createMockFetch only; default 0) */
  delayMs?: number;
  /** models listed by GET …/models */
  models?: string[];
  /** the model's context window: longer requests (`MockRequest.inputTokens`) get the provider's context-length error */
  contextWindow?: number;
  /** context windows the model list reports, by model id */
  modelWindows?: Record<string, number>;
}

export interface MockHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  bodyText?: string;
}

export interface MockHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** the body, in the pieces it should be written in */
  chunks: string[];
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-goog-api-key, http-referer, x-title, accept',
  'access-control-max-age': '600',
};

const split = (s: string, n: number): string[] => {
  const out: string[] = [];
  const chars = Array.from(s); // never split a surrogate pair
  for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''));
  return out;
};

const rid = () => Math.random().toString(36).slice(2, 10);

function protocolOf(url: string): MockProtocol | null {
  if (/\/chat\/completions(\?|$)/.test(url)) return 'openai';
  if (/\/v1\/messages(\?|$)/.test(url)) return 'anthropic';
  if (/:streamGenerateContent/.test(url)) return 'gemini';
  return null;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  return '';
};
const tryJson = (s: unknown) => {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
};

/** Reads the request the way a script wants to see it. */
export function describeRequest(protocol: MockProtocol, url: string, body: Record<string, unknown>): MockRequest {
  const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
  const req: MockRequest = { protocol, url, body, system: '', toolNames: [], lastUserText: '', toolResults: [], turnIndex: 0, stepIndex: 0, inputTokens };
  if (protocol === 'openai') {
    const msgs = (body.messages as Record<string, unknown>[]) ?? [];
    req.system = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
    req.toolNames = ((body.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name);
    const names = new Map<string, string>();
    let lastUser = -1;
    msgs.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
      if (m.role === 'assistant') {
        req.turnIndex++;
        for (const c of (m.tool_calls as { id: string; function: { name: string } }[]) ?? []) names.set(c.id, c.function.name);
      }
    });
    req.lastUserText = lastUser >= 0 ? textOf(msgs[lastUser].content) : '';
    req.stepIndex = msgs.slice(lastUser + 1).filter((m) => m.role === 'assistant').length;
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i--) {
      const id = msgs[i].tool_call_id as string;
      req.toolResults.unshift({ id, name: names.get(id), content: tryJson(msgs[i].content) });
    }
  } else if (protocol === 'anthropic') {
    const msgs = (body.messages as { role: string; content: Record<string, unknown>[] | string }[]) ?? [];
    const sys = body.system;
    req.system = typeof sys === 'string' ? sys : textOf(sys);
    req.toolNames = ((body.tools as { name: string }[]) ?? []).map((t) => t.name);
    const names = new Map<string, string>();
    let lastUser = -1;
    msgs.forEach((m, i) => {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (m.role === 'assistant') {
        req.turnIndex++;
        for (const b of blocks) if (b.type === 'tool_use') names.set(b.id as string, b.name as string);
      } else if (blocks.some((b) => b.type !== 'tool_result')) lastUser = i;
    });
    if (lastUser >= 0) {
      const m = msgs[lastUser];
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      req.lastUserText = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text))
        .join('\n');
    }
    req.stepIndex = msgs.slice(lastUser + 1).filter((m) => m.role === 'assistant').length;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content))
      for (const b of last.content) if (b.type === 'tool_result') req.toolResults.push({ id: b.tool_use_id as string, name: names.get(b.tool_use_id as string), content: tryJson(b.content) });
  } else {
    const contents = (body.contents as { role: string; parts: Record<string, unknown>[] }[]) ?? [];
    req.system = textOf((body.systemInstruction as { parts?: unknown[] } | undefined)?.parts);
    req.toolNames = ((body.tools as { functionDeclarations?: { name: string }[] }[]) ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name));
    let lastUser = -1;
    contents.forEach((c, i) => {
      if (c.role === 'model') req.turnIndex++;
      else if (c.parts.some((p) => typeof p.text === 'string')) lastUser = i;
    });
    if (lastUser >= 0)
      req.lastUserText = contents[lastUser].parts
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
    req.stepIndex = contents.slice(lastUser + 1).filter((c) => c.role === 'model').length;
    const last = contents[contents.length - 1];
    if (last && last.role === 'user')
      for (const p of last.parts) {
        const fr = p.functionResponse as { name: string; response: { result?: unknown; error?: unknown } } | undefined;
        if (fr) req.toolResults.push({ name: fr.name, content: fr.response.result ?? fr.response });
      }
  }
  return req;
}

/** The error each provider answers a request longer than the model's context window with (for `MockTurn.error`). */
export function contextLengthError(protocol: MockProtocol, tokens = 250_000, limit = 200_000): NonNullable<MockTurn['error']> {
  if (protocol === 'anthropic')
    return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${tokens} tokens > ${limit} maximum` } } };
  if (protocol === 'gemini')
    return {
      status: 400,
      body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: `The input token count (${tokens}) exceeds the maximum number of tokens allowed (${limit}).` } },
    };
  return {
    status: 400,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${tokens} tokens. Please reduce the length of the messages.`,
      },
    },
  };
}

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

function openaiChunks(turn: MockTurn, model: string, size: number): string[] {
  const id = `chatcmpl-${rid()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => sse({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const out = [chunk({ role: 'assistant', content: '' })];
  for (const p of split(turn.reasoning ?? '', size)) out.push(chunk({ reasoning_content: p }));
  for (const p of split(turn.text ?? '', size)) out.push(chunk({ content: p }));
  (turn.toolCalls ?? []).forEach((c, index) => {
    out.push(chunk({ tool_calls: [{ index, id: c.id ?? `call_${rid()}`, type: 'function', function: { name: c.name, arguments: '' } }] }));
    for (const p of split(JSON.stringify(c.args ?? {}), size + 2)) out.push(chunk({ tool_calls: [{ index, function: { arguments: p } }] }));
  });
  const finish = turn.toolCalls?.length ? 'tool_calls' : turn.finish === 'length' ? 'length' : turn.finish === 'content-filter' ? 'content_filter' : 'stop';
  out.push(chunk({}, finish));
  const input = turn.usage?.input ?? 100;
  const output = turn.usage?.output ?? 20;
  out.push(sse({ ...base, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } }));
  out.push('data: [DONE]\n\n');
  return out;
}

function anthropicChunks(turn: MockTurn, model: string, size: number): string[] {
  const out: string[] = [];
  const ev = (type: string, data: Record<string, unknown>) => out.push(sse({ type, ...data }, type));
  ev('message_start', {
    message: { id: `msg_${rid()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: turn.usage?.input ?? 100, output_tokens: 1 } },
  });
  let index = 0;
  if (turn.reasoning) {
    ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const p of split(turn.reasoning, size)) ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: p } });
    ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: `sig_${rid()}` } });
    ev('content_block_stop', { index });
    index++;
  }
  out.push('event: ping\ndata: {"type": "ping"}\n\n');
  if (turn.text) {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
    for (const p of split(turn.text, size)) ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } });
    ev('content_block_stop', { index });
    index++;
  }
  for (const c of turn.toolCalls ?? []) {
    ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id ?? `toolu_${rid()}`, name: c.name, input: {} } });
    for (const p of split(JSON.stringify(c.args ?? {}), size + 2)) ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } });
    ev('content_block_stop', { index });
    index++;
  }
  const stop = turn.toolCalls?.length ? 'tool_use' : turn.finish === 'length' ? 'max_tokens' : turn.finish === 'content-filter' ? 'refusal' : 'end_turn';
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: turn.usage?.output ?? 20 } });
  ev('message_stop', {});
  return out;
}

function geminiChunks(turn: MockTurn, size: number): string[] {
  const out: string[] = [];
  const chunk = (parts: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    out.push(sse({ candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }], modelVersion: 'mock' }));
  for (const p of split(turn.reasoning ?? '', size * 4)) chunk([{ text: p, thought: true }]);
  for (const p of split(turn.text ?? '', size * 2)) chunk([{ text: p }]);
  const calls = turn.toolCalls ?? [];
  if (calls.length) chunk(calls.map((c, i) => ({ functionCall: { name: c.name, args: c.args ?? {} }, ...(i === 0 ? { thoughtSignature: `ts_${rid()}` } : {}) })));
  const finish = turn.finish === 'length' ? 'MAX_TOKENS' : turn.finish === 'content-filter' ? 'SAFETY' : 'STOP';
  out.push(
    sse({
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: finish, index: 0 }],
      usageMetadata: { promptTokenCount: turn.usage?.input ?? 100, candidatesTokenCount: turn.usage?.output ?? 20, totalTokenCount: (turn.usage?.input ?? 100) + (turn.usage?.output ?? 20) },
    }),
  );
  return out;
}

function modelsBody(url: string, headers: MockHttpRequest['headers'], models: string[], windows: Record<string, number> = {}): unknown {
  const h = (k: string) => Object.entries(headers ?? {}).some(([key, v]) => key.toLowerCase() === k && v !== undefined);
  const w = (id: string, key: string) => (windows[id] ? { [key]: windows[id] } : {});
  if (h('anthropic-version')) return { data: models.map((id) => ({ id, type: 'model', display_name: id, ...w(id, 'max_input_tokens') })), has_more: false };
  if (h('x-goog-api-key') || /pageSize=|\/v1beta\/models/.test(url))
    return { models: models.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'], ...w(id, 'inputTokenLimit') })) };
  return { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock', ...w(id, 'context_length') })) };
}

/** A request handler for a Node HTTP server (async: the script may be). Answers CORS preflights and `GET …/models`. */
export function mockServerHandler(script: MockScript, opts: MockOptions = {}): (req: MockHttpRequest) => Promise<MockHttpResponse> {
  const size = Math.max(1, opts.chunkSize ?? 6);
  const models = opts.models ?? ['mock-model'];
  return async (req) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') return { status: 204, headers: { ...CORS }, chunks: [] };
    const url = req.url;
    if (method === 'GET' && /\/models(\?|$)/.test(url)) return { status: 200, headers: { ...CORS, 'content-type': 'application/json' }, chunks: [JSON.stringify(modelsBody(url, req.headers, models, opts.modelWindows))] };
    const protocol = protocolOf(url);
    if (!protocol || method !== 'POST') return { status: 404, headers: { ...CORS, 'content-type': 'application/json' }, chunks: [JSON.stringify({ error: { message: `No route for ${method} ${url}` } })] };
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.bodyText ?? '{}') as Record<string, unknown>;
    } catch {
      return { status: 400, headers: { ...CORS, 'content-type': 'application/json' }, chunks: [JSON.stringify({ error: { message: 'Invalid JSON body' } })] };
    }
    const described = describeRequest(protocol, url, body);
    const turn = opts.contextWindow && described.inputTokens > opts.contextWindow ? { error: contextLengthError(protocol, described.inputTokens, opts.contextWindow) } : await script(described);
    if (turn.error) {
      const b = turn.error.body ?? { error: { message: `Mock error ${turn.error.status}` } };
      return { status: turn.error.status, headers: { ...CORS, 'content-type': 'application/json', ...(turn.error.headers ?? {}) }, chunks: [typeof b === 'string' ? b : JSON.stringify(b)] };
    }
    const model = typeof body.model === 'string' ? body.model : (/models\/([^:]+):/.exec(url)?.[1] ?? 'mock-model');
    const chunks = protocol === 'openai' ? openaiChunks(turn, model, size) : protocol === 'anthropic' ? anthropicChunks(turn, model, size) : geminiChunks(turn, size);
    return { status: 200, headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, chunks };
  };
}

const abortErr = () => {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
};

/** A `fetch` that answers with the script (every request is also recorded in `calls`). */
export function createMockFetch(script: MockScript, opts: MockOptions = {}): ((input: string, init?: RequestInit) => Promise<Response>) & { calls: { url: string; body: unknown; headers: Record<string, string> }[] } {
  const handler = mockServerHandler(script, opts);
  const delay = opts.delayMs ?? 0;
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const f = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortErr();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ url: input, body: bodyText ? tryJson(bodyText) : undefined, headers });
    const res = await handler({ url: input, method: init.method ?? 'GET', headers, bodyText });
    if (signal?.aborted) throw abortErr();
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        };
        onAbort = () => {
          cleanup();
          try {
            controller.error(abortErr());
          } catch {
            /* already closed */
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const pump = () => {
          if (signal?.aborted) return;
          if (i >= res.chunks.length) {
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(res.chunks[i++]));
          if (delay > 0) timer = setTimeout(pump, delay);
          else queueMicrotask(pump);
        };
        pump();
      },
      cancel() {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      },
    });
    return new Response(res.status === 204 ? null : stream, { status: res.status, headers: res.headers });
  };
  return Object.assign(f, { calls });
}
