# Memory hygiene

Agent memory is context the next session trusts. Claude Code's docs say that when two instructions contradict each other the model may follow either arbitrarily, so a stale or conflicting memory is a host problem, not a tidiness one. Evidence: an audit of 13 memory dirs found append-style rewrites (a 41 KB "progress" file that ended "complete" and then listed next steps), memories that contradicted skills (a spawn rule forcing one model tier), one-off authorizations stored as permanent rules, and references to files and issues that no longer existed.

## Where memory lives

| Harness | Memory | Your lever |
|---|---|---|
| Claude Code | Auto memory, files you can edit: `~/.claude/projects/<project>/memory/`, a `MEMORY.md` index (first 200 lines or 25 KB load) plus one file per memory | `memory-lint.mjs`, `/memory`, `autoMemoryEnabled` |
| Copilot CLI | Copilot Memory (public preview): repository facts and user preferences kept by GitHub, shared with the cloud agent and code review, unused entries expire after 28 days | Review and delete in GitHub settings (repo owners, users) |
| Codex CLI | Opt-in generated state in `~/.codex/memories/`; not meant for hand edits | `/memories` per chat, `memories` flags in `config.toml`, delete in settings |
| opencode | None built in: `AGENTS.md` only (community plugins exist) | The instruction files |
| pi | None built in (community packages exist) | The instruction files |

Where a harness keeps no editable files, hygiene means keeping the facts that matter in `AGENTS.md` and the skills, where they are versioned, and pruning the harness's own store from its settings. Verified against each harness's docs in October 2026; recheck before relying on a detail.

## Write rules

- **One fact per file.** A file that needs "and also" is two memories.
- **Replace, don't append.** When a fact changes, rewrite the sentence that states it. No "Update:", "superseded", "previously"; git is the history, memory is the current state.
- **Status and progress go to issues or the repo**, not memory. A memory that says what is in flight is wrong by the next session.
- **A one-off authorization is not a rule.** "Merge all pending", "bypass once for this candidate" end with the task; never save them.
- **Conventions live in skills and `AGENTS.md`.** Memory holds what a repo cannot say: who the user is, corrections, where things are. Before saving, check no skill or instruction file says the opposite; if one does, fix the source instead.
- **Say why.** Lead with the rule, then the reason and when it applies, so a later session can judge an edge case.

## Unattended and drain runs

They never write memory. Sprint and overnight sessions wrote most of the accretion in the audit, and nobody was there to catch it. Put proposed changes (new, edited, delete, with the reason) in the final report; the owner or a supervised session applies them.

## Periodic audit (report only)

Run on a schedule or when behaviour surprises you; nothing is changed without the owner.

1. `node scripts/memory-lint.mjs [--repo <path>] [<memory-dir>...]` (Claude Code; defaults to every project's memory). It reports frontmatter and YAML problems, index not matching the files or over its limits, dangling links, oversized files, append-style wording and, with `--repo`, backticked paths that no longer exist. Tested by `tests/memory-lint.test.mjs`.
2. Read what the script cannot judge: stale references to issues, PRs and versions (check with `gh`), and contradictions with skills, `AGENTS.md` and the global instructions. `/doctor prompt-audit` in Claude Code does the same for instruction files.
3. Report findings as a list of file, problem, proposed fix. Delete or merge only on the owner's yes.
