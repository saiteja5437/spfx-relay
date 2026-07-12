import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCouplingDir } from '../src/analyze/coupling';
import { analyzeWebPart } from '../src/analyze/index';

/**
 * The eval corpus: every item under corpus/ is a synthetic legacy web part
 * (input/) with a hand-authored ground truth (expected.json). The analyzer's
 * output must match exactly — determinism is asserted, not hoped for.
 */

const corpusRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

describe('corpus eval', () => {
  const items = readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('has at least one corpus item', () => {
    expect(items.length).toBeGreaterThan(0);
  });

  for (const name of items) {
    it(`analyzes ${name} to its expected ground truth`, () => {
      const result = analyzeWebPart(join(corpusRoot, name, 'input'));
      const expected = JSON.parse(readFileSync(join(corpusRoot, name, 'expected.json'), 'utf8'));
      expect(result).toEqual(expected);
    });

    it(`analyzes ${name} identically on repeated runs`, () => {
      const first = analyzeWebPart(join(corpusRoot, name, 'input'));
      const second = analyzeWebPart(join(corpusRoot, name, 'input'));
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    // coupling.json is optional ground truth (multi-part items only; 001–005's
    // truth lives implicitly in `recommendation: single`).
    if (existsSync(join(corpusRoot, name, 'coupling.json'))) {
      it(`computes ${name} coupling to its expected ground truth`, () => {
        const report = analyzeCouplingDir(join(corpusRoot, name, 'input'));
        const expected = JSON.parse(readFileSync(join(corpusRoot, name, 'coupling.json'), 'utf8'));
        expect(report).toEqual(expected);
      });

      it(`computes ${name} coupling identically on repeated runs`, () => {
        const first = analyzeCouplingDir(join(corpusRoot, name, 'input'));
        const second = analyzeCouplingDir(join(corpusRoot, name, 'input'));
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      });
    }
  }
});
