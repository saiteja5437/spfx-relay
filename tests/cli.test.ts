import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNameFrom, parseCliArgs, providerConfigFrom } from '../src/cli';

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
    expect(options).toMatchObject({ provider: 'anthropic', yes: false, noCache: false, skipBundle: false });
  });

  it('parses an eval invocation with its own defaults', () => {
    expect(parseCliArgs(['eval', '--provider', 'ollama', '--model', 'gemma4:31b-cloud'])).toEqual({
      command: 'eval',
      provider: 'ollama',
      model: 'gemma4:31b-cloud',
      corpus: 'corpus',
      noCache: false,
    });
    expect(parseCliArgs(['eval'])).toMatchObject({ command: 'eval', provider: 'anthropic', corpus: 'corpus' });
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

describe('migrationNameFrom', () => {
  it('uses the folder name directly when it is descriptive', () => {
    expect(migrationNameFrom(join('c:', 'work', 'team-directory'))).toBe('team-directory');
  });

  it('skips generic layout folder names like input/ and src/', () => {
    expect(migrationNameFrom(join('c:', 'corpus', '001-static-hello', 'input'))).toBe('001-static-hello');
    expect(migrationNameFrom(join('c:', 'legacy-widget', 'src'))).toBe('legacy-widget');
  });

  it('accepts an explicit --name option in parsing', () => {
    const options = parseCliArgs(['migrate', './x', '--out', './y', '--name', 'TeamDirectory']);
    expect(options).toMatchObject({ name: 'TeamDirectory' });
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
