---
name: release-please
description: release-please workflow — automated versioning, changelog generation, and tagging from Conventional Commits. Use whenever you see `release-please-config.json`, `.release-please-manifest.json`, a `release-please.yml` workflow, or the user mentions release-please, automated releases, or "Release PR". You must follow these rules always.
---

## What release-please does

[release-please](https://github.com/googleapis/release-please) watches your default branch, parses Conventional Commits since the last release, and opens (or updates) a single **Release PR** that batches all release-worthy commits. Merging that PR is the release: release-please bumps versions in the files it tracks, regenerates `CHANGELOG.md`, tags `vX.Y.Z`, and creates a GitHub Release. Downstream automation (Docker build, npm publish, etc.) hangs off the tag, not off the PR.

The skill assumes the [[conventional-commits]] skill — release-please cannot work without correctly typed commits.

## The five files you will see

| File | Role | Edit by hand? |
|---|---|---|
| `release-please-config.json` | Release-type, packages, changelog sections, `extra-files` for non-canonical version locations | Yes — this is config |
| `.release-please-manifest.json` | Current released version per package. **Source of truth.** | Only to fix drift |
| `.github/workflows/release-please.yml` | Runs the action on every push to the default branch | Yes |
| `CHANGELOG.md` (per package) | Generated from commits | **No** — release-please owns it |
| The package's own version file(s) (`package.json`, `pyproject.toml`, `Cargo.toml`, …) | Mirrored from the manifest on each release | **No** under normal flow |

### Version source of truth

`.release-please-manifest.json` is canonical. Every version file release-please tracks must match it. If they drift (someone hand-edited a `version`), release-please will overwrite from the manifest on the next release — but the drift confuses local tooling (`uv`, `npm`, IDE plugins) in the meantime, so fix drift promptly.

## Type → bump → section

Default mapping (configurable in `release-please-config.json#changelog-sections`):

| Commit type | Bump | Section |
|---|---|---|
| `feat` | minor | Features / Added |
| `fix` | patch | Bug Fixes / Fixed |
| `perf` | patch | Performance |
| `refactor` | patch | Changed |
| `revert` | patch | Reverts |
| `docs` / `style` / `test` / `build` / `ci` / `chore` | none | hidden by default |
| any `<type>!` or `BREAKING CHANGE:` footer | major | Breaking |

To surface a hidden type in the changelog, override it in `release-please-config.json`:

```json
{
  "changelog-sections": [
    { "type": "feat",  "section": "Features" },
    { "type": "fix",   "section": "Bug Fixes" },
    { "type": "docs",  "section": "Documentation", "hidden": false }
  ]
}
```

## The release flow

1. Developers land Conventional Commits on the default branch.
2. The `release-please` workflow runs on each push and opens/updates a Release PR titled `chore(release): X.Y.Z` (or `chore(main): release X.Y.Z` for monorepos). The PR body previews the changelog and the version bumps.
3. Reviewers inspect the PR. **Do not push commits directly to the Release PR branch** — release-please will overwrite them on its next run. If something looks wrong, fix the underlying commits on `main` (e.g. with `git revert`) and let release-please re-render.
4. Merging the PR is the release. release-please then:
   - updates `.release-please-manifest.json` to the new version
   - updates every tracked version file (the package's native one + everything in `extra-files`)
   - rewrites `CHANGELOG.md`
   - creates tag `vX.Y.Z` (or `<package>-vX.Y.Z` in monorepos)
   - publishes a GitHub Release pointing at that tag
5. Downstream workflows triggered by the `v*` tag (Docker build, npm/PyPI publish, deployment) take over.

## Keeping non-canonical version locations in sync

release-please knows about your package's primary version file by `release-type` (e.g. `release-type: python` knows about `pyproject.toml`). If you have **other** files that must mirror the version — a workspace's per-package `pyproject.toml`, a `version.py` constant, a Helm `Chart.yaml`, a Dockerfile `LABEL` — declare them in `extra-files` so release-please bumps them in lockstep:

```json
{
  "packages": {
    ".": {
      "release-type": "python",
      "extra-files": [
        { "type": "toml", "path": "libs/core/pyproject.toml", "jsonpath": "$.project.version" },
        { "type": "toml", "path": "libs/api/pyproject.toml",  "jsonpath": "$.project.version" },
        { "type": "generic", "path": "src/__init__.py" }
      ]
    }
  }
}
```

`type: generic` looks for an `x-release-please-version` marker comment near the version line; structured types (`toml`, `json`, `yaml`, `xml`) use a path expression.

## Monorepo mode

For multi-package repos, declare each package in `release-please-config.json`:

```json
{
  "packages": {
    "libs/core":  { "release-type": "python" },
    "libs/api":   { "release-type": "python" },
    "apps/web":   { "release-type": "node" }
  },
  "separate-pull-requests": false
}
```

- `separate-pull-requests: false` (default) batches all packages into one Release PR with a per-package changelog.
- Setting it to `true` opens one PR per package — useful when packages release on independent cadences.
- Commits affect a package when they touch files inside its path. Cross-cutting `chore` commits affect no package and produce no bump.
- Tag format becomes `<package>-vX.Y.Z`.

## Manual release escape hatch

If release-please is broken or you need an emergency cut, you can release by hand. This is a last resort; the manifest must end up consistent with the tag, or the next automated release will be confused.

```bash
# 1. Set the same version in the manifest and every tracked version file
#    (don't forget anything listed under extra-files — checking the failing
#    workflow's planned diff is the safest way to enumerate them)
# 2. Update CHANGELOG.md by hand
# 3. Tag and create the GitHub Release — downstream workflows fire on the tag
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```

After the next merge to `main`, verify release-please reads the manifest correctly and re-opens a fresh Release PR.

## Common pitfalls

- **Pushing to the Release PR branch.** It's an automation artifact — overwritten on every workflow run. Fix the source commits instead.
- **Hand-editing `CHANGELOG.md`.** Gets clobbered. If you need a manual note, add it via the `Release-As:` footer on a commit or the PR's edit-the-changelog UI before merging.
- **Mistyped commit `type`.** A `feat` that should have been `chore` cuts a minor version with a blank "Features" entry; the reverse hides a real change. The fix is to `git revert` the bad commit and recommit with the right type — never amend an already-merged commit.
- **Missing `extra-files`.** A new version-bearing file (new sublibrary, new Helm chart, new constant) won't be bumped. Add it to `release-please-config.json` in the same PR that introduces the file.
- **Drift between manifest and version files.** Trust the manifest, not the file. Bring drifting files back into line by hand-editing them to match the manifest, or run release-please's `manifest-pr` action.
- **Forgetting that `BREAKING CHANGE:` must be a real footer.** It needs to start at the beginning of a line in the commit body's footer block, with no leading whitespace. Otherwise release-please won't parse it and you'll get a patch bump instead of a major.

## When working with Claude

- Before guessing the next version, read `.release-please-manifest.json` — it is authoritative.
- Before suggesting a config change, read `release-please-config.json` in the repo; defaults vary by `release-type` and per-package overrides are common.
- Never write to `CHANGELOG.md` or package version files in a normal PR. If the user asks you to "bump the version", that means: write the right Conventional Commit, push to `main`, and let release-please do it. Push back if asked to do it by hand without the escape-hatch context.
