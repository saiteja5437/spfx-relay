# v3 execution state

**Next step:** 03

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
