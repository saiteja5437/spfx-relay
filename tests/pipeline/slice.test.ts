import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCoupling, analyzeCouplingDir, loadCouplingInput } from '../../src/analyze/coupling';
import { SliceRefusalError, slicePartContexts } from '../../src/pipeline/slice';

const here = dirname(fileURLToPath(import.meta.url));
const independent = join(here, '..', 'fixtures', 'multi-part-independent');
const coupled = join(here, '..', 'fixtures', 'multi-part-coupled');

function sliceDir(dir: string) {
  return slicePartContexts(loadCouplingInput(dir), analyzeCouplingDir(dir));
}

describe('slicePartContexts', () => {
  it('slices two independent widgets with zero cross-part leakage (both directions)', () => {
    const parts = sliceDir(independent);
    expect(parts.map((p) => p.name)).toEqual(['NewsPanel', 'StockTicker']);
    expect(parts.map((p) => p.rootSelector)).toEqual(['#news-panel', '#stock-ticker']);

    const news = parts[0];
    const ticker = parts[1];
    if (!news || !ticker) throw new Error('unreachable');

    // NewsPanel: its handler, its data global, its region HTML — and no ticker anywhere.
    expect(news.html).toContain('id="news-panel"');
    expect(news.html).toContain('id="news-list"');
    const newsScripts = news.scripts.map((s) => `${s.file}\n${s.content}`).join('\n');
    expect(newsScripts).toContain("document.getElementById('news-refresh').addEventListener");
    expect(newsScripts).toContain('var newsItems');
    expect(JSON.stringify(news)).not.toMatch(/ticker/i);

    // StockTicker: symmetric — no news anywhere.
    expect(ticker.html).toContain('id="stock-ticker"');
    const tickerScripts = ticker.scripts.map((s) => `${s.file}\n${s.content}`).join('\n');
    expect(tickerScripts).toContain("$('#ticker-go').click");
    expect(tickerScripts).toContain('var clicks = 0;');
    expect(JSON.stringify(ticker)).not.toMatch(/news/i);
  });

  it('unwraps ready shells: sliced unit text is the INNER statements only', () => {
    const parts = sliceDir(independent);
    const tickerScript = parts[1]?.scripts.find((s) => s.file === 'ticker.js');
    expect(tickerScript?.content).not.toContain('ready');
    expect(tickerScript?.content).not.toContain('$(document)');
    // Inner statements in source order, joined with a blank line.
    expect(tickerScript?.content.startsWith('var clicks = 0;')).toBe(true);
  });

  it('is deterministic: two runs are deep-equal', () => {
    expect(sliceDir(independent)).toEqual(sliceDir(independent));
  });

  it('THROWS on a coupled page — the precondition is decompose, not hope', () => {
    expect(() => sliceDir(coupled)).toThrowError(SliceRefusalError);
    expect(() => sliceDir(coupled)).toThrowError(/coupling edge/);
  });

  it('duplicates const config and pure helpers (transitively) only into parts that use them', () => {
    const input = {
      html: [
        '<html><body>',
        '<div id="alpha-box"><button id="alpha-btn">A</button><span id="alpha-out"></span></div>',
        '<div id="beta-box"><span id="beta-out"></span></div>',
        '</body></html>',
      ].join('\n'),
      scripts: [
        {
          file: 'app.js',
          code: [
            "const FMT = '$';",
            'function fmt(n) { return FMT + n; }',
            'function fmtTwice(n) { return fmt(fmt(n)); }',
            "$('#alpha-btn').click(function () { $('#alpha-out').text(fmtTwice(1)); });",
            "$('#beta-out').text('hi');",
            "console.log('boot');",
          ].join('\n'),
        },
      ],
    };
    const report = analyzeCoupling(input);
    expect(report.recommendation).toBe('decompose');

    const parts = slicePartContexts(input, report);
    const alpha = parts[0];
    const beta = parts[1];
    if (!alpha || !beta) throw new Error('unreachable');

    // Alpha references fmtTwice → fmt → FMT: the whole chain arrives, in source order.
    const alphaCode = alpha.scripts[0]?.content ?? '';
    expect(alphaCode.indexOf('const FMT')).toBeGreaterThanOrEqual(0);
    expect(alphaCode.indexOf('const FMT')).toBeLessThan(alphaCode.indexOf('function fmt('));
    expect(alphaCode.indexOf('function fmtTwice(')).toBeLessThan(alphaCode.indexOf("$('#alpha-btn')"));
    // localeCompare order (house canonical sort): lowercase before uppercase.
    expect(alpha.duplicatedGlobals).toEqual(['fmt', 'FMT', 'fmtTwice']);

    // Beta never references the helpers: none of them leak in.
    const betaCode = beta.scripts[0]?.content ?? '';
    expect(betaCode).not.toContain('FMT');
    expect(betaCode).not.toContain('fmt');
    expect(beta.duplicatedGlobals).toEqual([]);

    // The region-less console.log is page-load init: duplicated into BOTH, loudly.
    expect(alphaCode).toContain("console.log('boot');");
    expect(betaCode).toContain("console.log('boot');");
    expect(alpha.assumptions.join('\n')).toContain('duplicated into every part');
  });

  it('duplicates unattributed-lookup units into every part with a loud assumption (override path)', () => {
    const input = {
      html: '<html><body>\n<div id="alpha-box"></div>\n<div id="beta-box"></div>\n</body></html>',
      scripts: [{ file: 'app.js', code: 'var sel = window.location.hash;\n$(sel).show();\n' }],
    };
    const report = analyzeCoupling(input);
    expect(report.recommendation).toBe('spa');
    expect(report.edges).toEqual([]); // tolerance-only spa — overridable per step 02

    const parts = slicePartContexts(input, report);
    for (const part of parts) {
      expect(part.scripts[0]?.content).toContain('$(sel).show();');
      expect(part.scripts[0]?.content).toContain('var sel = window.location.hash;');
      expect(part.assumptions.join('\n')).toContain('could not be attributed');
      expect(part.duplicatedGlobals).toContain('sel');
    }
  });
});
