# v3 execution state

**Next step:** 04

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
