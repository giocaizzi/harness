# Reading the review

| Section | Act when |
|---|---|
| Cost by harness and model | A harness or model grows without a reason; compare with the budget. |
| Claude Code cost by source | `hook_prompt`, `away_summary` or `prompt_suggestion` are a large share: background spend no task asked for. |
| Subagent routing | Subagent spend on Opus or Fable is high: lookups belong on Haiku, routine edits on Sonnet (`subagent-orchestration`). |
| Skills: never loaded | Not used in the window. Keep a skill at least 30 days before pruning it; check it is still installed. |
| Skills: never picked by the model | Loaded only when typed or by another skill: its description does not trigger. Write a trigger eval (below), then rework the description ([docs/skills.md](../../../../docs/skills.md)). |
| Guard reminders | A rule reminds often: the matching skill's description misses that situation, or the read hint fires for commands a read tool cannot replace. |
| Guard decisions | An ask the user always approves is a false positive; fix the rule in `plugins/guard/core/rules.mjs` with a test, and add the command (paraphrased, no private values) as a row in `plugins/guard/core/corpus.json`. A risky command that ran with no ask is a row too. |
| Manual approvals | A tool approved often by hand is a candidate for an allow rule in the harness settings. |
| Failing shell commands | A tool that is missing, a wrong flag, or reads done through the shell. |

File each action as a GitHub issue, or fix it in a PR the same day.

## Trigger evals

One case per skill the model never picks itself, in `plugins/<plugin>/evals/<skill>-trigger/` (`make agent-review EVALS=<dir>` writes the stubs):

- `prompt.md`: a request phrased the way a user would type it, without naming the skill and without private values; frontmatter `max_turns: 10`, `allowed_tools: [Read, Glob, Grep, Skill]`, `tags: [trigger]`.
- `graders/skill-fired.md`: `type: tool_used`, `tool: Skill`, `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?<skill>"'`.

Run from the plugin directory:

```sh
claude plugin eval . --tag trigger --ablation none
```

A skill that fires only mid-task (editing code, not answering a question) needs a repo to work in: write `case.yaml` with the prompt under `execution` and `context.scaffold_script: scaffold.sh`, a script that builds the repo in its working directory (a top-level `scaffold_script` is silently ignored), and add `Edit` and `Write` to `allowed_tools`. Run it with `--scaffold --allow-tools Edit Write`. Example: `plugins/dev-tools/evals/docs-sync-trigger/`.

`--ablation none` scores the trigger itself; under the default with/without ablation a `Skill` grader is only reported as an indicator. A case that fails points at the description: reword it, rerun, and commit the case with the fix so the next review catches a regression.
