import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProvider } from '../../src/providers/index';

/**
 * Optional live smoke tests — hit real APIs, so they are skipped unless
 * explicitly enabled. All other tests run without network or keys.
 *
 *   Anthropic:  SMOKE_ANTHROPIC=1 + ANTHROPIC_API_KEY set
 *   Ollama:     SMOKE_OLLAMA=1 (+ OLLAMA_MODEL, default llama3.1; needs `ollama serve`)
 */

const Greeting = z.object({
  greeting: z.string(),
  language: z.string(),
});

const options = {
  system: 'You are a test probe. Respond only with the requested JSON.',
  prompt: 'Return a short greeting in English.',
  maxTokens: 300,
};

describe.runIf(Boolean(process.env.SMOKE_ANTHROPIC && process.env.ANTHROPIC_API_KEY))(
  'anthropic live smoke',
  () => {
    it('generates structured output against the real API', async () => {
      const provider = createProvider({
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY as string,
      });
      const result = await provider.generateStructured(options, Greeting);
      expect(result.value.greeting.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    }, 60_000);
  },
);

describe.runIf(Boolean(process.env.SMOKE_OLLAMA))('ollama live smoke', () => {
  it('generates structured output against a local model', async () => {
    const provider = createProvider({
      provider: 'ollama',
      model: process.env.OLLAMA_MODEL ?? 'llama3.1',
    });
    const result = await provider.generateStructured(options, Greeting);
    expect(result.value.greeting.length).toBeGreaterThan(0);
  }, 180_000);
});
