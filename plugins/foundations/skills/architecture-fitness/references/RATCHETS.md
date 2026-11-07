# Ratchets

A ratchet turns a backlog you cannot fix now into a check that only moves one way. Turn the rule on at full severity at once; record what already breaks; fail anything new. The PR that fixes some updates the record, and no PR grows it.

## golangci-lint: new issues only

Under `issues` in `.golangci.yml`, report only what is new since the branch point:

```yaml
issues:
  new-from-merge-base: main
```

Or on the command line: `golangci-lint run --new-from-merge-base=origin/main`. CI needs the base ref (fetch full history, or fetch `main`). `whole-files: true` reports every issue in a touched file: stricter, and it drains the backlog faster.

## ESLint: bulk suppressions (ESLint 9.24+)

```sh
npx eslint --fix --suppress-all     # record existing violations in eslint-suppressions.json
npx eslint --prune-suppressions     # drop entries that no longer occur
```

Commit `eslint-suppressions.json`. New violations fail; fixed ones show as unused suppressions until pruned. `--suppress-rule <rule>` records one rule only; `--suppressions-location` moves the file. Set `linterOptions.reportUnusedDisableDirectives: "error"` and use no inline `eslint-disable` for architecture rules.

## ruff: a per-file-ignores list

Turn the rule on for the whole repo, then list the files that still break it, each with its reason, in `ruff.toml`:

```toml
[lint.per-file-ignores]
# Shrink only. Remove a line in the PR that fixes the file.
"src/acme/legacy/export.py" = ["PLR0913"]  # old report builder, to be split
```

A new line in this list needs a reason in review.

## Coverage floor in `make test`

The floor is a committed number that may only rise. It lives in `make test`, not in a required CI check.

```make
test:
	uv run pytest --cov=acme --cov-fail-under=$$(cat .coverage-floor)
```

Raise `.coverage-floor` in the PR that raises coverage (to the integer below the measured value); never lower it. To keep it from being lowered, compare it with the base branch's copy in the same target: `test "$$(cat .coverage-floor)" -ge "$$(git show origin/main:.coverage-floor)"`. For Go, compare the `go tool cover -func` total with the file in a small script; for TypeScript, feed the file to the test runner's coverage thresholds.

A floor breeds tests that execute code without asserting anything: review new tests for assertions.

## Regenerating a baseline

Two PRs that lower the same baseline conflict. After merging `main`, regenerate the file with the tool (`--prune-suppressions`, a fresh floor); never hand-merge counts.
