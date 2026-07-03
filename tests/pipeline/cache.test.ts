import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheKey, FileResponseCache, stableStringify, type CacheEntry } from '../../src/pipeline/cache';

const entry: CacheEntry = {
  rawText: '{"a":1}',
  value: { a: 1 },
  model: 'test-model',
  usage: { inputTokens: 10, outputTokens: 5 },
};

describe('cacheKey', () => {
  it('is stable for identical parts', () => {
    expect(cacheKey({ model: 'm', prompt: 'p' })).toBe(cacheKey({ model: 'm', prompt: 'p' }));
  });

  it('ignores object key insertion order', () => {
    expect(cacheKey({ a: 1, b: { x: 1, y: 2 } })).toBe(cacheKey({ b: { y: 2, x: 1 }, a: 1 }));
  });

  it('changes when any part changes', () => {
    const base = cacheKey({ model: 'm', prompt: 'p' });
    expect(cacheKey({ model: 'm', prompt: 'p2' })).not.toBe(base);
    expect(cacheKey({ model: 'm2', prompt: 'p' })).not.toBe(base);
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively but preserves array order', () => {
    expect(stableStringify({ b: [3, 1], a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1},"b":[3,1]}');
  });
});

describe('FileResponseCache', () => {
  it('round-trips entries and misses on unknown keys', () => {
    const cache = new FileResponseCache(mkdtempSync(join(tmpdir(), 'spfx-relay-cache-')));
    expect(cache.get('nope')).toBeUndefined();
    cache.set('key1', entry);
    expect(cache.get('key1')).toEqual(entry);
  });

  it('treats a corrupt entry as a miss instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spfx-relay-cache-'));
    const cache = new FileResponseCache(dir);
    writeFileSync(join(dir, 'bad.json'), 'not json {{{');
    expect(cache.get('bad')).toBeUndefined();
  });
});
