import { z } from 'zod';

/**
 * The intermediate representation (IR) is the contract between pipeline stages.
 * The analyzer (pure AST code, no LLM) produces it; the planner and transformer
 * consume it. Every LLM call downstream receives slices of this structure —
 * never raw, unbounded source dumps.
 *
 * All `file` fields are forward-slash relative paths within the input folder,
 * so results are byte-identical across operating systems.
 */

export const AssetSchema = z.object({
  kind: z.enum(['stylesheet', 'script', 'image', 'other']),
  /** The reference as written in the source (href/src value). */
  path: z.string(),
  /** File containing the reference. */
  file: z.string(),
  line: z.number().int(),
  /** True for http(s):// and protocol-relative (//) URLs. */
  external: z.boolean(),
  /** Whether the referenced local file exists; null for external URLs (not checked). */
  exists: z.boolean().nullable(),
});

export const DomOperationSchema = z.object({
  api: z.enum(['jquery', 'dom']),
  /** e.g. 'getElementById', 'append', 'html', or '$' for a bare jQuery lookup. */
  method: z.string(),
  /** Selector/id/element when statically known, else null. */
  target: z.string().nullable(),
  file: z.string(),
  line: z.number().int(),
});

export const EventHandlerSchema = z.object({
  via: z.enum(['jquery', 'addEventListener', 'html-attribute']),
  event: z.string(),
  target: z.string().nullable(),
  file: z.string(),
  line: z.number().int(),
});

export const NetworkCallSchema = z.object({
  api: z.enum(['fetch', 'xhr', 'jquery-ajax']),
  /** Statically-known URL, else null. */
  url: z.string().nullable(),
  file: z.string(),
  line: z.number().int(),
});

export const DependencySchema = z.object({
  /** Library name from the registry, or 'unknown' for unrecognized external scripts. */
  name: z.string(),
  /** The URL (or other origin) the dependency was detected from. */
  source: z.string(),
  file: z.string(),
  line: z.number().int(),
  /** False means the pipeline must refuse this input rather than guess. */
  supported: z.boolean(),
});

export const IrSchema = z.object({
  assets: z.array(AssetSchema),
  domOperations: z.array(DomOperationSchema),
  eventHandlers: z.array(EventHandlerSchema),
  networkCalls: z.array(NetworkCallSchema),
  dependencies: z.array(DependencySchema),
});

/** A bad practice detected in the legacy source — reported, and fed to the planner. */
export const FindingSchema = z.object({
  rule: z.enum(['hardcoded-secret', 'broken-asset-reference']),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  file: z.string(),
  line: z.number().int(),
});

/**
 * A construct outside the supported v1 profile. Refusals stop the transform for
 * the affected unit and appear in the report — the tool never guesses through them.
 */
export const RefusalSchema = z.object({
  construct: z.enum(['external-plugin', 'unknown-external-script', 'vendored-plugin']),
  reason: z.string(),
  file: z.string(),
  line: z.number().int(),
});

export const AnalysisResultSchema = z.object({
  ir: IrSchema,
  findings: z.array(FindingSchema),
  refusals: z.array(RefusalSchema),
});

export type Asset = z.infer<typeof AssetSchema>;
export type DomOperation = z.infer<typeof DomOperationSchema>;
export type EventHandler = z.infer<typeof EventHandlerSchema>;
export type NetworkCall = z.infer<typeof NetworkCallSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type Ir = z.infer<typeof IrSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Refusal = z.infer<typeof RefusalSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
