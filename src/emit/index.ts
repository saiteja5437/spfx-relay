import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Asset } from '../types/ir';
import type { MigrationPlan } from '../pipeline/plan';
import { renderScaffold } from './scaffold';

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

function writeOut(outDir: string, relativePath: string, content: string): void {
  const absolute = join(outDir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function ensureTrailingNewline(code: string): string {
  return code.endsWith('\n') ? code : `${code}\n`;
}
