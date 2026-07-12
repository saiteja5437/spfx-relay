import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { multiPartContentChecks, runEval } from '../../src/eval/index';
import { renderEvalMarkdown } from '../../src/eval/render';
import { ok, scriptedProvider } from '../pipeline/helpers';

const here = dirname(fileURLToPath(import.meta.url));
const evalCorpus = join(here, '..', 'fixtures', 'eval-corpus');
const multiCorpus = join(here, '..', 'fixtures', 'eval-corpus-multi');

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

  it('skips a migratable item without eval.json instead of burning a transform on it', async () => {
    // 300-no-eval exists in the fixture corpus with no eval.json: it must be
    // skipped with a message, never reach the provider, and not appear in results.
    const { provider, calls } = scriptedProvider([transformOf(GOOD_CODE)]);
    const progress: string[] = [];
    const run = await runEval({ provider, corpusDir: evalCorpus, onProgress: (m) => progress.push(m) });

    expect(run.results.map((r) => r.item)).toEqual(['100-ok', '200-blocked']);
    expect(calls).toHaveLength(1);
    expect(progress.join('\n')).toContain('Skipping 300-no-eval');
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

describe('multi-part eval (v3 step 08)', () => {
  const NEWS = `import * as React from 'react';
export default function NewsPanel(): React.ReactElement {
  return <ul id="news-list"><li id="news-refresh">x</li></ul>;
}
`;
  const TICKER = `import * as React from 'react';
export default function StockTicker(): React.ReactElement {
  return <span id="ticker-value"><button id="ticker-go">go</button></span>;
}
`;

  it('runs the decompose pipeline for a multi-part item and scores per-part checks', async () => {
    const { provider, calls } = scriptedProvider([transformOf(NEWS), transformOf(TICKER)]);
    const run = await runEval({ provider, corpusDir: multiCorpus });

    expect(calls).toHaveLength(2); // one sealed call per part
    const item = run.results[0];
    expect(item).toMatchObject({ item: '400-multi', outcome: 'migrated', analyzerConformant: true });
    expect(item?.transform?.partsOk).toEqual({ passed: 2, total: 2 });
    expect(item?.transform?.contentChecks).toMatchObject({ total: 8, passed: 8 });

    const markdown = renderEvalMarkdown(run);
    expect(markdown).toContain('| Parts ok |');
    expect(markdown).toContain('| 2/2 |');
  });

  it('a deliberate cross-part leak demonstrably fails the mustNotContain check', async () => {
    const leakyNews = NEWS.replace('>x<', '>ticker-value is over there<'); // leak: news mentions the ticker
    const { provider } = scriptedProvider([transformOf(leakyNews), transformOf(TICKER)]);
    const run = await runEval({ provider, corpusDir: multiCorpus });

    const checks = run.results[0]?.transform?.contentChecks;
    expect(run.results[0]?.transform?.partsOk).toEqual({ passed: 1, total: 2 });
    expect(checks?.failed).toEqual(['NewsPanel must not contain: ticker']);
  });

  it('multiPartContentChecks unit semantics: missing parts, leaks, and invented stylesheet imports', () => {
    const spec = {
      parts: {
        A: { mustContain: ['a-root'], mustNotContain: ['b-root', 'styles.css'] },
        B: { mustContain: ['b-root'] },
      },
    };
    const clean = multiPartContentChecks(spec, new Map([['A', '<div id="a-root"/>'], ['B', '<div id="b-root"/>']]));
    expect(clean.partsOk).toEqual({ passed: 2, total: 2 });
    expect(clean.checks.failed).toEqual([]);

    const leakyAndInvented = multiPartContentChecks(
      spec,
      new Map([['A', "import './styles.css';\n<div id=\"a-root\"/><div id=\"b-root\"/>"]]),
    );
    expect(leakyAndInvented.partsOk).toEqual({ passed: 0, total: 2 });
    expect(leakyAndInvented.checks.failed).toEqual([
      'A must not contain: b-root',
      'A must not contain: styles.css',
      'B: part missing from the run',
    ]);
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
