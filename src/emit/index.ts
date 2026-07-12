import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Asset } from '../types/ir';
import type { MigrationPlan } from '../pipeline/plan';
import { renderMultiPartScaffold, renderScaffold } from './scaffold';

/**
 * Emit: writes the verified migration to disk — scaffold, generated component,
 * and the legacy stylesheets/images copied next to it. Runs only after the
 * verify gates passed; nothing unverified lands in the output folder.
 */

export interface EmitArgs {
  outDir: string;
  plan: MigrationPlan;
  componentCode: string;
  inputDir: string;
  assets: Asset[];
}

export interface EmitResult {
  /** Forward-slash paths relative to outDir, sorted. */
  files: string[];
  componentPath: string;
}

export function emitProject(args: EmitArgs): EmitResult {
  const { outDir, plan, componentCode, inputDir, assets } = args;
  const files: string[] = [];

  for (const file of renderScaffold({ componentName: plan.componentName })) {
    writeOut(outDir, file.path, file.content);
    files.push(file.path);
  }

  const componentDir = `src/webparts/${plan.componentName.toLowerCase()}/components`;
  const componentPath = `${componentDir}/${plan.componentName}.tsx`;
  writeOut(outDir, componentPath, ensureTrailingNewline(componentCode));
  files.push(componentPath);

  // Stylesheets and images ship verbatim next to the component, preserving the
  // relative paths the legacy markup (and the generated imports) reference.
  for (const asset of assets) {
    if (asset.external || asset.exists !== true) continue;
    if (asset.kind !== 'stylesheet' && asset.kind !== 'image') continue;
    const target = `${componentDir}/${asset.path.replaceAll('\\', '/')}`;
    mkdirSync(dirname(join(outDir, target)), { recursive: true });
    copyFileSync(join(inputDir, asset.path), join(outDir, target));
    files.push(target);
  }

  return { files: [...new Set(files)].sort((a, b) => a.localeCompare(b)), componentPath };
}

export interface MultiPartEmitArgs {
  outDir: string;
  /** Base for the solution name — the migration's component name. */
  solutionBaseName: string;
  parts: Array<{ name: string; componentCode: string }>;
  inputDir: string;
  assets: Asset[];
}

export interface MultiPartEmitResult {
  files: string[];
  /** Part name → emitted component path. */
  componentPaths: Record<string, string>;
}

/** One solution, N web parts; shared stylesheets/images ship into EVERY part. */
export function emitMultiPartProject(args: MultiPartEmitArgs): MultiPartEmitResult {
  const { outDir, parts, inputDir, assets } = args;
  const files: string[] = [];
  const componentPaths: Record<string, string> = {};

  const scaffold = renderMultiPartScaffold({
    solutionBaseName: args.solutionBaseName,
    partNames: parts.map((part) => part.name),
  });
  for (const file of scaffold) {
    writeOut(outDir, file.path, file.content);
    files.push(file.path);
  }

  for (const part of parts) {
    const componentDir = `src/webparts/${part.name.toLowerCase()}/components`;
    const componentPath = `${componentDir}/${part.name}.tsx`;
    writeOut(outDir, componentPath, ensureTrailingNewline(part.componentCode));
    files.push(componentPath);
    componentPaths[part.name] = componentPath;

    for (const asset of assets) {
      if (asset.external || asset.exists !== true) continue;
      if (asset.kind !== 'stylesheet' && asset.kind !== 'image') continue;
      const target = `${componentDir}/${asset.path.replaceAll('\\', '/')}`;
      mkdirSync(dirname(join(outDir, target)), { recursive: true });
      copyFileSync(join(inputDir, asset.path), join(outDir, target));
      files.push(target);
    }
  }

  return { files: [...new Set(files)].sort((a, b) => a.localeCompare(b)), componentPaths };
}

function writeOut(outDir: string, relativePath: string, content: string): void {
  const absolute = join(outDir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function ensureTrailingNewline(code: string): string {
  return code.endsWith('\n') ? code : `${code}\n`;
}
