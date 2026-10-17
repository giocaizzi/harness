.PHONY: help check lint test e2e install build validate new-agent new-skill clean agent-review

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Generate plugins/*/.generated (Copilot, Codex, opencode) and the Copilot and Codex manifests.
	@uv run python scripts/build_agents.py

validate: ## Run all repo invariant checks (build sync, manifests, skills, marketplace, README).
	@uv run python scripts/validate.py

check: lint test ## Standard entrypoint: lint + test.

SH := $(wildcard plugins/*/skills/*/scripts/*.sh tests/*.sh)

lint: validate ## Repo invariant checks, plus shellcheck and PSScriptAnalyzer when installed.
ifeq ($(OS),Windows_NT)
	@where shellcheck >nul 2>nul & if errorlevel 1 (echo shellcheck not found, skipped) else (shellcheck --exclude=SC1017,SC1091,SC1103,SC2183 $(SH))
	@where pwsh >nul 2>nul & if errorlevel 1 (echo pwsh or PSScriptAnalyzer not found, skipped) else (pwsh -NoProfile -Command "$$r = Get-Module -ListAvailable PSScriptAnalyzer; if ($$null -eq $$r) { Write-Output 'PSScriptAnalyzer not found, skipped'; exit 0 }; $$result = Invoke-ScriptAnalyzer -Path . -Recurse; $$result; exit $$result.Count")
else
	@if command -v shellcheck >/dev/null; then shellcheck $(SH); else echo "shellcheck not found, skipped"; fi
	@if command -v pwsh >/dev/null && pwsh -NoProfile -Command 'exit !(Get-Module -ListAvailable PSScriptAnalyzer)'; then \
		pwsh -NoProfile -Command '$$r = Invoke-ScriptAnalyzer -Path . -Recurse; $$r; exit $$r.Count'; \
	else echo "pwsh or PSScriptAnalyzer not found, skipped"; fi
endif

test: ## Run the plugins' hook tests (Node 22+), their mod tests (`claude plugin test`), then the skill script tests.
	@node --test $(wildcard plugins/*/core/*.test.mjs plugins/*/hooks/*.test.mjs plugins/*/pi/*.test.mjs tests/*.test.mjs)
ifeq ($(OS),Windows_NT)
	@pwsh -NoProfile -Command "$$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'; $$dirs = Get-ChildItem -Path plugins -Recurse -Filter *.test.ts | ForEach-Object { Split-Path $$_.DirectoryName -Parent } | Sort-Object -Unique; foreach ($$dir in $$dirs) { claude plugin test $$dir; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE } }"
else
	@for d in $(sort $(patsubst %/tests/,%,$(dir $(wildcard plugins/*/tests/*.test.ts)))); do CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test $$d || exit 1; done
endif
ifeq ($(OS),Windows_NT)
	@where bash >nul 2>nul & if errorlevel 1 (echo bash not found, host-hygiene .sh tests skipped) else (bash tests/host-hygiene.test.sh)
	@where pwsh >nul 2>nul & if errorlevel 1 (echo pwsh not found, host-hygiene .ps1 tests skipped) else (pwsh -NoProfile -File tests/host-hygiene.test.ps1)
else
	@bash tests/host-hygiene.test.sh
	@if command -v pwsh >/dev/null; then pwsh -NoProfile -File tests/host-hygiene.test.ps1; else echo "pwsh not found, host-hygiene .ps1 tests skipped"; fi
endif

e2e: ## Drive each installed harness CLI (Codex, opencode, pi) against a scripted model in a throwaway home.
	@node tests/e2e/run.mjs

agent-review: ## Weekly agent telemetry review from Loki (docs/agent-review.md).  Usage: make agent-review [RANGE=7d] [EVALS=<dir>]
	@node scripts/agent-review.mjs --range $(or $(RANGE),7d) $(if $(EVALS),--evals $(EVALS))

install: ## Install what Codex and opencode cannot take from the marketplace.  Usage: make install HARNESS="codex opencode"
	@node scripts/install.mjs $(or $(HARNESS),codex opencode)

new-agent: ## Scaffold plugins/<PLUGIN>/agents/<NAME>.md and .yaml.  Usage: make new-agent NAME=<name> PLUGIN=<plugin>
	@scripts/new-agent.sh "$(NAME)" "$(PLUGIN)"

new-skill: ## Scaffold plugins/<PLUGIN>/skills/<NAME>/SKILL.md.  Usage: make new-skill PLUGIN=<plugin> NAME=<name>
	@scripts/new-skill.sh "$(PLUGIN)" "$(NAME)"

clean: ## Remove all generated files (plugins/*/.generated, per-harness manifests).
	@rm -rf plugins/*/.generated
	@find plugins -type f \( -path '*/.github/plugin/plugin.json' -o -path '*/.codex-plugin/plugin.json' \) -delete
	@echo "Removed generated files."
