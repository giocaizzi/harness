# Group runs

A group run works several approved tickets in one session and ships at most one PR for them. Each ticket is a **member**: a subagent works it from a **member brief** and hands back a **member result**; the run turns each member result into one entry of `result.json`'s `tasks` ([result.md](result.md), `tasks`). A runtime starts a group run; an attended `ticket-run` works one ticket and writes no `tasks`.

- **Lead.** The run's `ticket` (`FACTORY_TICKET`) is the group's lead and the first entry of `tasks`; `result.json` sits under its number. Every member passed the gate and is claimed under the run's `run_id` before its brief is written.
- **Handoffs are files.** The run writes each brief to `.factory/runs/<lead>/members/<number>.brief.json` before it spawns the member, and writes the member's final message (the result as JSON text) verbatim to `.factory/runs/<lead>/members/<number>.result.json`. A runtime validates both with `scripts/check-handoff.mjs`.
- **A malformed handoff parks only that member.** A brief or result that fails the check, or a member that returned no JSON, becomes a `parked` entry with `reason_code: handoff` and the first error as its `reason`; the other members go on. `check-handoff.mjs`'s `memberTask` makes that entry.
- **Released means unchanged.** A `released` member goes back to the queue as it was before the run: the runtime releases its claim (removes the claim label) as at any run end, and the member gets no result comment, no `needs-owner` and no other label or comment from the run.
- **No done member ships nothing.** When no entry is `done`, the run opens no PR (`pr` is `null`, every `pr_link` is `null`), `end_state` is not `done`, and `reason` says why no member finished.
- **One PR.** The PR carries every `done` member's branch and names each member per its entry's `pr_link`: `Closes #N` for `closes` (done), `Refs #N` for `refs` (parked or released).

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
| `checks` | array | `{command, result}` per check run, `result` one of `pass`, `fail`, `not_run` (with a `note` on why); none is `fail` when `done`. |
