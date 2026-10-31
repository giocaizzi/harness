# Group runs

A group run works several approved tickets in one session and ships at most one PR for them. Each ticket is a **member**: a subagent works it from a **member brief** and hands back a **member result**; the run turns each member result into one entry of `result.json`'s `tasks` ([result.md](result.md), `tasks`). A runtime starts a group run; an attended `ticket-run` works one ticket and writes no `tasks`.

- **Lead.** The run's `ticket` (`FACTORY_TICKET`) is the group's lead and the first entry of `tasks`; `result.json` sits under its number. Every member passed the gate and is claimed under the run's `run_id` before its brief is written.
- **The run file names the members.** The run reads its members, lead first, from the run file ([Run file](#run-file)).
- **Handoffs are files.** The run writes each brief to `.factory/runs/<lead>/members/<number>.brief.json` before it spawns the member, and writes the member's final message (the result as JSON text) verbatim to `.factory/runs/<lead>/members/<number>.result.json`. A runtime validates both with `scripts/check-handoff.mjs`; its `brief` and `result` modes, like `memberTask`, reject a brief whose `run_id` differs from `FACTORY_RUN_ID` when that is set.
- **A malformed handoff parks only that member.** A brief or result that fails the check, or a member that returned no JSON, becomes a `parked` entry with `reason_code: handoff` and the first error as its `reason`; the other members go on. `check-handoff.mjs`'s `memberTask` makes that entry.
- **Released means unchanged.** A `released` member goes back to the queue as it was before the run: the runtime releases its claim (removes the claim label) as at any run end, and the member gets no result comment, no `needs-owner` and no other label or comment from the run.
- **The run's end state follows its members.** `end_state` is `done` only when every entry is `done` or `released` and at least one is `done`; else `parked` when any entry is `parked` (a shipped PR does not make the run `done` while a member waits on the owner); else `failed`. A runtime's or budget's stop (`halted`, `budget_reached`) stands in for it only when not every member finished. `check-result.mjs` rejects any other `end_state`, and `write-result.mjs` refuses to write it (it checks, it does not fill the value).
- **No done member ships nothing.** When no entry is `done`, the run opens no PR (`pr` is `null`, every `pr_link` is `null`), `end_state` is not `done`, and `reason` says why no member finished.
- **No subagent.** Where a harness runs no subagent, each member runs as a separate session given its brief, in the foreground, its last message the member result, and started with `GUARD_RESULT_GATE=off` in its environment: it inherits the run's factory variables, and without it the `guard` plugin's stop hook would hold the member until the lead's `result.json` is valid and use up the run's two blocks. A member subagent told by that hook that the result file is invalid ignores it and ends its turn. On Codex the hook cannot tell a subagent's stop apart, so member subagents there can use up the two blocks and the lead is not held to a valid file: the lead runs the Record steps and checks the file itself.
- **One PR.** The PR carries every `done` member's branch and names each member per its entry's `pr_link`: `Closes #N` for `closes` (done), `Refs #N` for `refs` (parked); a released member is not named in the PR.

## Run file

The multi-task brief a runtime hands the run, one JSON object in the file named by `FACTORY_RUN_FILE`; check it with `scripts/check-handoff.mjs run`:

| Key | Type | Meaning |
|---|---|---|
| `schema` | integer | Run file format, `1`. |
| `run_id` | string | The group run's `run_id`; equal to `FACTORY_RUN_ID` when that is set. |
| `lead` | string | The lead, `<owner>/<repo>#<number>`; equal to `FACTORY_TICKET` when that is set. |
| `members` | array | Non-empty: one `{ticket}` object per member (that key only), each `<owner>/<repo>#<number>`, all in one repo, the lead's, and no number twice (compared ignoring case), the lead first. |

The members' order is the order of `tasks`: with `FACTORY_RUN_FILE` set, `check-result.mjs` (and so `write-result.mjs` and the guard plugin's result gate) rejects `tasks` whose tickets are not the members' tickets, exactly and in that order, and a run file it cannot read; it also rejects a result without `tasks` (schema 2) unless the run stopped at the gate (`phases` holding `gate` alone, never `done`), so a group run cannot record itself as a single ticket. A relative `FACTORY_RUN_FILE` is read from the session directory: the result gate resolves it against the session's `cwd`, and `write-result.mjs` against its own working directory, so the run calls it from the session directory.

## Member brief

`<number>.brief.json`, one JSON object:

| Key | Type | Meaning |
|---|---|---|
| `handoff` | `member_brief` | What the file is. |
| `version` | integer | Handoff format, `1`. |
| `run_id` | string | The group run's `run_id`. |
| `ticket` | string | The member, `<owner>/<repo>#<number>`. |
| `worktree` | string | Absolute path of the worktree the member works in. |
| `branch` | string | The member's branch, checked out in `worktree`. |
| `base` | string | The 40-hex commit `branch` starts from. |
| `brief` | string | Non-empty: the member's goal, acceptance checks and the command-form rule ([routing.md](routing.md#waiting-and-briefs)). |

## Member result

`<number>.result.json`, one JSON object, the member's final message:

| Key | Type | Meaning |
|---|---|---|
| `handoff` | `member_result` | What the file is. |
| `version` | integer | Handoff format, `1`. |
| `run_id` | string | Equal to the brief's. |
| `ticket` | string | Equal to the brief's. |
| `outcome` | `done` \| `parked` \| `released` | `done`: the member's acceptance checks pass on `head`. `parked`: it waits on the owner (`reason_code` says on what). `released`: the run gives it back to the queue unworked or abandoned. |
| `reason` | string | Empty when `done`; non-empty otherwise. |
| `reason_code` | string \| null | `null` when `done`; one of `result.md`'s codes when `parked`; `null` or one of them when `released`. |
| `branch` | string | Equal to the brief's. |
| `head` | string \| null | The 40-hex commit the member ends on; required when `done`, else the WIP commit or `null`. |
| `checks` | array | `{command, result}` per check run, `result` one of `pass`, `fail`, `not_run` (with a `note` on why); none is `fail` and at least one is `pass` when `done`. |
