# v3 blueprint — multi-web-part decomposition + SPA strategy

This directory is an execution contract, written by a stronger model for whichever
model continues the work. The architecture and every contested decision are already
settled here. Your job is faithful execution, not redesign.

## How to work this blueprint (read before every session)

1. Read `INVARIANTS.md` fully. It is short. It overrides anything you are tempted to do.
2. Open `STATE.md` — it names the next step. Load ONLY that step file plus INVARIANTS.
   Do not load all steps at once; do not work ahead.
3. Execute the step exactly. Its **Acceptance** list is the definition of done —
   every item, not most.
4. Run the gates: `npm run typecheck && npm test && npm run lint`. All green, no exceptions.
5. Update `STATE.md` (next step + one log line), commit with a detailed message.
6. If reality contradicts the step (an API changed, an assumption is false, a test
   can't be written as described): **STOP. Do not adapt silently.** Write the mismatch
   into STATE.md under "Blocked", report it to the user, and wait. This is the project's
   refusal-over-guessing principle applied to development itself.

## Step index

| Step | Title | Tier |
|---|---|---|
| 01 | Wire coupling analysis into the CLI plan stage | mechanical |
| 02 | `--strategy` override flag with safe-direction rule | mechanical |
| 03 | SPA path + Strategy section in the report | mechanical |
| 04 | Promote fixtures to corpus 006/007 with coupling ground truth | mechanical |
| 05 | Decompose context slicing (`slicePartContexts`) | **judgment** |
| 06 | Multi-part scaffold, per-part transform loop, manifest/report | mechanical (large) |
| 07 | Verification and bundle seal for N parts | mechanical |
| 08 | Eval extension for multi-part corpus items | mechanical |
| 09 | Docs, scorecard rerun, README v3 section | mechanical |

**Tier meaning:** `mechanical` — Sonnet-class is fine; the step is fully specified.
`judgment` — use the strongest model available; read the step's Design notes twice;
when in doubt prefer the narrower interpretation and flag the doubt in STATE.md.

## What already exists (do not rebuild)

Built and tested by the authoring model — treat as settled infrastructure:

- `src/analyze/coupling.ts` — region detection, unit splitting with ready-shell
  unwrapping, lookup attribution, shared-global/cross-region-unit edges, and the
  deterministic `single | decompose | spa` recommendation. Its header comment is the
  design document; the nuances there (why const primitives are inert, why pure helper
  functions don't couple, why unattributed lookups force SPA) are decisions, not bugs.
- `StrategySchema` + optional `strategy` on `MigrationPlanSchema`
  (`src/pipeline/plan.ts`), filled by `buildPlan` when a coupling report is passed.
- `tests/fixtures/multi-part-independent/` and `multi-part-coupled/` with
  hand-computed ground truth in `tests/analyze/coupling.test.ts` (7 tests).

## v4

`V4.md` — deliberately short; the provider pattern is self-documenting.

## When something fails

Each step has a **Failure playbook**. For anything not covered there, use
`REASONING.md` — the general diagnostic method. Never delete or weaken a failing
assertion to get green; the assertion is the ground truth, your change is the suspect.
