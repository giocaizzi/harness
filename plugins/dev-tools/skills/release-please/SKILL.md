---
name: release-please
description: release-please workflow — automated versioning, changelog generation, and tagging from Conventional Commits. Activate this skill when the task is about a repository that uses release-please, confirmed by `release-please-config.json`, `.release-please-manifest.json`, a `release-please.yml` workflow, or an explicit user request about release-please, automated releases, or a Release PR. You must follow these rules always.
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
3. Reviewers inspect the PR.
  - Do not push commits directly to the Release PR branch; release-please will overwrite them.
  - If something is wrong, fix the underlying commits on `main` and let release-please re-render the PR.
4. Merging the PR is the release. release-please then:
   - updates `.release-please-manifest.json` to the new version
   - updates every tracked version file (the package's native one + everything in `extra-files`)
   - rewrites `CHANGELOG.md`
   - creates tag `vX.Y.Z` (or `<package>-vX.Y.Z` in monorepos)
   - publishes a GitHub Release pointing at that tag
5. Downstream workflows triggered by the `v*` tag (Docker build, npm/PyPI publish, deployment) take over.

## Keeping non-canonical version locations in sync

Treat this in two steps:

- `release-type` determines the primary version file release-please manages. Example: `release-type: python` updates `pyproject.toml`.
- `extra-files` lists any additional files that must mirror the same version, such as another `pyproject.toml`, a `version.py` constant, a Helm `Chart.yaml`, or a Dockerfile `LABEL`.

Declare those additional files in `extra-files` so release-please bumps them in lockstep:

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

Use `type: generic` when a file has an `x-release-please-version` marker comment near the version line. Use structured types such as `toml`, `json`, `yaml`, or `xml` when the file should be updated through a path expression.

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

If release-please is broken or you need an emergency cut, you can release by hand. Use this only as a last resort. The manifest must end up consistent with the tag, or the next automated release will be confused.

```bash
# 1. Set the same version in the manifest and every tracked version file.
# 2. Update CHANGELOG.md by hand.
# 3. Tag and create the GitHub Release.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```

Before doing this, check `extra-files` so every tracked version location is updated. After the next merge to `main`, verify release-please reads the manifest correctly and opens a fresh Release PR.

## Common pitfalls

- **Pushing to the Release PR branch.** It will be overwritten. Fix the source commits instead.
- **Hand-editing `CHANGELOG.md`.** It will be regenerated. Add manual notes through release-please-supported inputs instead.
- **Mistyped commit `type`.** The bump will be wrong. Revert and recommit with the right type; do not amend an already-merged commit.
- **Missing `extra-files`.** New version-bearing files will drift. Add them in the same PR that introduces them.
- **Drift between manifest and version files.** Trust the manifest and realign the files to it.
- **Invalid `BREAKING CHANGE:` footer.** It must be a real footer line with no leading whitespace or release-please will miss the major bump.

## When working with Claude

- Before guessing the next version, read `.release-please-manifest.json`.
- Before suggesting a config change, read `release-please-config.json`.
- In a normal PR, do not edit `CHANGELOG.md` or package version files by hand.
- If the user asks to "bump the version", prefer the normal flow: land the right Conventional Commit and let release-please create the Release PR.
