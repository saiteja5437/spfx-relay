import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
