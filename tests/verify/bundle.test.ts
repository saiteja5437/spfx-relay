import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRunner, runBundleSeal, type CommandResult, type CommandRunner } from '../../src/verify/bundle';

function scriptedRunner(script: Record<string, CommandResult>): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const result = script[key];
    if (!result) throw new Error(`unexpected command: ${key}`);
    return result;
  };
  return { runner, calls };
}

const NPM_VERSION = 'npm --version';
const NPM_INSTALL = 'npm install --no-audit --no-fund --loglevel=error';
const GULP_BUNDLE = 'npx gulp bundle';

describe('runBundleSeal', () => {
  it('passes when install and bundle both succeed', () => {
    const { runner, calls } = scriptedRunner({
      [NPM_VERSION]: { ok: true, output: '10.0.0' },
      [NPM_INSTALL]: { ok: true, output: '' },
      [GULP_BUNDLE]: { ok: true, output: 'Build succeeded' },
    });
    const result = runBundleSeal('/out', runner);
    expect(result.status).toBe('passed');
    expect(calls).toEqual([NPM_VERSION, NPM_INSTALL, GULP_BUNDLE]);
  });

  it('skips with a clear warning when npm is missing — graceful degradation', () => {
    const { runner, calls } = scriptedRunner({ [NPM_VERSION]: { ok: false, output: '' } });
    const result = runBundleSeal('/out', runner);
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('bundle verification skipped');
    expect(calls).toEqual([NPM_VERSION]); // nothing else attempted
  });

  it('fails with the tool output when the bundle breaks', () => {
    const { runner } = scriptedRunner({
      [NPM_VERSION]: { ok: true, output: '10.0.0' },
      [NPM_INSTALL]: { ok: true, output: '' },
      [GULP_BUNDLE]: { ok: false, output: 'Error - TS2304: Cannot find name' },
    });
    const result = runBundleSeal('/out', runner);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('TS2304');
  });

  it('defaultRunner explains a spawn failure instead of returning empty output', () => {
    // Regression: a process that never produced stdout/stderr (spawn error,
    // timeout) used to fail with a completely empty output string.
    const missingCwd = join(process.cwd(), 'definitely-not-a-real-directory');
    const result = defaultRunner(process.execPath, ['--version'], missingCwd);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('did not complete');
  });

  it('fails at install without attempting the bundle', () => {
    const { runner, calls } = scriptedRunner({
      [NPM_VERSION]: { ok: true, output: '10.0.0' },
      [NPM_INSTALL]: { ok: false, output: 'ERESOLVE unable to resolve dependency tree' },
    });
    const result = runBundleSeal('/out', runner);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('ERESOLVE');
    expect(calls).not.toContain(GULP_BUNDLE);
  });
});
