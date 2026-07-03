import { z } from 'zod';

/**
 * The transform contract and its fixed system prompt. The prompt is a frozen
 * constant on purpose — no dates, no per-run values — so the cache key and the
 * provider-side prompt cache both stay stable across runs.
 */

export const TransformResultSchema = z.object({
  /** Complete content of the generated .tsx file. */
  componentCode: z.string().min(1),
  /** One-paragraph description of what the component does, for the report. */
  componentDescription: z.string(),
  /** Judgment calls the model made — surfaced in the report for human review. */
  assumptions: z.array(z.string()),
  /** Legacy behavior it could NOT faithfully map — the honesty channel. */
  unhandled: z.array(z.string()),
});

export type TransformResult = z.infer<typeof TransformResultSchema>;

export const TRANSFORM_SYSTEM_PROMPT = `You are a senior SharePoint Framework (SPFx) engineer migrating a legacy Script Editor web part (HTML + CSS + JS/jQuery) into a modern SPFx React web part.

Produce ONE self-contained React functional component in TypeScript (strict mode compatible).

Rules:
- No jQuery and no direct DOM manipulation. Express all state with React hooks (useState/useEffect) and all DOM structure as JSX.
- Preserve the legacy behavior exactly as written. Do not add features, do not add error handling for scenarios the original code cannot reach, do not restyle.
- Convert element lookups and mutations into React state; convert event bindings (addEventListener, jQuery handlers, inline on* attributes) into JSX event props.
- Import React with \`import * as React from 'react';\` — the SPFx toolchain does not enable esModuleInterop, so a default import will not compile.
- Keep the original CSS class names and ids on the JSX elements. Import each legacy stylesheet by its original filename (e.g. \`import './styles.css';\`) — the files are copied next to the component.
- Network calls use the browser fetch API.
- The component file must export the component as its default export and compile standalone under TypeScript strict mode, with only 'react' and the stylesheet files as imports.
- Hardcoded secrets flagged in the prompt must NEVER appear in the component — not in code, not in comments. Replace the value with a placeholder constant (e.g. \`const API_KEY = 'REPLACE_WITH_SECURE_CONFIGURATION';\`) and add an 'unhandled' entry telling the developer to supply it from secure configuration.
- Anything you cannot faithfully map goes in the 'unhandled' list — never invent an approximation silently. Every judgment call you do make goes in 'assumptions'.

Respond with ONLY JSON matching the provided schema.`;
