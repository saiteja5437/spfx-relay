import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scaffold rendering: the pinned SPFx project template (templates/spfx/) with
 * deterministic token substitution — pure string work, no LLM. Even the GUIDs
 * are deterministic (derived from the component name), so re-running a
 * migration emits byte-identical scaffolding.
 */

export interface ScaffoldFile {
  /** Forward-slash path relative to the output root. */
  path: string;
  content: string;
}

export interface ScaffoldTokens {
  componentName: string;
}

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'spfx');

export function renderScaffold(tokens: ScaffoldTokens, templatesDir = TEMPLATES_DIR): ScaffoldFile[] {
  const componentName = tokens.componentName;
  const componentLower = componentName.toLowerCase();
  const solutionName = `${kebabCase(componentName)}-spfx`;
  const replacements: Record<string, string> = {
    __COMPONENT_NAME__: componentName,
    __COMPONENT_LOWER__: componentLower,
    __COMPONENT_TITLE__: titleCase(componentName),
    __SOLUTION_NAME__: solutionName,
    __SOLUTION_GUID__: deterministicGuid(`solution:${solutionName}`),
    __WEBPART_GUID__: deterministicGuid(`webpart:${componentName}`),
  };

  return listFiles(templatesDir)
    .map((absolute) => ({
      path: substitute(relative(templatesDir, absolute).replaceAll('\\', '/'), replacements),
      content: substitute(readFileSync(absolute, 'utf8').replaceAll('\r\n', '\n'), replacements),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** RFC-4122-shaped GUID derived from a seed — stable across runs by design. */
export function deterministicGuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function substitute(text: string, replacements: Record<string, string>): string {
  let result = text;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(token, value);
  }
  return result;
}

function kebabCase(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function titleCase(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}
