.PHONY: help check lint test build validate new-agent new-skill clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Generate per-plugin agent files and Copilot manifests from sources.
	@uv run python scripts/build_agents.py

validate: ## Run all repo invariant checks (build sync, manifests, skills, marketplace, README).
	@uv run python scripts/validate.py

check: lint test ## Standard entrypoint: lint + test.

SH := $(wildcard plugins/*/skills/*/scripts/*.sh tests/*.sh)

lint: validate ## Repo invariant checks, plus shellcheck and PSScriptAnalyzer when installed.
	@if command -v shellcheck >/dev/null; then shellcheck $(SH); else echo "shellcheck not found, skipped"; fi
	@if command -v pwsh >/dev/null && pwsh -NoProfile -Command 'exit !(Get-Module -ListAvailable PSScriptAnalyzer)'; then \
		pwsh -NoProfile -Command '$$r = Invoke-ScriptAnalyzer -Path . -Recurse; $$r; exit $$r.Count'; \
	else echo "pwsh or PSScriptAnalyzer not found, skipped"; fi

test: ## Run the plugins' hook tests (Node 22+), their mod tests (`claude plugin test`), then the skill script tests.
	@node --test $(wildcard plugins/*/core/*.test.mjs plugins/*/hooks/*.test.mjs)
	@for d in $(sort $(dir $(patsubst %/,%,$(dir $(wildcard plugins/*/tests/*.test.ts))))); do claude plugin test $$d || exit 1; done
	@bash tests/heavy.test.sh
	@if command -v pwsh >/dev/null; then pwsh -NoProfile -File tests/heavy.test.ps1; else echo "pwsh not found, heavy.ps1 tests skipped"; fi

new-agent: ## Scaffold src/agents/<NAME>/.  Usage: make new-agent NAME=<name> PLUGIN=<plugin>
	@scripts/new-agent.sh "$(NAME)" "$(PLUGIN)"

new-skill: ## Scaffold plugins/<PLUGIN>/skills/<NAME>/SKILL.md.  Usage: make new-skill PLUGIN=<plugin> NAME=<name>
	@scripts/new-skill.sh "$(PLUGIN)" "$(NAME)"

clean: ## Remove all generated agent files and Copilot manifests.
	@find plugins -type f -path '*/agents/*.md' -delete
	@find plugins -type f -path '*/copilot/*.agent.md' -delete
	@find plugins -type f -path '*/.github/plugin/plugin.json' -delete
	@echo "Removed generated files."
