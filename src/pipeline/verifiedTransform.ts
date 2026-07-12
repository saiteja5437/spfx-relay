import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderResult } from '../providers/types';
import { lintComponent } from '../verify/lint';
import { typecheckComponent } from '../verify/typecheck';
import type { VerifyResult } from '../verify/types';
import type { TransformResult } from './prompts';
import { runTransform, type TransformArgs } from './transform';

/**
 * The compile-repair loop: transform → fast gates (typecheck + lint) → on
 * failure, re-run the sealed transform step with the exact diagnostics and the
 * failing code appended. The feedback changes the prompt, which changes the
 * cache key — so repairs never replay the cached bad response, and reruns of
 * the whole loop stay deterministic.
 */

export interface GateResults {
  typecheck: VerifyResult;
  lint: VerifyResult;
}

export interface VerifiedTransform {
  ok: boolean;
  attempts: number;
  result: ProviderResult<TransformResult>;
  gates: GateResults;
}

export type GateChecker = (componentName: string, componentCode: string) => Promise<GateResults>;

export async function runVerifiedTransform(
  args: TransformArgs & { maxRepairRounds?: number; checkGates?: GateChecker },
): Promise<VerifiedTransform> {
  const maxRepairRounds = args.maxRepairRounds ?? 2;
  const checkGates = args.checkGates ?? defaultGateChecker;

  let feedback: string | undefined;
  let last: { result: ProviderResult<TransformResult>; gates: GateResults } | undefined;

  for (let attempt = 1; attempt <= maxRepairRounds + 1; attempt++) {
    const result = await runTransform({ ...args, feedback });
    const gates = await checkGates(args.part?.name ?? args.plan.componentName, result.value.componentCode);
    if (gates.typecheck.ok && gates.lint.ok) {
      return { ok: true, attempts: attempt, result, gates };
    }
    last = { result, gates };
    feedback = formatGateFeedback(result.value.componentCode, gates);
  }

  // `last` is always set here: the loop body ran at least once to get here.
  return { ok: false, attempts: maxRepairRounds + 1, ...(last as NonNullable<typeof last>) };
}

/** Runs the real gates against the candidate in a scratch directory. */
export const defaultGateChecker: GateChecker = async (componentName, componentCode) => {
  const dir = mkdtempSync(join(tmpdir(), 'spfx-relay-verify-'));
  const componentPath = join(dir, `${componentName}.tsx`);
  const declarationsPath = join(dir, 'declarations.d.ts');
  writeFileSync(componentPath, componentCode);
  writeFileSync(declarationsPath, "declare module '*.css';\n");

  const typecheck = typecheckComponent(componentPath, [declarationsPath]);
  const lint = await lintComponent(componentPath);
  return { typecheck, lint };
};

/** Exported for the v3 multi-part loop — identical feedback wording per part. */
export function formatGateFeedback(componentCode: string, gates: GateResults): string {
  const sections = ['Your previously generated component failed verification.', '', 'Code you produced:', '```tsx', componentCode, '```'];
  if (!gates.typecheck.ok) {
    sections.push('', 'TypeScript errors (strict mode):');
    sections.push(...gates.typecheck.issues.map((i) => `- ${i.file}:${i.line} ${i.message}`));
  }
  if (!gates.lint.ok) {
    sections.push('', 'Lint errors:');
    sections.push(...gates.lint.issues.map((i) => `- ${i.file}:${i.line} ${i.message}`));
  }
  sections.push('', 'Fix every listed issue. Keep the behavior identical. Follow all original rules.');
  return sections.join('\n');
}
