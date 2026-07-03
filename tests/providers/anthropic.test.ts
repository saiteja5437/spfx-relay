import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { ProviderError } from '../../src/providers/types';
import { fakeFetch, jsonResponse, streamResponse } from './helpers';

const Greeting = z.object({ greeting: z.string() });

function provider(fetchFn: typeof fetch) {
  return new AnthropicProvider({
    apiKey: 'test-key',
    http: { fetchFn, maxRetries: 1, baseDelayMs: 1 },
  });
}

function messageResponse(text: string, overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  });
}

describe('AnthropicProvider', () => {
  it('requires an API key', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrowError(ProviderError);
  });

  it('sends the correct wire shape: url, headers, system field, closed JSON schema', async () => {
    const { fn, calls } = fakeFetch(messageResponse('{"greeting":"hi"}'));
    await provider(fn).generateStructured({ system: 'sys', prompt: 'greet', maxTokens: 200 }, Greeting);

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBe(200);
    expect(body.messages).toEqual([{ role: 'user', content: 'greet' }]);
    // Sampling params are never sent — current Claude models reject them.
    expect(body).not.toHaveProperty('temperature');
    const format = (body.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema.additionalProperties).toBe(false);
  });

  it('returns locally validated structured output with usage', async () => {
    const { fn } = fakeFetch(messageResponse('{"greeting":"hello"}'));
    const result = await provider(fn).generateStructured({ system: 's', prompt: 'p' }, Greeting);
    expect(result.value).toEqual({ greeting: 'hello' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('rejects schema-violating output with repair-ready details', async () => {
    const { fn } = fakeFetch(messageResponse('{"wrong":"shape"}'));
    const promise = provider(fn).generateStructured({ system: 's', prompt: 'p' }, Greeting);
    await expect(promise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.kind === 'invalid-response' && (e.details ?? '').includes('greeting'),
    );
  });

  it('maps 401 to auth and 400 to invalid-request', async () => {
    const p1 = provider(fakeFetch(new Response('no', { status: 401 })).fn);
    await expect(p1.generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({ kind: 'auth' });

    const p2 = provider(fakeFetch(new Response('bad', { status: 400 })).fn);
    await expect(p2.generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'invalid-request',
      retryable: false,
    });
  });

  it('retries 429 then surfaces rate-limit when exhausted', async () => {
    const { fn, calls } = fakeFetch(
      new Response('slow', { status: 429, headers: { 'retry-after': '0' } }),
      new Response('slow', { status: 429, headers: { 'retry-after': '0' } }),
    );
    await expect(provider(fn).generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'rate-limit',
      retryable: true,
    });
    expect(calls).toHaveLength(2); // maxRetries: 1 → initial attempt + one retry
  });

  it('surfaces a refusal stop_reason as a typed refusal error', async () => {
    const { fn } = fakeFetch(messageResponse('', { stop_reason: 'refusal', content: [] }));
    await expect(provider(fn).generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'refusal',
    });
  });

  it('fails loudly on max_tokens truncation instead of returning partial output', async () => {
    const { fn } = fakeFetch(messageResponse('partial…', { stop_reason: 'max_tokens' }));
    await expect(provider(fn).generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('streams text deltas over SSE and accumulates usage', async () => {
    const sse = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":12}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { fn, calls } = fakeFetch(streamResponse(sse, 'text/event-stream'));

    const deltas: string[] = [];
    const result = await provider(fn).generateText({
      system: 's',
      prompt: 'p',
      onDelta: (t) => deltas.push(t),
    });

    expect((calls[0]?.body as Record<string, unknown>).stream).toBe(true);
    expect(deltas).toEqual(['Hello', ' world']);
    expect(result.value).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('surfaces stream error events as retryable server errors', async () => {
    const sse = ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'];
    const { fn } = fakeFetch(streamResponse(sse, 'text/event-stream'));
    const promise = provider(fn).generateText({ system: 's', prompt: 'p', onDelta: () => {} });
    await expect(promise).rejects.toMatchObject({ kind: 'server', retryable: true });
  });
});
