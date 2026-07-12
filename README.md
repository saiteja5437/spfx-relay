# spfx-relay

Migrates legacy SharePoint customizations — the classic **Script Editor web part** shape of
HTML + CSS + JS/jQuery — into **compiling, linted, convention-correct SPFx React web parts**,
plus a migration report a developer reviews.

## Why

Modern SharePoint pages don't support Script Editor web parts. Organizations hold hundreds of
these legacy customizations, and the only official migration path is a manual rewrite. This
tool automates the mechanical majority of that rewrite while being honest about the rest.

## Thesis: the value is the harness, not the model

An LLM performs the one step that genuinely requires judgment (imperative jQuery →
declarative React). Everything around it is deterministic engineering:

```
analyze ──▶ plan ──▶ transform ──▶ verify ──▶ emit ──▶ report
 (AST,      (user     (LLM, sealed   (strict tsc,   (SPFx        (what changed,
 no LLM)   approves)  JSON steps)    ESLint, gulp    scaffold)    what was flagged,
                                     bundle seal)                 what was refused)
```

- **Sealed LLM steps** — every model call has a Zod-validated JSON contract and a bounded
  repair loop (validation errors and compiler diagnostics are fed back, max 2–3 attempts),
  then a loud typed failure. Never a silent guess.
- **Hard verification gates** — generated code must pass strict TypeScript and ESLint before
  it is emitted; a final `npm install && gulp bundle` seals the run. "It builds" is a binary
  fact, not a claim.
- **Honest refusal is a feature** — constructs outside the supported profile (jQuery plugins,
  unknown external scripts) are detected deterministically and reported for manual migration,
  never hallucinated through. A blocked plan cannot reach the model.
- **Reproducible runs** — LLM responses are cached by SHA-256 of (provider, model, prompts,
  schema); re-running an unchanged input replays bit-for-bit. Prompts are byte-stable across
  operating systems. Every run writes an audit manifest of each model call.
- **Measured, not vibes** — a seeded eval corpus scores any model on compile rate, repair
  attempts, refusal correctness, and content checks (see Scorecard).

## Usage

Requires Node ≥ 20 and either an Anthropic API key or [Ollama](https://ollama.com).

```sh
npm install

# Migrate a legacy web part (prints the plan, waits for approval; --yes to skip)
npm run cli -- migrate ./legacy-folder --out ./webpart --provider ollama --model gemma4:31b-cloud

# With Anthropic (set ANTHROPIC_API_KEY first)
npm run cli -- migrate ./legacy-folder --out ./webpart --provider anthropic

# Score a model against the eval corpus
npm run cli -- eval --provider ollama --model gemma4:31b-cloud
```

The input folder must contain the web part's entry `index.html` plus the local scripts,
stylesheets, and images it references.

### Options (`migrate`)

| Flag | Effect |
|---|---|
| `--provider anthropic\|ollama` | Model provider (default `anthropic`) |
| `--model <id>` | Model override (defaults: `claude-opus-4-8` / `llama3.1`) |
| `--name <PascalCase>` | Component name override (otherwise derived from the folder) |
| `--strategy spa\|decompose` | Override the v3 strategy recommendation (safe direction only — see below) |
| `--yes` | Skip the plan-approval prompt |
| `--no-cache` | Bypass the response cache |
| `--skip-bundle` | Skip the final `npm install && gulp bundle` seal |
| `--force` | Write into a non-empty output folder |

Exit codes: `0` migrated · `2` blocked by refusals · `3` failed verification · `4` bundle
seal failed. Every run — including blocked and failed ones — writes `migration-report.md`
and `run-manifest.json` into the output folder.

### Privacy: local vs hosted models

With a **truly local** Ollama model, nothing leaves your machine — use that for sensitive
code, accepting slower runs and more repair rounds from small models. Note that Ollama
`:cloud` models and Anthropic are **hosted**: the legacy source code is sent to the provider.
The tool itself sends nothing anywhere else; cache and manifests stay on disk.

## Scorecard

`spfx-relay eval` over the 7-item corpus (via `eval-results/`):

| Model | Compile rate | Refusal correctness | Content checks | Parts ok | Avg gate attempts | Tokens (in/out) | Time |
|---|---|---|---|---|---|---|---|
| ollama/gemma4:31b-cloud | 6/6 | 7/7 | 24/24 | 2/2 | 1.0 | 10.0K/2.5K | 22s |

The first eval run against this model scored 11/12: it reproduced a planted hardcoded secret
in the generated component. One prompt rule later, 12/12 — that eval-driven loop is the
point of the harness. v3 repeated the pattern: the first multi-part run imported a stylesheet
that doesn't exist (compiled clean, failed webpack); the eval's per-part checks caught it,
one preamble rule later 006 scored 8/8 with zero cross-part leakage, and the emitted
two-web-part solution seals for real.

## v3: multi-web-part decomposition

Legacy pages often compose several widgets as sibling `<div id=…>` blocks. v3 decides —
deterministically, from AST evidence, before any model call — whether such a page should
become several web parts or stay whole:

- **Coupling analysis** (pure AST, runs on every plan): candidate regions are body-direct
  containers with ids; scripts are split into top-level units after unwrapping
  `$(document).ready`-style shells; every statically-resolvable DOM lookup is attributed to
  a region. Two signals couple regions: a **shared mutable global** used across regions, and
  a **single unit touching two regions**. `const` primitives and pure helper functions don't
  couple — they are duplicable.
- **Strategy** = `single` (≤1 region) · `decompose` (independent regions) · `spa` (coupled,
  or too many unattributable lookups — refusal-over-guessing: never split on evidence the
  analyzer doesn't have). The plan and the report show the strategy, the parts, and the
  coupling evidence; the human approves it like everything else.
- **Safe-direction override** (`--strategy`): merging (`→ spa`) is always allowed — it cannot
  break behavior. Splitting (`→ decompose`) against detected coupling edges is **refused**
  (exit 2, edges listed); it is allowed only when spa came from unattributed-lookup tolerance
  alone, with a loud warning.
- **Decompose runs** slice each part's exact context (region HTML via parse5, its attributed
  script units, shared CSS duplicated honestly, transitively-referenced helpers), transform
  parts sequentially through the same sealed steps, verify them in one shared tsc program
  with diagnostics routed per part, and emit **one SPFx solution with N web parts**
  (deterministic per-part GUIDs, one bundle entry each). The seal additionally asserts
  `dist/` holds one bundle per part. `spa` runs the proven v1 whole-page pipeline — one
  component owning the page.

## V1 scope

| In | Out (detected and refused) |
|---|---|
| Self-contained HTML + CSS + vanilla JS/jQuery | jQuery plugin ecosystems (ag-Grid, DevExtreme, DataTables, …) |
| Single web part per run (v3 adds multi-widget decomposition) | Multi-page apps |
| Flagging bad practices (hardcoded secrets, broken asset refs) | Behavioral-equivalence guarantees |
| Anthropic Claude + Ollama providers | Other frameworks / providers (roadmap) |

## Known limitations

Stated honestly, because the tool's credibility depends on it:

- **No behavioral-equivalence guarantee.** The output compiles, lints, and preserves the
  visible surface (asserted by eval content checks) — a developer still reviews the report's
  `assumptions` and `unhandled` sections before shipping. That review is part of the design.
- **The bundle seal requires Node 22.** The emitted scaffold pins SPFx 1.21.1, whose build
  toolchain hard-rejects other Node majors (`>=22.14.0 <23.0.0`). The seal is live-proven:
  a real `npm install` + `gulp bundle` passes against the emitted project, and the plain
  `./style.css` import works as-is in the SPFx webpack pipeline. On an unsupported Node the
  seal fails with the toolchain's own version error, quoted in full in the report.
- **Analyzer blind spots (documented in code):** property-style DOM mutations
  (`el.textContent = …`) are not recorded in the IR (the transform still sees the full
  source); the secret rule matches common patterns (named variables, known key prefixes),
  it is not a full secret scanner.
- **Small local models struggle.** 7B-class models are slow on consumer hardware and fail
  schema/compile gates more often. The gates make that safe (loud failure, never bad output)
  but not fast — prefer hosted models or larger code-tuned local models, and check the
  scorecard for the model you plan to use.
- **Coupling analysis approximations (v3, documented in code):** identifier shadowing inside
  handlers is ignored; ready-shell unwrapping goes one level deep (a nested
  `$(document).ready` stays one unit); property writes (`el.innerHTML = …`) attribute via
  the lookup that produced the element, inheriting v1's property-write blind spot. All of
  them err toward *more* coupling — i.e. toward the safe spa recommendation, never toward
  a risky split.
- **The plan-approval prompt is interactive** — use `--yes` in CI/scripts.
- Developed on Windows; prompts and outputs are line-ending-normalized for cross-platform
  determinism, but there is no CI pipeline yet.

## Development

```sh
npm test            # 100+ offline tests incl. corpus conformance — no network, no keys
npm run typecheck
npm run lint
```

- `src/analyze/` — deterministic analyzer (parse5 + TS compiler API): IR, findings, refusals
- `src/providers/` — `ModelProvider` interface + raw-HTTP Anthropic (SSE) and Ollama (NDJSON)
  adapters; the pipeline imports only the interface
- `src/pipeline/` — cache, manifest, sealed step runner, plan, context packets, transform,
  compile-repair loop
- `src/verify/` — strict tsc gate, ESLint gate, bundle seal
- `src/emit/` — pinned SPFx scaffold templates + deterministic rendering (stable GUIDs)
- `src/eval/` — the eval runner and scorecard renderer
- `corpus/` — seeded eval items: `input/` + exact `expected.json` ground truth + optional
  `eval.json` content checks

See `CLAUDE.md` for the design decisions, invariants, and roadmap.

## Roadmap

- **v2 — plugin registry:** upgrade refusals to user-approved mappings (same plugin via its
  React wrapper, or a recommended replacement) with version and license metadata; richer
  plan approval.
- ~~v3 — multi-web-part decomposition~~ — shipped (see the v3 section above).
- **v4 — further framework targets** and providers (OpenAI/Azure OpenAI adapter).

## Status

- [x] Milestone 1 — skeleton, IR contracts, deterministic analyzer, seeded corpus
- [x] Milestone 2 — `ModelProvider` + hand-rolled Anthropic/Ollama adapters over raw HTTP
- [x] Milestone 3 — pipeline core: cache, sealed steps, repair loop, plan, transform
- [x] Milestone 4 — verify gates, compile-repair, SPFx emit, report, CLI
- [x] Milestone 5 — eval harness and per-model scorecard
- [x] Bundle seal live-proven — real `npm install` + `gulp bundle` (SPFx 1.21.1, Node 22.14)
      passes against an emitted project; seal failures now quote the toolchain's full output
- [x] v3 — coupling analysis, single/decompose/spa strategy with safe-direction override,
      context slicing, N-part solution emit + per-part verification, multi-part eval; the
      two-web-part corpus item transforms, verifies, and seals live (one bundle per part)

## License

MIT
