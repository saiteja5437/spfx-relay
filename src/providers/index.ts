import { AnthropicProvider, type AnthropicConfig } from './anthropic';
import { OllamaProvider, type OllamaConfig } from './ollama';
import type { ModelProvider } from './types';

export type ProviderConfig =
  | ({ provider: 'anthropic' } & AnthropicConfig)
  | ({ provider: 'ollama' } & OllamaConfig);

/** The only place concrete adapters are referenced — everything else uses ModelProvider. */
export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
  }
}

export type { AnthropicConfig } from './anthropic';
export type { OllamaConfig } from './ollama';
export { parseStructured, closedJsonSchema } from './structured';
export * from './types';
