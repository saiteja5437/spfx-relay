import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryResponseCache } from '../../src/pipeline/cache';
import { RunManifest } from '../../src/pipeline/manifest';
import { runStructuredStep, StepFailure } from '../../src/pipeline/step';
import { ProviderError } from '../../src/providers/types';
import { ok, scriptedProvider } from './helpers';

const Greeting = z.object({ greeting: z.string() });

const base = { name: 'test-step', system: 'sys', prompt: 'original prompt' };

function invalidResponse(details: string, raw: string) {
  return new ProviderError('invalid-response', 'validation failed', { details, raw });
}

describe('runStructuredStep', () => {
  it('returns a first-try success and records it in the manifest', async () => {
    const { provider, calls } = scriptedProvider([ok({ greeting: 'hi' })]);
    const manifest = new RunManifest();

    const result = await runStructuredStep({ ...base, provider, manifest }, Greeting);

    expect(result.value).toEqual({ greeting: 'hi' });
    expect(calls).toHaveLength(1);
    expect(manifest.steps[0]).toMatchObject({
      step: 'test-step',
      attempts: 1,
      cacheHit: false,
      outcome: 'ok',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it('repairs a validation failure by re-prompting with the errors and previous output', async () => {
    const { provider, calls } = scriptedProvider([
      invalidResponse('greeting: expected string, got number', '{"greeting":1}'),
      ok({ greeting: 'fixed' }),
    ]);
    const manifest = new RunManifest();

    const result = await runStructuredStep({ ...base, provider, manifest }, Greeting);

    expect(result.value).toEqual({ greeting: 'fixed' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe('original prompt');
    expect(calls[1]?.prompt).toContain('original prompt');
    expect(calls[1]?.prompt).toContain('greeting: expected string, got number');
    expect(calls[1]?.prompt).toContain('{"greeting":1}');
    expect(manifest.steps[0]).toMatchObject({ attempts: 2, outcome: 'ok' });
  });

  it('fails loudly after maxAttempts — the loop is bounded', async () => {
    const { provider, calls } = scriptedProvider([
      invalidResponse('bad', '{}'),
      invalidResponse('still bad', '{}'),
    ]);
    const manifest = new RunManifest();

    await expect(
      runStructuredStep({ ...base, provider, manifest, maxAttempts: 2 }, Greeting),
    ).rejects.toBeInstanceOf(StepFailure);

    expect(calls).toHaveLength(2);
    expect(manifest.steps[0]).toMatchObject({ attempts: 2, outcome: 'failed' });
    expect(manifest.steps[0]?.error).toContain('validation failed');
  });

  it('does not repair non-repairable errors (auth fails immediately)', async () => {
    const { provider, calls } = scriptedProvider([new ProviderError('auth', 'bad key')]);

    await expect(runStructuredStep({ ...base, provider }, Greeting)).rejects.toBeInstanceOf(StepFailure);
    expect(calls).toHaveLength(1);
  });

  it('replays from cache without calling the provider', async () => {
    const cache = new MemoryResponseCache();
    const manifest = new RunManifest();

    const first = scriptedProvider([ok({ greeting: 'cached' })]);
    await runStructuredStep({ ...base, provider: first.provider, cache }, Greeting);

    // Empty script: any provider call would throw 'script exhausted'.
    const second = scriptedProvider([]);
    const replay = await runStructuredStep({ ...base, provider: second.provider, cache, manifest }, Greeting);

    expect(replay.value).toEqual({ greeting: 'cached' });
    expect(second.calls).toHaveLength(0);
    expect(manifest.steps[0]).toMatchObject({ cacheHit: true, attempts: 0, outcome: 'ok' });
  });

  it('ignores a cache entry that no longer matches the schema', async () => {
    const cache = new MemoryResponseCache();
    const first = scriptedProvider([ok({ greeting: 'v1' })]);
    await runStructuredStep({ ...base, provider: first.provider, cache }, Greeting);

    // Same request, stricter schema — the old entry must not slip through.
    const Stricter = z.object({ greeting: z.string().min(10) });
    const second = scriptedProvider([ok({ greeting: 'long enough now' })]);
    const result = await runStructuredStep({ ...base, provider: second.provider, cache }, Stricter);

    expect(result.value).toEqual({ greeting: 'long enough now' });
    expect(second.calls).toHaveLength(1);
  });

  it('accumulates total usage across steps in the manifest', async () => {
    const manifest = new RunManifest();
    const { provider } = scriptedProvider([ok({ greeting: 'a' }), ok({ greeting: 'b' })]);
    await runStructuredStep({ ...base, provider, manifest }, Greeting);
    await runStructuredStep({ ...base, name: 'second', provider, manifest, prompt: 'other' }, Greeting);

    expect(manifest.totalUsage()).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(manifest.toJSON().steps).toHaveLength(2);
  });
});
