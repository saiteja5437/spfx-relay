import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeWebPart } from '../../src/analyze/index';
import { loadSourceFiles } from '../../src/pipeline/context';
import { buildPlan } from '../../src/pipeline/plan';
import { runVerifiedTransform } from '../../src/pipeline/verifiedTransform';
import { ok, scriptedProvider } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const corpusInput = join(here, '..', '..', 'corpus', '001-static-hello', 'input');

function corpusArgs() {
  const analysis = analyzeWebPart(corpusInput);
  const plan = buildPlan({ analysis, name: '001-static-hello' });
  const sources = loadSourceFiles(corpusInput, plan.sourceFiles);
  return { analysis, plan, sources };
}

const GOOD_CODE = `import * as React from 'react';
export default function StaticHello(): React.ReactElement {
  return <div id="greeting-box" />;
}
`;

// Fails the real typecheck gate: string assigned to number.
const BAD_CODE = `import * as React from 'react';
export default function StaticHello(): React.ReactElement {
  const count: number = 'oops';
  return <div>{count}</div>;
}
`;

function transformOf(code: string) {
  return ok({ componentCode: code, componentDescription: 'test', assumptions: [], unhandled: [] });
}

describe('runVerifiedTransform (real gates, scripted model)', () => {
  it('passes first try with verifiable code', async () => {
    const { provider, calls } = scriptedProvider([transformOf(GOOD_CODE)]);
    const verified = await runVerifiedTransform({ provider, ...corpusArgs() });

    expect(verified.ok).toBe(true);
    expect(verified.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('feeds compiler diagnostics back and succeeds on the repair round', async () => {
    const { provider, calls } = scriptedProvider([transformOf(BAD_CODE), transformOf(GOOD_CODE)]);
    const verified = await runVerifiedTransform({ provider, ...corpusArgs() });

    expect(verified.ok).toBe(true);
    expect(verified.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    // The repair prompt must contain the failing code and the actual TS error.
    expect(calls[1]?.prompt).toContain('failed verification');
    expect(calls[1]?.prompt).toContain("const count: number = 'oops';");
    expect(calls[1]?.prompt).toMatch(/TypeScript errors/);
    expect(calls[1]?.prompt).toMatch(/not assignable to type 'number'/);
  });

  it('gives up loudly after the bounded repair rounds', async () => {
    const { provider, calls } = scriptedProvider([
      transformOf(BAD_CODE),
      transformOf(BAD_CODE),
    ]);
    const verified = await runVerifiedTransform({ provider, ...corpusArgs(), maxRepairRounds: 1 });

    expect(verified.ok).toBe(false);
    expect(verified.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(verified.gates.typecheck.ok).toBe(false);
  });
});
