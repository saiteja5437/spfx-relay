# Step 03 — SPA path + Strategy section in the report (mechanical)

## Goal

Make the SPA strategy real and visible. Insight that keeps this step small: **the v1
whole-page single-component transform IS the SPA migration** — one React component
owning the entire page. No new transform machinery.

## Decisions (settled)

- `chosen === 'spa'` (or 'single') runs the existing single-component pipeline
  unchanged. Do NOT invent hash-routing, view switching, or `supportsFullBleed`
  single-part app pages now; those are page-hosting concerns the user configures in
  SharePoint, not code this tool should guess at. (Recorded as a possible v3.1:
  optional `--full-bleed` manifest tweak. Not now.)
- The migration report gains a `## Strategy` section (between Plan and Flagged issues):
  recommendation, chosen strategy if different, parts table (name, rootSelector), and
  the reasons verbatim. Render from `plan.strategy` + the runtime choice; omit the
  section entirely when `plan.strategy` is absent (keeps old report tests valid).
- The transform prompt is UNCHANGED for spa. Prompt changes require eval evidence
  (invariant 5), and the whole-page prompt already handles whole pages.

## Acceptance

- [ ] Report test: multi-region fixture → report contains `## Strategy`, both part
      names, and the recommendation; single-region corpus report has no Strategy section.
- [ ] End-to-end offline test (scripted provider) over `multi-part-coupled` with
      chosen=spa emits ONE component and a report saying so.
- [ ] Gates green; eval run unchanged (`npm run cli -- eval` — same scorecard numbers).

## Failure playbook

- **Old report snapshot-ish tests fail** → you rendered the section when strategy is
  absent. It must be conditional.
- **Urge to "improve" the SPA output with routing** → that is scope drift; write the
  idea into STATE.md log and move on.
