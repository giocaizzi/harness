# Runbook template

Location: `docs/RUNBOOKS/<verb>-<thing>.md` (for example `restore-database.md`, `rotate-token.md`). One procedure per file, linked from `AGENTS.md` or the docs index.

```markdown
# <Verb> <thing>

**When:** the situation that calls for this procedure (and what it is not for).
**Preconditions:** access, tools, approvals, and anything that must be true first.

## Steps
1. One action per step, with the real command, copy-pasteable.
2. ...

## Verify
How you know it worked: the command and the expected output.

## Rollback
How to undo it, or "irreversible" and the consequence.

**Last verified:** YYYY-MM-DD by <who or what>
```

Rules:
- Commands come from the repo, its CI or its scripts; don't invent steps. Mark anything unverified as such.
- No secrets in a runbook. Say where the value lives and how to fetch it (see `secrets-handling`).
- Update the runbook in the same change that alters the procedure, and refresh `Last verified`.
- Link to `docs/` for the why (decisions, architecture); the runbook holds only the how.
