# Step 08 — Eval extension for multi-part corpus items (mechanical)

## Decisions (settled)

- `eval.json` for 006/007. Schema gains an optional `parts` map:
  `{ "parts": { "NewsPanel": { "mustContain": [...], "mustNotContain": [...] } } }` —
  same check semantics as v1, applied to that part's emitted component file. Top-level
  checks still apply to the whole emitted tree (unchanged for 001–005).
- 006 (decompose): each part's checks must include a `mustNotContain` for the OTHER
  part's distinctive strings — cross-part leakage is the failure the eval exists to
  catch. 007 (spa): plain v1-style checks over the single component (it exercises the
  spa path end-to-end).
- Scorecard: add a `parts ok` column (n/m) only if a multi-part item is present;
  keep old rows rendering identically (append-only change).
- This step also JUSTIFIES the part-scoped prompt preamble from step 06: run the eval
  before and after enabling it; the preamble ships only if 006 leakage checks pass
  with it and nothing else regresses. Record both scorecards in the commit message.

## Acceptance

- [ ] `npm run cli -- eval` over all 7 items with a scripted... no — eval is live by
      design. Offline: unit tests for the parts-check logic with canned outputs.
      Live: one eval run with the proven local model, scorecard updated in README.
- [ ] Leakage `mustNotContain` checks demonstrably work: a deliberate canned leak in a
      unit test fails the check.
- [ ] Gates green.

## Failure playbook

- **006 fails leakage with a real model** → this is the eval doing its job: the fix is
  the step 06 preamble wording (prompt), iterated via THIS eval, never post-processing
  of model output. See §6 of REASONING.md.
- **Model can't produce two parts reliably** → parts are independent calls; a failure
  is one part's repair loop, not a multi-part-specific bug. Debug it as v1.
