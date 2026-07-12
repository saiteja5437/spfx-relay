import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyResult } from './types';

/**
 * The final seal: one real `npm install` + `gulp bundle` in the emitted
 * project — the truest "it builds as SPFx" signal, run once at the end of the
 * run. Environment-dependent by nature, so it degrades gracefully: missing
 * toolchain means SKIPPED with a clear warning, never a crash.
 */

export interface BundleResult {
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export const defaultRunner: CommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    shell: process.platform === 'win32', // npm/npx are .cmd shims on Windows
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024, // spawnSync's 1 MiB default kills verbose npm/gulp runs mid-stream
  });
  let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // A spawn failure or timeout leaves status non-zero with no stdout/stderr to
  // explain it — say what happened so the report never shows a bare failure.
  if (result.error) {
    output += `${output ? '\n' : ''}[runner] ${command} did not complete: ${result.error.message}`;
  } else if (result.status !== 0 && result.signal) {
    output += `${output ? '\n' : ''}[runner] ${command} was killed by signal ${result.signal}`;
  }
  return { ok: result.status === 0, output };
};

export function runBundleSeal(outDir: string, runner: CommandRunner = defaultRunner): BundleResult {
  const npmCheck = runner('npm', ['--version'], outDir);
  if (!npmCheck.ok) {
    return {
      status: 'skipped',
      detail: 'npm was not found on PATH — bundle verification skipped. Run `npm install && npx gulp bundle` in the output folder to verify manually.',
    };
  }

  const install = runner('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], outDir);
  if (!install.ok) {
    return { status: 'failed', detail: `npm install failed:\n${tail(install.output)}` };
  }

  const bundle = runner('npx', ['gulp', 'bundle'], outDir);
  if (!bundle.ok) {
    return { status: 'failed', detail: `gulp bundle failed:\n${tail(bundle.output)}` };
  }

  return { status: 'passed', detail: 'npm install and gulp bundle completed successfully.' };
}

/**
 * v3 step 07: after a passing seal on a multi-part solution, assert dist/
 * holds one bundle per part — a part silently dropped by webpack (a
 * misconfigured `bundles` entry) is a real failure mode a green gulp exit
 * code does not catch.
 */
export function verifyPartBundles(outDir: string, partLowerNames: string[]): BundleResult {
  const dist = join(outDir, 'dist');
  const files = existsSync(dist) ? readdirSync(dist) : [];
  const missing = partLowerNames.filter(
    (lower) => !files.some((file) => file.startsWith(`${lower}-web-part`) && file.endsWith('.js')),
  );
  if (missing.length > 0) {
    return {
      status: 'failed',
      detail:
        `gulp bundle exited green but dist/ has no bundle for: ${missing.join(', ')} — ` +
        'a part was silently dropped by webpack; check config.json bundles entries.',
    };
  }
  return { status: 'passed', detail: `npm install and gulp bundle completed; dist/ holds one bundle per part (${partLowerNames.length}).` };
}

export function bundleAsVerify(result: BundleResult): VerifyResult {
  return {
    ok: result.status !== 'failed',
    issues: result.status === 'failed' ? [{ file: '(bundle)', line: 0, message: result.detail }] : [],
  };
}

function tail(output: string, maxChars = 2000): string {
  return output.length <= maxChars ? output : `…${output.slice(-maxChars)}`;
}
