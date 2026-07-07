# How to reason when something fails

The method behind this project's debugging (used to find, e.g., the Node-24 bundle-seal
failure hidden by a first-line-only report renderer). Work it in order; do not skip to
fixes.

## 1. Get the full error, not the summary

The first symptom is usually a truncated or secondhand version of the truth. Before
theorizing: read the WHOLE tool output, the report file, the raw exit code. If output
is missing, that absence is itself the first bug to fix (a swallowed error has caused
a real incident in this repo once already — src/report/index.ts renders full detail
now for this reason).

## 2. Separate the layers before blaming one

A failure always has a layer: input fixture → analyzer → plan → prompt/context →
model → schema/repair → emit → tsc/lint → bundle → environment. Reproduce with the
layers stripped: run the analyzer alone on the input; run the transform with the
cached response (`.spfx-relay/` cache hits are free and deterministic); run
`npx gulp bundle` manually in the emitted folder. The failing layer is the one that
still fails with everything else held constant.

## 3. Distrust coincidence in timing and environment

If it worked before and fails now, list what ACTUALLY changed: `git log` since the
last green run, `node --version`, npm logs in `%LOCALAPPDATA%\npm-cache\_logs`
(timestamped, show the node version each run used), file mtimes. Evidence over memory:
this repo's history shows environment drift (nvm version switches) masquerading as
code bugs.

## 4. Hand-trace before changing ground truth

When a test with hand-computed expectations fails: trace the fixture through the code
BY HAND on paper first. Only two outcomes are possible — the code is wrong (fix code)
or the hand-computation was wrong (fix expectation, in its own commit, with the trace
written in the commit message). "The test is flaky" is not an outcome; nothing here is
timing-dependent — tests are offline and deterministic by design.

## 5. Determinism failures bisect cleanly

If repeat runs differ: the cause is one of (a) unsorted collection → find the missing
canonicalSort; (b) OS artifacts (CRLF, path separators) → find the missing
normalize/toPosix at the entry point; (c) something dynamic in a prompt (date, random,
object-key order) → prompts must be frozen; (d) parallelism. Diff the two outputs
byte-wise; the first differing byte names the subsystem.

## 6. Model-quality failures are eval items, not patches

If the model produces wrong-but-schema-valid output: do NOT add post-processing to
"fix up" outputs (that's guessing). Add a corpus item that captures the failure, watch
it fail, then improve the PROMPT until the eval passes — the secret-leak rule in the
system prompt was born exactly this way.

## 7. When two explanations fit, prefer the one you can falsify next

Pick the hypothesis with the cheapest decisive test and run that test. Do not fix two
things at once; a fix that "also changed X while I was there" destroys the experiment.

## 8. Know when to stop

Three failed fix attempts on the same symptom = your model of the system is wrong
somewhere upstream. Stop patching. Re-read the relevant module header comments (they
carry the design decisions), re-run layer separation (§2), and if still stuck, write
the evidence into STATE.md "Blocked" and ask the user. A documented dead-end is
progress; a fourth blind patch is not.
