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

## uv projects: refresh `uv.lock` on the release PR

`uv.lock` names the project (and each workspace package) with its own `version`, so after a release it still shows the old one and a plain `uv run` rewrites it. `extra-files` cannot fix it: release-please's TOML updater with a filter path (`$.package[?(@.name=='x')].version`) matches nothing (checked against release-please 17), and a positional path (`$.package[0].version`) breaks when dependencies change.

Run `uv lock` on the release PR branch in the release workflow, with the release-please GitHub App token so CI runs on the push. Give the action step `id: rp`, then:

```yaml
      - if: ${{ steps.rp.outputs.prs_created == 'true' }}
        uses: actions/checkout@v7
        with:
          ref: ${{ fromJSON(steps.rp.outputs.pr).headBranchName }}
          token: ${{ steps.app-token.outputs.token }}
      - if: ${{ steps.rp.outputs.prs_created == 'true' }}
        uses: astral-sh/setup-uv@v7
      - if: ${{ steps.rp.outputs.prs_created == 'true' }}
        run: |
          uv lock
          if ! git diff --quiet -- uv.lock; then
            git config user.name "release-please[bot]"
            git config user.email "release-please[bot]@users.noreply.github.com"
            git commit -m "chore: refresh uv.lock" -- uv.lock
            git push
          fi
```

Reference: `giocaizzi/greenhouse` `.github/workflows/release-please.yml`.
