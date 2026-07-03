import { writeFileSync } from 'node:fs';
import type { ProviderUsage } from '../providers/types';

/**
 * The run manifest: one record per LLM step, the audit trail behind every
 * migration. Failed attempts burn tokens the wire doesn't report back, so
 * `usage` covers successful responses only — `attempts` tells the whole story.
 */

export interface StepRecord {
  step: string;
  provider: string;
  model: string;
  /** The cache key — identifies the exact (provider, model, prompts, schema) tuple. */
  promptHash: string;
  attempts: number;
  cacheHit: boolean;
  usage: ProviderUsage;
  outcome: 'ok' | 'failed';
  error?: string;
  durationMs: number;
}

export class RunManifest {
  readonly startedAt = new Date().toISOString();
  private readonly records: StepRecord[] = [];

  record(record: StepRecord): void {
    this.records.push(record);
  }

  get steps(): readonly StepRecord[] {
    return this.records;
  }

  totalUsage(): ProviderUsage {
    return this.records.reduce(
      (total, record) => ({
        inputTokens: total.inputTokens + record.usage.inputTokens,
        outputTokens: total.outputTokens + record.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
  }

  toJSON(): { startedAt: string; totalUsage: ProviderUsage; steps: readonly StepRecord[] } {
    return { startedAt: this.startedAt, totalUsage: this.totalUsage(), steps: this.records };
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 2));
  }
}
