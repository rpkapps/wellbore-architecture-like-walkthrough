import { describe, expect, it } from 'vitest';
import { readLines, readNDJSON, readSSE } from '../../src/assistant/providers/sse';
import { collect, streamOf } from './core-helpers';

const enc = new TextEncoder();

describe('readLines', () => {
  it('splits LF, CRLF and bare CR, including a CRLF split across chunks', async () => {
    const lines = await collect(readLines(streamOf(['a\r', '\nb\nc\rd\r\n', 'e'])));
    expect(lines).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('decodes UTF-8 characters split across chunk boundaries', async () => {
    const bytes = enc.encode('data: “Hugin” 🛢️\n');
    const lines = await collect(readLines(streamOf([bytes.slice(0, 7), bytes.slice(7, 9), bytes.slice(9, 13), bytes.slice(13)])));
    expect(lines).toEqual(['data: “Hugin” 🛢️']);
  });

  it('strips a leading byte-order mark', async () => {
    expect(await collect(readLines(streamOf(['﻿hello\n'])))).toEqual(['hello']);
  });
});

describe('readSSE', () => {
  it('joins multi-line data, keeps event names and ids, skips comments', async () => {
    const events = await collect(readSSE(streamOf([': keep-alive\n', 'event: update\nid: 7\ndata: one\ndata:two\n\n', 'data: {"x":1}\n\n'])));
    expect(events).toEqual([
      { event: 'update', data: 'one\ntwo', id: '7' },
      { event: 'message', data: '{"x":1}', id: '7' },
    ]);
  });

  it('handles lines split at arbitrary positions and CRLF framing', async () => {
    const text = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"héllo"}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = enc.encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const events = await collect(readSSE(streamOf(chunks)));
    expect(events.map((e) => e.data)).toEqual(['{"type":"content_block_delta","delta":{"text":"héllo"}}', '[DONE]']);
    expect(events[0].event).toBe('content_block_delta');
  });

  it('dispatches a final event without a trailing blank line, and ignores empty data-less blocks', async () => {
    const events = await collect(readSSE(streamOf(['event: ping\n\n', 'data: last'])));
    expect(events).toEqual([{ event: 'message', data: 'last', id: undefined }]);
  });

  it('keeps the value when there is no space after the colon, and an empty data line', async () => {
    const events = await collect(readSSE(streamOf(['data:a\ndata:\ndata: b\n\n'])));
    expect(events[0].data).toBe('a\n\nb');
  });

  it('stops with an AbortError when the signal aborts mid-stream', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: 1\n\n'));
      },
    });
    const it = readSSE(body, ac.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value.data).toBe('1');
    const next = it.next();
    ac.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('readNDJSON', () => {
  it('parses one JSON value per line, skipping blank lines', async () => {
    expect(await collect(readNDJSON(streamOf(['{"a":1}\n\n{"b"', ':2}\n'])))).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
