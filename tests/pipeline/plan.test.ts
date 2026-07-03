import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeWebPart } from '../../src/analyze/index';
import { buildPlan, componentNameFrom } from '../../src/pipeline/plan';

const here = dirname(fileURLToPath(import.meta.url));
const corpusInput = join(here, '..', '..', 'corpus', '001-static-hello', 'input');
const refusalFixture = join(here, '..', 'fixtures', 'plugin-refusal');

describe('componentNameFrom', () => {
  it('derives PascalCase and drops numeric segments', () => {
    expect(componentNameFrom('001-static-hello')).toBe('StaticHello');
    expect(componentNameFrom('team_directory')).toBe('TeamDirectory');
    expect(componentNameFrom('myWidget')).toBe('MyWidget');
  });

  it('falls back when nothing usable remains', () => {
    expect(componentNameFrom('123-456')).toBe('MigratedWebPart');
  });
});

describe('buildPlan', () => {
  it('builds an approvable plan from a clean analysis', () => {
    const analysis = analyzeWebPart(corpusInput);
    const plan = buildPlan({ analysis, name: '001-static-hello' });

    expect(plan.componentName).toBe('StaticHello');
    expect(plan.sourceFiles).toEqual(['app.js', 'index.html', 'styles.css']); // images excluded, sorted
    expect(plan.stats).toEqual({ domOperations: 2, eventHandlers: 1, networkCalls: 0, dependencies: 0 });
    expect(plan.blocked).toBe(false);
    expect(plan.findings).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('blocks the plan when the analysis contains refusals', () => {
    const analysis = analyzeWebPart(refusalFixture);
    const plan = buildPlan({ analysis, name: 'plugin-refusal' });

    expect(plan.blocked).toBe(true);
    expect(plan.refusals).toHaveLength(2);
    expect(plan.componentName).toBe('PluginRefusal');
  });
});
