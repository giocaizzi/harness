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
