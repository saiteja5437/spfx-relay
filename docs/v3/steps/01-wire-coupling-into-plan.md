# Step 01 — Wire coupling analysis into the CLI plan stage (mechanical)

## Goal

Every `migrate` run computes the coupling report and shows the strategy in the plan
the user approves. No behavior change beyond display: transform still follows the v1
single-component path regardless of recommendation (steps 03+ act on it).

## Decisions (settled)

- Coupling runs unconditionally (it is cheap, pure AST). No flag gates it.
- `analyzeCouplingDir(inputDir)` is called in the CLI next to `analyzeWebPart`, and its
  report is passed to `buildPlan({ analysis, name, coupling })`. The plan's optional
  `strategy` block is now always present for CLI runs.
- Plan display (the block starting `Migration plan —` in src/cli.ts) gains, after the
  stats lines: a `Strategy:` line with the recommendation, one indented line per part
  (`name  ←  rootSelector`), and each reason on its own indented line. Keep the existing
  alignment style of the block.
- The eval runner also passes coupling (same call site pattern) — scorecard output is
  unchanged in shape.

## Changes

1. `src/cli.ts`: import `analyzeCouplingDir`; compute after `analyzeWebPart`; pass to
   `buildPlan`; extend the plan print.
2. No changes to `src/analyze/coupling.ts` or `plan.ts` (already built).

## Acceptance

- [ ] `npm run cli -- migrate corpus/001-static-hello/input --out <tmp> --yes --skip-bundle`
      (any provider with cache hit) prints `Strategy: single` with its reason.
- [ ] A new offline test asserts the CLI plan-rendering function (extract it if it is
      inline) includes parts + recommendation for `tests/fixtures/multi-part-independent`.
- [ ] All existing tests untouched and green; corpus expected.json files unchanged
      (coupling is NOT part of AnalysisResult — do not add it there).
- [ ] Gates green.

## Failure playbook

- **Corpus determinism test fails** → you added coupling data into `AnalysisResult` or
  changed IR sorting. Revert that; coupling stays a separate report by design (it keeps
  the v1 ground-truth corpus byte-stable).
- **`strategy` fails schema parse for a single-region page** → check `componentNameFrom`
  produced an empty/invalid name from an unusual id (e.g. all digits). The regex demands
  `^[A-Z][A-Za-z0-9]*$`; `componentNameFrom` already falls back to `MigratedWebPart` —
  route region names through it and keep the fallback.
- **Plan print misaligns** → cosmetic only; match the existing two-space label column,
  do not refactor the block.
