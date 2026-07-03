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
- [x] **Milestone 3** — pipeline core: response cache (bit-identical reruns), sealed step runner with bounded repair loop, run manifest, deterministic plan stage, transform stage with byte-stable context packets
- [x] **Milestone 4** — verify gates (strict tsc + ESLint driving a compile-repair loop), SPFx scaffold emit with deterministic GUIDs, best-effort `gulp bundle` seal, markdown migration report, and the `spfx-relay migrate` CLI with plan approval
- [x] **Milestone 5** — eval harness: 5-item corpus across difficulty tiers, per-model scorecard (compile rate, repair attempts, refusal correctness, content checks, tokens, latency) via `spfx-relay eval`

## Usage

```sh
# Migrate a legacy web part (prints the plan, waits for approval; --yes to skip)
npm run cli -- migrate ./legacy-folder --out ./webpart --provider ollama --model gemma4:31b-cloud

# Score a model against the corpus
npm run cli -- eval --provider ollama --model gemma4:31b-cloud
```

Providers: `anthropic` (set `ANTHROPIC_API_KEY`) or `ollama` (local — nothing leaves the
machine with a local model; note that Ollama `:cloud` models are hosted and do send the
prompt off-machine, so use a truly local model for sensitive code).

## Development

```sh
npm install
npm test        # runs unit tests + the corpus conformance suite (offline, no keys)
npm run typecheck
npm run lint
```

The eval corpus lives in `corpus/` — each item is an `input/` folder (a synthetic legacy
web part), an `expected.json` ground-truth file the analyzer must match exactly, and an
optional `eval.json` with content checks for the generated component. Determinism is
asserted, not hoped for; `spfx-relay eval` scores models against the same corpus.

## License

MIT
