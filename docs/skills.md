# Writing skills

The skills and agents here follow two posts: [The new rules of context engineering for Claude 5 generation models](https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/) (Thariq Shihipar, July 2026) and [Lessons from building Claude Code: How we use skills](https://claude.dev/blog/lessons-from-building-claude-code-how-we-use-skills/) (June 2026). The spec a `SKILL.md` must pass is [agentskills.io](https://agentskills.io/specification), checked by `make validate`.

## Rules

- **A guide, not a rulebook.** A skill helps the agent find what it needs and leaves the rest to its judgement. Keep hard rules for the places where a mistake is costly.
- **Opinions only.** Write down what is particular to us (conventions, choices, gotchas). Leave out what the model already knows or can read from the repo.
- **No conflicting instructions.** Two rules that pull in different directions cost more than either one is worth. Before adding a rule, check that no other skill or `AGENTS.md` contradicts it.
- **Interfaces over examples.** Examples narrow what the agent tries. Make the scripts, make targets and parameters a skill points to expressive enough that no worked example is needed.
- **Progressive disclosure.** Keep `SKILL.md` short and move detail to `references/` or `scripts/`, which the agent loads only when it needs them. A separate step, such as verification or review, gets its own skill.
- **Say a thing once.** Usage instructions go in one place, such as the script or the skill description, and are not repeated elsewhere.
- **Rich references.** Point to code, tests or a rubric instead of describing them in prose.
- **A description is a trigger.** Write a skill's `description` for the model, saying when to load it, early enough to fire before the work starts; an agent's `description` is its interface: when to use it, when not, and what not to pass.
- **One category per skill.** A skill that mixes reference, policy and process confuses the agent: split it, or move the other parts to `references/`.
- **Gotchas.** Failure points go in a skill's `## Gotchas` section, one line per real failure, pruned once a model change makes a line obsolete: they are the highest-signal part of a skill.
- **Goals over scripts.** State the goal and the constraints; don't railroad steps the agent can order itself.

## Evals

Each skill that should fire without being named gets at least one positive case, each in `plugins/<plugin>/evals/<skill>-trigger/` or `<skill>-<situation>/` (for example `react-effect-loop/`): `case.yaml` (tag `trigger`, a realistic prompt that does not name the skill), `scaffold.sh` (a tiny git repo built in a throwaway dir) and `graders/skill-fired.md` (`tool_used: Skill` matching the skill). A case that does not fire is a gap in the skill description: improve the prompt once, then open an issue for the description rather than dropping the case.

A skill added or re-evaluated from now on gets at least two positive cases and a negative case, `plugins/<plugin>/evals/<skill>-negative/`: a nearby prompt it must stay quiet on, graded by the same `tool_used: Skill` grader with `min: 0` and `max: 0`. The count includes only calls matching `input_match`, so another skill firing does not fail it.

A skill step that must hold in a given state gets a behavior case beside them, `plugins/<plugin>/evals/<skill>-<step>/` with tag `behavior`: the scaffold also writes the state the step reads (for example a ticket snapshot), and an `llm` grader lists what the answer must do.

Routing cases (tag `routing`, `plugins/dev-tools/evals/routing-*`) check that the hub hands each kind of work to the right agent: a plan, a design, an investigation, a root-cause fix and a feature to `driver`, a cross-module lookup to `scout`, a fully specified edit never to `driver`, and a one-line question to no agent at all. Each grades the `Agent` call's `subagent_type`. Five carry `routing-dev`, the cases a description change is tuned on; the other four carry `routing-holdout` and are only measured, so a change that overfits the tuning cases shows. Run them on each session model a hub may use, with the tools a real session has: `make eval PLUGIN=dev-tools TAG=routing MODEL=sonnet ALLOW="Write Edit Bash"`, then `MODEL=opus`. An eval run loads only the plugin under test, never a `CLAUDE.md` (not even one a scaffold writes), so these cases measure the plugin alone; to measure a line of global instructions on top, copy the cases into another eval directory below the plugin with the line as `execution.append_system_prompt` (`schema_version: "1.1"`) and pass `--eval-dir`. `driver-open-question` (tag `behavior`) checks that the driver returns the user's decisions as open questions.

`make eval [PLUGIN=<plugin>] [TAG=trigger] [MODEL=<model>] [RUNS=<n>] [ALLOW=<tools>] [MAX_COST=<usd>]` runs them with `claude plugin eval <plugin> --tag <TAG> --ablation none --scaffold --trust-plugin --no-publish` (`--model`, `--runs`, `--allow-tools` when set), for every plugin with an `evals/` directory or for one. Run it by hand: it calls a model (about $0.15 per run, 3 runs per case) and is not part of `make check` or CI. Results land in `plugins/<plugin>/evals/results/` (git-ignored); `--no-publish` keeps the HTML report local.
