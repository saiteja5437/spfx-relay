import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCouplingDir } from '../../src/analyze/coupling';
import { analyzeWebPart } from '../../src/analyze/index';
import { RunManifest } from '../../src/pipeline/manifest';
import { buildPlan } from '../../src/pipeline/plan';
import { renderReport } from '../../src/report/index';

const here = dirname(fileURLToPath(import.meta.url));
const corpusInput = join(here, '..', '..', 'corpus', '001-static-hello', 'input');
const refusalFixture = join(here, '..', 'fixtures', 'plugin-refusal');

function manifestWithOneStep(): RunManifest {
  const manifest = new RunManifest();
  manifest.record({
    step: 'transform',
    provider: 'fake',
    model: 'fake-model',
    promptHash: 'abc123',
    attempts: 2,
    cacheHit: false,
    usage: { inputTokens: 1200, outputTokens: 800 },
    outcome: 'ok',
    durationMs: 42,
  });
  return manifest;
}

describe('renderReport', () => {
  it('renders a full migrated report with every review surface', () => {
    const analysis = analyzeWebPart(corpusInput);
    const plan = buildPlan({ analysis, name: '001-static-hello' });

    const report = renderReport({
      status: 'migrated',
      plan,
      transform: {
        componentCode: 'code',
        componentDescription: 'A greeting box with a button.',
        assumptions: ['Button label kept verbatim.'],
        unhandled: ['document.title change was ignored.'],
      },
      gates: {
        typecheck: { ok: true, issues: [] },
        lint: { ok: true, issues: [] },
      },
      transformAttempts: 2,
      bundle: { status: 'passed', detail: 'ok' },
      emittedFiles: ['package.json', 'src/webparts/statichello/components/StaticHello.tsx'],
      manifest: manifestWithOneStep(),
    });

    expect(report).toContain('# Migration report — StaticHello');
    expect(report).toContain('MIGRATED');
    expect(report).toContain('A greeting box with a button.');
    expect(report).toContain('Button label kept verbatim.');
    expect(report).toContain('document.title change was ignored.');
    expect(report).toContain('- TypeScript (strict): **PASSED**');
    expect(report).toContain('SPFx bundle seal: **PASSED**');
    expect(report).toContain('| transform | fake-model | 2 | miss | 1200/800 | ok |');
    expect(report).toContain('Total tokens: 1200 in / 800 out.');
  });

  it('shows the full bundle failure output, not just its first line', () => {
    // Regression: the first live seal failure (unsupported Node) was reported as a
    // bare "gulp bundle failed:" because everything after line 1 was dropped.
    const analysis = analyzeWebPart(corpusInput);
    const plan = buildPlan({ analysis, name: '001-static-hello' });

    const report = renderReport({
      status: 'migrated',
      plan,
      gates: {
        typecheck: { ok: true, issues: [] },
        lint: { ok: true, issues: [] },
      },
      bundle: {
        status: 'failed',
        detail: 'gulp bundle failed:\nError: Your dev environment is running NodeJS version v24.14.0\nwhich does not meet the requirements for running this tool.',
      },
      manifest: new RunManifest(),
    });

    expect(report).toContain('SPFx bundle seal: **FAILED** — gulp bundle failed:');
    expect(report).toContain('NodeJS version v24.14.0');
    expect(report).toContain('```'); // the captured tool output is fenced
  });

  it('renders a Strategy section for a multi-region plan, and omits it without one', () => {
    const fixture = join(here, '..', 'fixtures', 'multi-part-independent');
    const analysis = analyzeWebPart(fixture);
    const plan = buildPlan({ analysis, name: 'multi-part-independent', coupling: analyzeCouplingDir(fixture) });

    const report = renderReport({ status: 'migrated', plan, chosen: 'spa', manifest: new RunManifest() });
    expect(report).toContain('## Strategy');
    expect(report).toContain('**Recommendation:** decompose');
    expect(report).toContain('**Chosen:** spa (user override');
    expect(report).toContain('| `NewsPanel` | `#news-panel` |');
    expect(report).toContain('| `StockTicker` | `#stock-ticker` |');
    expect(report).toContain('safe to split into separate web parts');

    // v1 plans carry no strategy — the section must not appear (keeps old reports valid).
    const v1Plan = buildPlan({ analysis: analyzeWebPart(corpusInput), name: '001-static-hello' });
    const v1Report = renderReport({ status: 'migrated', plan: v1Plan, manifest: new RunManifest() });
    expect(v1Report).not.toContain('## Strategy');
  });

  it('renders a blocked report that lists every refusal', () => {
    const analysis = analyzeWebPart(refusalFixture);
    const plan = buildPlan({ analysis, name: 'plugin-refusal' });

    const report = renderReport({ status: 'blocked', plan, manifest: new RunManifest() });

    expect(report).toContain('BLOCKED');
    expect(report).toContain('external-plugin');
    expect(report).toContain('unknown-external-script');
    expect(report).toContain("'ag-grid'");
    expect(report).not.toContain('## Transform'); // nothing was transformed
  });
});
