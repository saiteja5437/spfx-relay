# spfx-relay

Migrates legacy SharePoint customizations — the classic Script Editor web part shape of
HTML + CSS + JS/jQuery — into **compiling, linted, convention-correct SPFx React web parts**,
plus a migration report a developer reviews.

Modern SharePoint pages don't support Script Editor web parts. Organizations hold hundreds of
these legacy customizations, and today the only migration path is a manual rewrite. This tool
automates the mechanical majority of that rewrite while being honest about the rest.

## Thesis

**The value is the harness, not the model.** An LLM performs the one step that genuinely
requires judgment (imperative jQuery → declarative React). Everything around it is
deterministic engineering:

```
analyze ──▶ plan ──▶ transform ──▶ verify ──▶ report
 (AST,      (user     (LLM, sealed   (tsc, ESLint,  (what changed,
 no LLM)   approves)  JSON steps)    gulp bundle)   what was flagged,
                                                    what was refused)
```

- Every LLM call is a **sealed step**: schema-validated JSON in/out, bounded repair loop
  (max 3 attempts), then a loud failure — never a silent guess.
- **Hard verification gates**: the output must type-check, lint, and bundle. "It builds"
  is a binary fact, not a claim.
- **Honest refusal is a feature**: constructs outside the supported profile (external
  plugins, multi-page apps) are detected deterministically and reported for manual
  migration — not hallucinated through.
- **Reproducible runs**: LLM responses are cached by (model, prompt-hash); re-running an
  unchanged input replays the cache bit-for-bit.

## V1 scope

| In | Out (detected and refused) |
|---|---|
| Self-contained HTML + CSS + vanilla JS/jQuery | jQuery plugin ecosystems (ag-Grid, DevExtreme, DataTables, …) |
| Single web part per run | Multi-page apps |
| Flagging bad practices (hardcoded secrets, client-side auth, broken asset refs) | Behavioral-equivalence guarantees |
| Anthropic Claude + Ollama providers | Other frameworks / other providers (v2+) |

## Status

- [x] **Milestone 1** — project skeleton, IR contracts, deterministic analyzer, seeded corpus + eval test
- [x] **Milestone 2** — `ModelProvider` interface + hand-rolled Anthropic (SSE) and Ollama (NDJSON) adapters over raw HTTP, with local Zod validation and typed errors
- [ ] Milestone 3 — plan + transform stages (sealed LLM steps, repair loop)
- [ ] Milestone 4 — verify stage (tsc/ESLint gates, final `gulp bundle` seal) + report
- [ ] Milestone 5 — eval harness metrics (compile rate, flag precision/recall, refusal correctness, cost/latency per model)

## Development

```sh
npm install
npm test        # runs unit tests + the corpus eval
npm run typecheck
npm run lint
```

The eval corpus lives in `corpus/` — each item is an `input/` folder (a synthetic legacy
web part) plus an `expected.json` ground-truth file. The analyzer's output must match
exactly; determinism is asserted, not hoped for.

## License

MIT
