.PHONY: help build validate new-agent new-skill clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Generate per-plugin agent files and Copilot manifests from sources.
	@uv run python scripts/build_agents.py

validate: ## Run all repo invariant checks (build sync, manifests, skills, marketplace, README).
	@uv run python scripts/validate.py

new-agent: ## Scaffold src/agents/<NAME>/.  Usage: make new-agent NAME=<name> PLUGIN=<plugin>
	@scripts/new-agent.sh "$(NAME)" "$(PLUGIN)"

new-skill: ## Scaffold plugins/<PLUGIN>/skills/<NAME>/SKILL.md.  Usage: make new-skill PLUGIN=<plugin> NAME=<name>
	@scripts/new-skill.sh "$(PLUGIN)" "$(NAME)"

clean: ## Remove all generated agent files and Copilot manifests.
	@find plugins -type f -path '*/agents/*.md' -delete
	@find plugins -type f -path '*/copilot/*.agent.md' -delete
	@find plugins -type f -path '*/.github/plugin/plugin.json' -delete
	@echo "Removed generated files."
