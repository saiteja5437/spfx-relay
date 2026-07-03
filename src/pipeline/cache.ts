import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderUsage } from '../providers/types';

/**
 * Response cache: the pipeline's reproducibility guarantee. LLM sampling is not
 * deterministic, but a cached run is — re-running an unchanged input replays
 * the recorded response bit-for-bit, instantly and for free.
 *
 * Keys are SHA-256 over a canonically-serialized (sorted-key) view of every
 * input that shapes the response: provider, model, system prompt, user prompt,
 * and the JSON schema.
 */

export interface CacheEntry {
  rawText: string;
  value: unknown;
  model: string;
  usage: ProviderUsage;
}

export interface ResponseCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}

export function cacheKey(parts: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex');
}

/** JSON.stringify with recursively sorted object keys — insertion order must never change the key. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

/** One JSON file per entry under a cache directory (e.g. `.spfx-relay/cache/`). */
export class FileResponseCache implements ResponseCache {
  constructor(private readonly dir: string) {}

  get(key: string): CacheEntry | undefined {
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
    } catch {
      return undefined; // corrupt entry behaves like a miss
    }
  }

  set(key: string, entry: CacheEntry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(entry, null, 2));
  }
}

export class MemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
  }
}
