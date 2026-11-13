# Maintenance lines and hotfixes

A maintenance line patches an older version while `main` has moved on. Open one only for a version you still support; otherwise the fix ships from `main` as the next version.

- **Cut from the release tag**, as `release/X.Y.x`: the line's history is exactly what users run.
- **Only patches on the line.** It never bumps minor or major, so its versions can never collide with `main`'s.
- **Fix on the line, then port to `main`** as its own PR, unless `main` already has the fix; otherwise the next `main` release regresses it.
- **The line gets the same gate as `main`**: required checks and protection cover `release/**` too, and the CI workflow's PR trigger lists those branches (a PR runs the workflow of its base branch).
- **The latest marker stays on `main`'s newest release**: check it after every line release.
- **Retire the line** when support ends: delete the branch; the tags keep its commits.

A hotfix of the current version needs no line: it is a `fix:` change on `main` released at once, ahead of the usual batch.

The release-please spelling (workflow trigger, `target-branch`, manifest on the line) is in the `release-please` skill, references/release-flow.md, Maintenance line.
