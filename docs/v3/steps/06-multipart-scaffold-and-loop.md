# Step 06 — Multi-part scaffold, per-part transform loop, manifest/report (mechanical, large)

Split into 06a/06b commits if needed; acceptance is joint.

## Decisions (settled)

- **One SPFx solution, N web parts.** SPFx supports this natively: one entry per part
  in `config/config.json` `bundles`, one manifest + component folder per part under
  `src/webparts/<lowercasename>/`. Do NOT emit N solutions (defeats the purpose:
  the user composes parts on one page).
- **Deterministic GUIDs per part**: extend the existing deterministic-GUID mechanism
  (see how the scaffold seeds GUIDs today in src/emit/scaffold.ts) to seed from
  `(solutionName, partName)` so adding a part never changes existing parts' GUIDs.
- **Per-part transform loop**: for each `PartContext`, in order, run the EXISTING
  verified transform (`runStructuredStep` + compile-repair) with the part's slice as
  context. One part's failure fails the run (exit 3) AFTER attempting all parts, so
  the report shows every part's outcome (matches v1's everything-reported ethic).
- **Manifest**: `run-manifest.json` steps gain a `part` field (optional string — absent
  for v1 single runs; do not break the schema for old manifests/tests).
- **Report**: per-part Transform + Verification subsections (`### NewsPanel`), plus the
  existing totals. LLM usage table gains a part column (blank for single runs).
- **Prompt**: the transform prompt needs a part-scoped variant: same frozen system
  prompt, and a user-prompt preamble stating "this is one part of a decomposed page;
  other parts handle the rest; do not reference DOM outside your fragment". That
  preamble is a PROMPT CHANGE ⇒ needs eval evidence in step 08 before it is trusted
  (build now, justify there).
- Cache keys already include the prompt, so per-part calls cache independently. Verify,
  don't assume: one offline test asserting two parts produce two distinct cache keys.

## Acceptance

- [ ] Offline end-to-end (scripted provider returning canned per-part components) over
      006: emits a solution with TWO webparts folders, both in config.json bundles,
      distinct deterministic GUIDs (assert exact values twice = determinism).
- [ ] Manifest has two transform steps tagged with part names; report shows both parts.
- [ ] A scripted failure in part 2 still reports part 1 as ok and exits 3.
- [ ] v1 single-part flow byte-identical to before (existing e2e tests untouched).
- [ ] Gates green.

## Failure playbook

- **config.json schema rejected by gulp later** → compare field-by-field against a
  `yo @microsoft/sharepoint` two-part reference (generate one manually once; do not
  vendor the generator into the tool).
- **GUID collisions or churn** → the seed string must be exactly
  `(solutionName + '/' + partName)` through the existing hash-to-GUID function; churn
  means something dynamic leaked into the seed.
- **Tempted to run parts in parallel** → no. Sequential keeps manifests, repair
  budgets, and failure ordering deterministic. Parallelism is a non-goal.
