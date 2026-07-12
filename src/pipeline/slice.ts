import { serializeOuter } from 'parse5';
import {
  analyzeCouplingInternals,
  type CouplingInput,
  type CouplingReport,
  type GlobalBinding,
  type Unit,
} from '../analyze/coupling';
import { analyzeHtml } from '../analyze/html';
import { strategyFrom } from './plan';

/**
 * v3 step 05 — decompose context slicing. For each part, the exact source
 * slice its transform will see. Pure and deterministic, no LLM. A wrong slice
 * produces a component that compiles beautifully and behaves wrongly, so every
 * rule here prefers refusal or honest duplication over guessing:
 *
 * - HTML: the region root's outer HTML, serialized from the parse5 tree.
 * - Scripts: the units (top-level statements after ready-shell unwrapping,
 *   shared with the coupling analyzer via analyzeCouplingInternals) whose
 *   attributed regions are exactly {thisPart}. Region-less units are homed by
 *   the couplable globals they touch (a `var x` used only by one region's
 *   handlers belongs to that part); units touching nothing are duplicated into
 *   every part — they are page-load initialization each part re-runs. Units
 *   with unattributable DOM lookups are duplicated too, each named loudly in
 *   `assumptions`. A region-less unit whose globals home in TWO parts cannot
 *   be placed safely — that is a refusal, not a guess.
 * - Preamble: const-primitive globals and pure helper functions referenced
 *   (transitively, to fixpoint) by the part's units are duplicated in, in
 *   source order, before the part's own units.
 * - CSS: whole stylesheets go to every part unchanged — splitting a cascade
 *   statically is guess-prone; duplication is safe and honest.
 * - Inline HTML handlers (onclick=…) travel with the region's HTML slice, not
 *   the script slice.
 *
 * Known nuance (accepted): leading comments BETWEEN units are dropped —
 * `getText` keeps a statement's own text including inner comments only.
 *
 * Note: `assumptions` extends the blueprint's output contract — the step
 * requires duplication/unattributed facts to reach the migration report, and
 * the report can only render what the slicer surfaces.
 */

export class SliceRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SliceRefusalError';
  }
}

export interface PartContext {
  name: string; // from plan.strategy.parts
  rootSelector: string;
  html: string; // region outer HTML, LF-normalized
  scripts: Array<{ file: string; content: string }>; // sliced text per source file
  stylesheets: string[]; // original stylesheet paths (shared by every part)
  duplicatedGlobals: string[]; // names, for the report
  /** Slicing decisions the human must review (duplicated units, unattributed lookups). */
  assumptions: string[];
}

export function slicePartContexts(input: CouplingInput, report: CouplingReport): PartContext[] {
  if (report.recommendation !== 'decompose' && !(report.recommendation === 'spa' && report.edges.length === 0)) {
    throw new SliceRefusalError(
      `slicePartContexts requires a decompose decision — coupling recommends '${report.recommendation}' with ` +
        `${report.edges.length} coupling edge(s); splitting shared state breaks the page.`,
    );
  }

  const internals = analyzeCouplingInternals(input);
  const parts = strategyFrom(report).parts;
  const regionNames = report.regions.map((region) => region.name);

  // Per-binding home regions: every region observed using the binding. For
  // functions this includes the body's own regions (a non-pure function is
  // anchored where its body touches the DOM).
  const homeOf = (global: GlobalBinding): Set<string> => {
    const regions = new Set<string>();
    for (const user of global.usedBy) for (const r of internals.units[user]?.regions ?? []) regions.add(r);
    if (global.isFunction && global.ownUnit !== null) {
      for (const r of internals.units[global.ownUnit]?.regions ?? []) regions.add(r);
    }
    return regions;
  };

  const globalsByDeclUnit = new Map<number, GlobalBinding[]>();
  for (const global of internals.globals.values()) {
    globalsByDeclUnit.set(global.declUnit, [...(globalsByDeclUnit.get(global.declUnit) ?? []), global]);
  }
  const aliasDeclUnits = new Set([...internals.aliases.values()].map((alias) => alias.declUnit));

  // Preamble-eligible units: every binding they declare is duplicable — an
  // inert const primitive, or a function that is pure BY ITS OWN BODY (the
  // unit.regions check below covers purity, because a function-declaration
  // unit's regions ARE its body's regions). Being *used* by a region's units
  // is exactly what makes a helper preamble-worthy, so usage never disqualifies.
  const isPreambleUnit = (unit: Unit, index: number): boolean => {
    const declared = globalsByDeclUnit.get(index) ?? [];
    if (declared.length === 0 || aliasDeclUnits.has(index)) return false;
    if (unit.regions.size > 0 || unit.unattributedLookups.length > 0) return false;
    return declared.every((g) => !g.couplable || g.isFunction);
  };

  const preambleUnits = new Set<number>();
  internals.units.forEach((unit, index) => {
    if (unit.node !== null && isPreambleUnit(unit, index)) preambleUnits.add(index);
  });

  // Placement for every non-preamble script unit (inline HTML handlers ride
  // with the region HTML instead — their unit.node is null).
  const placement = new Map<number, string>(); // unit index → region name
  const inEveryPart = new Set<number>();
  const assumptions: string[] = [];

  internals.units.forEach((unit, index) => {
    if (unit.node === null || preambleUnits.has(index)) return;

    if (unit.regions.size >= 2) {
      throw new SliceRefusalError(
        `Statement at ${unit.file}:${unit.line} touches regions ${[...unit.regions].sort().join(', ')} — ` +
          'a cross-region unit must have forced SPA; the coupling report and slice input diverged.',
      );
    }
    const only = [...unit.regions][0];
    if (only !== undefined) {
      placement.set(index, only);
      return;
    }

    // Region-less: home it by the couplable globals it declares or uses.
    const homes = new Set<string>();
    for (const global of internals.globals.values()) {
      if (!global.couplable) continue;
      if (global.declUnit === index || global.usedBy.has(index)) {
        for (const region of homeOf(global)) homes.add(region);
      }
    }
    if (homes.size >= 2) {
      throw new SliceRefusalError(
        `Statement at ${unit.file}:${unit.line} uses shared globals homed in different parts ` +
          `(${[...homes].sort().join(', ')}) — this page cannot be sliced safely; migrate as one web part (--strategy spa).`,
      );
    }
    const home = [...homes][0];
    if (home !== undefined) {
      placement.set(index, home);
      return;
    }

    inEveryPart.add(index);
    if (unit.unattributedLookups.length > 0) {
      assumptions.push(
        `Unit at ${unit.file}:${unit.line} uses DOM lookups that could not be attributed to a region ` +
          `('${unit.unattributedLookups.join("', '")}') — duplicated into every part; verify against the original page.`,
      );
    } else {
      assumptions.push(
        `Top-level statement at ${unit.file}:${unit.line} touches no region — duplicated into every part ` +
          '(each part re-runs this page-load initialization).',
      );
    }
  });

  const stylesheets = analyzeHtml(normalize(input.html))
    .assets.filter((asset) => asset.kind === 'stylesheet' && !/^(https?:)?\/\//i.test(asset.path))
    .map((asset) => asset.path);
  if (stylesheets.length > 0) {
    assumptions.push(
      `Stylesheet(s) ${stylesheets.map((s) => `'${s}'`).join(', ')} are shared unchanged by every part — ` +
        'CSS is never split statically.',
    );
  }

  return parts.map((part, partIndex) => {
    const region = regionNames[partIndex];
    if (region === undefined) throw new SliceRefusalError('Part/region mismatch — parts must come from this report.');
    const root = internals.facts.roots.get(region);
    if (!root) {
      throw new SliceRefusalError(
        `Region '${region}' from the coupling report was not found in the HTML — report and input diverged.`,
      );
    }

    const unitIndexes = internals.units
      .map((_, index) => index)
      .filter((index) => placement.get(index) === region || inEveryPart.has(index));

    // Preamble to fixpoint: bindings referenced by the part's units, plus
    // bindings referenced by already-included preamble units, until stable.
    const included = new Set<number>(unitIndexes);
    const preambleIncluded = new Set<number>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const index of preambleUnits) {
        if (preambleIncluded.has(index)) continue;
        const declared = globalsByDeclUnit.get(index) ?? [];
        if (declared.some((g) => [...g.usedBy].some((user) => included.has(user)))) {
          preambleIncluded.add(index);
          included.add(index);
          grew = true;
        }
      }
    }

    const orderedText = (indexes: Set<number>, file: string): string[] =>
      [...indexes]
        .filter((index) => internals.units[index]?.file === file)
        .sort((a, b) => (internals.units[a]?.line ?? 0) - (internals.units[b]?.line ?? 0) || a - b)
        .map((index) => {
          const unit = internals.units[index];
          return unit?.node ? normalize(unit.node.getText(unit.sourceFile)) : '';
        })
        .filter((text) => text.length > 0);

    const files = [...new Set(internals.units.map((unit) => unit.file))];
    const scripts = files
      .map((file) => {
        const pieces = [...orderedText(preambleIncluded, file), ...orderedText(new Set(unitIndexes), file)];
        return { file, content: pieces.join('\n\n') };
      })
      .filter((script) => script.content.length > 0);

    const duplicatedGlobals = [
      ...new Set([
        ...[...preambleIncluded].flatMap((index) => (globalsByDeclUnit.get(index) ?? []).map((g) => g.name)),
        ...unitIndexes
          .filter((index) => inEveryPart.has(index))
          .flatMap((index) => (globalsByDeclUnit.get(index) ?? []).map((g) => g.name)),
      ]),
    ].sort((a, b) => a.localeCompare(b));

    return {
      name: part.name,
      rootSelector: part.rootSelector,
      html: normalize(serializeOuter(root)),
      scripts,
      stylesheets,
      duplicatedGlobals,
      assumptions: [...assumptions],
    };
  });
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
