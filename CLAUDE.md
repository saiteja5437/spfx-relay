# CLAUDE.md — spfx-relay

Context for AI-assisted development sessions. Read this before changing anything.

## What this is and why it exists

A CLI that migrates legacy SharePoint Script Editor web parts (HTML + CSS + JS/jQuery)
into verified SPFx React web parts. Built by a SharePoint SPFx developer as a learning +
portfolio project for applied AI engineering. The owner deliberately hand-builds core
plumbing (provider adapters, SSE/NDJSON parsers, repair loops) to learn the internals —
**do not suggest replacing them with SDKs or frameworks** (Vercel AI SDK was considered
and rejected for this reason).

## The thesis (never compromise it)

**The value is the harness, not the model.** The system must stay deterministic at the
system level even though the model is probabilistic:

1. **LLM calls only through `runStructuredStep`** (src/pipeline/step.ts): Zod-validated
   JSON contract, bounded repair (max 3 attempts), typed `StepFailure`. No free-text
   between stages, no unbounded loops, ever.
2. **The pipeline imports only the `ModelProvider` interface** — concrete adapters are
   referenced in exactly one place (`src/providers/index.ts` factory). Adding a provider
   is one new file.
3. **Honest refusal over guessing.** Unsupported constructs (plugins, unknown externals)
   block the plan; a blocked plan cannot reach the model (enforced in `runTransform`).
   Oversized context is refused, never truncated.
4. **Determinism mechanics:** canonical sorting everywhere, CRLF→LF normalization, frozen
   system prompt (no dates/dynamic values), response cache keyed by SHA-256 of
   (provider, model, system, prompt, schema), deterministic scaffold GUIDs. Same input →
   byte-identical output on any OS.
5. **Everything is measured.** Prompt/model changes must be justified by an eval run
   (`npm run cli -- eval`), not vibes. The corpus caught a real analyzer bug and a real
   secret-leak prompt weakness — keep growing it.

## Locked decisions (don't re-litigate)

- TypeScript/Node, CLI form factor, Vitest, ESLint flat config, MIT. Zod v4, parse5,
  TS compiler API for JS analysis (no extra parser deps).
- Providers v1: **Anthropic (raw HTTP, SSE)** + **Ollama (raw HTTP, NDJSON)**. Defaults:
  `claude-opus-4-8` / `llama3.1`. Timeouts: Ollama 15 min (local cold loads);
  timeouts never retry, fast network failures do (src/providers/http.ts).
- Verification is staged: strict tsc + curated ESLint per attempt (drive the
  compile-repair loop), one `gulp bundle` seal at the end, graceful skip if npm missing.
- Generated components: `import * as React` (SPFx has no esModuleInterop), stylesheets
  imported by original filename, default export, compiles standalone.
- Plan approval before transform (`--yes` to skip). Exit codes: 0 ok / 2 blocked /
  3 failed verification / 4 bundle failed. Reports written for every outcome.
- Corpus `expected.json` is EXACT analyzer ground truth (the corpus test asserts equality
  and repeat-run determinism). `eval.json` holds content checks (mustContain /
  mustNotContain) — surface assertions, explicitly not behavioral equivalence.

## Working conventions

- Gates before every commit: `npm run typecheck && npm test && npm run lint` — all green,
  no exceptions. Tests are offline (fetch is injected; scripted providers); live calls
  only in `tests/providers/live.smoke.test.ts` behind SMOKE_* env vars.
- New corpus items: hand-compute `expected.json`, run the corpus test, and if output
  differs, first verify the ANALYZER is right before touching expectations.
- Milestone workflow: present a short outline, get approval, build, run gates, update
  README status, commit with a detailed message.

## Current state (end of v1)

All 5 v1 milestones complete; ~107 offline tests. Live-proven with Ollama
(`gemma4:31b-cloud`: 4/4 compile, 5/5 refusals, 12/12 content checks, avg 1 gate
attempt). Anthropic adapter is fully tested offline but has not had a live run yet
(no API key on this machine so far).

## Known gaps / next work (in value order)

1. **Bundle seal never run against a real SPFx toolchain** — needs Node 22; expect
   template iteration (e.g. `./styles.css` import may need `.module.scss` treatment in
   the SPFx webpack pipeline). Templates pinned SPFx 1.21.1 in `templates/spfx/`.
2. **Anthropic live run + second scorecard row** (needs ANTHROPIC_API_KEY).
3. **v2 — plugin registry:** upgrade refusals in `src/analyze/dependencies.ts` to
   user-approved mappings (same plugin via React wrapper vs recommended replacement),
   with version + license metadata (ag-Grid/DevExtreme are commercial — flag it). The
   plan-approval step is the designed interaction point.
4. **v3 — multi-web-part decomposition; v4 — more targets/providers (OpenAI/Azure).**
5. CI pipeline (GitHub Actions: typecheck + test + lint) — everything is offline-safe.
6. Analyzer blind spot: property-style DOM mutations (`el.textContent = …`) aren't in
   the IR (documented in src/analyze/script.ts).
