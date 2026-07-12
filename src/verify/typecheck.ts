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

// Note: esModuleInterop defaults to true on modern TypeScript, so this gate
// would accept `import React from 'react'` — but the SPFx toolchain (TS 5.3,
// esModuleInterop off) would not. The transform prompt therefore mandates
// `import * as React`, which compiles under both.
function compilerOptions(): ts.CompilerOptions {
  return {
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
}

/**
 * v3: one strict program over ALL part components together (shared compiler
 * options = the shared type surface). Issues report paths RELATIVE to rootDir
 * (posix), so the multi-part loop can route each diagnostic to its owning part
 * by the `src/webparts/<name>/` prefix.
 */
export function typecheckFiles(rootDir: string, rootFiles: string[], extraRootFiles: string[] = []): VerifyResult {
  const program = ts.createProgram([...rootFiles, ...extraRootFiles], compilerOptions());
  const issues = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const full = diagnostic.file.fileName.replaceAll('\\', '/');
      const root = rootDir.replaceAll('\\', '/').replace(/\/+$/, '');
      const file = full.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? full.slice(root.length + 1) : basename(full);
      return { file, line: line + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') };
    }
    return { file: '(global)', line: 0, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') };
  });
  return { ok: issues.length === 0, issues };
}

export function typecheckComponent(componentPath: string, extraRootFiles: string[] = []): VerifyResult {
  const program = ts.createProgram([componentPath, ...extraRootFiles], compilerOptions());
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
