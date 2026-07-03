import { basename, dirname } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import type { VerifyResult } from './types';

/**
 * Fast gate #2: a small, deliberate rule set over the generated component —
 * legacy idioms that must not survive the migration. Only error-severity
 * messages fail the gate.
 */

export async function lintComponent(componentPath: string): Promise<VerifyResult> {
  const eslint = new ESLint({
    cwd: dirname(componentPath),
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser as never,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          'no-var': 'error',
          'prefer-const': 'error',
          eqeqeq: 'error',
          'no-empty': 'error',
          'no-debugger': 'error',
        },
      },
    ],
  });

  const results = await eslint.lintFiles([componentPath]);
  const issues = results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 2)
      .map((message) => ({
        file: basename(result.filePath),
        line: message.line ?? 0,
        message: `${message.ruleId ?? 'parse-error'}: ${message.message}`,
      })),
  );

  return { ok: issues.length === 0, issues };
}
