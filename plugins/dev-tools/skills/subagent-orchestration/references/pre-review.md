# Pre-review self-check

An author (a driver, a worker, or a session shipping its own change) runs this before handing back or asking for review, so the first review is the last.

- The PR body describes this change (What, Why, Verification), not an earlier draft.
- Every doc that mentions the changed behaviour is updated (`docs-sync`), and any "last verified" line says what was actually checked and when, or is left alone.
- Golden and generated files are regenerated with the repo's command and read, not only regenerated.
- Each new test was shown failing on the base (or with its logic removed) before it passed.
- Assumptions are labelled as assumptions in the report and the PR body.
- The lint ratchet (a baseline, an ignore list, a coverage floor, a warning count) is not raised to make the change pass.
- The base is merged in and the full check passed on the merged tree (`github-workflow`, Landing a change, rule 5).
- Nothing in scope is left for a follow-up (rule 7): related findings and Minors are folded in.
