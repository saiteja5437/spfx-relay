import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCouplingDir } from '../analyze/coupling';
import { analyzeWebPart } from '../analyze/index';
import { stableStringify, type ResponseCache } from '../pipeline/cache';
import { loadSourceFiles } from '../pipeline/context';
import { RunManifest } from '../pipeline/manifest';
import { buildPlan } from '../pipeline/plan';
import { runVerifiedTransform } from '../pipeline/verifiedTransform';
import type { ModelProvider } from '../providers/types';

/**
 * The eval harness: runs every corpus item through the REAL pipeline against
 * one provider/model and scores the result. This is what turns model choice
 * and prompt changes into measured numbers instead of vibes.
 *
 * Honest scoping of the metrics:
 * - analyzerConformance and refusal correctness are DETERMINISTIC properties
 *   (no LLM involved) — they guard the analyzer and corpus against drift.
 * - compile rate, attempts, content checks, tokens, latency are the per-model
 *   metrics — they measure the LLM stage.
 * - contentChecks are light surface assertions, NOT behavioral equivalence.
 */

export interface EvalSpec {
  componentMustContain?: string[];
  componentMustNotContain?: string[];
}

export interface ContentCheckResult {
  total: number;
  passed: number;
  failed: string[];
}

export interface EvalItemResult {
  item: string;
  expectedOutcome: 'migrated' | 'blocked';
  outcome: 'migrated' | 'blocked' | 'failed-verification' | 'error';
  analyzerConformant: boolean;
  refusalCorrect: boolean;
  transform?: {
    compileOk: boolean;
    /** Compile-repair rounds used (1 = passed first try). */
    gateAttempts: number;
    /** Total sealed-step attempts including schema repairs, from the manifest. */
    stepAttempts: number;
    contentChecks: ContentCheckResult;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
  error?: string;
}

export interface EvalSummary {
  items: number;
  migratable: number;
  compilePassed: number;
  analyzerConformant: number;
  refusalCorrect: number;
  contentChecksPassed: number;
  contentChecksTotal: number;
  averageGateAttempts: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
}

export interface EvalRun {
  provider: string;
  model: string;
  startedAt: string;
  results: EvalItemResult[];
  summary: EvalSummary;
}

export interface EvalRunArgs {
  provider: ModelProvider;
  corpusDir: string;
  cache?: ResponseCache;
  maxRepairRounds?: number;
  onProgress?: (message: string) => void;
}

export async function runEval(args: EvalRunArgs): Promise<EvalRun> {
  const capabilities = args.provider.capabilities();
  const startedAt = new Date().toISOString();
  const items = readdirSync(args.corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const results: EvalItemResult[] = [];
  for (const item of items) {
    args.onProgress?.(`Evaluating ${item} …`);
    results.push(await evalItem(args, item));
  }

  return {
    provider: capabilities.name,
    model: capabilities.model,
    startedAt,
    results,
    summary: summarize(results),
  };
}

async function evalItem(args: EvalRunArgs, item: string): Promise<EvalItemResult> {
  const itemDir = join(args.corpusDir, item);
  const inputDir = join(itemDir, 'input');
  const expected = JSON.parse(readFileSync(join(itemDir, 'expected.json'), 'utf8')) as {
    refusals: unknown[];
  };
  const expectedOutcome: 'migrated' | 'blocked' = expected.refusals.length > 0 ? 'blocked' : 'migrated';

  const analysis = analyzeWebPart(inputDir);
  const analyzerConformant = stableStringify(analysis) === stableStringify(expected);
  const coupling = analyzeCouplingDir(inputDir);
  const plan = buildPlan({ analysis, name: item, coupling });
  const refusalCorrect = plan.blocked === (expectedOutcome === 'blocked');

  const base = { item, expectedOutcome, analyzerConformant, refusalCorrect };

  if (plan.blocked) {
    return { ...base, outcome: 'blocked' };
  }

  const manifest = new RunManifest();
  const started = Date.now();
  try {
    const verified = await runVerifiedTransform({
      provider: args.provider,
      plan,
      analysis,
      sources: loadSourceFiles(inputDir, plan.sourceFiles),
      cache: args.cache,
      manifest,
      maxRepairRounds: args.maxRepairRounds,
    });

    const usage = manifest.totalUsage();
    return {
      ...base,
      outcome: verified.ok ? 'migrated' : 'failed-verification',
      transform: {
        compileOk: verified.ok,
        gateAttempts: verified.attempts,
        stepAttempts: manifest.steps.reduce((sum, step) => sum + step.attempts, 0),
        contentChecks: contentChecks(itemDir, verified.result.value.componentCode),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - started,
      },
    };
  } catch (error) {
    return { ...base, outcome: 'error', error: (error as Error).message };
  }
}

function contentChecks(itemDir: string, componentCode: string): ContentCheckResult {
  const specPath = join(itemDir, 'eval.json');
  if (!existsSync(specPath)) return { total: 0, passed: 0, failed: [] };
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as EvalSpec;

  const failed: string[] = [];
  let total = 0;
  for (const needle of spec.componentMustContain ?? []) {
    total++;
    if (!componentCode.includes(needle)) failed.push(`missing: ${needle}`);
  }
  for (const needle of spec.componentMustNotContain ?? []) {
    total++;
    if (componentCode.includes(needle)) failed.push(`must not appear: ${needle}`);
  }
  return { total, passed: total - failed.length, failed };
}

function summarize(results: EvalItemResult[]): EvalSummary {
  const migratable = results.filter((r) => r.expectedOutcome === 'migrated');
  const transforms = results.filter((r) => r.transform !== undefined);
  const gateAttempts = transforms.map((r) => r.transform?.gateAttempts ?? 0);

  return {
    items: results.length,
    migratable: migratable.length,
    compilePassed: results.filter((r) => r.transform?.compileOk === true).length,
    analyzerConformant: results.filter((r) => r.analyzerConformant).length,
    refusalCorrect: results.filter((r) => r.refusalCorrect).length,
    contentChecksPassed: transforms.reduce((sum, r) => sum + (r.transform?.contentChecks.passed ?? 0), 0),
    contentChecksTotal: transforms.reduce((sum, r) => sum + (r.transform?.contentChecks.total ?? 0), 0),
    averageGateAttempts:
      gateAttempts.length === 0
        ? null
        : Math.round((gateAttempts.reduce((a, b) => a + b, 0) / gateAttempts.length) * 100) / 100,
    totalInputTokens: transforms.reduce((sum, r) => sum + (r.transform?.inputTokens ?? 0), 0),
    totalOutputTokens: transforms.reduce((sum, r) => sum + (r.transform?.outputTokens ?? 0), 0),
    totalDurationMs: transforms.reduce((sum, r) => sum + (r.transform?.durationMs ?? 0), 0),
  };
}
