import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnalysisResultSchema,
  type AnalysisResult,
  type Asset,
  type Dependency,
  type DomOperation,
  type EventHandler,
  type NetworkCall,
} from '../types/ir';
import { analyzeHtml } from './html';
import { analyzeScript, type StringAssignment } from './script';
import { classifyExternalScript, classifyLocalScript, isExternalUrl } from './dependencies';
import { secretFindings } from './rules/secrets';
import { assetFindings } from './rules/assets';
import { pluginRefusals } from './rules/plugins';

const ENTRY_FILE = 'index.html';

/**
 * Analyzes one legacy web part folder deterministically — no LLM, no network.
 * Output arrays are canonically sorted and schema-validated, so the same input
 * always produces the byte-identical result the eval corpus asserts against.
 */
export function analyzeWebPart(inputDir: string): AnalysisResult {
  const entryPath = join(inputDir, ENTRY_FILE);
  if (!existsSync(entryPath)) {
    throw new Error(
      `No ${ENTRY_FILE} found in '${inputDir}' — the input folder must contain the web part's entry HTML file.`,
    );
  }

  const htmlFacts = analyzeHtml(readFileSync(entryPath, 'utf8'));

  const assets: Asset[] = [];
  const dependencies: Dependency[] = [];
  const scriptsToAnalyze: Array<{ file: string; code: string; lineOffset: number }> = [];

  for (const ref of htmlFacts.assets) {
    const external = isExternalUrl(ref.path);
    const exists = external ? null : existsSync(join(inputDir, ref.path));
    assets.push({ kind: ref.kind, path: ref.path, file: ENTRY_FILE, line: ref.line, external, exists });

    if (ref.kind !== 'script') continue;
    if (external) {
      const library = classifyExternalScript(ref.path);
      dependencies.push({
        name: library.name,
        source: ref.path,
        file: ENTRY_FILE,
        line: ref.line,
        supported: library.supported,
      });
    } else if (exists) {
      // Vendored library files (jquery.<plugin>.js copied into the site
      // assets) are dependencies, not authored code: classified against the
      // same registry, never content-analyzed, never sent to the model.
      const library = classifyLocalScript(ref.path);
      if (library) {
        dependencies.push({
          name: library.name,
          source: toPosix(ref.path),
          file: ENTRY_FILE,
          line: ref.line,
          supported: library.supported,
        });
        continue;
      }
      scriptsToAnalyze.push({
        file: toPosix(ref.path),
        code: readFileSync(join(inputDir, ref.path), 'utf8'),
        lineOffset: 0,
      });
    }
  }

  for (const inline of htmlFacts.inlineScripts) {
    scriptsToAnalyze.push({ file: ENTRY_FILE, code: inline.content, lineOffset: inline.lineOffset });
  }

  const domOperations: DomOperation[] = [];
  const networkCalls: NetworkCall[] = [];
  const stringAssignments: StringAssignment[] = [];
  const eventHandlers: EventHandler[] = htmlFacts.eventAttributes.map((attr) => ({
    via: 'html-attribute' as const,
    event: attr.event,
    target: attr.target,
    file: ENTRY_FILE,
    line: attr.line,
  }));

  for (const script of scriptsToAnalyze) {
    const facts = analyzeScript(script.code, script.file, script.lineOffset);
    domOperations.push(...facts.domOperations);
    eventHandlers.push(...facts.eventHandlers);
    networkCalls.push(...facts.networkCalls);
    stringAssignments.push(...facts.stringAssignments);
  }

  const result: AnalysisResult = {
    ir: {
      assets: canonicalSort(assets),
      domOperations: canonicalSort(domOperations),
      eventHandlers: canonicalSort(eventHandlers),
      networkCalls: canonicalSort(networkCalls),
      dependencies: canonicalSort(dependencies),
    },
    findings: canonicalSort([...secretFindings(stringAssignments), ...assetFindings(assets)]),
    refusals: canonicalSort(pluginRefusals(dependencies)),
  };

  // The contract is enforced, not assumed: invalid output fails here, loudly.
  return AnalysisResultSchema.parse(result);
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function canonicalSort<T extends { file: string; line: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
