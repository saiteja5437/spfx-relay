# v3 execution state

**Next step:** 08

**Blocked:** (nothing)

## Log

- 2026-07-07 — Blueprint authored (Fable). Coupling core, StrategySchema, fixtures,
  and 7 ground-truth tests implemented and green. Steps 01–09 pending.
- 2026-07-12 — Step 01 done: coupling wired into CLI + eval plan stage, `renderPlan`
  extracted with Strategy section, 2 new offline tests (118 green). Live run on
  corpus 001 (cached gemma4:31b-cloud) prints `Strategy: single` with reason.
- 2026-07-12 — Step 02 done: `--strategy <spa|decompose>` with safe-direction rule in
  exported `resolveStrategy` (edges→refusal exit 2 + report; tolerance-only→allowed
  with warning; ignored on single). `chosen` lives on the runtime decision object,
  not the plan. 7 new offline tests (125 green).
- 2026-07-12 — Step 03 done: `## Strategy` report section (conditional on plan.strategy;
  Chosen line only when it differs), spa runs the v1 single-component pipeline untouched
  (e2e scripted test over multi-part-coupled: ONE component). Eval rerun: scorecard
  numbers identical (4/4, 5/5, 12/12, avg 1 attempt). 127 tests green.
- 2026-07-12 — Step 04 done: corpus 006-multi-independent / 007-multi-coupled with
  hand-computed expected.json + coupling.json (matched the analyzer first run);
  corpus test asserts coupling.json when present; eval skips migratable items
  without eval.json (message points at step 08). 136 tests green; scorecard identical.
- 2026-07-12 — Step 05 done (judgment): `slicePartContexts` in src/pipeline/slice.ts,
  sharing coupling.ts machinery via new exported `analyzeCouplingInternals` (zero
  behavior change — corpus determinism tests stayed green). Judgment calls flagged:
  (a) PartContext gained `assumptions: string[]` beyond the blueprint contract — the
  step requires duplication/unattributed facts to reach the report and the contract
  had no carrier field; (b) a region-less unit whose couplable globals home in TWO
  parts throws SliceRefusalError (refusal-over-guessing; case absent from blueprint);
  (c) inline HTML handlers travel with the region HTML slice, not the script slice.
  6 new tests incl. leakage-both-directions, fixpoint preamble, override path. 142 green.
- 2026-07-12 — Step 06 done: renderMultiPartScaffold (one solution, N parts, GUID seed
  exactly `${solutionName}/${partName}`), emitMultiPartProject, sequential
  runMultiPartTransform (fails AFTER attempting all parts), manifest steps gain
  optional `part`, report per-part sections. Interpretations flagged: (a) part-scoped
  prompt omits the whole-page IR (the slice IS the context; page-wide IR describes DOM
  the part must not touch) — eval-justified in step 08; (b) usage-table Part column is
  conditional on part-tagged steps, resolving the step's byte-identical-vs-blank-column
  contradiction in favor of byte-identity; (c) a failed multi-part run emits no project
  files (v1 nothing-unverified ethic). 145 tests green.
- 2026-07-12 — Step 07 done (code) + live seal attempted. Interpretation flagged: the
  combined tsc program covers all PART components in an emit-shaped scratch dir (the
  literal "whole emitted project" cannot compile offline — SPFx types only exist after
  the seal's npm install, the same staging reason as v1); routing/budgets exactly as
  specified. LIVE RESULT (Node 22.14, gemma4:31b-cloud, live parts transform 1 attempt
  each): dist/ DID contain both web-part bundles (config/manifests correct), but the
  seal FAILED — both generated components imported './styles.css' which does not exist
  (006 has no stylesheet; tsc's `declare module '*.css'` cannot catch a nonexistent
  css path, webpack can). This is a prompt-content failure in the NEW part-scoped
  prompt → the fix is step 08's eval-driven preamble iteration (mustNotContain checks
  + preamble wording), NOT post-processing. Seal to be re-run after 08.
  Also: live006 first attempted in the session scratchpad — SPFx node_modules exceeds
  Windows MAX_PATH there; emitted solutions for live seals need a SHORT path.
