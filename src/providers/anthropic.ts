import type { ZodType } from 'zod';
import { fetchWithRetry, parseSse, type HttpOptions } from './http';
import { closedJsonSchema, parseStructured } from './structured';
import {
  ProviderError,
  type GenerateOptions,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type ProviderUsage,
} from './types';

/**
 * Anthropic Messages API adapter over raw HTTP — deliberately no SDK, so the
 * wire format (headers, body shape, SSE event stream) stays visible. In a
 * production system you would normally use @anthropic-ai/sdk.
 */

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16_000;
const API_VERSION = '2023-06-01';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  http?: HttpOptions;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsage;
}

interface AnthropicStreamData {
  message?: { model?: string; usage?: AnthropicUsage };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
}

export class AnthropicProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly config: AnthropicConfig) {
    if (!config.apiKey) {
      throw new ProviderError('auth', 'Anthropic API key is missing — set ANTHROPIC_API_KEY.');
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  capabilities(): ProviderCapabilities {
    return {
      name: 'anthropic',
      model: this.model,
      supportsJsonSchema: true,
      // Current Claude models reject sampling parameters; pipeline determinism
      // comes from the response cache, so the adapter never sends temperature.
      supportsTemperature: false,
      streaming: true,
    };
  }

  async generateText(options: GenerateOptions): Promise<ProviderResult<string>> {
    if (options.onDelta) return this.generateTextStreaming(options);

    const response = await this.request(this.baseBody(options));
    const data = (await response.json()) as AnthropicResponse;
    this.checkStopReason(data.stop_reason ?? null);
    const text = textOf(data);
    return { value: text, model: data.model ?? this.model, usage: usageOf(data.usage), rawText: text };
  }

  async generateStructured<T>(options: GenerateOptions, schema: ZodType<T>): Promise<ProviderResult<T>> {
    const body = {
      ...this.baseBody(options),
      output_config: { format: { type: 'json_schema', schema: closedJsonSchema(schema) } },
    };
    const response = await this.request(body);
    const data = (await response.json()) as AnthropicResponse;
    this.checkStopReason(data.stop_reason ?? null);

    const rawText = textOf(data);
    const parsed = parseStructured(rawText, schema);
    if (!parsed.ok) {
      throw new ProviderError('invalid-response', 'Anthropic response failed local schema validation.', {
        details: parsed.error,
        raw: rawText,
      });
    }
    return { value: parsed.value, model: data.model ?? this.model, usage: usageOf(data.usage), rawText };
  }

  private async generateTextStreaming(options: GenerateOptions): Promise<ProviderResult<string>> {
    const response = await this.request({ ...this.baseBody(options), stream: true });
    if (!response.body) {
      throw new ProviderError('invalid-response', 'Anthropic returned no body for a streaming request.');
    }

    let text = '';
    let model = this.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;

    for await (const event of parseSse(response.body)) {
      switch (event.event) {
        case 'message_start': {
          const data = JSON.parse(event.data) as AnthropicStreamData;
          model = data.message?.model ?? model;
          inputTokens = data.message?.usage?.input_tokens ?? inputTokens;
          break;
        }
        case 'content_block_delta': {
          const data = JSON.parse(event.data) as AnthropicStreamData;
          if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
            text += data.delta.text;
            options.onDelta?.(data.delta.text);
          }
          break;
        }
        case 'message_delta': {
          const data = JSON.parse(event.data) as AnthropicStreamData;
          outputTokens = data.usage?.output_tokens ?? outputTokens;
          stopReason = data.delta?.stop_reason ?? stopReason;
          break;
        }
        case 'error':
          throw new ProviderError('server', `Anthropic stream error: ${event.data}`, { retryable: true });
      }
    }

    this.checkStopReason(stopReason);
    return { value: text, model, usage: { inputTokens, outputTokens }, rawText: text };
  }

  private baseBody(options: GenerateOptions): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: options.system,
      messages: [{ role: 'user', content: options.prompt }],
    };
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      },
      this.config.http,
    );
    if (!response.ok) await this.raise(response);
    return response;
  }

  private async raise(response: Response): Promise<never> {
    const bodyText = await response.text().catch(() => '');
    const status = response.status;
    const kind =
      status === 401 || status === 403
        ? 'auth'
        : status === 429
          ? 'rate-limit'
          : status >= 500
            ? 'server'
            : 'invalid-request';
    throw new ProviderError(kind, `Anthropic API ${status}: ${truncate(bodyText)}`, {
      retryable: kind === 'rate-limit' || kind === 'server',
    });
  }

  private checkStopReason(stopReason: string | null): void {
    if (stopReason === 'refusal') {
      throw new ProviderError('refusal', 'The model declined this request.');
    }
    if (stopReason === 'max_tokens') {
      throw new ProviderError('invalid-response', 'Output was truncated at max_tokens — raise maxTokens.', {
        details: 'stop_reason=max_tokens',
      });
    }
  }
}

function textOf(data: AnthropicResponse): string {
  return (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function usageOf(usage: AnthropicUsage | undefined): ProviderUsage {
  return { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 };
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
