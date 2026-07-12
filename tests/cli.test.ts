import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { analyzeCoupling, analyzeCouplingDir } from '../src/analyze/coupling';
import { analyzeWebPart } from '../src/analyze/index';
import { main, migrationNameFrom, parseCliArgs, providerConfigFrom, renderPlan, resolveStrategy } from '../src/cli';
import { buildPlan } from '../src/pipeline/plan';

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

  it('parses --strategy and rejects unknown values; eval never carries it', () => {
    expect(parseCliArgs(['migrate', './x', '--out', './y', '--strategy', 'spa'])).toMatchObject({ strategy: 'spa' });
    expect(parseCliArgs(['migrate', './x', '--out', './y', '--strategy', 'decompose'])).toMatchObject({
      strategy: 'decompose',
    });
    expect(() => parseCliArgs(['migrate', './x', '--out', './y', '--strategy', 'single'])).toThrowError(
      /Unknown strategy/,
    );
    // Eval stays deterministic: it always follows the recommendation.
    expect(parseCliArgs(['eval', '--strategy', 'spa'])).not.toHaveProperty('strategy');
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

describe('renderPlan', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('shows the coupling strategy with recommendation, parts, and reasons', () => {
    const fixture = join(here, 'fixtures', 'multi-part-independent');
    const plan = buildPlan({
      analysis: analyzeWebPart(fixture),
      name: 'multi-part-independent',
      coupling: analyzeCouplingDir(fixture),
    });

    const text = renderPlan(plan);
    expect(text).toContain('Strategy:          decompose');
    expect(text).toContain('    NewsPanel  ←  #news-panel');
    expect(text).toContain('    StockTicker  ←  #stock-ticker');
    expect(text).toContain('safe to split into separate web parts');
  });

  it('omits the strategy section when the plan has none (v1 flow)', () => {
    const fixture = join(here, 'fixtures', 'multi-part-independent');
    const plan = buildPlan({ analysis: analyzeWebPart(fixture), name: 'multi-part-independent' });
    expect(renderPlan(plan)).not.toContain('Strategy:');
  });
});

describe('resolveStrategy (safe-direction rule)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const independent = analyzeCouplingDir(join(here, 'fixtures', 'multi-part-independent'));
  const coupled = analyzeCouplingDir(join(here, 'fixtures', 'multi-part-coupled'));
  const single = analyzeCouplingDir(join(here, '..', 'corpus', '001-static-hello', 'input'));
  // spa recommended purely from unattributed-lookup tolerance — zero edges.
  const toleranceOnly = analyzeCoupling({
    html: '<html><body>\n<div id="alpha-box"></div>\n<div id="beta-box"></div>\n</body></html>',
    scripts: [{ file: 'app.js', code: 'var sel = window.location.hash;\n$(sel).show();\n' }],
  });

  it('defaults to the recommendation when no override is given', () => {
    expect(resolveStrategy(independent)).toEqual({ chosen: 'decompose', notes: [] });
    expect(resolveStrategy(coupled)).toEqual({ chosen: 'spa', notes: [] });
    expect(resolveStrategy(single)).toEqual({ chosen: 'single', notes: [] });
  });

  it('always allows decompose → spa (merging cannot break behavior)', () => {
    const decision = resolveStrategy(independent, 'spa');
    expect(decision.chosen).toBe('spa');
    expect(decision.refusal).toBeUndefined();
  });

  it('refuses spa → decompose when coupling edges exist, listing the evidence', () => {
    const decision = resolveStrategy(coupled, 'decompose');
    expect(decision.chosen).toBe('spa');
    expect(decision.refusal).toContain('refused');
    expect(decision.refusal).toContain("'cartTotal'");
    expect(decision.refusal).toContain('cart.js:1');
  });

  it('allows spa → decompose when spa came only from tolerance, with a loud warning', () => {
    expect(toleranceOnly.edges).toEqual([]);
    const decision = resolveStrategy(toleranceOnly, 'decompose');
    expect(decision.chosen).toBe('decompose');
    expect(decision.refusal).toBeUndefined();
    expect(decision.notes.join('\n')).toContain('WARNING');
    expect(decision.notes.join('\n')).toContain('1 DOM lookup(s)');
  });

  it('ignores the flag on a single-region page with a printed note', () => {
    for (const override of ['spa', 'decompose'] as const) {
      const decision = resolveStrategy(single, override);
      expect(decision.chosen).toBe('single');
      expect(decision.refusal).toBeUndefined();
      expect(decision.notes.join('\n')).toContain('ignored');
    }
  });
});

describe('main: refused decompose override', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('exits 2 (blocked), prints the edge evidence, and still writes the report', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'spfx-relay-refuse-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await main([
        'migrate',
        join(here, 'fixtures', 'multi-part-coupled'),
        '--out',
        outDir,
        '--strategy',
        'decompose',
        '--yes',
        '--skip-bundle',
      ]);
      expect(code).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain("'cartTotal'");
      expect(existsSync(join(outDir, 'migration-report.md'))).toBe(true);
      expect(existsSync(join(outDir, 'run-manifest.json'))).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
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
