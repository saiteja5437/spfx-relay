import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runEval } from '../../src/eval/index';
import { renderEvalMarkdown } from '../../src/eval/render';
import { ok, scriptedProvider } from '../pipeline/helpers';

const here = dirname(fileURLToPath(import.meta.url));
const evalCorpus = join(here, '..', 'fixtures', 'eval-corpus');

// Compiles under the real gates and satisfies 100-ok's content checks.
const GOOD_CODE = `import * as React from 'react';
export default function Ok(): React.ReactElement {
  return <div id="hello-box" />;
}
`;

// Fails the real typecheck gate.
const BAD_CODE = `import * as React from 'react';
export default function Ok(): React.ReactElement {
  const n: number = 'nope';
  return <div>{n}</div>;
}
`;

function transformOf(code: string) {
  return ok({ componentCode: code, componentDescription: 'test', assumptions: [], unhandled: [] });
}

describe('runEval', () => {
  it('scores a clean run: analyzer conformance, refusal correctness, compile, content checks', async () => {
    const { provider, calls } = scriptedProvider([transformOf(GOOD_CODE)]);
    const run = await runEval({ provider, corpusDir: evalCorpus });

    expect(run.results.map((r) => r.item)).toEqual(['100-ok', '200-blocked']);

    const okItem = run.results[0];
    expect(okItem).toMatchObject({
      expectedOutcome: 'migrated',
      outcome: 'migrated',
      analyzerConformant: true,
      refusalCorrect: true,
    });
    expect(okItem?.transform).toMatchObject({
      compileOk: true,
      gateAttempts: 1,
      contentChecks: { total: 2, passed: 2, failed: [] },
    });

    const blockedItem = run.results[1];
    expect(blockedItem).toMatchObject({
      expectedOutcome: 'blocked',
      outcome: 'blocked',
      analyzerConformant: true,
      refusalCorrect: true,
    });
    expect(blockedItem?.transform).toBeUndefined(); // blocked items never reach the model
    expect(calls).toHaveLength(1);

    expect(run.summary).toMatchObject({
      items: 2,
      migratable: 1,
      compilePassed: 1,
      analyzerConformant: 2,
      refusalCorrect: 2,
      contentChecksPassed: 2,
      contentChecksTotal: 2,
      averageGateAttempts: 1,
    });
  });

  it('scores a failed verification honestly and keeps evaluating', async () => {
    const { provider } = scriptedProvider([transformOf(BAD_CODE), transformOf(BAD_CODE)]);
    const run = await runEval({ provider, corpusDir: evalCorpus, maxRepairRounds: 1 });

    expect(run.results[0]).toMatchObject({ outcome: 'failed-verification' });
    expect(run.results[0]?.transform).toMatchObject({ compileOk: false, gateAttempts: 2 });
    expect(run.summary.compilePassed).toBe(0);
    // The blocked item is still scored even though the migratable one failed.
    expect(run.results[1]).toMatchObject({ outcome: 'blocked', refusalCorrect: true });
  });

  it('records provider errors per item without aborting the run', async () => {
    const { provider } = scriptedProvider([new Error('boom')]);
    const run = await runEval({ provider, corpusDir: evalCorpus, maxRepairRounds: 0 });

    expect(run.results[0]).toMatchObject({ outcome: 'error' });
    expect(run.results[0]?.error).toContain('boom');
    expect(run.results[1]).toMatchObject({ outcome: 'blocked' });
  });

  it('fails content checks when the component drops required surface', async () => {
    const missingBox = transformOf(GOOD_CODE.replace('hello-box', 'other-box'));
    const { provider } = scriptedProvider([missingBox]);
    const run = await runEval({ provider, corpusDir: evalCorpus });

    const checks = run.results[0]?.transform?.contentChecks;
    expect(checks).toMatchObject({ total: 2, passed: 1 });
    expect(checks?.failed).toEqual(['missing: hello-box']);
  });
});

describe('renderEvalMarkdown', () => {
  it('renders the scorecard table and summary', async () => {
    const { provider } = scriptedProvider([transformOf(GOOD_CODE)]);
    const run = await runEval({ provider, corpusDir: evalCorpus });
    const markdown = renderEvalMarkdown(run);

    expect(markdown).toContain('# spfx-relay eval — fake/fake-model');
    expect(markdown).toContain('| 100-ok | migrated | ✅ migrated | ok | ok |');
    expect(markdown).toContain('| 200-blocked | blocked | ⛔ blocked | ok | ok | — |');
    expect(markdown).toContain('- Compile rate: **1/1** migratable items');
    expect(markdown).toContain('- Refusal correctness: **2/2**');
    expect(markdown).toContain('not behavioral equivalence');
  });
});
