---
name: conventional-commits
description: Conventional Commits for commit messages and PR titles, where the type drives version bump and changelog. Use when writing a commit message, drafting a PR title, or rewriting history.
---

The commit `type` is machine-readable intent: release tools (release-please, semantic-release, Changesets) read it to pick the version bump and changelog section. A wrong type ships the wrong version or hides a real change, so treat the header as an API.

Header: `<type>[(scope)][!]: <description>`. Imperative, lowercase type, no trailing period, aim for <=72 chars. Body explains why, not what. Footers: `BREAKING CHANGE: ...`, `Refs: ...`.

## Choosing the type

Pick the smallest type that matches user-visible impact:

- `feat`: new user-visible behaviour (minor).
- `fix`: repairs previously broken behaviour, including security patches (patch). Behaviour added because something was missing is `feat`.
- `perf`, `refactor`, `revert`: patch. `refactor` means no behaviour change for callers; using `feat` for it inflates the minor version.
- `docs`, `style`, `test`, `build`, `ci`, `chore`: no bump. `build` = bundlers/package managers, `ci` = pipeline config, `chore` = other housekeeping.
- If all changes serve one user-facing goal, one commit with the highest-impact type; independent goals get separate commits, each with one scope.

The mapping above is the common default but is configurable per repo; read the release config (`release-please-config.json`, `.changeset/`, `package.json#release`, `cz-config.js`) rather than guessing. See [references/types-and-examples.md](references/types-and-examples.md) for the full table and worked examples (read when unsure about a type or formatting a breaking change).

## Scope

Optional short noun for the subsystem. Reuse the vocabulary already in the repo's log (`git log --oneline -20`); inventing a scope per commit makes changelogs noisy.

## Breaking changes (firm)

Anything that forces consumers to change code, config, or behaviour is breaking: removed or renamed public API or flag, changed defaults, dropped runtime support. Mark with `!` and/or a `BREAKING CHANGE:` footer. Forgetting it makes release automation cut a patch instead of a major, so re-read the diff and ask whether a consumer would have to change anything. The footer should say what broke and how to migrate, since release notes are generated from it.

## PR titles and squash merges

Same header format as commits; body and footers go in the PR description. In squash-merge repos only the PR title and description survive onto `main`, so they decide the release:

- **Per-commit types are discarded.** Pick the type once, on the title; the branch's own commits are only history.
- **Pin the squash settings** to `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`. The defaults (`COMMIT_OR_PR_TITLE`, `COMMIT_MESSAGES`) use the lone commit's message for a one-commit PR (ignoring a corrected title) and concatenate every commit message, fixups and duplicate trailers included.
- **Footers must be in the PR description**, as real lines with no indentation: `BREAKING CHANGE:`, `Refs:`, `Co-Authored-By:`. A footer only in a branch commit is lost.
- **Validate the title in CI**, required on `main`: job `Validate PR title`, trigger `pull_request` types `opened, edited, synchronize, reopened` (without `edited`, fixing a title does not re-run the check). Read the title from an env var, never interpolate it into the script. Skip release-please's own `release-please--*` PRs at the step level, never the job: a job-level skip leaves a required check unreported and blocks every release PR. The reference workflow is `standard/workflows/pr-title.yml` in `giocaizzi/.github`.
- **A wrong title after merge** means a revert and a correct recommit, not a force-push.

## History

Do not amend or rewrite an already-pushed commit message to fix a type without confirming with the user; it forces a force-push.
