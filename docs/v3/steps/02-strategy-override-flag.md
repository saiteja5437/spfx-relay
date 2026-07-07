# Step 02 — `--strategy` override with the safe-direction rule (mechanical)

## Goal

The user can override the recommendation at plan time — but only in the safe
direction. This is the v3 analogue of plan approval: the tool recommends, the human
decides, the tool refuses to be forced into a guess.

## Decisions (settled)

- New CLI flag `--strategy <spa|decompose>` (also accepted by eval? No — eval always
  follows the recommendation; keep eval deterministic).
- **Safe-direction rule:** overriding decompose→spa is ALWAYS allowed (merging cannot
  break behavior). Overriding spa→decompose is REFUSED when coupling edges exist
  (splitting shared state breaks pages) — exit code 2 (blocked) with a message listing
  the edges. When the spa recommendation came only from unattributed-lookup tolerance
  (edges == 0), the override IS allowed — the user may know the page better than static
  analysis; print a loud warning naming the unattributed count.
- `--strategy` on a single-region page: ignored with a printed note (not an error).
- The chosen strategy (not just the recommendation) is what steps 03/05/06 execute; add
  `chosen: 'single' | 'decompose' | 'spa'` — decide its home: put it on the CLI's run
  options object, NOT in `StrategySchema` (the plan records the analysis; the choice is
  runtime input. Keeping them separate preserves plan determinism for caching).

## Acceptance

- [ ] Offline CLI-arg tests: default = recommendation; decompose→spa allowed;
      spa(edges)→decompose exits 2 and prints edge evidence; spa(tolerance-only)→
      decompose allowed with warning; flag ignored on single.
- [ ] Exit code 2 path produces a report file (every outcome writes a report — v1 rule).
- [ ] Gates green.

## Failure playbook

- **Tempted to allow spa→decompose with edges "because the user insisted"** → no. The
  refusal IS the feature. If a real page needs it, that page belongs in the corpus and
  the coupling analyzer (or a future edge-severity model) is what should change —
  with evidence.
- **Unclear where `chosen` should thread through** → follow how `--yes` flows today
  (parseCliArgs → options → runMigrate); mirror that path exactly.
