# Reading the review

| Section | Act when |
|---|---|
| Cost by harness and model | A harness or model grows without a reason; compare with the budget. |
| Claude Code cost by source | `hook_prompt`, `away_summary` or `prompt_suggestion` are a large share: background spend no task asked for. |
| hook_prompt by plugin | A plugin's row is a large share: its mod forks the session (`$.model.fork`) or runs a prompt hook, each a full-context request on the session's model. A fork stays on the session's model to share its cache, so cut its triggers (a mod option such as a minimum answer length) or disable it. For a `type: prompt` or `agent` hook, pin a cheaper model on the hook or disable it. An empty plugin is a session on Claude Code before 2.1.310, which did not label these requests: match the sessions' dates against when a mod was enabled. |
| Subagent routing | Subagent spend on Opus or Fable is high: lookups belong on Haiku, routine edits on Sonnet (`subagent-orchestration`). |
| Routing shape | Fewer than 1.5 workers per driver, under half of the workers spawned by a driver, drivers making over 30% of subagent edits or a median above 3 edits each: drivers edit instead of fanning out to `worker`s (`subagent-orchestration`, the driver prompt). Track Opus per driver against the previous window: it should fall as edits move to workers. |
| LSP share | With at least 30 searches in the window, the share is below 5% for `main`, `driver`, `scout`, `worker` or `reviewer`, or one of them has 0 LSP calls: agents grep for symbols instead of using the LSP tool. First check the language servers start (Claude Code `/plugin` errors, `lspOps` failures above 10% mean a broken server), then the agent prompts, skills and the guard `lsp` hint. |
| Reviewer tier | Under 80% of reviewers on Sonnet: hubs raise the reviewer for routine changes; `model: opus` with `effort: high` belongs only to the sensitive-review set. |
| Effort high | A row for any agent outside the reviewers and verifiers (`reviewer`, `api-reviewer`, `verifier`): a spawn raised its effort where the routing table does not. |
| agent_summary share | Above 10% of subagent spend: the background summaries of running subagents, priced on each subagent's model; long Opus drivers drive it. |
| By plugin version | Against the previous version, cost per session or the Opus share of subagent cost rises, workers per driver falls, or effort high+ or agent_summary share rises: a dev-tools change (agent prompts, routing rules) moved routing; read that version's changes. `(unknown)` large: sessions on a guard without `guard.session` or started before the window; only Claude Code sessions are joined. |
| Subagent cost by agent | Spend without an agent id is agent-team teammates: with agent teams on, a named spawn becomes a teammate that telemetry cannot tie to an agent. Turn agent teams off, or name a spawn only when you will message it. |
| Spawns with no model pinned | Any row: the spawn ran on the session's model. Fix the skill or brief that spawned it. |
| Model swaps | Any row: a subagent finished on a fallback model; a factory run records it as a routing deviation. |
| Skills: never loaded | Not used in the window. Keep a skill at least 30 days before pruning it; check it is still installed. |
| Skills: never picked by the model | Loaded only when typed or by another skill: its description does not trigger. Write a trigger eval (below), then rework the description ([docs/skills.md](../../../../docs/skills.md)). |
| Guard reminders | A rule reminds often: the matching skill's description misses that situation, or the read hint fires for commands a read tool cannot replace. |
| Guard decisions | An ask the user always approves is a false positive; fix the rule in `plugins/guard/core/rules.mjs` with a test, and add the command (paraphrased, no private values) as a row in `plugins/guard/core/corpus.json`. A risky command that ran with no ask is a row too. |
| Guard asks answered | `timeout` or `unavailable` is a large share of asks: the asks land while the user is away; look at which rule asks (decisions, `via`) before raising the timeout. A rule whose asks are nearly all `allow` is a false positive. |
| Manual approvals | A tool approved often by hand is a candidate for an allow rule in the harness settings. |
| Failing shell commands | A tool that is missing, a wrong flag, or reads done through the shell. |
| PR graph | Should-have-been-stacked pairs are above 0 or rise, or the stacked share falls: dependent PRs were opened against the default branch instead of as a stack (`github-workflow`, the guard `stack` hint). Manifest-only pairs are parallel PRs bumping the same version, which the versioning rules handle, not stacking. |

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
