import type { RunManifest } from '../pipeline/manifest';
import type { MigrationPlan } from '../pipeline/plan';
import type { TransformResult } from '../pipeline/prompts';
import type { GateResults } from '../pipeline/verifiedTransform';
import type { BundleResult } from '../verify/bundle';
import type { VerifyResult } from '../verify/types';

/**
 * The migration report — the human-review artifact every run produces, success
 * or not. Everything the tool decided, flagged, refused, assumed, or could not
 * handle is stated here explicitly; nothing is left implicit in the code.
 */

/** One decomposed part's outcome for the report (v3 step 06). */
export interface PartReport {
  name: string;
  ok: boolean;
  transform?: TransformResult;
  gates?: GateResults;
  attempts?: number;
  /** Tool-side slicing decisions (duplications, unattributed lookups). */
  sliceAssumptions: string[];
}

export interface ReportArgs {
  status: 'migrated' | 'blocked' | 'failed';
  plan: MigrationPlan;
  /** Runtime strategy choice (may differ from the recommendation via --strategy). */
  chosen?: 'single' | 'decompose' | 'spa';
  transform?: TransformResult;
  gates?: GateResults;
  transformAttempts?: number;
  /** Per-part outcomes for a decompose run — renders ### subsections. */
  parts?: PartReport[];
  bundle?: BundleResult;
  emittedFiles?: string[];
  manifest: RunManifest;
}

export function renderReport(args: ReportArgs): string {
  const { plan } = args;
  const lines: string[] = [
    `# Migration report — ${plan.componentName}`,
    '',
    `**Status:** ${statusLabel(args.status)}`,
    '',
    '## Plan',
    '',
    `| | |`,
    `|---|---|`,
    `| Component | \`${plan.componentName}\` |`,
    `| Source files | ${plan.sourceFiles.map((f) => `\`${f}\``).join(', ')} |`,
    `| DOM operations | ${plan.stats.domOperations} |`,
    `| Event handlers | ${plan.stats.eventHandlers} |`,
    `| Network calls | ${plan.stats.networkCalls} |`,
    `| External dependencies | ${plan.stats.dependencies} |`,
  ];

  if (plan.strategy) {
    const strategy = plan.strategy;
    lines.push('', '## Strategy', '', `**Recommendation:** ${strategy.recommendation}`);
    if (args.chosen && args.chosen !== strategy.recommendation) {
      lines.push('', `**Chosen:** ${args.chosen} (user override — see the safe-direction rule)`);
    }
    if (strategy.parts.length > 0) {
      lines.push('', '| Part | Root selector |', '|---|---|');
      for (const part of strategy.parts) lines.push(`| \`${part.name}\` | \`${part.rootSelector}\` |`);
    }
    lines.push('', ...strategy.reasons.map((reason) => `- ${reason}`));
  }

  lines.push('', '## Flagged issues', '');
  if (plan.findings.length === 0) {
    lines.push('None.');
  } else {
    for (const finding of plan.findings) {
      lines.push(`- **[${finding.severity}] ${finding.rule}** at \`${finding.file}:${finding.line}\` — ${finding.message}`);
    }
  }

  lines.push('', '## Refused constructs (require manual migration)', '');
  if (plan.refusals.length === 0) {
    lines.push('None.');
  } else {
    for (const refusal of plan.refusals) {
      lines.push(`- **${refusal.construct}** at \`${refusal.file}:${refusal.line}\` — ${refusal.reason}`);
    }
  }

  if (args.parts && args.parts.length > 0) {
    lines.push('', '## Transform (per part)');
    for (const part of args.parts) {
      lines.push('', `### ${part.name}`, '', part.ok ? '**Verified.**' : '**FAILED verification.**');
      if (part.transform) {
        lines.push('', part.transform.componentDescription || '_No description provided._');
        lines.push('', '**Assumptions the model made:**', '');
        lines.push(...listOrNone(part.transform.assumptions));
        lines.push('', '**Behavior the model could NOT map (review required):**', '');
        lines.push(...listOrNone(part.transform.unhandled));
      }
      lines.push('', '**Slicing decisions (tool-side):**', '');
      lines.push(...listOrNone(part.sliceAssumptions));
    }

    lines.push('', '## Verification (per part)', '');
    for (const part of args.parts) {
      if (!part.gates) continue;
      lines.push(`- ${part.name} — TypeScript: ${gateLabel(part.gates.typecheck)}, Lint: ${gateLabel(part.gates.lint)}` +
        (part.attempts !== undefined ? `, attempts: ${part.attempts}` : ''));
      for (const issue of [...part.gates.typecheck.issues, ...part.gates.lint.issues]) {
        lines.push(`  - \`${issue.file}:${issue.line}\` ${issue.message}`);
      }
    }
    if (args.bundle) {
      lines.push('', `- SPFx bundle seal: **${args.bundle.status.toUpperCase()}** — ${firstLine(args.bundle.detail)}`);
      const rest = args.bundle.detail.split('\n').slice(1).join('\n').trim();
      if (rest.length > 0) {
        lines.push('', '```', rest, '```');
      }
    }
  }

  if (args.transform) {
    lines.push('', '## Transform', '', args.transform.componentDescription || '_No description provided._');
    lines.push('', '### Assumptions the model made', '');
    lines.push(...listOrNone(args.transform.assumptions));
    lines.push('', '### Behavior the model could NOT map (review required)', '');
    lines.push(...listOrNone(args.transform.unhandled));
  }

  if (args.gates) {
    lines.push('', '## Verification', '');
    lines.push(`- TypeScript (strict): ${gateLabel(args.gates.typecheck)}`);
    lines.push(`- Lint: ${gateLabel(args.gates.lint)}`);
    if (args.transformAttempts !== undefined) {
      lines.push(`- Transform attempts (incl. compile repairs): ${args.transformAttempts}`);
    }
    for (const issue of [...args.gates.typecheck.issues, ...args.gates.lint.issues]) {
      lines.push(`  - \`${issue.file}:${issue.line}\` ${issue.message}`);
    }
    if (args.bundle) {
      lines.push(`- SPFx bundle seal: **${args.bundle.status.toUpperCase()}** — ${firstLine(args.bundle.detail)}`);
      const rest = args.bundle.detail.split('\n').slice(1).join('\n').trim();
      if (rest.length > 0) {
        lines.push('', '```', rest, '```');
      }
    }
  }

  if (args.emittedFiles && args.emittedFiles.length > 0) {
    lines.push('', '## Emitted files', '');
    lines.push(...args.emittedFiles.map((file) => `- \`${file}\``));
  }

  const usage = args.manifest.totalUsage();
  // The Part column appears only when a step is part-tagged, so v1 single-part
  // reports stay byte-identical.
  const withParts = args.manifest.steps.some((step) => step.part !== undefined);
  lines.push(
    '',
    '## LLM usage',
    '',
    withParts ? `| Step | Model | Attempts | Cache | Tokens in/out | Outcome | Part |` : `| Step | Model | Attempts | Cache | Tokens in/out | Outcome |`,
    withParts ? `|---|---|---|---|---|---|---|` : `|---|---|---|---|---|---|`,
    ...args.manifest.steps.map(
      (step) =>
        `| ${step.step} | ${step.model} | ${step.attempts} | ${step.cacheHit ? 'hit' : 'miss'} | ${step.usage.inputTokens}/${step.usage.outputTokens} | ${step.outcome} |` +
        (withParts ? ` ${step.part ?? ''} |` : ''),
    ),
    '',
    `Total tokens: ${usage.inputTokens} in / ${usage.outputTokens} out.`,
    '',
    '---',
    '_Generated by spfx-relay. Review the assumptions and unhandled items above before shipping._',
  );

  return lines.join('\n') + '\n';
}

function statusLabel(status: ReportArgs['status']): string {
  switch (status) {
    case 'migrated':
      return '✅ MIGRATED — verified output emitted';
    case 'blocked':
      return '⛔ BLOCKED — unsupported constructs detected; nothing was transformed';
    case 'failed':
      return '❌ FAILED — the transform did not pass verification; no component was emitted';
  }
}

function gateLabel(result: VerifyResult): string {
  return result.ok ? '**PASSED**' : `**FAILED** (${result.issues.length} issue(s))`;
}

function listOrNone(items: string[]): string[] {
  return items.length === 0 ? ['None declared.'] : items.map((item) => `- ${item}`);
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
