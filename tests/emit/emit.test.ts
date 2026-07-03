import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeWebPart } from '../../src/analyze/index';
import { emitProject } from '../../src/emit/index';
import { deterministicGuid, renderScaffold } from '../../src/emit/scaffold';
import { buildPlan } from '../../src/pipeline/plan';

const here = dirname(fileURLToPath(import.meta.url));
const corpusInput = join(here, '..', '..', 'corpus', '001-static-hello', 'input');

const componentCode = "import * as React from 'react';\nexport default function StaticHello() { return null; }";

describe('deterministicGuid', () => {
  it('is stable for the same seed and RFC-4122 shaped', () => {
    expect(deterministicGuid('x')).toBe(deterministicGuid('x'));
    expect(deterministicGuid('x')).not.toBe(deterministicGuid('y'));
    expect(deterministicGuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('renderScaffold', () => {
  it('substitutes tokens in both paths and content, byte-identically across runs', () => {
    const first = renderScaffold({ componentName: 'StaticHello' });
    const second = renderScaffold({ componentName: 'StaticHello' });
    expect(second).toEqual(first);

    const paths = first.map((f) => f.path);
    expect(paths).toContain('src/webparts/statichello/StaticHelloWebPart.ts');
    expect(paths).toContain('src/webparts/statichello/StaticHelloWebPart.manifest.json');

    const joined = first.map((f) => f.content).join('\n');
    expect(joined).not.toContain('__COMPONENT_NAME__');
    expect(joined).not.toContain('__SOLUTION_NAME__');
    expect(joined).not.toContain('__WEBPART_GUID__');
  });

  it('names the solution from the component and derives a readable title', () => {
    const files = renderScaffold({ componentName: 'StaticHello' });
    const pkg = files.find((f) => f.path === 'package.json');
    expect(pkg?.content).toContain('"name": "static-hello-spfx"');
    const manifest = files.find((f) => f.path.endsWith('.manifest.json'));
    expect(manifest?.content).toContain('"title": { "default": "Static Hello" }');
  });
});

describe('emitProject', () => {
  function emitCorpus() {
    const analysis = analyzeWebPart(corpusInput);
    const plan = buildPlan({ analysis, name: '001-static-hello' });
    const outDir = mkdtempSync(join(tmpdir(), 'spfx-relay-out-'));
    const result = emitProject({ outDir, plan, componentCode, inputDir: corpusInput, assets: analysis.ir.assets });
    return { outDir, result };
  }

  it('writes scaffold, component, and copied assets', () => {
    const { outDir, result } = emitCorpus();

    expect(result.componentPath).toBe('src/webparts/statichello/components/StaticHello.tsx');
    expect(readFileSync(join(outDir, result.componentPath), 'utf8')).toBe(`${componentCode}\n`);

    // Stylesheets and images copied verbatim; the replaced script is NOT copied.
    expect(readFileSync(join(outDir, 'src/webparts/statichello/components/styles.css'), 'utf8')).toContain('#greeting-box');
    expect(existsSync(join(outDir, 'src/webparts/statichello/components/logo.svg'))).toBe(true);
    expect(existsSync(join(outDir, 'src/webparts/statichello/components/app.js'))).toBe(false);

    expect(result.files).toContain('package.json');
    expect(result.files).toContain('gulpfile.js');
    expect(result.files).toContain('config/config.json');
    expect(result.files).toContain('src/webparts/statichello/StaticHelloWebPart.ts');
  });

  it('wires the web part class to the generated component', () => {
    const { outDir } = emitCorpus();
    const webPart = readFileSync(join(outDir, 'src/webparts/statichello/StaticHelloWebPart.ts'), 'utf8');
    expect(webPart).toContain("import StaticHello from './components/StaticHello';");
    expect(webPart).toContain('class StaticHelloWebPart');
  });
});
