# Step 05 — Decompose context slicing (JUDGMENT — strongest model available)

## Goal

`slicePartContexts(input, couplingReport)`: for each part, the exact source slice its
transform will see. This is the correctness heart of decomposition — a wrong slice
produces a component that compiles beautifully and behaves wrongly.

## Design (settled — read twice)

New module `src/pipeline/slice.ts`, pure and deterministic, no LLM. Per part:

- **HTML**: the region root element's outer HTML, serialized from the parse5 tree
  (`parse5.serializeOuter` on the region node), NOT regex extraction. Plus a minimal
  wrapper note is unnecessary — the transform prompt already receives fragments.
- **Scripts**: the units (top-level statements after ready-shell unwrapping — reuse the
  machinery in `src/analyze/coupling.ts`; EXPORT its internals rather than duplicating:
  refactor `unwrapReadyShells`/unit walking into shared functions in that file) whose
  attributed regions are exactly `{thisPart}`. Unit text via `stmt.getText(sourceFile)`,
  joined with blank lines, in original source order, preceded by the duplicable
  preamble (below). Region-less units (touch no region, use no couplable global —
  e.g. pure top-level statements) are DUPLICATED into every part: they are
  initialization the original page ran once per load; each part's runtime instance
  re-running them is the decomposition semantic. Record this in the report assumptions.
- **Duplicable preamble** (per part, in source order): const-primitive globals (inert
  config) and pure helper functions (own body touches no region) that the part's units
  reference — transitively (helper calling helper: compute a one-level-deep closure,
  then iterate to fixpoint; the corpus fixtures need depth 1, write the fixpoint anyway,
  it is 5 lines).
- **CSS**: whole stylesheet(s) go to every part unchanged. Splitting CSS statically is
  guess-prone (cascade, shared classes); duplication is safe and honest. Report notes it.
- **Precondition (assert, don't handle)**: `couplingReport.recommendation === 'decompose'`
  or (spa-by-tolerance overridden per step 02 — in which case unattributed units exist:
  they go to EVERY part with a loud report assumption naming each one; this is the
  documented cost of the user's override).
- Determinism: parts in region document order; units in source order; the same slice
  twice must be deep-equal (add the test).

## Output contract

```ts
export interface PartContext {
  name: string;            // from plan.strategy.parts
  rootSelector: string;
  html: string;            // region outer HTML, LF-normalized
  scripts: Array<{ file: string; content: string }>; // sliced text per source file
  stylesheets: string[];   // original stylesheet paths (shared)
  duplicatedGlobals: string[]; // names, for the report
}
```

## Acceptance

- [ ] `slicePartContexts` over `multi-part-independent`: NewsPanel slice contains
      `#news-refresh` handler text and `newsItems`, and does NOT contain `ticker` in
      any form; StockTicker slice symmetric (assert both directions — leakage is the
      failure mode that matters).
- [ ] Ready-shell fixture (ticker.js): sliced unit text is the INNER statements, no
      `$(document).ready` shell.
- [ ] Determinism test (two runs deep-equal).
- [ ] A coupled fixture run asserts `slicePartContexts` THROWS (precondition).
- [ ] Gates green.

## Failure playbook

- **A unit appears in no part** (attributed to a region that isn't a part) →
  impossible if parts come from the same coupling report; if it happens, the two were
  computed from different inputs — fix the call site, not the slicer.
- **Unit text loses comments/formatting** → acceptable; `getText` keeps the original
  statement text including inner comments. Do not try to preserve leading comments
  between units (trivia handling is a rabbit hole; note it as a known nuance).
- **Cross-part leakage in the test** → your attribution reuse diverged from
  coupling.ts. The two MUST share code; if you copied instead of refactoring, refactor
  now — divergence here is silent wrong-behavior later.
