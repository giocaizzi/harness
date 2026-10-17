# Agent review

An on-demand review of agent telemetry: what the agents cost, which skills get used, where the guard had to remind, how subagents were routed and which commands keep failing. Run it weekly, act on what it shows, and turn skill misses into description evals.

## Prerequisites

- Telemetry reaching Loki: Claude Code OTel logs (`service_name="claude-code"`) and the guard's decision log (`service_name="guard"`, [guard.md](guard.md)). Codex, Copilot, opencode and pi records add to the cost section when the collector maps them to `agent_event="api_request"`.
- Read access to Loki, from the environment (the script never prints it):
  - `GRAFANA_URL` and `GRAFANA_TOKEN` (a Grafana service-account token with Viewer role) to query through Grafana; `LOKI_UID` if the Loki datasource uid is not `loki`; or
  - `LOKI_URL`, plus `LOKI_HEADERS` (`Key=Value,Key2=Value2`) when Loki needs auth.
  Keep the token in your secret store and export it from there, never in a file in this repo.
- Node 22+.

## Run

```sh
make agent-review                        # last 7 days, Markdown to stdout
make agent-review RANGE=30d > review.md  # longer window (Loki retention permitting)
make agent-review EVALS=/tmp/evals       # also write eval stubs (below)
```

## Read the report

| Section | Act when |
|---|---|
| Cost by harness and model | A harness or model grows without a reason; compare with the budget. |
| Claude Code cost by source | `hook_prompt`, `away_summary` or `prompt_suggestion` are a large share: background spend no task asked for. |
| Subagent routing | Subagent spend on Opus or Fable is high: lookups belong on Haiku, routine edits on Sonnet (`subagent-orchestration`). |
| Skills: never loaded | Not used in the window. Keep a skill at least 30 days before pruning it; check it is still installed. |
| Skills: never picked by the model | Loaded only when typed or by another skill: its description does not trigger. Write an eval (below), then rework the description ([skills.md](skills.md)). |
| Guard reminders | A rule reminds often: the matching skill's description misses that situation, or the read hint fires for commands a read tool cannot replace. |
| Guard decisions | An ask the user always approves is a false positive; fix the rule in `plugins/guard/core/rules.mjs` with a test. |
| Manual approvals | A tool approved often by hand is a candidate for an allow rule in the harness settings. |
| Failing shell commands | A tool that is missing, a wrong flag, or reads done through the shell. |

File each action as a GitHub issue, or fix it in a PR the same day.

## Description evals

`EVALS=<dir>` writes one case per skill the model never picked itself, laid out as `<plugin>/evals/<skill>-trigger/`:

- `prompt.md`: a placeholder. Replace it with a request phrased the way a user would type it, without naming the skill and without private values.
- `graders/skill-fired.md`: a `tool_used` grader that passes when the `Skill` tool loads that skill.

Copy the cases you finish into `plugins/<plugin>/evals/`, then run from the plugin directory:

```sh
claude plugin eval . --tag trigger --ablation none
```

`--ablation none` scores the trigger itself; under the default with/without ablation a `Skill` grader is only reported as an indicator. A case that fails points at the description: reword it, rerun, and commit the case with the fix so the next review catches a regression.
