---
name: release-please
description: Working in a repo that uses release-please (release-please-config.json, manifest, or a Release PR) for automated versioning, changelogs and tags. Use when releasing, bumping versions, or editing release-please config.
---

release-please parses Conventional Commits on the default branch and maintains one Release PR. Merging that PR is the release: it bumps tracked version files, regenerates `CHANGELOG.md`, tags `vX.Y.Z` (`<package>-vX.Y.Z` in monorepos) and creates a GitHub Release. Downstream publish/deploy hangs off the release, not the PR; with the default `GITHUB_TOKEN` the tag starts no other workflow, so gate a job on the action's `release_created` output or use an App token ([references/release-flow.md](references/release-flow.md)). It depends on correctly typed commits; see `conventional-commits`.

## Files and ownership

- `release-please-config.json`: release-type, packages, changelog sections, `extra-files`. Hand-edit.
- `.release-please-manifest.json`: current released version per package, the source of truth. Edit only to fix drift; read it before guessing the next version.
- `.github/workflows/release-please.yml`: runs the action on pushes to the default branch.
- `CHANGELOG.md` and the tracked version files (`package.json`, `pyproject.toml`, ...): release-please owns them. Hand edits get overwritten, and drift confuses local tooling (`uv`, `npm`, IDEs) until the next release, so realign files to the manifest promptly.

To bump a version, land the right Conventional Commit and let the Release PR appear; do not edit versions by hand in a normal PR.

To force a specific version (a prerelease such as `1.0.0-rc.1`, or skipping ahead), set `"release-as": "<version>"` on the package in `release-please-config.json` in a PR, then remove it in a PR right after the release is tagged, or every later Release PR proposes that version again. The schema marks the key deprecated, but release-please reads it before any commit, so it is deterministic. A `Release-As: <version>` footer works only when it is the last trailer block of the commit on the default branch: in a squash merge GitHub appends `---------` and `Co-authored-by:` trailers after the PR body, and the parser then drops the footer and the Release PR falls back to the version from commit types. Use the footer only in a commit message you control end to end (a direct or empty commit), and check `git log -1 --format=%B origin/<default>` before trusting the Release PR.

## Gotchas

- Pushing to the Release PR branch is overwritten. Fix the source commits on `main` and let it re-render.
- A mistyped commit type gives the wrong bump. Revert and recommit with the right type; do not amend a merged commit.
- `BREAKING CHANGE:` must be a real footer line with no leading whitespace, or the major bump is missed.
- Version-bearing files beyond the `release-type` default (another `pyproject.toml`, a `version.py`, Helm `Chart.yaml`, a Dockerfile `LABEL`) must be listed in `extra-files`, added in the same PR that introduces them, or they drift.
- A squash-merged PR that batches several changes gives one changelog entry, typed by its title: put every change, one Conventional Commit header each, between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` lines in the PR body (editable after the merge, before the Release PR is merged).
- Cross-cutting `chore` commits touch no package and produce no bump in monorepos.
- **`uv.lock` goes stale after every release** in a uv project unless listed in `extra-files`: it records the project's own version. Add one `toml` entry per `[[package]]` that carries a version you bump, filtering on `@.name.value` (the TOML parser wraps strings, so `@.name=='x'` matches nothing). Recipe in `references/config-recipes.md`.
- Hidden types (`docs`, `chore`, ...) trigger no release and no changelog entry by default; surface one via `changelog-sections` with `"hidden": false`.

Config snippets (extra-files types, monorepo layout, changelog sections) are in [references/config-recipes.md](references/config-recipes.md); read when editing `release-please-config.json`.

## Maintenance line

To patch an old minor after `main` has moved on, run release-please on a `release/X.Y.x` branch cut from the release tag, with its own Release PR. Every fix also lands on `main` as its own PR, or the next `main` release regresses it. Steps, workflow changes and gotchas (branch protection, tags, "latest" release): [references/release-flow.md](references/release-flow.md#maintenance-line).

## Manual release (last resort)

Only if release-please is broken or an emergency cut is needed. The manifest, every tracked version file (check `extra-files`) and the tag must end up consistent, or the next automated release gets confused: set the version in all of them, update `CHANGELOG.md`, then `git tag -a vX.Y.Z`, push the tag, `gh release create vX.Y.Z`. After the next merge to `main`, verify a fresh Release PR opens correctly.

The step-by-step release flow, downstream-tag handling and the manual-release commands (incl. `gh release create --notes-from-tag`) are in [references/release-flow.md](references/release-flow.md); read when walking through or performing a release.
