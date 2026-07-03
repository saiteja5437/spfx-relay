import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OllamaProvider } from '../../src/providers/ollama';
import { ProviderError } from '../../src/providers/types';
import { fakeFetch, jsonResponse, streamResponse } from './helpers';

const Greeting = z.object({ greeting: z.string() });

function provider(fetchFn: typeof fetch) {
  return new OllamaProvider({
    model: 'llama3.1',
    http: { fetchFn, maxRetries: 0, baseDelayMs: 1 },
  });
}

function chatResponse(content: string) {
  return jsonResponse({
    model: 'llama3.1',
    message: { content },
    done: true,
    prompt_eval_count: 9,
    eval_count: 4,
  });
}

describe('OllamaProvider', () => {
  it('requires a model name', () => {
    expect(() => new OllamaProvider({ model: '' })).toThrowError(ProviderError);
  });

  it('sends the correct wire shape: local url, system as message role, format schema, temperature 0', async () => {
    const { fn, calls } = fakeFetch(chatResponse('{"greeting":"hi"}'));
    await provider(fn).generateStructured({ system: 'sys', prompt: 'greet' }, Greeting);

    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.stream).toBe(false); // Ollama defaults to streaming — must be explicit
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'greet' },
    ]);
    expect(body.options).toEqual({ temperature: 0 });
    expect((body.format as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('returns validated structured output with usage from eval counts', async () => {
    const { fn } = fakeFetch(chatResponse('{"greeting":"hello"}'));
    const result = await provider(fn).generateStructured({ system: 's', prompt: 'p' }, Greeting);
    expect(result.value).toEqual({ greeting: 'hello' });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it('tolerates markdown-fenced JSON from weaker models', async () => {
    const { fn } = fakeFetch(chatResponse('```json\n{"greeting":"hi"}\n```'));
    const result = await provider(fn).generateStructured({ system: 's', prompt: 'p' }, Greeting);
    expect(result.value).toEqual({ greeting: 'hi' });
  });

  it('rejects schema-violating output with repair-ready details', async () => {
    const { fn } = fakeFetch(chatResponse('{"greeting":42}'));
    const promise = provider(fn).generateStructured({ system: 's', prompt: 'p' }, Greeting);
    await expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.kind === 'invalid-response' && e.details !== undefined,
    );
  });

  it('streams NDJSON deltas and reads usage from the final chunk', async () => {
    const ndjson = [
      '{"model":"llama3.1","message":{"content":"Hel"},"done":false}\n',
      '{"model":"llama3.1","message":{"content":"lo"},"done":false}\n',
      '{"model":"llama3.1","message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":4}\n',
    ];
    const { fn, calls } = fakeFetch(streamResponse(ndjson, 'application/x-ndjson'));

    const deltas: string[] = [];
    const result = await provider(fn).generateText({
      system: 's',
      prompt: 'p',
      onDelta: (t) => deltas.push(t),
    });

    expect((calls[0]?.body as Record<string, unknown>).stream).toBe(true);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result.value).toBe('Hello');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it('gives an actionable hint when the model is not pulled (404)', async () => {
    const { fn } = fakeFetch(new Response('model not found', { status: 404 }));
    await expect(provider(fn).generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'invalid-request',
      message: expect.stringContaining('ollama pull llama3.1'),
    });
  });

  it('gives an actionable hint when Ollama is not running', async () => {
    const refused: typeof fetch = () => Promise.reject(new TypeError('ECONNREFUSED'));
    const p = new OllamaProvider({ model: 'llama3.1', http: { fetchFn: refused, maxRetries: 0, baseDelayMs: 1 } });
    await expect(p.generateText({ system: 's', prompt: 'p' })).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('ollama serve'),
    });
  });
});
