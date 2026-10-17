---
name: docs-sync
description: Update docs, runbooks, README and AGENTS.md that the current diff made stale. Use when code, commands or procedures changed, or when the user types /docs-sync (optionally a path).
---

# Docs sync

Argument: an optional path to limit the scope. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

1. **Read the diff** (`git diff` against the default branch) and list what changed in behavior, commands, config, interfaces or procedures.
2. **Find the docs that describe them:** everything under `docs/`, the README, and `AGENTS.md`.
3. **Update only what is stale.** A changed operational procedure must change its runbook in `docs/` in the same PR; write one if none exists.
4. **Keep the split.** `AGENTS.md` is practical instructions for AI coding agents. `docs/` is the documentation: the source of truth for business decisions, details, infrastructure and architecture decisions, plus runbooks. Work in progress goes in `docs/wip/`, and a backlog in `docs/backlog/` only when GitHub issues do not fit. `AGENTS.md` links to docs, it does not duplicate them. `README.md` is the human quickstart and presentation (badges, quickstart, link to `docs/`); agent instructions never go there.

Report which files changed and why; say so when nothing was stale.

Runbooks follow the shape in [references/runbook-template.md](references/runbook-template.md): read it when writing or updating one.
