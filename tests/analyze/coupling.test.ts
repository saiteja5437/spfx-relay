import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCoupling, analyzeCouplingDir } from '../../src/analyze/coupling';
import { analyzeWebPart } from '../../src/analyze/index';
import { buildPlan } from '../../src/pipeline/plan';

const here = dirname(fileURLToPath(import.meta.url));
const independent = join(here, '..', 'fixtures', 'multi-part-independent');
const coupled = join(here, '..', 'fixtures', 'multi-part-coupled');
const singlePart = join(here, '..', '..', 'corpus', '001-static-hello', 'input');

// Every expectation here is hand-computed ground truth (same discipline as the
// corpus): if the analyzer disagrees, first verify the ANALYZER is wrong
// before touching these numbers.
describe('analyzeCoupling', () => {
  it('recommends decompose for two independent widgets (incl. ready-shell unwrapping)', () => {
    const report = analyzeCouplingDir(independent);

    expect(report.regions).toEqual([
      { name: 'news-panel', tag: 'div', line: 4 },
      { name: 'stock-ticker', tag: 'div', line: 9 },
    ]);
    expect(report.edges).toEqual([]);
    // news.js: #news-refresh + #news-list; ticker.js: #ticker-go + #ticker-value
    expect(report.attributed).toBe(4);
    expect(report.unattributed).toBe(0);
    // ticker.js is wrapped in $(document).ready — without unwrapping, its two
    // lookups would form one giant unit with news.js globals and misreport.
    expect(report.recommendation).toBe('decompose');
  });

  it('recommends spa when a mutable global links two regions', () => {
    const report = analyzeCouplingDir(coupled);

    expect(report.regions.map((r) => r.name)).toEqual(['product-list', 'cart-summary']);
    expect(report.edges).toEqual([
      {
        from: 'cart-summary',
        to: 'product-list',
        kind: 'shared-global',
        evidence: 'cartTotal',
        file: 'cart.js',
        line: 1,
      },
    ]);
    expect(report.attributed).toBe(3);
    expect(report.recommendation).toBe('spa');
    expect(report.reasons.join('\n')).toContain("'cartTotal'");
  });

  it('recommends spa when one unit touches two regions (cross-region selector)', () => {
    const report = analyzeCoupling({
      html: '<html><body>\n<div id="alpha-box"><button id="alpha-btn">A</button></div>\n<div id="beta-box"><span id="beta-out"></span></div>\n</body></html>',
      scripts: [{ file: 'app.js', code: "$('#alpha-btn, #beta-out').hide();\n" }],
    });

    expect(report.edges).toEqual([
      {
        from: 'alpha-box',
        to: 'beta-box',
        kind: 'cross-region-unit',
        evidence: '#alpha-btn, #beta-out',
        file: 'app.js',
        line: 1,
      },
    ]);
    expect(report.recommendation).toBe('spa');
  });

  it('refuses to trust decomposition when lookups are dynamic (unattributed over tolerance)', () => {
    const report = analyzeCoupling({
      html: '<html><body>\n<div id="alpha-box"></div>\n<div id="beta-box"></div>\n</body></html>',
      scripts: [{ file: 'app.js', code: 'var sel = window.location.hash;\n$(sel).show();\n' }],
    });

    expect(report.edges).toEqual([]);
    expect(report.attributed).toBe(0);
    expect(report.unattributed).toBe(1);
    expect(report.recommendation).toBe('spa');
    expect(report.reasons.join('\n')).toContain('could not be statically attributed');
  });

  it('recommends single for a one-widget page (v1 corpus input)', () => {
    const report = analyzeCouplingDir(singlePart);
    expect(report.regions.length).toBeLessThanOrEqual(1);
    expect(report.recommendation).toBe('single');
  });

  it('is deterministic: repeat runs produce identical reports', () => {
    expect(analyzeCouplingDir(independent)).toEqual(analyzeCouplingDir(independent));
    expect(analyzeCouplingDir(coupled)).toEqual(analyzeCouplingDir(coupled));
  });
});

describe('buildPlan strategy block', () => {
  it('fills strategy from a coupling report and stays absent without one', () => {
    const analysis = analyzeWebPart(independent);
    const coupling = analyzeCouplingDir(independent);

    const withStrategy = buildPlan({ analysis, name: 'multi-part-independent', coupling });
    expect(withStrategy.strategy).toEqual({
      parts: [
        { name: 'NewsPanel', rootSelector: '#news-panel' },
        { name: 'StockTicker', rootSelector: '#stock-ticker' },
      ],
      recommendation: 'decompose',
      reasons: ['2 independent regions with no detected shared state — safe to split into separate web parts.'],
      couplingEdges: 0,
    });

    const withoutStrategy = buildPlan({ analysis, name: 'multi-part-independent' });
    expect(withoutStrategy.strategy).toBeUndefined();
  });
});
