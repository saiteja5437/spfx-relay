import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeWebPart } from '../../src/analyze/index';
import {
  buildTransformContext,
  ContextBudgetExceeded,
  loadSourceFiles,
} from '../../src/pipeline/context';
import { buildPlan } from '../../src/pipeline/plan';
import { BlockedPlanError, runTransform } from '../../src/pipeline/transform';
import { ok, scriptedProvider } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const corpusInput = join(here, '..', '..', 'corpus', '001-static-hello', 'input');
const refusalFixture = join(here, '..', 'fixtures', 'plugin-refusal');

function corpusArgs() {
  const analysis = analyzeWebPart(corpusInput);
  const plan = buildPlan({ analysis, name: '001-static-hello' });
  const sources = loadSourceFiles(corpusInput, plan.sourceFiles);
  return { analysis, plan, sources };
}

const transformResult = {
  componentCode: "import React from 'react';\nexport default function StaticHello() { return <div />; }\n",
  componentDescription: 'A greeting box.',
  assumptions: [],
  unhandled: [],
};

describe('loadSourceFiles', () => {
  it('normalizes CRLF so prompts are byte-stable across operating systems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spfx-relay-src-'));
    writeFileSync(join(dir, 'a.js'), 'var a = 1;\r\nvar b = 2;\r\n');
    const [file] = loadSourceFiles(dir, ['a.js']);
    expect(file?.content).toBe('var a = 1;\nvar b = 2;\n');
  });
});

describe('buildTransformContext', () => {
  it('is byte-identical across builds — the determinism the cache key relies on', () => {
    const args = corpusArgs();
    const first = buildTransformContext(args);
    const second = buildTransformContext(args);
    expect(second.system).toBe(first.system);
    expect(second.prompt).toBe(first.prompt);
  });

  it('packs the component name, IR, and every source file into the prompt', () => {
    const { prompt } = buildTransformContext(corpusArgs());
    expect(prompt).toContain('Component name: StaticHello');
    expect(prompt).toContain('"domOperations"');
    expect(prompt).toContain('### app.js');
    expect(prompt).toContain('### index.html');
    expect(prompt).toContain('### styles.css');
    expect(prompt).toContain("getElementById('load-button')");
  });

  it('refuses oversized inputs instead of silently truncating', () => {
    expect(() => buildTransformContext({ ...corpusArgs(), maxChars: 500 })).toThrowError(
      ContextBudgetExceeded,
    );
  });
});

describe('runTransform', () => {
  it('runs the sealed step and returns the structured transform result', async () => {
    const { provider, calls } = scriptedProvider([ok(transformResult)]);
    const result = await runTransform({ provider, ...corpusArgs() });

    expect(result.value.componentCode).toContain('StaticHello');
    expect(calls[0]?.system).toContain('SharePoint Framework');
    expect(calls[0]?.prompt).toContain('## Legacy source files');
  });

  it('hard-stops on a blocked plan — enforced in code, not trusted to the caller', async () => {
    const analysis = analyzeWebPart(refusalFixture);
    const plan = buildPlan({ analysis, name: 'plugin-refusal' });
    const { provider, calls } = scriptedProvider([]);

    await expect(runTransform({ provider, plan, analysis, sources: [] })).rejects.toBeInstanceOf(
      BlockedPlanError,
    );
    expect(calls).toHaveLength(0);
  });
});
