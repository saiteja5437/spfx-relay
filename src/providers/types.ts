import type { ZodType } from 'zod';

/**
 * The provider contract. The pipeline imports ONLY this interface — never a
 * concrete adapter — so adding a provider (OpenAI, Azure OpenAI, …) is one new
 * file implementing `ModelProvider`, with zero pipeline changes.
 */

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult<T> {
  value: T;
  /** Model that actually served the request (as reported by the provider). */
  model: string;
  usage: ProviderUsage;
  /** Raw text the model produced — logged to the run manifest, never parsed downstream. */
  rawText: string;
}

export interface GenerateOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** 0 for determinism where supported; adapters that don't support it ignore it. */
  temperature?: number;
  /** When set on generateText, the adapter streams and calls back per text delta. */
  onDelta?: (text: string) => void;
}

export interface ProviderCapabilities {
  name: string;
  model: string;
  /** Native JSON-schema enforcement. Local Zod validation runs regardless. */
  supportsJsonSchema: boolean;
  supportsTemperature: boolean;
  streaming: boolean;
}

export interface ModelProvider {
  capabilities(): ProviderCapabilities;
  generateText(options: GenerateOptions): Promise<ProviderResult<string>>;
  generateStructured<T>(options: GenerateOptions, schema: ZodType<T>): Promise<ProviderResult<T>>;
}

export type ProviderErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'invalid-request'
  | 'server'
  /** Response arrived but failed JSON parsing or schema validation. */
  | 'invalid-response'
  /** The model declined to answer. */
  | 'refusal';

/**
 * Every failure surfaces as a typed ProviderError so callers branch on `kind`
 * and `retryable` — never on message strings.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Machine-consumable detail, e.g. schema-validation issues fed to the repair loop. */
  readonly details?: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable?: boolean; details?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
