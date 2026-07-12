import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCouplingDir, loadCouplingInput } from '../analyze/coupling';
import { analyzeWebPart } from '../analyze/index';
import { stableStringify, type ResponseCache } from '../pipeline/cache';
import { loadSourceFiles } from '../pipeline/context';
import { RunManifest } from '../pipeline/manifest';
import { runMultiPartTransform } from '../pipeline/multipart';
import { buildPlan } from '../pipeline/plan';
import { slicePartContexts } from '../pipeline/slice';
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

export interface PartCheckSpec {
  mustContain?: string[];
  mustNotContain?: string[];
}

export interface EvalSpec {
  componentMustContain?: string[];
  componentMustNotContain?: string[];
  /** v3: per-part checks for decomposed items, keyed by part name. */
  parts?: Record<string, PartCheckSpec>;
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
    /** Compile-repair rounds used (1 = passed first try). For multi-part: max across parts. */
    gateAttempts: number;
    /** Total sealed-step attempts including schema repairs, from the manifest. */
    stepAttempts: number;
    contentChecks: ContentCheckResult;
    /** v3: parts whose per-part checks all passed, out of parts with checks. */
    partsOk?: { passed: number; total: number };
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
    // A migratable item without eval.json has nothing the LLM stage can be
    // scored against yet — skip it loudly rather than burn a transform on it.
    // (Blocked items never reach the model, so they are always evaluable.)
    const itemDir = join(args.corpusDir, item);
    const expected = JSON.parse(readFileSync(join(itemDir, 'expected.json'), 'utf8')) as { refusals: unknown[] };
    if (expected.refusals.length === 0 && !existsSync(join(itemDir, 'eval.json'))) {
      args.onProgress?.(`Skipping ${item} — no eval.json (multi-part eval checks arrive in v3 step 08).`);
      continue;
    }
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
    // v3: a decompose recommendation exercises the real multi-part pipeline.
    if (coupling.recommendation === 'decompose') {
      const parts = slicePartContexts(loadCouplingInput(inputDir), coupling);
      const run = await runMultiPartTransform({
        provider: args.provider,
        plan,
        analysis,
        parts,
        inputDir,
        cache: args.cache,
        manifest,
        maxRepairRounds: args.maxRepairRounds,
      });
      const usage = manifest.totalUsage();
      const { checks, partsOk } = multiPartContentChecks(
        readSpec(itemDir),
        new Map(run.results.map((r) => [r.part.name, r.verified.result.value.componentCode])),
      );
      return {
        ...base,
        outcome: run.ok ? 'migrated' : 'failed-verification',
        transform: {
          compileOk: run.ok,
          gateAttempts: Math.max(...run.results.map((r) => r.verified.attempts)),
          stepAttempts: manifest.steps.reduce((sum, step) => sum + step.attempts, 0),
          contentChecks: checks,
          partsOk,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - started,
        },
      };
    }

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

function readSpec(itemDir: string): EvalSpec {
  const specPath = join(itemDir, 'eval.json');
  if (!existsSync(specPath)) return {};
  return JSON.parse(readFileSync(specPath, 'utf8')) as EvalSpec;
}

function contentChecks(itemDir: string, componentCode: string): ContentCheckResult {
  const spec = readSpec(itemDir);
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

/**
 * v3 multi-part checks: top-level checks apply across all components joined;
 * per-part checks apply to that part's component only. Exported so the
 * leakage semantics are unit-tested with canned outputs (a deliberate leak
 * must demonstrably fail).
 */
export function multiPartContentChecks(
  spec: EvalSpec,
  components: Map<string, string>,
): { checks: ContentCheckResult; partsOk: { passed: number; total: number } } {
  const failed: string[] = [];
  let total = 0;
  const joined = [...components.values()].join('\n');
  for (const needle of spec.componentMustContain ?? []) {
    total++;
    if (!joined.includes(needle)) failed.push(`missing: ${needle}`);
  }
  for (const needle of spec.componentMustNotContain ?? []) {
    total++;
    if (joined.includes(needle)) failed.push(`must not appear: ${needle}`);
  }

  let partsPassed = 0;
  const partSpecs = Object.entries(spec.parts ?? {});
  for (const [name, partSpec] of partSpecs) {
    const code = components.get(name);
    let ok = true;
    if (code === undefined) {
      total++;
      failed.push(`${name}: part missing from the run`);
      ok = false;
    } else {
      for (const needle of partSpec.mustContain ?? []) {
        total++;
        if (!code.includes(needle)) {
          failed.push(`${name} missing: ${needle}`);
          ok = false;
        }
      }
      for (const needle of partSpec.mustNotContain ?? []) {
        total++;
        if (code.includes(needle)) {
          failed.push(`${name} must not contain: ${needle}`);
          ok = false;
        }
      }
    }
    if (ok) partsPassed++;
  }

  return {
    checks: { total, passed: total - failed.length, failed },
    partsOk: { passed: partsPassed, total: partSpecs.length },
  };
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
