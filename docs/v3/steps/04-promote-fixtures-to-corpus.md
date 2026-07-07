# Step 04 — Promote fixtures to corpus 006/007 with coupling ground truth (mechanical)

## Goal

The multi-part fixtures become first-class corpus citizens so determinism and coupling
behavior are asserted forever, and the eval can later exercise them (step 08).

## Decisions (settled)

- Copy `tests/fixtures/multi-part-independent` → `corpus/006-multi-independent/input`
  and `multi-part-coupled` → `corpus/007-multi-coupled/input`. COPY, don't move — the
  unit tests keep their local fixtures (unit tests must not reach into corpus items
  that step 08 will wire into the eval; 001 usage in coupling.test.ts predates this
  rule and may remain).
- Each gets `expected.json` (EXACT `analyzeWebPart` output — hand-compute it: assets,
  domOperations, eventHandlers per the v1 analyzer; note `$()` lookups and
  `.click()` handlers land in different arrays) and a NEW `coupling.json` (EXACT
  `analyzeCouplingDir` output).
- Extend the corpus test to assert `coupling.json` equality + repeat-run determinism
  whenever the file exists. Items 001–005 get NO coupling.json (their ground truth
  lives implicitly in `recommendation: single`; adding five files of noise helps
  nobody) — the corpus test must therefore treat coupling.json as optional.
- `eval.json` is NOT added yet — the eval runner can't do per-part checks until
  step 08. An eval-less corpus item must be skipped cleanly by the current eval
  runner; verify it is, or gate 006/007 out of eval explicitly with a clear message.

## Hand-computation discipline

Write expected.json by reading the fixture sources line by line, not by running the
analyzer and pasting. THEN run the corpus test: agreement is the check. If they
disagree, hand-trace again before suspecting the analyzer; if the analyzer is wrong,
that is a v1 bug — fix it in its own commit first (this exact flow caught a real
analyzer bug during v1).

## Acceptance

- [ ] Corpus test green over 7 items, including coupling.json equality for 006/007
      and repeat-run determinism.
- [ ] `npm run cli -- eval` still runs green over the corpus (006/007 skipped or
      handled without error).
- [ ] Gates green.

## Failure playbook

- **analyzer output ≠ your expected.json** → §4 of REASONING.md. Most likely YOUR
  hand-compute missed: jQuery `.click()` is an eventHandler (via 'jquery'), while the
  `$('#x')` factory that receives it is NOT a separate domOperation when chained
  (see `isChainedReceiver` in src/analyze/script.ts) — but a bare `$('#x')` IS.
- **eval crashes on an item without eval.json** → fix the runner to skip with a
  message; do not fabricate an eval.json with empty checks.
