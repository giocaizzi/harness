.PHONY: help check lint test e2e install build validate new-agent new-skill clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Generate per-plugin agents and per-harness manifests (Copilot, Codex) from sources.
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
	@node --test $(wildcard plugins/*/core/*.test.mjs plugins/*/hooks/*.test.mjs plugins/*/pi/*.test.mjs tests/*.test.mjs)
	@for d in $(sort $(dir $(patsubst %/,%,$(dir $(wildcard plugins/*/tests/*.test.ts))))); do claude plugin test $$d || exit 1; done
	@bash tests/host-hygiene.test.sh
	@if command -v pwsh >/dev/null; then pwsh -NoProfile -File tests/host-hygiene.test.ps1; else echo "pwsh not found, host-hygiene .ps1 tests skipped"; fi

e2e: ## Drive each installed harness CLI (Codex, opencode, pi) against a scripted model in a throwaway home.
	@node tests/e2e/run.mjs

install: ## Install what Codex and opencode cannot take from the marketplace.  Usage: make install HARNESS="codex opencode"
	@node scripts/install.mjs $(or $(HARNESS),codex opencode)

new-agent: ## Scaffold src/agents/<NAME>/.  Usage: make new-agent NAME=<name> PLUGIN=<plugin>
	@scripts/new-agent.sh "$(NAME)" "$(PLUGIN)"

new-skill: ## Scaffold plugins/<PLUGIN>/skills/<NAME>/SKILL.md.  Usage: make new-skill PLUGIN=<plugin> NAME=<name>
	@scripts/new-skill.sh "$(PLUGIN)" "$(NAME)"

clean: ## Remove all generated agent files and per-harness manifests.
	@find plugins -type f -path '*/agents/*.md' -delete
	@find plugins -type f -path '*/copilot/*.agent.md' -delete
	@find plugins -type f -path '*/.github/plugin/plugin.json' -delete
	@find plugins -type f \( -path '*/codex/*.toml' -o -path '*/opencode/*.md' -o -path '*/.codex-plugin/plugin.json' -o -path '*/hooks/codex.json' \) -delete
	@echo "Removed generated files."
