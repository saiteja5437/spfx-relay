import type { ModelProvider, ProviderResult } from '../providers/types';
import type { AnalysisResult } from '../types/ir';
import type { ResponseCache } from './cache';
import { buildTransformContext, type SourceFile } from './context';
import type { RunManifest } from './manifest';
import type { MigrationPlan } from './plan';
import { TransformResultSchema, type TransformResult } from './prompts';
import { runStructuredStep } from './step';

/**
 * The transform stage — the pipeline's one genuinely LLM-powered step, run
 * through the sealed step runner (schema contract, bounded repair, cache,
 * manifest). A blocked plan is a hard stop here, enforced in code rather than
 * trusted to the caller.
 */

const DEFAULT_MAX_TOKENS = 16_000;

export class BlockedPlanError extends Error {
  constructor(refusalCount: number) {
    super(`Plan is blocked by ${refusalCount} refusal(s) — the transform must not run. See the report.`);
    this.name = 'BlockedPlanError';
  }
}

export interface TransformArgs {
  provider: ModelProvider;
  plan: MigrationPlan;
  analysis: AnalysisResult;
  sources: SourceFile[];
  cache?: ResponseCache;
  manifest?: RunManifest;
  maxTokens?: number;
  maxContextChars?: number;
}

export async function runTransform(args: TransformArgs): Promise<ProviderResult<TransformResult>> {
  if (args.plan.blocked) throw new BlockedPlanError(args.plan.refusals.length);

  const context = buildTransformContext({
    plan: args.plan,
    analysis: args.analysis,
    sources: args.sources,
    maxChars: args.maxContextChars,
  });

  return runStructuredStep(
    {
      name: 'transform',
      provider: args.provider,
      system: context.system,
      prompt: context.prompt,
      maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
      cache: args.cache,
      manifest: args.manifest,
    },
    TransformResultSchema,
  );
}
