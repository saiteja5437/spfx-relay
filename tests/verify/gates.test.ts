import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintComponent } from '../../src/verify/lint';
import { typecheckComponent } from '../../src/verify/typecheck';

const GOOD_COMPONENT = `import * as React from 'react';
import './styles.css';

export default function StaticHello(): React.ReactElement {
  const [greeting, setGreeting] = React.useState<string>('');
  return (
    <div id="greeting-box">
      <button id="load-button" onClick={() => setGreeting('Hello!')}>Load greeting</button>
      <p id="greeting-output">{greeting}</p>
    </div>
  );
}
`;

const BROKEN_COMPONENT = `import * as React from 'react';

export default function Broken(): React.ReactElement {
  const count: number = 'not a number';
  return <div>{count.toFixed(missingArg)}</div>;
}
`;

function writeCandidate(code: string): { componentPath: string; declarationsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spfx-relay-gate-'));
  const componentPath = join(dir, 'Candidate.tsx');
  const declarationsPath = join(dir, 'declarations.d.ts');
  writeFileSync(componentPath, code);
  writeFileSync(declarationsPath, "declare module '*.css';\n");
  return { componentPath, declarationsPath };
}

describe('typecheckComponent', () => {
  it('passes a well-formed strict React component (css import included)', () => {
    const { componentPath, declarationsPath } = writeCandidate(GOOD_COMPONENT);
    const result = typecheckComponent(componentPath, [declarationsPath]);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports structured diagnostics with file and line for broken code', () => {
    const { componentPath, declarationsPath } = writeCandidate(BROKEN_COMPONENT);
    const result = typecheckComponent(componentPath, [declarationsPath]);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toMatchObject({ file: 'Candidate.tsx' });
    expect(result.issues.some((i) => i.line === 4)).toBe(true); // the string-to-number assignment
  });
});

describe('lintComponent', () => {
  it('passes clean generated code', async () => {
    const { componentPath } = writeCandidate(GOOD_COMPONENT);
    const result = await lintComponent(componentPath);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails on surviving legacy idioms like var and loose equality', async () => {
    const { componentPath } = writeCandidate(
      `import * as React from 'react';
export default function Bad(): React.ReactElement {
  var x = 1;
  if (x == '1') { /* loose */ }
  return <div />;
}
`,
    );
    const result = await lintComponent(componentPath);
    expect(result.ok).toBe(false);
    const rules = result.issues.map((i) => i.message.split(':')[0]);
    expect(rules).toContain('no-var');
    expect(rules).toContain('eqeqeq');
  });
});
