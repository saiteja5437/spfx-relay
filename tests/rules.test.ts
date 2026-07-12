import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCouplingInput } from '../src/analyze/coupling';
import { classifyLocalScript } from '../src/analyze/dependencies';
import { analyzeWebPart } from '../src/analyze/index';
import { analyzeScript } from '../src/analyze/script';
import { secretFindings } from '../src/analyze/rules/secrets';
import { buildPlan } from '../src/pipeline/plan';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('hardcoded-secret rule', () => {
  const findingsFor = (code: string) =>
    secretFindings(analyzeScript(code, 'test.js').stringAssignments);

  it('flags a secret-named variable assigned a string', () => {
    const findings = findingsFor(`var apiKey = "abcd1234efgh";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'hardcoded-secret', severity: 'error', line: 1 });
  });

  it('flags known credential prefixes regardless of the variable name', () => {
    const findings = findingsFor(`var config = { value: "sk-live-abc12345" };`);
    expect(findings).toHaveLength(1);
  });

  it('flags secret-named object properties', () => {
    const findings = findingsFor(`$.ajax({ url: "/api", headers: { token: "abcd1234" } });`);
    expect(findings).toHaveLength(1);
  });

  it('never reproduces the full secret in the message', () => {
    const findings = findingsFor(`var password = "hunter2secret";`);
    expect(findings[0]?.message).not.toContain('hunter2secret');
  });

  it('does not flag ordinary strings', () => {
    expect(findingsFor(`var color = "red"; var title = "Team Directory";`)).toHaveLength(0);
  });
});

describe('broken-asset-reference rule', () => {
  it('flags a stylesheet reference that does not exist', () => {
    const result = analyzeWebPart(join(fixturesRoot, 'broken-asset'));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ rule: 'broken-asset-reference', severity: 'error' });
    expect(result.ir.assets[0]).toMatchObject({ path: 'missing.css', exists: false });
  });
});

describe('external-dependency refusals', () => {
  it('supports jQuery, refuses known plugins, refuses unknown externals', () => {
    const result = analyzeWebPart(join(fixturesRoot, 'plugin-refusal'));

    const byName = Object.fromEntries(result.ir.dependencies.map((d) => [d.name, d]));
    expect(byName['jquery']).toMatchObject({ supported: true });
    expect(byName['ag-grid']).toMatchObject({ supported: false });
    expect(byName['unknown']).toMatchObject({ supported: false });

    expect(result.refusals).toHaveLength(2);
    const constructs = result.refusals.map((r) => r.construct).sort();
    expect(constructs).toEqual(['external-plugin', 'unknown-external-script']);
  });
});

describe('vendored-plugin refusals (local library files)', () => {
  // Found by the first real-world analyze-only sweep: a locally-copied
  // jquery.carouselTicker.js sailed through as authored source.
  it('classifyLocalScript: registry first, then the generic jquery.<plugin>.js shape', () => {
    expect(classifyLocalScript('javascripts/jquery.carouselTicker.js')).toEqual({
      name: 'jquery-plugin:carouselTicker',
      supported: false,
    });
    expect(classifyLocalScript('jquery.simpleTicker.min.js')).toEqual({
      name: 'jquery-plugin:simpleTicker',
      supported: false,
    });
    // Registry patterns win over the generic shape.
    expect(classifyLocalScript('libs/jquery.dataTables.min.js')).toEqual({ name: 'datatables', supported: false });
    expect(classifyLocalScript('jquery-3.6.0.min.js')).toEqual({ name: 'jquery', supported: true });
    // Authored code stays authored.
    expect(classifyLocalScript('app.js')).toBeNull();
    expect(classifyLocalScript('scripts/ticker.js')).toBeNull();
  });

  it('refuses a local plugin file and never analyzes its internals', () => {
    const result = analyzeWebPart(join(fixturesRoot, 'local-plugin'));

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ construct: 'vendored-plugin', file: 'index.html', line: 11 });
    expect(result.refusals[0]?.reason).toContain("'jquery-plugin:simpleTicker'");

    // The plugin file's internals contributed NOTHING to the IR — only app.js did.
    expect(result.ir.domOperations.every((op) => op.file === 'app.js')).toBe(true);
    expect(result.ir.eventHandlers.every((handler) => handler.file === 'app.js')).toBe(true);

    // And it never reaches the model as a source file, nor the coupling input.
    const plan = buildPlan({ analysis: result, name: 'local-plugin' });
    expect(plan.blocked).toBe(true);
    expect(plan.sourceFiles).toEqual(['app.js', 'index.html']);
    const coupling = loadCouplingInput(join(fixturesRoot, 'local-plugin'));
    expect(coupling.scripts.map((script) => script.file)).toEqual(['app.js']);
  });
});

describe('script analysis', () => {
  it('records jQuery event handlers and DOM operations distinctly', () => {
    const facts = analyzeScript(
      [
        `$('#save').click(function () {`,
        `  $('#status').text('Saving...');`,
        `});`,
      ].join('\n'),
      'inline.js',
    );
    expect(facts.eventHandlers).toEqual([
      { via: 'jquery', event: 'click', target: '#save', file: 'inline.js', line: 1 },
    ]);
    expect(facts.domOperations).toEqual([
      { api: 'jquery', method: 'text', target: '#status', file: 'inline.js', line: 2 },
    ]);
  });

  it('records network calls with statically-known URLs', () => {
    const facts = analyzeScript(
      `$.ajax({ url: '/_api/web/lists', method: 'GET' });\nfetch('/api/items');`,
      'net.js',
    );
    expect(facts.networkCalls).toEqual([
      { api: 'jquery-ajax', url: '/_api/web/lists', file: 'net.js', line: 1 },
      { api: 'fetch', url: '/api/items', file: 'net.js', line: 2 },
    ]);
  });
});
