import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCouplingDir, loadCouplingInput } from '../../src/analyze/coupling';
import { analyzeWebPart } from '../../src/analyze/index';
import { emitMultiPartProject } from '../../src/emit/index';
import { renderMultiPartScaffold } from '../../src/emit/scaffold';
import { cacheKey } from '../../src/pipeline/cache';
import { buildTransformContext } from '../../src/pipeline/context';
import { RunManifest } from '../../src/pipeline/manifest';
import { MultiPartVerifyError, runMultiPartTransform, type MultiPartGateChecker } from '../../src/pipeline/multipart';
import { buildPlan } from '../../src/pipeline/plan';
import { slicePartContexts } from '../../src/pipeline/slice';
import { renderReport, type PartReport } from '../../src/report/index';
import { ok, scriptedProvider } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
// Step 06 acceptance names corpus 006 explicitly as the e2e input.
const inputDir = join(here, '..', '..', 'corpus', '006-multi-independent', 'input');

const component = (name: string) => `import * as React from 'react';
export default function ${name}(): React.ReactElement {
  return <div />;
}
`;

const BAD_CODE = `import * as React from 'react';
export default function StockTicker(): React.ReactElement {
  const n: number = 'nope';
  return <div>{n}</div>;
}
`;

function transformOf(code: string) {
  return ok({ componentCode: code, componentDescription: 'test', assumptions: [], unhandled: [] });
}

function fixtureArgs() {
  const analysis = analyzeWebPart(inputDir);
  const coupling = analyzeCouplingDir(inputDir);
  const plan = buildPlan({ analysis, name: '006-multi-independent', coupling });
  const parts = slicePartContexts(loadCouplingInput(inputDir), coupling);
  return { analysis, plan, parts };
}

describe('multi-part transform loop + scaffold (offline e2e over corpus 006)', () => {
  it('emits ONE solution with TWO web parts, both bundled, deterministic distinct GUIDs', async () => {
    const { analysis, plan, parts } = fixtureArgs();
    const { provider, calls } = scriptedProvider([transformOf(component('NewsPanel')), transformOf(component('StockTicker'))]);
    const manifest = new RunManifest();

    const run = await runMultiPartTransform({ provider, plan, analysis, parts, inputDir, manifest });
    expect(run.ok).toBe(true);
    expect(calls).toHaveLength(2);

    // Manifest: two transform steps tagged with their part names.
    expect(manifest.steps.map((step) => step.part)).toEqual(['NewsPanel', 'StockTicker']);

    const outDir = mkdtempSync(join(tmpdir(), 'spfx-relay-multi-'));
    const emitted = emitMultiPartProject({
      outDir,
      solutionBaseName: plan.componentName,
      parts: run.results.map(({ part, verified }) => ({ name: part.name, componentCode: verified.result.value.componentCode })),
      inputDir,
      assets: analysis.ir.assets,
    });

    expect(existsSync(join(outDir, 'src/webparts/newspanel/components/NewsPanel.tsx'))).toBe(true);
    expect(existsSync(join(outDir, 'src/webparts/stockticker/components/StockTicker.tsx'))).toBe(true);
    expect(emitted.componentPaths).toEqual({
      NewsPanel: 'src/webparts/newspanel/components/NewsPanel.tsx',
      StockTicker: 'src/webparts/stockticker/components/StockTicker.tsx',
    });

    const config = JSON.parse(readFileSync(join(outDir, 'config/config.json'), 'utf8')) as {
      bundles: Record<string, { components: Array<{ entrypoint: string; manifest: string }> }>;
    };
    expect(Object.keys(config.bundles)).toEqual(['newspanel-web-part', 'stockticker-web-part']);
    expect(config.bundles['newspanel-web-part']?.components[0]?.entrypoint).toBe(
      './lib/webparts/newspanel/NewsPanelWebPart.js',
    );

    // GUIDs: distinct per part, byte-identical across two renders (determinism).
    const guidOf = (files: ReturnType<typeof renderMultiPartScaffold>, part: string): string => {
      const manifestFile = files.find((f) => f.path === `src/webparts/${part.toLowerCase()}/${part}WebPart.manifest.json`);
      return (JSON.parse(manifestFile?.content ?? '{}') as { id: string }).id;
    };
    const tokens = { solutionBaseName: plan.componentName, partNames: ['NewsPanel', 'StockTicker'] };
    const first = renderMultiPartScaffold(tokens);
    const second = renderMultiPartScaffold(tokens);
    expect(guidOf(first, 'NewsPanel')).toBe(guidOf(second, 'NewsPanel'));
    expect(guidOf(first, 'StockTicker')).toBe(guidOf(second, 'StockTicker'));
    expect(guidOf(first, 'NewsPanel')).not.toBe(guidOf(first, 'StockTicker'));
    expect(guidOf(first, 'NewsPanel')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

    // Report renders both parts and the part-tagged usage rows.
    const partReports: PartReport[] = run.results.map(({ part, verified }) => ({
      name: part.name,
      ok: verified.ok,
      transform: verified.result.value,
      gates: verified.gates,
      attempts: verified.attempts,
      sliceAssumptions: part.assumptions,
    }));
    const report = renderReport({ status: 'migrated', plan, chosen: 'decompose', parts: partReports, manifest });
    expect(report).toContain('### NewsPanel');
    expect(report).toContain('### StockTicker');
    expect(report).toContain('| Part |');
    expect(report).toContain('NewsPanel |');
  });

  it('a failure in part 2 still reports part 1 ok, and the run fails (CLI maps to exit 3)', async () => {
    const { analysis, plan, parts } = fixtureArgs();
    const { provider, calls } = scriptedProvider([transformOf(component('NewsPanel')), transformOf(BAD_CODE)]);
    const manifest = new RunManifest();

    const run = await runMultiPartTransform({ provider, plan, analysis, parts, inputDir, manifest, maxRepairRounds: 0 });
    expect(run.ok).toBe(false);
    expect(calls).toHaveLength(2); // part 2 failed AFTER part 1 was attempted — nothing skipped
    expect(run.results.map((r) => r.verified.ok)).toEqual([true, false]);

    const partReports: PartReport[] = run.results.map(({ part, verified }) => ({
      name: part.name,
      ok: verified.ok,
      gates: verified.gates,
      sliceAssumptions: part.assumptions,
    }));
    const report = renderReport({ status: 'failed', plan, chosen: 'decompose', parts: partReports, manifest });
    expect(report).toContain('### NewsPanel');
    expect(report).toContain('**Verified.**');
    expect(report).toContain('### StockTicker');
    expect(report).toContain('**FAILED verification.**');
  });

  it('repairs ONLY the failing part: part 1 stays at 1 attempt, part 2 records 2', async () => {
    const { analysis, plan, parts } = fixtureArgs();
    const { provider, calls } = scriptedProvider([
      transformOf(component('NewsPanel')),
      transformOf(BAD_CODE),
      transformOf(component('StockTicker')),
    ]);

    const run = await runMultiPartTransform({ provider, plan, analysis, parts, inputDir });
    expect(run.ok).toBe(true);
    expect(calls).toHaveLength(3); // 2 initial + exactly one repair (part 2 only)
    expect(run.results.map((r) => r.verified.attempts)).toEqual([1, 2]);
    // The repair prompt carried part 2's failing code and diagnostics.
    expect(calls[2]?.prompt).toContain('failed verification');
    expect(calls[2]?.prompt).toContain("const n: number = 'nope';");
  });

  it('a diagnostic in a scaffold file fails LOUDLY, naming the file, with no repair call', async () => {
    const { analysis, plan, parts } = fixtureArgs();
    const { provider, calls } = scriptedProvider([
      transformOf(component('NewsPanel')),
      transformOf(component('StockTicker')),
    ]);
    const scaffoldError: MultiPartGateChecker = () =>
      Promise.resolve({
        typecheck: { ok: false, issues: [{ file: 'declarations.d.ts', line: 1, message: 'tool bug' }] },
        lints: new Map(),
      });

    await expect(
      runMultiPartTransform({ provider, plan, analysis, parts, inputDir, checkGates: scaffoldError }),
    ).rejects.toThrow(MultiPartVerifyError);
    await expect(
      runMultiPartTransform({
        provider: scriptedProvider([transformOf(component('NewsPanel')), transformOf(component('StockTicker'))]).provider,
        plan,
        analysis,
        parts,
        inputDir,
        checkGates: scaffoldError,
      }),
    ).rejects.toThrow(/declarations\.d\.ts/);
    expect(calls).toHaveLength(2); // initial transforms only — scaffold errors never reach a model
  });

  it('two parts produce two distinct cache keys (verified, not assumed)', () => {
    const { analysis, plan, parts } = fixtureArgs();
    const schema = { type: 'object' };
    const keys = parts.map((part) => {
      const context = buildTransformContext({
        plan,
        analysis,
        sources: [
          { path: 'index.html', content: part.html },
          ...part.scripts.map((s) => ({ path: s.file, content: s.content })),
        ],
        part: { name: part.name, rootSelector: part.rootSelector },
      });
      return cacheKey({ provider: 'fake', model: 'fake-model', system: context.system, prompt: context.prompt, schema });
    });
    expect(keys[0]).not.toBe(keys[1]);
  });
});
