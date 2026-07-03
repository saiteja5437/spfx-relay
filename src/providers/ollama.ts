import type { ZodType } from 'zod';
import { fetchWithRetry, parseNdjson, type HttpOptions } from './http';
import { closedJsonSchema, parseStructured } from './structured';
import {
  ProviderError,
  type GenerateOptions,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderResult,
} from './types';

/**
 * Ollama chat API adapter (local models, free). Deliberate wire-format contrast
 * with the Anthropic adapter: NDJSON streaming instead of SSE, system prompt as
 * a message role instead of a top-level field, JSON schema via `format`.
 *
 * Local models fail schema validation far more often than hosted frontier
 * models — the local parseStructured() gate is what keeps that failure loud
 * instead of silent.
 */

const DEFAULT_BASE_URL = 'http://localhost:11434';

export interface OllamaConfig {
  model: string;
  baseUrl?: string;
  http?: HttpOptions;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements ModelProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: OllamaConfig) {
    if (!config.model) {
      throw new ProviderError('invalid-request', "Ollama model name is required (e.g. 'llama3.1').");
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  capabilities(): ProviderCapabilities {
    return {
      name: 'ollama',
      model: this.config.model,
      supportsJsonSchema: true,
      supportsTemperature: true,
      streaming: true,
    };
  }

  async generateText(options: GenerateOptions): Promise<ProviderResult<string>> {
    if (options.onDelta) return this.generateTextStreaming(options);

    const response = await this.request({ ...this.baseBody(options), stream: false });
    const data = (await response.json()) as OllamaChatResponse;
    const text = data.message?.content ?? '';
    return { value: text, model: data.model ?? this.config.model, usage: usageOf(data), rawText: text };
  }

  async generateStructured<T>(options: GenerateOptions, schema: ZodType<T>): Promise<ProviderResult<T>> {
    const body = { ...this.baseBody(options), stream: false, format: closedJsonSchema(schema) };
    const response = await this.request(body);
    const data = (await response.json()) as OllamaChatResponse;

    const rawText = data.message?.content ?? '';
    const parsed = parseStructured(rawText, schema);
    if (!parsed.ok) {
      throw new ProviderError('invalid-response', 'Ollama response failed local schema validation.', {
        details: parsed.error,
        raw: rawText,
      });
    }
    return { value: parsed.value, model: data.model ?? this.config.model, usage: usageOf(data), rawText };
  }

  private async generateTextStreaming(options: GenerateOptions): Promise<ProviderResult<string>> {
    const response = await this.request({ ...this.baseBody(options), stream: true });
    if (!response.body) {
      throw new ProviderError('invalid-response', 'Ollama returned no body for a streaming request.');
    }

    let text = '';
    let model = this.config.model;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of parseNdjson(response.body)) {
      const data = chunk as OllamaChatResponse;
      if (data.error) {
        throw new ProviderError('server', `Ollama stream error: ${data.error}`, { retryable: true });
      }
      const delta = data.message?.content ?? '';
      if (delta.length > 0) {
        text += delta;
        options.onDelta?.(delta);
      }
      if (data.done) {
        model = data.model ?? model;
        inputTokens = data.prompt_eval_count ?? 0;
        outputTokens = data.eval_count ?? 0;
      }
    }

    return { value: text, model, usage: { inputTokens, outputTokens }, rawText: text };
  }

  private baseBody(options: GenerateOptions): Record<string, unknown> {
    return {
      model: this.config.model,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.prompt },
      ],
      options: { temperature: options.temperature ?? 0 },
    };
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.config.http,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'network') {
        throw new ProviderError(
          'network',
          `Could not reach Ollama at ${this.baseUrl} — is it running? Start it with 'ollama serve'.`,
          { retryable: true, cause: error.cause },
        );
      }
      throw error;
    }
    if (!response.ok) await this.raise(response);
    return response;
  }

  private async raise(response: Response): Promise<never> {
    const bodyText = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new ProviderError(
        'invalid-request',
        `Ollama model '${this.config.model}' not found — pull it first: 'ollama pull ${this.config.model}'.`,
      );
    }
    const kind = response.status >= 500 ? 'server' : 'invalid-request';
    throw new ProviderError(kind, `Ollama API ${response.status}: ${bodyText.slice(0, 300)}`, {
      retryable: kind === 'server',
    });
  }
}

function usageOf(data: OllamaChatResponse): { inputTokens: number; outputTokens: number } {
  return { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 };
}
