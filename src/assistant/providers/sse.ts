/*
 * Streaming readers for provider responses: Server-Sent Events (OpenAI,
 * Anthropic, Gemini `alt=sse`) and newline-delimited JSON. They decode UTF-8
 * across chunk boundaries, accept LF, CRLF and bare CR line endings, and
 * release the body when the consumer stops early or the request is aborted.
 */

/** One dispatched SSE event. */
export interface SSEMessage {
  /** the `event:` name, `message` when the server sent none */
  event: string;
  /** the `data:` lines joined with `\n` */
  data: string;
  id?: string;
}

/** Yields the body's lines (without their terminators), decoding UTF-8 across chunks. */
export async function* readLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let scanFrom = 0;
  let first = true;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (first && buffer.length) {
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
        first = false;
      }
      let start = 0;
      for (let i = scanFrom; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c === 10 /* \n */) {
          yield buffer.slice(start, i);
          start = i + 1;
        } else if (c === 13 /* \r */) {
          // a CR at the very end may be the first half of a CRLF split across chunks: keep it
          if (i === buffer.length - 1) break;
          yield buffer.slice(start, i);
          start = buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
          if (buffer.charCodeAt(i + 1) === 10) i++;
        }
      }
      buffer = buffer.slice(start);
      // the remainder holds no terminator (but maybe a trailing CR): resume scanning at its end
      scanFrom = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length;
    }
    if (signal?.aborted) throw abortError(signal);
    buffer += decoder.decode();
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer.length) yield buffer;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

/**
 * Parses an SSE stream (the WHATWG rules: `data:` lines accumulate, a blank
 * line dispatches, `:` lines are comments, one leading space after the colon
 * is dropped). An event left pending when the stream ends is still
 * dispatched: some servers omit the final blank line.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  for await (const line of readLines(body, signal)) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n'), id };
      data = [];
      event = '';
      continue;
    }
    if (line.charCodeAt(0) === 58 /* : */) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n'), id };
}

/** The OpenAI-style end-of-stream sentinel. */
export const isDoneSentinel = (data: string) => data.trim() === '[DONE]';

/** Yields each non-empty line of a newline-delimited JSON body, parsed. Malformed lines throw. */
export async function* readNDJSON(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  for await (const line of readLines(body, signal)) {
    const t = line.trim();
    if (t) yield JSON.parse(t);
  }
}

/** A DOMException-like AbortError carrying the signal's reason. */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const e = new Error(typeof reason === 'string' ? reason : 'The operation was aborted.');
  e.name = 'AbortError';
  return e;
}
