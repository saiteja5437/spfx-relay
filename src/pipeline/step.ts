import type { ZodType } from 'zod';
import { closedJsonSchema } from '../providers/structured';
import { ProviderError, type ModelProvider, type ProviderResult } from '../providers/types';
import { cacheKey, type ResponseCache } from './cache';
import type { RunManifest } from './manifest';

/**
 * The sealed step runner — every LLM call in the pipeline goes through here.
 * Guarantees, in order:
 *   1. Cache replay when an identical request was answered before.
 *   2. Schema-validated output (enforced by the provider adapter).
 *   3. A BOUNDED repair loop: validation failures are re-prompted with the
 *      exact errors and previous output, at most `maxAttempts` times total.
 *   4. A loud, typed StepFailure afterwards — never a silent guess.
 */

export interface StepOptions {
  name: string;
  provider: ModelProvider;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Total attempts including the first call. Default 3 (one call + two repairs). */
  maxAttempts?: number;
  cache?: ResponseCache;
  manifest?: RunManifest;
}

export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly attempts: number,
    cause: Error,
  ) {
    super(`Step '${step}' failed after ${attempts} attempt(s): ${cause.message}`, { cause });
    this.name = 'StepFailure';
  }
}

export async function runStructuredStep<T>(options: StepOptions, schema: ZodType<T>): Promise<ProviderResult<T>> {
  const { name, provider, system, prompt, maxAttempts = 3, cache, manifest } = options;
  const capabilities = provider.capabilities();
  const key = cacheKey({
    provider: capabilities.name,
    model: capabilities.model,
    system,
    prompt,
    schema: closedJsonSchema(schema),
  });
  const started = Date.now();

  const cached = cache?.get(key);
  if (cached) {
    // Re-validate: a cache entry written under an older schema must not slip through.
    const check = schema.safeParse(cached.value);
    if (check.success) {
      manifest?.record({
        step: name,
        provider: capabilities.name,
        model: cached.model,
        promptHash: key,
        attempts: 0,
        cacheHit: true,
        usage: cached.usage,
        outcome: 'ok',
        durationMs: Date.now() - started,
      });
      return { value: check.data, model: cached.model, usage: cached.usage, rawText: cached.rawText };
    }
  }

  let currentPrompt = prompt;
  let lastError: Error = new Error('step never ran');
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      const result = await provider.generateStructured(
        { system, prompt: currentPrompt, maxTokens: options.maxTokens, temperature: 0 },
        schema,
      );
      cache?.set(key, { rawText: result.rawText, value: result.value, model: result.model, usage: result.usage });
      manifest?.record({
        step: name,
        provider: capabilities.name,
        model: result.model,
        promptHash: key,
        attempts: attempt,
        cacheHit: false,
        usage: result.usage,
        outcome: 'ok',
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      lastError = error as Error;
      const repairable = error instanceof ProviderError && error.kind === 'invalid-response';
      if (!repairable || attempt === maxAttempts) break;
      currentPrompt = repairPrompt(prompt, error);
    }
  }

  manifest?.record({
    step: name,
    provider: capabilities.name,
    model: capabilities.model,
    promptHash: key,
    attempts: attemptsMade,
    cacheHit: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    outcome: 'failed',
    error: lastError.message,
    durationMs: Date.now() - started,
  });
  throw new StepFailure(name, attemptsMade, lastError);
}

function repairPrompt(originalPrompt: string, error: ProviderError): string {
  const previous = error.raw ? `Your previous response (may be truncated):\n${truncate(error.raw, 2000)}\n\n` : '';
  return (
    `${originalPrompt}\n\n---\n` +
    `Your previous response was rejected by schema validation.\n${previous}` +
    `Validation errors: ${error.details ?? error.message}\n` +
    `Respond again with ONLY valid JSON matching the required schema. Fix these exact errors.`
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
