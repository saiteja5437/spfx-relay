import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult } from '../types/ir';
import type { MigrationPlan } from './plan';
import { TRANSFORM_SYSTEM_PROMPT } from './prompts';

/**
 * Deterministic context assembly. Every transform call receives a minimal,
 * byte-stable packet: the plan's component name, the IR (already canonically
 * sorted by the analyzer), and the source files sorted by path with normalized
 * line endings. Same input folder → same prompt → same cache key, on any OS.
 *
 * Inputs over the size budget are REFUSED, never silently truncated — a
 * truncated prompt produces confidently wrong output.
 */

export const DEFAULT_MAX_CONTEXT_CHARS = 120_000;

export interface SourceFile {
  path: string;
  content: string;
}

export interface TransformContext {
  system: string;
  prompt: string;
}

export class ContextBudgetExceeded extends Error {
  constructor(actual: number, budget: number) {
    super(
      `Transform context is ${actual} characters — over the ${budget} budget. ` +
        `This web part is too large for a single-unit v1 migration; split it manually.`,
    );
    this.name = 'ContextBudgetExceeded';
  }
}

export function loadSourceFiles(inputDir: string, paths: string[]): SourceFile[] {
  return paths
    .map((path) => ({
      path,
      content: readFileSync(join(inputDir, path), 'utf8').replaceAll('\r\n', '\n'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function buildTransformContext(args: {
  plan: MigrationPlan;
  analysis: AnalysisResult;
  sources: SourceFile[];
  /** Verification feedback from a failed previous attempt — drives the compile-repair loop. */
  feedback?: string;
  maxChars?: number;
}): TransformContext {
  const { plan, analysis } = args;
  const maxChars = args.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const sources = [...args.sources].sort((a, b) => a.path.localeCompare(b.path));

  const sections: string[] = [
    '# Migration task',
    '',
    `Component name: ${plan.componentName}`,
    '',
    '## Static analysis of the legacy code (IR)',
    '```json',
    JSON.stringify(analysis.ir, null, 2),
    '```',
  ];

  if (plan.findings.length > 0) {
    sections.push(
      '',
      '## Flagged issues (do NOT reproduce these in the migrated code)',
      ...plan.findings.map((finding) => `- [${finding.rule}] ${finding.file}:${finding.line} — ${finding.message}`),
    );
  }

  sections.push('', '## Legacy source files');
  for (const source of sources) {
    sections.push('', `### ${source.path}`, '```', source.content, '```');
  }

  if (args.feedback) {
    sections.push('', '## Previous attempt failed verification', args.feedback);
  }

  sections.push(
    '',
    '## Instructions',
    `Migrate this legacy web part into a single React functional component named ${plan.componentName}, following every rule in the system prompt.`,
  );

  const prompt = sections.join('\n');
  const total = prompt.length + TRANSFORM_SYSTEM_PROMPT.length;
  if (total > maxChars) throw new ContextBudgetExceeded(total, maxChars);

  return { system: TRANSFORM_SYSTEM_PROMPT, prompt };
}
