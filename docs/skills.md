# Writing skills

The skills here follow [The new rules of context engineering for Claude 5 generation models](https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/) (Thariq Shihipar, July 2026). The spec a `SKILL.md` must pass is [agentskills.io](https://agentskills.io/specification), checked by `make validate`.

## Rules

- **A guide, not a rulebook.** A skill helps the agent find what it needs and leaves the rest to its judgement. Keep hard rules for the places where a mistake is costly.
- **Opinions only.** Write down what is particular to us (conventions, choices, gotchas). Leave out what the model already knows or can read from the repo.
- **No conflicting instructions.** Two rules that pull in different directions cost more than either one is worth. Before adding a rule, check that no other skill or `AGENTS.md` contradicts it.
- **Interfaces over examples.** Examples narrow what the agent tries. Make the scripts, make targets and parameters a skill points to expressive enough that no worked example is needed.
- **Progressive disclosure.** Keep `SKILL.md` short and move detail to `references/` or `scripts/`, which the agent loads only when it needs them. A separate step, such as verification or review, gets its own skill.
- **Say a thing once.** Usage instructions go in one place, such as the script or the skill description, and are not repeated elsewhere.
- **Rich references.** Point to code, tests or a rubric instead of describing them in prose.

## Evals

Each skill that should fire without being named gets a case in `plugins/<plugin>/evals/<skill>-trigger/`: `case.yaml` (tag `trigger`, a realistic prompt that does not name the skill), `scaffold.sh` (a tiny git repo built in a throwaway dir) and `graders/skill-fired.md` (`tool_used: Skill` matching the skill). A case that does not fire is a gap in the skill description: improve the prompt once, then open an issue for the description rather than dropping the case.

A skill step that must hold in a given state gets a behavior case beside them, `plugins/<plugin>/evals/<skill>-<step>/` with tag `behavior`: the scaffold also writes the state the step reads (for example a ticket snapshot), and an `llm` grader lists what the answer must do.

Routing cases (tag `routing`, `plugins/dev-tools/evals/driver-*`) check that judgement work reaches the `driver` agent and that the driver returns the user's decisions as open questions. Run them on each session model a hub may use: `make eval PLUGIN=dev-tools TAG=routing MODEL=sonnet`, then `MODEL=opus`.

`make eval [PLUGIN=<plugin>] [TAG=trigger] [MODEL=<model>] [MAX_COST=<usd>]` runs them with `claude plugin eval <plugin> --tag <TAG> --ablation none --scaffold --trust-plugin --no-publish` (`--model` when `MODEL` is set), for every plugin with an `evals/` directory or for one. Run it by hand: it calls a model (about $0.15 per run, 3 runs per case) and is not part of `make check` or CI. Results land in `plugins/<plugin>/evals/results/` (git-ignored); `--no-publish` keeps the HTML report local.
