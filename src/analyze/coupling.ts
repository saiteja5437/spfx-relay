import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import ts from 'typescript';
import { z } from 'zod';
import { classifyLocalScript } from './dependencies';
import { analyzeHtml } from './html';

/**
 * v3 coupling analysis — the deterministic evidence behind the decompose-vs-SPA
 * strategy decision. Pure AST work, no LLM, no network.
 *
 * Model:
 * - A REGION is a candidate web part: a direct child of <body> that is a
 *   container tag and has an id. Legacy Script Editor pages compose widgets as
 *   sibling <div id=…> blocks; requiring an id gives a stable name and a stable
 *   attribution key. No class-name heuristics, ever.
 * - Scripts are split into top-level UNITS (statements), after unwrapping the
 *   ubiquitous $(document).ready / DOMContentLoaded / window.onload shells —
 *   without unwrapping, every legacy page would be one giant unit and every
 *   two-region page would falsely read as coupled.
 * - A unit is ATTRIBUTED to the regions whose ids/classes its statically-known
 *   DOM lookups resolve to. Unresolvable lookups (dynamic selectors, tag-only
 *   selectors, ids owned by no or multiple regions) count as UNATTRIBUTED —
 *   they are the measured uncertainty, never a guess.
 * - COUPLING EDGES between regions come from exactly two signals:
 *   `shared-global`  — a mutable top-level binding (var/let, const with a
 *                      non-primitive initializer, or a function whose own body
 *                      touches a region) used by units attributed to different
 *                      regions. const primitives are inert config (duplicable);
 *                      pure helper functions (touch no region) are duplicable.
 *   `cross-region-unit` — one unit whose lookups span two or more regions.
 * - Recommendation (deterministic): ≤1 region → 'single'. Any edge → 'spa'
 *   (splitting shared state would break behavior; one web part keeps it
 *   correct). Too much unattributed (> UNATTRIBUTED_TOLERANCE of lookups) →
 *   'spa' (refusal-over-guessing: never split on evidence we don't have).
 *   Otherwise → 'decompose'.
 *
 * Known approximations (documented, acceptable): identifier shadowing inside
 * handlers is ignored; only one level of ready-wrapper unwrapping; property
 * writes (el.innerHTML = …) attribute via the lookup that produced `el`, not
 * the write itself.
 */

export const RegionSchema = z.object({
  /** The region root's id — also the future part's working name. */
  name: z.string(),
  tag: z.string(),
  line: z.number().int(),
});

export const CouplingEdgeSchema = z.object({
  /** Region pair, lexically ordered so output is canonical. */
  from: z.string(),
  to: z.string(),
  kind: z.enum(['shared-global', 'cross-region-unit']),
  /** The shared binding's name, or the unit's lookup targets. */
  evidence: z.string(),
  file: z.string(),
  line: z.number().int(),
});

export const CouplingReportSchema = z.object({
  regions: z.array(RegionSchema),
  edges: z.array(CouplingEdgeSchema),
  /** Statically-resolvable DOM lookups vs. ones we could not place. */
  attributed: z.number().int(),
  unattributed: z.number().int(),
  recommendation: z.enum(['single', 'decompose', 'spa']),
  reasons: z.array(z.string()),
});

export type Region = z.infer<typeof RegionSchema>;
export type CouplingEdge = z.infer<typeof CouplingEdgeSchema>;
export type CouplingReport = z.infer<typeof CouplingReportSchema>;

export interface CouplingScript {
  /** Path as reported in evidence (posix-relative, e.g. 'app.js' or 'index.html'). */
  file: string;
  code: string;
  /** For inline scripts: added to 1-based lines to get HTML file lines. */
  lineOffset?: number;
}

export interface CouplingInput {
  html: string;
  scripts: CouplingScript[];
}

/** Above this share of unresolvable lookups, decomposition cannot be trusted. */
export const UNATTRIBUTED_TOLERANCE = 1 / 3;

const CONTAINER_TAGS = new Set(['div', 'section', 'main', 'article', 'aside']);
const ID_LOOKUPS = new Set(['getElementById']);
const CLASS_LOOKUPS = new Set(['getElementsByClassName']);
const SELECTOR_LOOKUPS = new Set(['querySelector', 'querySelectorAll']);
const TAG_LOOKUPS = new Set(['getElementsByTagName']);

// ---------------------------------------------------------------------------
// Region extraction (parse5)
// ---------------------------------------------------------------------------

type P5Node = DefaultTreeAdapterMap['node'];
export type P5Element = DefaultTreeAdapterMap['element'];

export interface RegionFacts {
  regions: Region[];
  /** Region name → its parse5 root element (for HTML slicing, v3 step 05). */
  roots: Map<string, P5Element>;
  /** id/class → names of regions containing it; only single-owner keys attribute. */
  idOwner: Map<string, Set<string>>;
  classOwner: Map<string, Set<string>>;
  inlineHandlers: Array<{ code: string; line: number; region: string | null }>;
}

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node;
}

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function extractRegions(html: string): RegionFacts {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const facts: RegionFacts = { regions: [], roots: new Map(), idOwner: new Map(), classOwner: new Map(), inlineHandlers: [] };

  const htmlEl = document.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'html');
  const body = htmlEl?.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'body');
  if (!body) return facts;

  const usedNames = new Set<string>();
  for (const child of body.childNodes) {
    if (!isElement(child)) continue;
    const id = attr(child, 'id');
    // Duplicate ids are invalid HTML; only the first becomes a region.
    if (CONTAINER_TAGS.has(child.tagName) && id && !usedNames.has(id)) {
      usedNames.add(id);
      facts.regions.push({ name: id, tag: child.tagName, line: child.sourceCodeLocation?.startLine ?? 0 });
      facts.roots.set(id, child);
    }
  }
  const regionNames = new Set(facts.regions.map((r) => r.name));

  const walk = (node: P5Node, region: string | null): void => {
    if (isElement(node)) {
      const id = attr(node, 'id');
      const enteredRegion = region === null && id !== undefined && regionNames.has(id) ? id : region;
      if (enteredRegion !== null) {
        if (id) addOwner(facts.idOwner, id, enteredRegion);
        for (const cls of (attr(node, 'class') ?? '').split(/\s+/).filter(Boolean)) {
          addOwner(facts.classOwner, cls, enteredRegion);
        }
      }
      for (const a of node.attrs) {
        if (a.name.startsWith('on') && a.name.length > 2 && a.value.trim().length > 0) {
          facts.inlineHandlers.push({
            code: a.value,
            line: node.sourceCodeLocation?.attrs?.[a.name]?.startLine ?? node.sourceCodeLocation?.startLine ?? 0,
            region: enteredRegion,
          });
        }
      }
      if ('childNodes' in node) for (const c of node.childNodes) walk(c, enteredRegion);
      return;
    }
    if ('childNodes' in node) for (const c of node.childNodes) walk(c, region);
  };
  walk(body, null);
  return facts;
}

function addOwner(map: Map<string, Set<string>>, key: string, region: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(region);
  map.set(key, set);
}

// ---------------------------------------------------------------------------
// Script units, globals, attribution (TS compiler API)
// ---------------------------------------------------------------------------

export interface Unit {
  file: string;
  line: number;
  regions: Set<string>;
  /** Lookup targets as written — evidence for cross-region-unit edges. */
  targets: string[];
  node: ts.Node | null; // null for HTML inline handlers (whole source walked)
  sourceFile: ts.SourceFile;
  lineOffset: number;
  scope: string; // '' = shared window scope; otherwise per-wrapper
  seedRegion: string | null;
  /** Lookup values in this unit that could not be attributed (slicing evidence). */
  unattributedLookups: string[];
}

export interface GlobalBinding {
  name: string;
  key: string;
  file: string;
  line: number;
  couplable: boolean;
  isFunction: boolean;
  ownUnit: number | null; // index of the declaring unit (functions)
  usedBy: Set<number>;
  /** Index of the unit whose statement declares this binding. */
  declUnit: number;
}

export interface AliasBinding {
  key: string;
  region: string | null;
  /** Index of the unit whose statement declares this alias. */
  declUnit: number;
}

interface Ctx {
  facts: RegionFacts;
  globals: Map<string, GlobalBinding>;
  aliases: Map<string, AliasBinding>;
  units: Unit[];
  attributed: number;
  unattributed: number;
}

/**
 * The full analysis context behind a coupling report — exported so the v3
 * slicer (src/pipeline/slice.ts) shares this exact attribution machinery
 * instead of duplicating it. Divergence here would be silent wrong-behavior.
 */
export interface CouplingInternals {
  facts: RegionFacts;
  units: Unit[];
  globals: Map<string, GlobalBinding>;
  aliases: Map<string, AliasBinding>;
  edges: CouplingEdge[];
  attributed: number;
  unattributed: number;
}

export function analyzeCouplingInternals(input: CouplingInput): CouplingInternals {
  const facts = extractRegions(normalize(input.html));
  const ctx: Ctx = { facts, globals: new Map(), aliases: new Map(), units: [], attributed: 0, unattributed: 0 };

  // Pass 1 — enumerate units and declare bindings across ALL scripts first, so
  // a unit in one file can be linked to a window global declared in another.
  const parsed = input.scripts.map((script, i) => {
    const sourceFile = ts.createSourceFile(`${i}-${script.file}`, normalize(script.code), ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    return { script, sourceFile, statements: unwrapReadyShells(sourceFile, `f${i}`) };
  });
  for (const { script, sourceFile, statements } of parsed) {
    for (const { stmt, scope } of statements) {
      const unitIndex = ctx.units.length;
      ctx.units.push({
        file: script.file,
        line: lineOf(stmt, sourceFile, script.lineOffset ?? 0),
        regions: new Set(),
        targets: [],
        node: stmt,
        sourceFile,
        lineOffset: script.lineOffset ?? 0,
        scope,
        seedRegion: null,
        unattributedLookups: [],
      });
      declareBindings(stmt, sourceFile, script, scope, unitIndex, ctx);
    }
  }
  for (const handler of facts.inlineHandlers) {
    const sourceFile = ts.createSourceFile('inline-handler.js', normalize(handler.code), ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    ctx.units.push({
      file: 'index.html',
      line: handler.line,
      regions: new Set(handler.region ? [handler.region] : []),
      targets: [],
      node: null,
      sourceFile,
      lineOffset: 0,
      scope: '',
      seedRegion: handler.region,
      unattributedLookups: [],
    });
  }

  // Pass 2 — attribute every unit and link its global uses.
  ctx.units.forEach((unit, index) => walkUnit(unit, index, ctx));

  return {
    facts,
    units: ctx.units,
    globals: ctx.globals,
    aliases: ctx.aliases,
    edges: collectEdges(ctx),
    attributed: ctx.attributed,
    unattributed: ctx.unattributed,
  };
}

export function analyzeCoupling(input: CouplingInput): CouplingReport {
  const internals = analyzeCouplingInternals(input);
  const { recommendation, reasons } = recommend(internals.facts.regions, internals.edges, internals);

  return CouplingReportSchema.parse({
    regions: [...internals.facts.regions].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    edges: internals.edges,
    attributed: internals.attributed,
    unattributed: internals.unattributed,
    recommendation,
    reasons,
  });
}

/** Builds the CouplingInput for a web part folder (mirrors analyzeWebPart's discovery). */
export function loadCouplingInput(inputDir: string): CouplingInput {
  const html = readFileSync(join(inputDir, 'index.html'), 'utf8');
  const htmlFacts = analyzeHtml(html);
  const scripts: CouplingScript[] = [];
  for (const ref of htmlFacts.assets) {
    if (ref.kind !== 'script' || /^(https?:)?\/\//i.test(ref.path)) continue;
    // Vendored library internals must not pollute coupling evidence either —
    // their globals are library plumbing, not page state.
    if (classifyLocalScript(ref.path)) continue;
    const path = join(inputDir, ref.path);
    if (existsSync(path)) scripts.push({ file: ref.path.replaceAll('\\', '/'), code: readFileSync(path, 'utf8') });
  }
  for (const inline of htmlFacts.inlineScripts) {
    scripts.push({ file: 'index.html', code: inline.content, lineOffset: inline.lineOffset });
  }
  return { html, scripts };
}

/** Directory variant mirroring analyzeWebPart's input discovery. */
export function analyzeCouplingDir(inputDir: string): CouplingReport {
  return analyzeCoupling(loadCouplingInput(inputDir));
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile, offset: number): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + offset;
}

/**
 * $(document).ready(fn) / $(fn) / document.addEventListener('DOMContentLoaded', fn)
 * / window.onload = fn — replace the shell statement with the handler's body
 * statements (one level; nested shells stay one unit, acceptable and rare).
 */
function unwrapReadyShells(sourceFile: ts.SourceFile, filePrefix: string): Array<{ stmt: ts.Statement; scope: string }> {
  const out: Array<{ stmt: ts.Statement; scope: string }> = [];
  let wrapperCount = 0;
  for (const stmt of sourceFile.statements) {
    const body = readyShellBody(stmt);
    if (body) {
      wrapperCount += 1;
      const scope = `${filePrefix}:w${wrapperCount}`;
      for (const inner of body.statements) out.push({ stmt: inner, scope });
    } else {
      out.push({ stmt, scope: '' });
    }
  }
  return out;
}

function readyShellBody(stmt: ts.Statement): ts.Block | null {
  const fnBlock = (node: ts.Expression | undefined): ts.Block | null =>
    node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isBlock(node.body) ? node.body : null;

  if (ts.isExpressionStatement(stmt)) {
    const expr = stmt.expression;
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      // $(fn) / jQuery(fn)
      if (ts.isIdentifier(callee) && (callee.text === '$' || callee.text === 'jQuery')) {
        return fnBlock(expr.arguments[0]);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        // $(document).ready(fn)
        if (callee.name.text === 'ready') return fnBlock(expr.arguments[0]);
        // document/window.addEventListener('DOMContentLoaded'|'load', fn)
        if (
          callee.name.text === 'addEventListener' &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === 'document' || callee.expression.text === 'window') &&
          expr.arguments[0] &&
          ts.isStringLiteralLike(expr.arguments[0]) &&
          ['DOMContentLoaded', 'load'].includes(expr.arguments[0].text)
        ) {
          return fnBlock(expr.arguments[1]);
        }
      }
    }
    // window.onload = fn
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      expr.left.name.text === 'onload'
    ) {
      return fnBlock(expr.right);
    }
  }
  return null;
}

function declareBindings(
  stmt: ts.Statement,
  sourceFile: ts.SourceFile,
  script: CouplingScript,
  scope: string,
  unitIndex: number,
  ctx: Ctx,
): void {
  const keyFor = (name: string): string => (scope === '' ? `g:${name}` : `s:${scope}:${name}`);

  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    ctx.globals.set(keyFor(stmt.name.text), {
      name: stmt.name.text,
      key: keyFor(stmt.name.text),
      file: script.file,
      line: lineOf(stmt, sourceFile, script.lineOffset ?? 0),
      couplable: true,
      isFunction: true,
      ownUnit: unitIndex,
      usedBy: new Set(),
      declUnit: unitIndex,
    });
    return;
  }
  if (!ts.isVariableStatement(stmt)) return;
  const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const line = lineOf(decl, sourceFile, script.lineOffset ?? 0);
    const lookup = decl.initializer ? asLookup(decl.initializer) : null;
    if (lookup) {
      // Element alias: `var btn = $('#x')` — uses of `btn` attribute its region.
      const resolved = resolveLookup(lookup, ctx.facts);
      ctx.aliases.set(keyFor(decl.name.text), {
        key: keyFor(decl.name.text),
        region: resolved.regions.length === 1 ? (resolved.regions[0] ?? null) : null,
        declUnit: unitIndex,
      });
      continue;
    }
    const inert = isConst && decl.initializer !== undefined && isPrimitiveLiteral(decl.initializer);
    ctx.globals.set(keyFor(decl.name.text), {
      name: decl.name.text,
      key: keyFor(decl.name.text),
      file: script.file,
      line,
      couplable: !inert, // const primitives are duplicable config, not shared state
      isFunction: false,
      ownUnit: null,
      usedBy: new Set(),
      declUnit: unitIndex,
    });
  }
}

function isPrimitiveLiteral(node: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

interface Lookup {
  kind: 'id' | 'class' | 'selector' | 'tag' | 'dynamic' | 'skip';
  value: string;
}

/** Classifies a call expression as a DOM lookup, or null when it is not one. */
function asLookup(node: ts.Expression): Lookup | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  const arg = node.arguments[0];

  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'document') {
    const method = callee.name.text;
    const staticArg = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
    if (ID_LOOKUPS.has(method)) return staticArg ? { kind: 'id', value: staticArg } : { kind: 'dynamic', value: method };
    if (CLASS_LOOKUPS.has(method)) return staticArg ? { kind: 'class', value: staticArg } : { kind: 'dynamic', value: method };
    if (SELECTOR_LOOKUPS.has(method)) return staticArg ? { kind: 'selector', value: staticArg } : { kind: 'dynamic', value: method };
    if (TAG_LOOKUPS.has(method)) return { kind: 'tag', value: staticArg ?? method };
    return null;
  }
  if (ts.isIdentifier(callee) && (callee.text === '$' || callee.text === 'jQuery')) {
    if (!arg) return { kind: 'skip', value: '' };
    if (ts.isStringLiteralLike(arg)) {
      const text = arg.text.trim();
      if (text.startsWith('<')) return { kind: 'skip', value: text }; // HTML fragment, not a lookup
      return { kind: 'selector', value: text };
    }
    if (ts.isIdentifier(arg)) {
      if (['document', 'window', 'this'].includes(arg.text)) return { kind: 'skip', value: arg.text };
      return { kind: 'dynamic', value: arg.text }; // runtime selector — honest uncertainty
    }
    if (arg.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'skip', value: 'this' };
    return { kind: 'dynamic', value: '(expression)' };
  }
  return null;
}

/** Resolves a lookup to owning regions. `known=false` counts as unattributed. */
function resolveLookup(lookup: Lookup, facts: RegionFacts): { regions: string[]; known: boolean; counted: boolean } {
  const single = (map: Map<string, Set<string>>, key: string): string | null => {
    const owners = map.get(key);
    return owners && owners.size === 1 ? ([...owners][0] ?? null) : null; // multi-owner keys are ambiguous
  };
  switch (lookup.kind) {
    case 'skip':
      return { regions: [], known: false, counted: false };
    case 'dynamic':
    case 'tag':
      return { regions: [], known: false, counted: true };
    case 'id': {
      const region = single(facts.idOwner, lookup.value);
      return { regions: region ? [region] : [], known: region !== null, counted: true };
    }
    case 'class': {
      const region = single(facts.classOwner, lookup.value);
      return { regions: region ? [region] : [], known: region !== null, counted: true };
    }
    case 'selector': {
      const regions = new Set<string>();
      for (const [, id] of lookup.value.matchAll(/#([\w-]+)/g)) {
        const region = id ? single(facts.idOwner, id) : null;
        if (region) regions.add(region);
      }
      for (const [, cls] of lookup.value.matchAll(/\.([\w-]+)/g)) {
        const region = cls ? single(facts.classOwner, cls) : null;
        if (region) regions.add(region);
      }
      return { regions: [...regions], known: regions.size > 0, counted: true };
    }
  }
}

function walkUnit(unit: Unit, unitIndex: number, ctx: Ctx): void {
  if (unit.seedRegion) unit.regions.add(unit.seedRegion);
  const resolveBinding = (name: string): string | null => {
    const scoped = unit.scope === '' ? null : `s:${unit.scope}:${name}`;
    if (scoped && (ctx.globals.has(scoped) || ctx.aliases.has(scoped))) return scoped;
    const global = `g:${name}`;
    return ctx.globals.has(global) || ctx.aliases.has(global) ? global : null;
  };

  const visit = (node: ts.Node): void => {
    const lookup = asLookup(node as ts.Expression);
    if (lookup) {
      const resolved = resolveLookup(lookup, ctx.facts);
      if (resolved.counted) {
        if (resolved.known) {
          ctx.attributed += 1;
          for (const region of resolved.regions) unit.regions.add(region);
          unit.targets.push(lookup.value);
        } else {
          ctx.unattributed += 1;
          unit.unattributedLookups.push(lookup.value);
        }
      }
    }
    if (ts.isIdentifier(node) && !isDeclarationName(node) && !isPropertyName(node)) {
      const key = resolveBinding(node.text);
      if (key) {
        const global = ctx.globals.get(key);
        if (global) global.usedBy.add(unitIndex);
        const alias = ctx.aliases.get(key);
        if (alias?.region) unit.regions.add(alias.region);
      }
    }
    ts.forEachChild(node, visit);
  };

  if (unit.node) visit(unit.node);
  else ts.forEachChild(unit.sourceFile, visit);
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

function collectEdges(ctx: Ctx): CouplingEdge[] {
  const edges = new Map<string, CouplingEdge>();
  const addPairs = (regions: string[], kind: CouplingEdge['kind'], evidence: string, file: string, line: number): void => {
    const sorted = [...new Set(regions)].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const from = sorted[i];
        const to = sorted[j];
        if (from === undefined || to === undefined) continue;
        const edge: CouplingEdge = { from, to, kind, evidence, file, line };
        edges.set(JSON.stringify(edge), edge);
      }
    }
  };

  for (const global of ctx.globals.values()) {
    if (!global.couplable) continue;
    const userRegions = [...global.usedBy].flatMap((u) => [...(ctx.units[u]?.regions ?? [])]);
    if (global.isFunction) {
      // A function couples only when its own body touches a region — pure
      // helpers are duplicated into each part instead.
      const ownRegions = global.ownUnit !== null ? [...(ctx.units[global.ownUnit]?.regions ?? [])] : [];
      if (ownRegions.length === 0) continue;
      addPairs([...ownRegions, ...userRegions], 'shared-global', global.name, global.file, global.line);
    } else {
      addPairs(userRegions, 'shared-global', global.name, global.file, global.line);
    }
  }
  ctx.units.forEach((unit) => {
    if (unit.regions.size >= 2) {
      const evidence = [...new Set(unit.targets)].sort((a, b) => a.localeCompare(b)).join(', ');
      addPairs([...unit.regions], 'cross-region-unit', evidence, unit.file, unit.line);
    }
  });

  return [...edges.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind) ||
      a.evidence.localeCompare(b.evidence) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

function recommend(
  regions: Region[],
  edges: CouplingEdge[],
  ctx: Pick<Ctx, 'attributed' | 'unattributed'>,
): { recommendation: CouplingReport['recommendation']; reasons: string[] } {
  if (regions.length <= 1) {
    return {
      recommendation: 'single',
      reasons: [
        regions.length === 0
          ? 'No distinct widget regions detected — the page is one web part.'
          : `One widget region ('${regions[0]?.name ?? ''}') — the single-web-part path applies.`,
      ],
    };
  }
  if (edges.length > 0) {
    const summaries = [...new Set(edges.map((e) => `${e.kind} '${e.evidence}' links ${e.from} and ${e.to}`))].slice(0, 5);
    return {
      recommendation: 'spa',
      reasons: [
        `${regions.length} regions share state — splitting them would break behavior; migrate as one web part (SPA).`,
        ...summaries,
      ],
    };
  }
  const total = ctx.attributed + ctx.unattributed;
  if (total > 0 && ctx.unattributed / total > UNATTRIBUTED_TOLERANCE) {
    return {
      recommendation: 'spa',
      reasons: [
        `${ctx.unattributed} of ${total} DOM lookups could not be statically attributed to a region — ` +
          'decomposition cannot be trusted on incomplete evidence; keeping the page whole (SPA).',
      ],
    };
  }
  return {
    recommendation: 'decompose',
    reasons: [`${regions.length} independent regions with no detected shared state — safe to split into separate web parts.`],
  };
}
