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

export interface MultiPartScaffoldTokens {
  /** Base for the solution name (the migration name), e.g. 'MultiIndependent'. */
  solutionBaseName: string;
  /** Part component names in strategy order. */
  partNames: string[];
}

/**
 * One SPFx solution, N web parts (v3 step 06). Solution-level files render
 * once; everything under src/webparts/ renders once per part; config.json is
 * built programmatically with one bundle entry per part. Web part GUIDs are
 * seeded from exactly `${solutionName}/${partName}` so adding a part never
 * changes existing parts' GUIDs.
 */
export function renderMultiPartScaffold(tokens: MultiPartScaffoldTokens, templatesDir = TEMPLATES_DIR): ScaffoldFile[] {
  const solutionName = `${kebabCase(tokens.solutionBaseName)}-spfx`;
  const solutionReplacements: Record<string, string> = {
    __SOLUTION_NAME__: solutionName,
    __SOLUTION_GUID__: deterministicGuid(`solution:${solutionName}`),
  };

  const files: ScaffoldFile[] = [];
  for (const absolute of listFiles(templatesDir)) {
    const relPath = relative(templatesDir, absolute).replaceAll('\\', '/');
    const raw = readFileSync(absolute, 'utf8').replaceAll('\r\n', '\n');

    if (relPath.startsWith('src/webparts/')) {
      for (const part of tokens.partNames) {
        const replacements: Record<string, string> = {
          ...solutionReplacements,
          __COMPONENT_NAME__: part,
          __COMPONENT_LOWER__: part.toLowerCase(),
          __COMPONENT_TITLE__: titleCase(part),
          __WEBPART_GUID__: deterministicGuid(`${solutionName}/${part}`),
        };
        files.push({ path: substitute(relPath, replacements), content: substitute(raw, replacements) });
      }
    } else if (relPath === 'config/config.json') {
      files.push({ path: relPath, content: multiPartConfigJson(tokens.partNames) });
    } else {
      files.push({ path: relPath, content: substitute(raw, solutionReplacements) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function multiPartConfigJson(partNames: string[]): string {
  const bundles: Record<string, unknown> = {};
  for (const part of partNames) {
    bundles[`${part.toLowerCase()}-web-part`] = {
      components: [
        {
          entrypoint: `./lib/webparts/${part.toLowerCase()}/${part}WebPart.js`,
          manifest: `./src/webparts/${part.toLowerCase()}/${part}WebPart.manifest.json`,
        },
      ],
    };
  }
  const config = {
    $schema: 'https://developer.microsoft.com/json-schemas/spfx-build/config.2.0.schema.json',
    version: '2.0',
    bundles,
    externals: {},
    localizedResources: {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
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
