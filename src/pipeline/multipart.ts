import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AnalysisResult } from '../types/ir';
import type { ModelProvider, ProviderResult } from '../providers/types';
import { lintComponent } from '../verify/lint';
import { typecheckFiles } from '../verify/typecheck';
import type { VerifyResult } from '../verify/types';
import type { ResponseCache } from './cache';
import type { SourceFile } from './context';
import type { RunManifest } from './manifest';
import type { MigrationPlan } from './plan';
import type { TransformResult } from './prompts';
import type { PartContext } from './slice';
import { runTransform } from './transform';
import { formatGateFeedback, type GateResults } from './verifiedTransform';

/**
 * The per-part transform loop with whole-program verification (v3 steps 06+07).
 *
 * - Parts transform SEQUENTIALLY, in strategy order — parallelism is a
 *   non-goal; sequential keeps manifests, repair budgets, and failure ordering
 *   deterministic.
 * - tsc runs ONCE per repair round over every part's current component in an
 *   emit-shaped scratch layout (parts share compiler options — the shared type
 *   surface); each diagnostic is routed to its owning part by the
 *   `src/webparts/<lower>/` path prefix. A diagnostic outside every part is a
 *   TOOL bug: the run fails loudly and no scaffold error ever reaches a model.
 * - The repair budget is PER PART (default 3 attempts each) — a global budget
 *   would let one bad part starve the others. Clean parts are never re-run.
 * - One part failing fails the run, but only AFTER every part had its chance,
 *   so the report shows each part's outcome (v1's everything-reported ethic).
 */

export class MultiPartVerifyError extends Error {
  constructor(files: string[]) {
    super(
      `Verification produced diagnostics outside every part (${files.join(', ')}) — ` +
        'scaffold/tool errors are a bug in spfx-relay, not something a model may repair. Aborting.',
    );
    this.name = 'MultiPartVerifyError';
  }
}

export interface PartRunResult {
  part: PartContext;
  verified: {
    ok: boolean;
    attempts: number;
    result: ProviderResult<TransformResult>;
    gates: GateResults;
  };
}

export interface MultiPartRun {
  ok: boolean;
  results: PartRunResult[];
}

/** Combined gate pass over every part's current component code. */
export type MultiPartGateChecker = (
  components: Array<{ name: string; code: string }>,
) => Promise<{ typecheck: VerifyResult; lints: Map<string, VerifyResult> }>;

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
  checkGates?: MultiPartGateChecker;
  onProgress?: (message: string) => void;
}

interface PartState {
  part: PartContext;
  sources: SourceFile[];
  attempts: number;
  feedback?: string;
  result?: ProviderResult<TransformResult>;
  gates?: GateResults;
  ok: boolean;
}

export async function runMultiPartTransform(args: MultiPartArgs): Promise<MultiPartRun> {
  const maxAttempts = (args.maxRepairRounds ?? 2) + 1;
  const checkGates = args.checkGates ?? defaultMultiPartGateChecker;
  const states: PartState[] = args.parts.map((part) => ({
    part,
    sources: partSources(part, args.inputDir),
    attempts: 0,
    ok: false,
  }));

  for (;;) {
    const pending = states.filter((s) => !s.ok && s.attempts < maxAttempts && (s.result === undefined || s.feedback !== undefined));
    if (pending.length === 0) break;

    for (const state of pending) {
      args.onProgress?.(
        `Transforming part ${state.part.name} (${state.part.rootSelector})${state.attempts > 0 ? ' — repair' : ''} …`,
      );
      state.result = await runTransform({
        provider: args.provider,
        plan: args.plan,
        analysis: args.analysis,
        sources: state.sources,
        part: { name: state.part.name, rootSelector: state.part.rootSelector },
        feedback: state.feedback,
        cache: args.cache,
        manifest: args.manifest,
      });
      state.attempts += 1;
      state.feedback = undefined;
    }

    // One combined gate pass over every part's CURRENT component.
    const withResults = states.filter((s): s is PartState & { result: ProviderResult<TransformResult> } => s.result !== undefined);
    const combined = await checkGates(withResults.map((s) => ({ name: s.part.name, code: s.result.value.componentCode })));
    routeAndApply(withResults, combined, maxAttempts);
  }

  const results: PartRunResult[] = states.map((state) => {
    if (!state.result || !state.gates) {
      // Unreachable: every part transforms at least once and every gate pass covers it.
      throw new Error(`Part ${state.part.name} finished without a transform result — loop invariant broken.`);
    }
    return {
      part: state.part,
      verified: { ok: state.ok, attempts: state.attempts, result: state.result, gates: state.gates },
    };
  });

  return { ok: results.every((r) => r.verified.ok), results };
}

function routeAndApply(
  states: Array<PartState & { result: ProviderResult<TransformResult> }>,
  combined: { typecheck: VerifyResult; lints: Map<string, VerifyResult> },
  maxAttempts: number,
): void {
  const owners = new Map(states.map((s) => [`src/webparts/${s.part.name.toLowerCase()}/`, s]));

  const perPartTypecheck = new Map<PartState, VerifyResult['issues']>(states.map((s) => [s, []]));
  const orphaned: string[] = [];
  for (const issue of combined.typecheck.issues) {
    const normalized = issue.file.replaceAll('\\', '/');
    const owner = [...owners.entries()].find(([prefix]) => normalized.toLowerCase().startsWith(prefix))?.[1];
    if (owner) perPartTypecheck.get(owner)?.push(issue);
    else orphaned.push(issue.file);
  }
  if (orphaned.length > 0) throw new MultiPartVerifyError([...new Set(orphaned)]);

  for (const state of states) {
    const typecheckIssues = perPartTypecheck.get(state) ?? [];
    const lint = combined.lints.get(state.part.name) ?? { ok: true, issues: [] };
    const gates: GateResults = {
      typecheck: { ok: typecheckIssues.length === 0, issues: typecheckIssues },
      lint,
    };
    state.gates = gates;
    state.ok = gates.typecheck.ok && gates.lint.ok;
    if (!state.ok && state.attempts < maxAttempts) {
      state.feedback = formatGateFeedback(state.result.value.componentCode, gates);
    }
  }
}

/** Real gates in an emit-shaped scratch dir: one tsc program, per-part lint. */
export const defaultMultiPartGateChecker: MultiPartGateChecker = async (components) => {
  const root = mkdtempSync(join(tmpdir(), 'spfx-relay-verify-multi-'));
  const declarationsPath = join(root, 'declarations.d.ts');
  writeFileSync(declarationsPath, "declare module '*.css';\n");

  const componentPaths: string[] = [];
  for (const component of components) {
    const path = join(root, 'src', 'webparts', component.name.toLowerCase(), 'components', `${component.name}.tsx`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, component.code);
    componentPaths.push(path);
  }

  const typecheck = typecheckFiles(root, componentPaths, [declarationsPath]);
  const lints = new Map<string, VerifyResult>();
  for (const [index, component] of components.entries()) {
    const path = componentPaths[index];
    if (path) lints.set(component.name, await lintComponent(path));
  }
  return { typecheck, lints };
};

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
