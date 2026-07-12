import { z } from 'zod';
import type { CouplingReport } from '../analyze/coupling';
import { FindingSchema, RefusalSchema, type AnalysisResult } from '../types/ir';

/**
 * The plan stage is deterministic — no LLM. It reshapes the analysis into the
 * artifact the CLI shows the user for approval before any transform runs:
 * what will be migrated, what was flagged, what was refused, and whether the
 * run is blocked outright.
 */

/**
 * v3: the decompose-vs-SPA strategy block, derived from the coupling analysis.
 * Optional so every v1 single-part flow is untouched; the CLI fills it once the
 * v3 steps wire coupling into the plan stage (docs/v3).
 */
export const StrategySchema = z.object({
  parts: z.array(
    z.object({
      name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
      /** Root of the region in the original page, e.g. '#news-panel'. */
      rootSelector: z.string(),
    }),
  ),
  recommendation: z.enum(['single', 'decompose', 'spa']),
  reasons: z.array(z.string()),
  couplingEdges: z.number().int(),
});

export type Strategy = z.infer<typeof StrategySchema>;

export const MigrationPlanSchema = z.object({
  componentName: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  /** Text sources fed to the transform (entry HTML + local scripts/stylesheets). */
  sourceFiles: z.array(z.string()),
  stats: z.object({
    domOperations: z.number().int(),
    eventHandlers: z.number().int(),
    networkCalls: z.number().int(),
    dependencies: z.number().int(),
  }),
  findings: z.array(FindingSchema),
  refusals: z.array(RefusalSchema),
  /** True when refusals exist — the transform must not run on a blocked plan. */
  blocked: z.boolean(),
  strategy: StrategySchema.optional(),
});

export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

export function buildPlan(args: {
  analysis: AnalysisResult;
  name: string;
  coupling?: CouplingReport;
}): MigrationPlan {
  const { analysis, name, coupling } = args;

  const sourceFiles = [
    'index.html',
    ...analysis.ir.assets
      .filter((asset) => !asset.external && asset.exists === true)
      .filter((asset) => asset.kind === 'script' || asset.kind === 'stylesheet')
      .map((asset) => asset.path),
  ];

  const plan: MigrationPlan = {
    componentName: componentNameFrom(name),
    sourceFiles: [...new Set(sourceFiles)].sort((a, b) => a.localeCompare(b)),
    stats: {
      domOperations: analysis.ir.domOperations.length,
      eventHandlers: analysis.ir.eventHandlers.length,
      networkCalls: analysis.ir.networkCalls.length,
      dependencies: analysis.ir.dependencies.length,
    },
    findings: analysis.findings,
    refusals: analysis.refusals,
    blocked: analysis.refusals.length > 0,
    ...(coupling ? { strategy: strategyFrom(coupling) } : {}),
  };

  return MigrationPlanSchema.parse(plan);
}

/** Exported so the v3 slicer derives part names from the SAME logic (no divergence). */
export function strategyFrom(coupling: CouplingReport): Strategy {
  const used = new Set<string>();
  const parts = coupling.regions.map((region) => {
    let name = componentNameFrom(region.name);
    // Two ids can normalize to the same component name — disambiguate deterministically.
    let suffix = 2;
    while (used.has(name)) name = `${componentNameFrom(region.name)}${suffix++}`;
    used.add(name);
    return { name, rootSelector: `#${region.name}` };
  });
  return {
    parts,
    recommendation: coupling.recommendation,
    reasons: coupling.reasons,
    couplingEdges: coupling.edges.length,
  };
}

/** '001-static-hello' → 'StaticHello'; purely-numeric segments are dropped. */
export function componentNameFrom(rawName: string): string {
  const segments = rawName
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0 && !/^\d+$/.test(segment))
    .map((segment) => segment.replace(/^\d+/, ''))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return 'MigratedWebPart';
  return segments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join('');
}
