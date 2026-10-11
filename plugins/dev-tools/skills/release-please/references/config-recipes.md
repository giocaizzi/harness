# Config recipes

## Changelog sections

Default mapping: feat->minor/Features, fix->patch/Bug Fixes, perf, refactor, revert->patch, docs/style/test/build/ci/chore->hidden, `!` or `BREAKING CHANGE:`->major.

```json
{
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix",  "section": "Bug Fixes" },
    { "type": "docs", "section": "Documentation", "hidden": false }
  ]
}
```

## extra-files

`release-type` sets the primary version file. Mirror others via `extra-files`. Use `type: generic` for files with an `x-release-please-version` marker comment near the version; use `toml`/`json`/`yaml`/`xml` with a path expression otherwise.

```json
{
  "packages": {
    ".": {
      "release-type": "python",
      "extra-files": [
        { "type": "toml", "path": "libs/core/pyproject.toml", "jsonpath": "$.project.version" },
        { "type": "generic", "path": "src/__init__.py" }
      ]
    }
  }
}
```

## Monorepo

```json
{
  "packages": {
    "libs/core": { "release-type": "python" },
    "apps/web":  { "release-type": "node" }
  },
  "separate-pull-requests": false
}
```

- `false` (default): one Release PR with per-package changelogs. `true`: one PR per package, for independent cadences.
- A commit affects a package when it touches files under its path.
- Release PR title: `chore(release): X.Y.Z`, or `chore(main): release X.Y.Z` in monorepos.
