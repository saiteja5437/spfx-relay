import { z } from 'zod';
import { FindingSchema, RefusalSchema, type AnalysisResult } from '../types/ir';

/**
 * The plan stage is deterministic — no LLM. It reshapes the analysis into the
 * artifact the CLI shows the user for approval before any transform runs:
 * what will be migrated, what was flagged, what was refused, and whether the
 * run is blocked outright.
 */

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
});

export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

export function buildPlan(args: { analysis: AnalysisResult; name: string }): MigrationPlan {
  const { analysis, name } = args;

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
  };

  return MigrationPlanSchema.parse(plan);
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
