import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult } from '../types/ir';
import type { ModelProvider } from '../providers/types';
import type { ResponseCache } from './cache';
import type { SourceFile } from './context';
import type { RunManifest } from './manifest';
import type { MigrationPlan } from './plan';
import type { PartContext } from './slice';
import { runVerifiedTransform, type GateChecker, type VerifiedTransform } from './verifiedTransform';

/**
 * The per-part transform loop (v3 step 06). Parts run SEQUENTIALLY, in
 * strategy order — parallelism is a non-goal; sequential keeps manifests,
 * repair budgets, and failure ordering deterministic. One part's failure
 * fails the run, but only AFTER every part was attempted, so the report can
 * show each part's outcome (v1's everything-reported ethic).
 */

export interface PartRunResult {
  part: PartContext;
  verified: VerifiedTransform;
}

export interface MultiPartRun {
  ok: boolean;
  results: PartRunResult[];
}

export interface MultiPartArgs {
  provider: ModelProvider;
  plan: MigrationPlan;
  analysis: AnalysisResult;
  parts: PartContext[];
  /** Where shared stylesheets are read from. */
  inputDir: string;
  cache?: ResponseCache;
  manifest?: RunManifest;
  maxRepairRounds?: number;
  checkGates?: GateChecker;
  onProgress?: (message: string) => void;
}

export async function runMultiPartTransform(args: MultiPartArgs): Promise<MultiPartRun> {
  const results: PartRunResult[] = [];

  for (const part of args.parts) {
    args.onProgress?.(`Transforming part ${part.name} (${part.rootSelector}) …`);
    const sources = partSources(part, args.inputDir);
    const verified = await runVerifiedTransform({
      provider: args.provider,
      plan: args.plan,
      analysis: args.analysis,
      sources,
      part: { name: part.name, rootSelector: part.rootSelector },
      cache: args.cache,
      manifest: args.manifest,
      maxRepairRounds: args.maxRepairRounds,
      checkGates: args.checkGates,
    });
    results.push({ part, verified });
  }

  return { ok: results.every((result) => result.verified.ok), results };
}

/** The part's slice as its transform context: fragment, sliced units, shared CSS. */
function partSources(part: PartContext, inputDir: string): SourceFile[] {
  return [
    { path: 'index.html', content: part.html },
    ...part.scripts.map((script) => ({ path: script.file, content: script.content })),
    ...part.stylesheets.map((path) => ({
      path,
      content: readFileSync(join(inputDir, path), 'utf8').replaceAll('\r\n', '\n'),
    })),
  ];
}
