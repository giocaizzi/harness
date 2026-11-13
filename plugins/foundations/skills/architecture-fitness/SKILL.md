---
name: architecture-fitness
description: "Use when a layering or import rule keeps being broken, two implementations of a port must behave the same, or lint warnings or coverage must stop getting worse. Checks that fail in make check instead of documents."
---

# Architecture Fitness

A rule that matters is a check that fails. These are the choices we make; the config for each language is in `references/`.

- **A failing check in `make check`, never a sentence in a doc.** If a layering rule was broken twice, the second fix is the check, not a reminder. The check runs in `lint`, so humans, CI and agents hit the same wall.
- **Python**: import-linter `layers` and `forbidden` contracts in `pyproject.toml`, run as `uv run lint-imports` in `lint`. Template in [references/PYTHON.md](./references/PYTHON.md).
- **Go**: depguard rules per layer in the house `.golangci.yml`; an `arch_test.go` over `go list -deps` only for what depguard cannot say. Block and test in [references/GO.md](./references/GO.md).
- **TypeScript**: exactly the tools the `atomic-design` skill already picks (`import-x/no-restricted-paths`, or `eslint-plugin-boundaries` for many element types, plus dependency-cruiser for the graph). Never add a second boundary tool. Backend zones in [references/TYPESCRIPT.md](./references/TYPESCRIPT.md).
- **A rule's message is the instruction**: what to do instead and where it lives. An agent reads it as its next step.
- **Exceptions are listed one by one, each with a reason.** No blanket ignore, no glob that swallows a directory.
- **One conformance suite per port**, run against the fake and every real adapter; the real one behind a test marker or build tag, against a container. See [references/CONFORMANCE.md](./references/CONFORMANCE.md).
- **A ratchet for a backlog you cannot fix now**: a committed count or suppressions file that may only shrink (golangci-lint `new-from-merge-base`, ESLint bulk suppressions, a ruff per-file-ignores list). The PR that lowers it updates it. Per tool in [references/RATCHETS.md](./references/RATCHETS.md).
- **A coverage floor is a ratchet inside `make test`** that may only rise: the PR that raises coverage raises the committed floor, and nothing lowers it. It is not a required coverage check in CI; coverage reporting stays informational, as `repo-standard` says.

## Gotchas

- import-linter reports nothing useful when the package is not installed in the env: run it through `uv run`.
- depguard matches file sets by `files` globs, with `$test` and `$all` variables: a rule meant for production code also hits tests unless it says `!$test`.
- `go list -deps` includes the standard library: filter to the module's own path.
- Two PRs that both lower a baseline conflict: regenerate the file, never hand-merge counts.
- A coverage floor breeds assertion-free tests: review new tests for assertions, not only for the number.
