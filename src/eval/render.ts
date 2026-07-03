import type { EvalItemResult, EvalRun } from './index';

/** Renders the scorecard humans read (and READMEs quote). */
export function renderEvalMarkdown(run: EvalRun): string {
  const lines: string[] = [
    `# spfx-relay eval — ${run.provider}/${run.model}`,
    '',
    `Run started: ${run.startedAt}`,
    '',
    '| Item | Expected | Outcome | Analyzer | Refusal | Attempts (gate/step) | Content checks | Tokens in/out | Time |',
    '|---|---|---|---|---|---|---|---|---|',
  ];

  for (const result of run.results) {
    lines.push(
      [
        '',
        result.item,
        result.expectedOutcome,
        outcomeLabel(result),
        result.analyzerConformant ? 'ok' : 'DRIFT',
        result.refusalCorrect ? 'ok' : 'WRONG',
        result.transform ? `${result.transform.gateAttempts}/${result.transform.stepAttempts}` : '—',
        contentLabel(result),
        result.transform ? `${result.transform.inputTokens}/${result.transform.outputTokens}` : '—',
        result.transform ? `${(result.transform.durationMs / 1000).toFixed(1)}s` : '—',
        '',
      ].join(' | '),
    );
  }

  const s = run.summary;
  lines.push(
    '',
    '## Summary',
    '',
    `- Compile rate: **${s.compilePassed}/${s.migratable}** migratable items`,
    `- Refusal correctness: **${s.refusalCorrect}/${s.items}**`,
    `- Analyzer conformance: **${s.analyzerConformant}/${s.items}**`,
    `- Content checks: **${s.contentChecksPassed}/${s.contentChecksTotal}**`,
    `- Average gate attempts: **${s.averageGateAttempts ?? '—'}**`,
    `- Total tokens: **${s.totalInputTokens} in / ${s.totalOutputTokens} out**`,
    `- Total transform time: **${(s.totalDurationMs / 1000).toFixed(1)}s**`,
    '',
    '_Content checks are light surface assertions (ids, labels, conventions) — not behavioral equivalence._',
    '',
  );

  return lines.join('\n');
}

function outcomeLabel(result: EvalItemResult): string {
  switch (result.outcome) {
    case 'migrated':
      return '✅ migrated';
    case 'blocked':
      return '⛔ blocked';
    case 'failed-verification':
      return '❌ failed gates';
    case 'error':
      return `💥 error`;
  }
}

function contentLabel(result: EvalItemResult): string {
  const checks = result.transform?.contentChecks;
  if (!checks || checks.total === 0) return '—';
  const label = `${checks.passed}/${checks.total}`;
  return checks.failed.length > 0 ? `${label} (${checks.failed.join('; ')})` : label;
}
