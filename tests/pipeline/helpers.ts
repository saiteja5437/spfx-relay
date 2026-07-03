import type {
  GenerateOptions,
  ModelProvider,
  ProviderCapabilities,
  ProviderResult,
} from '../../src/providers/types';

/** A scripted ModelProvider: replays queued results/errors and records every call. */
export function scriptedProvider(
  script: Array<ProviderResult<unknown> | Error>,
  capabilities: Partial<ProviderCapabilities> = {},
): { provider: ModelProvider; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = [];
  const queue = [...script];

  const next = (): ProviderResult<unknown> => {
    const item = queue.shift();
    if (!item) throw new Error('scriptedProvider: script exhausted — unexpected extra call');
    if (item instanceof Error) throw item;
    return item;
  };

  const provider: ModelProvider = {
    capabilities: () => ({
      name: 'fake',
      model: 'fake-model',
      supportsJsonSchema: true,
      supportsTemperature: true,
      streaming: false,
      ...capabilities,
    }),
    generateText: (options) => {
      calls.push(options);
      return Promise.resolve(next() as ProviderResult<string>);
    },
    generateStructured: <T>(options: GenerateOptions) => {
      calls.push(options);
      return Promise.resolve(next() as ProviderResult<T>);
    },
  };

  return { provider, calls };
}

export function ok<T>(value: T): ProviderResult<T> {
  return {
    value,
    model: 'fake-model',
    usage: { inputTokens: 100, outputTokens: 50 },
    rawText: JSON.stringify(value),
  };
}
