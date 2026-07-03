import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { VerifyResult } from './types';

/**
 * Fast gate #1: the generated component must type-check under strict settings
 * mirroring the SPFx toolchain (classic JSX, no esModuleInterop — hence
 * `import * as React`). React types resolve from spfx-relay's own
 * node_modules, so the gate needs no install inside the output project.
 */

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function typecheckComponent(componentPath: string, extraRootFiles: string[] = []): VerifyResult {
  // Note: esModuleInterop defaults to true on modern TypeScript, so this gate
  // would accept `import React from 'react'` — but the SPFx toolchain (TS 5.3,
  // esModuleInterop off) would not. The transform prompt therefore mandates
  // `import * as React`, which compiles under both.
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2017,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2017.d.ts', 'lib.dom.d.ts'],
    paths: {
      react: [join(TOOL_ROOT, 'node_modules/@types/react/index')],
      'react-dom': [join(TOOL_ROOT, 'node_modules/@types/react-dom/index')],
    },
    skipLibCheck: true,
  };

  const program = ts.createProgram([componentPath, ...extraRootFiles], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const issues = diagnostics.map((diagnostic) => {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return {
        file: basename(diagnostic.file.fileName),
        line: line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      };
    }
    return {
      file: '(global)',
      line: 0,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    };
  });

  return { ok: issues.length === 0, issues };
}
