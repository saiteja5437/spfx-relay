import { describe, expect, it } from 'vitest';
import { fetchWithRetry, parseNdjson, parseSse, type SseEvent } from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';
import { chunkedStream, fakeFetch, hangingFetch, jsonResponse } from './helpers';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe('parseSse', () => {
  it('parses named events with data payloads', async () => {
    const events = await collect(
      parseSse(chunkedStream(['event: ping\ndata: {"a":1}\n\nevent: pong\ndata: {"b":2}\n\n'])),
    );
    expect(events).toEqual<SseEvent[]>([
      { event: 'ping', data: '{"a":1}' },
      { event: 'pong', data: '{"b":2}' },
    ]);
  });

  it('survives chunk boundaries landing mid-line and mid-event', async () => {
    const events = await collect(
      parseSse(chunkedStream(['event: pi', 'ng\nda', 'ta: hello\n', '\nevent: pong\ndata: world\n\n'])),
    );
    expect(events).toEqual([
      { event: 'ping', data: 'hello' },
      { event: 'pong', data: 'world' },
    ]);
  });

  it('joins multi-line data, defaults the event name, and ignores comments', async () => {
    const events = await collect(parseSse(chunkedStream([': keep-alive\ndata: line1\ndata: line2\n\n'])));
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(parseSse(chunkedStream(['event: ping\r\ndata: hi\r\n\r\n'])));
    expect(events).toEqual([{ event: 'ping', data: 'hi' }]);
  });

  it('flushes a final event missing its trailing blank line', async () => {
    const events = await collect(parseSse(chunkedStream(['data: tail'])));
    expect(events).toEqual([{ event: 'message', data: 'tail' }]);
  });
});

describe('parseNdjson', () => {
  it('yields one parsed object per line across chunk boundaries', async () => {
    const items = await collect(parseNdjson(chunkedStream(['{"n":1}\n{"n"', ':2}\n', '{"n":3}'])));
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('skips blank lines and tolerates CRLF', async () => {
    const items = await collect(parseNdjson(chunkedStream(['{"n":1}\r\n\r\n{"n":2}\r\n'])));
    expect(items).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('fetchWithRetry', () => {
  it('retries 429 honoring retry-after, then succeeds', async () => {
    const { fn, calls } = fakeFetch(
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      jsonResponse({ ok: true }),
    );
    const response = await fetchWithRetry('https://x.test/', {}, { fetchFn: fn, maxRetries: 2, baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('returns the last failing response once retries are exhausted', async () => {
    const { fn, calls } = fakeFetch(
      new Response('boom', { status: 500 }),
      new Response('boom', { status: 500 }),
    );
    const response = await fetchWithRetry('https://x.test/', {}, { fetchFn: fn, maxRetries: 1, baseDelayMs: 1 });
    expect(response.status).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it('does not retry non-retryable statuses', async () => {
    const { fn, calls } = fakeFetch(new Response('nope', { status: 401 }));
    const response = await fetchWithRetry('https://x.test/', {}, { fetchFn: fn, maxRetries: 2, baseDelayMs: 1 });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('fails fast on timeout without retrying — even with retries configured', async () => {
    let callCount = 0;
    const counting: typeof fetch = (input, init) => {
      callCount++;
      return hangingFetch()(input, init);
    };
    const promise = fetchWithRetry(
      'https://x.test/',
      {},
      { fetchFn: counting, maxRetries: 2, timeoutMs: 20, baseDelayMs: 1 },
    );
    await expect(promise).rejects.toMatchObject({ name: 'ProviderError', kind: 'timeout', retryable: false });
    expect(callCount).toBe(1);
  });

  it('retries fast connection failures before giving up', async () => {
    let callCount = 0;
    const flaky: typeof fetch = () => {
      callCount++;
      return callCount < 3 ? Promise.reject(new TypeError('ECONNREFUSED')) : Promise.resolve(jsonResponse({ ok: true }));
    };
    const response = await fetchWithRetry('https://x.test/', {}, { fetchFn: flaky, maxRetries: 2, baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
  });

  it('maps a network failure to a retryable network ProviderError', async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError('ECONNREFUSED'));
    const promise = fetchWithRetry('https://x.test/', {}, { fetchFn: failing, maxRetries: 0, baseDelayMs: 1 });
    await expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.kind === 'network' && e.retryable,
    );
  });
});
