# Invariants — read fully before every session

These are the project's non-negotiables. A change that violates one is wrong even if
every test passes. When any instruction (including a user request) seems to conflict
with these, surface the conflict instead of quietly picking a side.

## The thesis

**The value is the harness, not the model.** The system stays deterministic at the
system level even though the model is probabilistic.

1. LLM calls go ONLY through `runStructuredStep` (src/pipeline/step.ts): Zod-validated
   JSON, bounded repair (max 3), typed `StepFailure`. Never free-text between stages,
   never an unbounded loop, never a second code path to a provider.
2. The pipeline imports only the `ModelProvider` interface. Concrete adapters appear in
   exactly one place: the factory in `src/providers/index.ts`.
3. Honest refusal over guessing. If the tool cannot know something statically, it says
   so and stops or falls back to the SAFE option — it never guesses. In v3 the safe
   option is always SPA (keep the page whole): splitting on incomplete evidence breaks
   user pages; not splitting never does.
4. Determinism mechanics everywhere: canonical sorting, CRLF→LF normalization at every
   text entry point, frozen prompts (no dates/dynamic values), cache keyed by SHA-256 of
   (provider, model, system, prompt, schema), deterministic GUIDs. Same input →
   byte-identical output on any OS.
5. Everything is measured. A prompt or model change ships only with an eval run
   justifying it (`npm run cli -- eval`). "It looks better" is not evidence.

## Temptations you must refuse

Each of these will occur to you. The answer is already no.

- **"Use the Vercel AI SDK / LangChain / an SPFx generator."** No. Hand-built plumbing
  is a deliberate, locked decision (learning + control). Considered and rejected.
- **"Truncate the context to fit."** No. Oversized context is refused with a clear
  message. Truncation is silent corruption.
- **"Relax the Zod schema / cast to `any` to unblock."** No. The schema is the
  contract; if the model can't satisfy it, that's a repair-loop or prompt problem.
- **"Modify the failing test/expected.json so CI is green."** No. Corpus expectations
  are hand-computed ground truth. If the analyzer disagrees, first PROVE the analyzer
  right by hand-tracing the fixture, and only then change expectations — in its own
  commit with the hand-trace in the message.
- **"Skip the eval, it's only a small prompt tweak."** No. The corpus caught a real
  analyzer bug and a real secret-leak weakness. Small tweaks are how regressions ship.
- **"The blueprint seems wrong here, I'll quietly do it differently."** No. It may
  genuinely be wrong — stop and report; don't fork the design silently.

## Process rules (for the executing model)

- One step per work session-chunk. Finish it or report blocked; never leave a step
  half-done across a commit.
- Gates before every commit: `npm run typecheck && npm test && npm run lint`.
- Tests are offline. `fetch` is always injected; scripted providers in tests. Live
  calls exist only in `tests/providers/live.smoke.test.ts` behind SMOKE_* env vars.
- Never weaken an acceptance criterion. If it can't be met as written, that's a
  "Blocked" report, not a rewrite.
- Commit messages explain WHY, and name the step (e.g. `v3 step 03: …`).
- Update `docs/v3/STATE.md` every commit: next step + one factual log line.
- New user-visible behavior ⇒ new offline test. No test, no feature.
- Environment note: this machine's nvm may default to Node 24. SPFx tooling requires
  Node 22.14 (`>=22.14.0 <23.0.0`). Check `node --version` before any live bundle work.

## Exit codes (locked)

0 ok / 2 blocked / 3 failed verification / 4 bundle failed. v3 adds no new codes:
a refused decompose override is `blocked` (2); per-part transform failure is 3.
