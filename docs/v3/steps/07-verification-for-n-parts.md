# Step 07 — Verification and bundle seal for N parts (mechanical)

## Decisions (settled)

- **tsc/lint gates run on the whole emitted project once per repair attempt**, not
  per part in isolation — parts share tsconfig and the SPFx type surface, and
  whole-project is what ships. BUT repair must stay part-scoped: route each
  diagnostic to the owning part by file path prefix (`src/webparts/<name>/`), and
  re-run the repair loop only for parts that own errors. Diagnostics outside any part
  (scaffold files) are a tool bug: fail loudly, do not send scaffold errors to a model.
- Repair budget stays per part (max 3 attempts each) — a global budget would let one
  bad part starve the others.
- **One bundle seal at the end** for the whole solution (unchanged code path). Assert
  it produces one bundle per part (check `dist/` manifest count) — a part silently
  dropped by webpack is a real failure mode of misconfigured bundles entries.
- Exit codes unchanged: any part failing gates after repairs → 3; seal failure → 4.

## Acceptance

- [ ] Offline test: scripted provider yields part 1 clean, part 2 with a type error
      then a fixed retry — assert part 1's transform is NOT re-run (attempts stay 1)
      and part 2 records 2 attempts.
- [ ] Offline test: diagnostic in a scaffold file fails the run with a message naming
      the file, without any model call.
- [ ] Live (manual, Node 22.14): seal over emitted 006 passes and `dist/` contains
      two web-part bundles. Record the result in STATE.md log.
- [ ] Gates green.

## Failure playbook

- **Seal fails only in multi-part** → diff emitted config.json/manifests against your
  yo-generated two-part reference solution (step 06 playbook); the delta IS the bug.
- **A part's fix breaks another part's compile** (shared file collision) → parts must
  not share generated files except the scaffold; if they do, the emit layout from
  step 06 was violated — fix emit, not the repair loop.
