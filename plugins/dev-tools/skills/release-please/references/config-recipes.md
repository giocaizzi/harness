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

## uv projects: bump the versions in `uv.lock`

`uv.lock` names the project (and each workspace package) with its own `version`, so after a release it still shows the old one and a plain `uv run` rewrites it. List the lock in `extra-files`, one `toml` entry per package, selecting the `[[package]]` by name with `.name.value`:

```json
{ "type": "toml", "path": "uv.lock", "jsonpath": "$.package[?(@.name.value=='my-pkg')].version" }
```

- The `.value` is required: release-please's TOML parser wraps strings, so `@.name=='my-pkg'` silently matches nothing ("No entries modified").
- Avoid positional paths (`$.package[0].version`): the index moves when dependencies change.
- Add an entry when a workspace package is added. Check a new entry against the real file before relying on it: run the `GenericToml` updater from `release-please` over `uv.lock` and confirm only the version lines change.
- Fallback if a lock cannot be matched: run `uv lock` on the release PR branch in the release workflow, with the release-please GitHub App token so CI runs on the push.

Reference: `acme/app` and `giocaizzi/greenhouse` `release-please-config.json`.
