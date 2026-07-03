import { describe, expect, it } from 'vitest';
import { parseCliArgs, providerConfigFrom } from '../src/cli';

describe('parseCliArgs', () => {
  it('parses a full migrate invocation', () => {
    const options = parseCliArgs([
      'migrate',
      './legacy',
      '--out',
      './webpart',
      '--provider',
      'ollama',
      '--model',
      'qwen2.5-coder',
      '--yes',
      '--no-cache',
      '--skip-bundle',
      '--force',
    ]);
    expect(options).toEqual({
      command: 'migrate',
      input: './legacy',
      out: './webpart',
      provider: 'ollama',
      model: 'qwen2.5-coder',
      yes: true,
      noCache: true,
      skipBundle: true,
      force: true,
    });
  });

  it('defaults to anthropic with approval and cache enabled', () => {
    const options = parseCliArgs(['migrate', './legacy', '--out', './webpart']);
    expect(options.provider).toBe('anthropic');
    expect(options.yes).toBe(false);
    expect(options.noCache).toBe(false);
    expect(options.skipBundle).toBe(false);
  });

  it('rejects missing input, missing --out, unknown command, unknown provider', () => {
    expect(() => parseCliArgs(['migrate', '--out', 'x'])).toThrowError(/Missing <input>/);
    expect(() => parseCliArgs(['migrate', './legacy'])).toThrowError(/Missing --out/);
    expect(() => parseCliArgs(['convert', './legacy', '--out', 'x'])).toThrowError(/Unknown command/);
    expect(() => parseCliArgs(['migrate', './legacy', '--out', 'x', '--provider', 'openai'])).toThrowError(
      /Unknown provider/,
    );
  });
});

describe('providerConfigFrom', () => {
  const base = parseCliArgs(['migrate', 'in', '--out', 'out']);

  it('builds anthropic config from the environment key', () => {
    const config = providerConfigFrom(base, { ANTHROPIC_API_KEY: 'sk-test' });
    expect(config).toEqual({ provider: 'anthropic', apiKey: 'sk-test' });
  });

  it('passes an explicit model through', () => {
    const config = providerConfigFrom({ ...base, model: 'claude-sonnet-4-6' }, { ANTHROPIC_API_KEY: 'k' });
    expect(config).toEqual({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-6' });
  });

  it('defaults ollama to llama3.1 when no model is given', () => {
    const config = providerConfigFrom({ ...base, provider: 'ollama' }, {});
    expect(config).toEqual({ provider: 'ollama', model: 'llama3.1' });
  });
});
