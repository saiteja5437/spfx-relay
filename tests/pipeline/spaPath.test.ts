import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCouplingDir } from '../../src/analyze/coupling';
import { analyzeWebPart } from '../../src/analyze/index';
import { resolveStrategy } from '../../src/cli';
import { emitProject } from '../../src/emit/index';
import { loadSourceFiles } from '../../src/pipeline/context';
import { RunManifest } from '../../src/pipeline/manifest';
import { buildPlan } from '../../src/pipeline/plan';
import { runVerifiedTransform } from '../../src/pipeline/verifiedTransform';
import { renderReport } from '../../src/report/index';
import { ok, scriptedProvider } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const coupledFixture = join(here, '..', 'fixtures', 'multi-part-coupled');

// The v1 whole-page single-component transform IS the SPA migration: one React
// component owning the entire page. This test proves the coupled fixture flows
// through the existing pipeline untouched when the chosen strategy is spa.
describe('SPA path (chosen=spa runs the v1 single-component pipeline)', () => {
  const COMPONENT = `import * as React from 'react';
export default function MultiPartCoupled(): React.ReactElement {
  return <div id="page-root" />;
}
`;

  it('emits ONE component and a report that says spa', async () => {
    const analysis = analyzeWebPart(coupledFixture);
    const coupling = analyzeCouplingDir(coupledFixture);
    const plan = buildPlan({ analysis, name: 'multi-part-coupled', coupling });
    const decision = resolveStrategy(coupling);
    expect(decision.chosen).toBe('spa');
    expect(plan.blocked).toBe(false);

    const { provider, calls } = scriptedProvider([
      ok({ componentCode: COMPONENT, componentDescription: 'Whole page as one part.', assumptions: [], unhandled: [] }),
    ]);
    const manifest = new RunManifest();
    const verified = await runVerifiedTransform({
      provider,
      plan,
      analysis,
      sources: loadSourceFiles(coupledFixture, plan.sourceFiles),
      manifest,
    });
    expect(verified.ok).toBe(true);
    expect(calls).toHaveLength(1);
    if (!verified.ok) throw new Error('unreachable');

    const outDir = mkdtempSync(join(tmpdir(), 'spfx-relay-spa-'));
    const emitted = emitProject({
      outDir,
      plan,
      componentCode: verified.result.value.componentCode,
      inputDir: coupledFixture,
      assets: analysis.ir.assets,
    });
    const components = emitted.files.filter((file) => file.includes('components') && file.endsWith('.tsx'));
    expect(components).toHaveLength(1);

    const report = renderReport({
      status: 'migrated',
      plan,
      chosen: decision.chosen,
      transform: verified.result.value,
      gates: verified.gates,
      transformAttempts: verified.attempts,
      emittedFiles: emitted.files,
      manifest,
    });
    expect(report).toContain('## Strategy');
    expect(report).toContain('**Recommendation:** spa');
    // chosen === recommendation, so no override line appears.
    expect(report).not.toContain('**Chosen:**');
  });
});
