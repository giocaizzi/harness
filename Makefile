.PHONY: help check lint typecheck format format-check test e2e install build validate new-agent new-skill clean agent-review pr-graph ci-health eval

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Compile TypeScript, then generate plugins/*/.generated and plugin manifests.
	@npm run build:typescript
	@uv run python scripts/build_agents.py

validate: ## Run all repo invariant checks (build sync, manifests, skills, marketplace, README).
	@uv run python scripts/validate.py

check: lint typecheck test ## Standard entrypoint: lint + typecheck + test.

typecheck: ## Type-check the TypeScript sources without emitting runtime files.
	@npm run typecheck

format: ## Format TypeScript source and TypeScript tooling configuration.
	@npm run format

format-check: ## Check TypeScript source and TypeScript tooling formatting.
	@npm run format:check

# cmd.exe recipes only when make runs them through cmd; with sh on PATH (Git for Windows) the POSIX ones work.
WIN_CMD := $(if $(filter Windows_NT,$(OS)),$(if $(filter sh sh.exe bash bash.exe,$(notdir $(SHELL))),,1))

SH := $(wildcard plugins/*/skills/*/scripts/*.sh tests/*.sh)

lint: validate ## Repo invariant checks, plus shellcheck and PSScriptAnalyzer when installed.
	@npm run lint:typescript
	@npm run format:check
ifneq ($(WIN_CMD),)
	@where shellcheck >nul 2>nul & if errorlevel 1 (echo shellcheck not found, skipped) else (shellcheck --exclude=SC1017,SC1091,SC1103,SC2183 $(SH))
	@where pwsh >nul 2>nul & if errorlevel 1 (echo pwsh or PSScriptAnalyzer not found, skipped) else (pwsh -NoProfile -Command "$$r = Get-Module -ListAvailable PSScriptAnalyzer; if ($$null -eq $$r) { Write-Output 'PSScriptAnalyzer not found, skipped'; exit 0 }; $$result = Invoke-ScriptAnalyzer -Path . -Recurse; $$result; exit $$result.Count")
else
	@if command -v shellcheck >/dev/null; then shellcheck $(SH); else echo "shellcheck not found, skipped"; fi
	@if command -v pwsh >/dev/null && pwsh -NoProfile -Command 'exit !(Get-Module -ListAvailable PSScriptAnalyzer)'; then \
		pwsh -NoProfile -Command '$$r = Invoke-ScriptAnalyzer -Path . -Recurse; $$r; exit $$r.Count'; \
	else echo "pwsh or PSScriptAnalyzer not found, skipped"; fi
endif

# Tests and probes never post to a real collector, whatever the shell exports (GUARD_OTEL=off, core/otel.mjs),
# nor append fake decisions to a factory run's events file.
test: export GUARD_OTEL := off
test: export FACTORY_EVENTS_FILE :=
test: ## Run the plugins' hook tests (Node 22+), their mod tests (`claude plugin test`), then the skill script tests.
	@node --test $(wildcard plugins/*/core/*.test.mjs plugins/*/hooks/*.test.mjs plugins/*/pi/*.test.mjs tests/*.test.mjs)
ifneq ($(WIN_CMD),)
	@pwsh -NoProfile -Command "$$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'; $$dirs = Get-ChildItem -Path plugins -Recurse -Filter *.test.ts | ForEach-Object { Split-Path $$_.DirectoryName -Parent } | Sort-Object -Unique; foreach ($$dir in $$dirs) { claude plugin test $$dir; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE } }"
else
	@for d in $(sort $(patsubst %/tests/,%,$(dir $(wildcard plugins/*/tests/*.test.ts)))); do CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test $$d || exit 1; done
endif
ifneq ($(WIN_CMD),)
	@where bash >nul 2>nul & if errorlevel 1 (echo bash not found, host-hygiene .sh tests skipped) else (bash tests/host-hygiene.test.sh)
	@where pwsh >nul 2>nul & if errorlevel 1 (echo pwsh not found, host-hygiene .ps1 tests skipped) else (pwsh -NoProfile -File tests/host-hygiene.test.ps1)
else
	@bash tests/host-hygiene.test.sh
	@if command -v pwsh >/dev/null; then pwsh -NoProfile -File tests/host-hygiene.test.ps1; else echo "pwsh not found, host-hygiene .ps1 tests skipped"; fi
endif

e2e: ## Drive each installed harness CLI (Copilot CLI, Codex, opencode, pi) against a scripted model in a throwaway home.
	@node tests/e2e/run.mjs

eval: ## Run the plugins' skill evals (calls a model, costs money, not part of check or CI).  Usage: make eval [PLUGIN=<plugin>] [TAG=trigger|routing] [MODEL=<model>] [RUNS=<n>] [ALLOW=<tools>] [MAX_COST=<usd>]
	@for d in $(if $(PLUGIN),plugins/$(PLUGIN),$(patsubst %/evals/,%,$(sort $(dir $(wildcard plugins/*/evals/))))); do \
		test -d $$d/evals || { echo "$$d has no evals/"; exit 1; }; \
		echo "== $$d"; claude plugin eval $$d --tag $(or $(TAG),trigger) --ablation none --scaffold --trust-plugin --no-publish $(if $(MODEL),--model $(MODEL)) $(if $(RUNS),--runs $(RUNS)) $(if $(ALLOW),--allow-tools $(ALLOW)) $(if $(MAX_COST),--max-cost-usd $(MAX_COST)) || exit 1; \
	done

agent-review: ## Weekly agent telemetry review from Loki (docs/agent-review.md).  Usage: make agent-review [RANGE=7d] [EVALS=<dir>]
	@node scripts/agent-review.mjs --range $(or $(RANGE),7d) $(if $(EVALS),--evals $(EVALS))

pr-graph: ## PR graph: PR size and pace, stacked share and should-have-been-stacked pairs across every repo gh can reach (docs/agent-review.md).  Usage: make pr-graph [RANGE=30d]
	@node scripts/pr-graph.mjs --range $(or $(RANGE),30d)

ci-health: ## CI health: run counts, run time, queue, re-runs, flakes and a workflow audit, this window vs the one before (docs/agent-review.md).  Usage: make ci-health [RANGE=30d]
	@node scripts/ci-health.mjs --range $(or $(RANGE),30d)

install: ## Install what Codex, opencode and Antigravity cannot take from the marketplace.  Usage: make install HARNESS="codex opencode antigravity"
	@node scripts/install.mjs $(or $(HARNESS),codex opencode antigravity)

new-agent: ## Scaffold plugins/<PLUGIN>/agents/<NAME>.md and .yaml.  Usage: make new-agent NAME=<name> PLUGIN=<plugin>
	@scripts/new-agent.sh "$(NAME)" "$(PLUGIN)"

new-skill: ## Scaffold plugins/<PLUGIN>/skills/<NAME>/SKILL.md.  Usage: make new-skill PLUGIN=<plugin> NAME=<name>
	@scripts/new-skill.sh "$(PLUGIN)" "$(NAME)"

clean: ## Remove all generated files (plugins/*/.generated, per-harness manifests).
	@rm -rf plugins/*/.generated
	@find plugins -type f \( -path '*/.github/plugin/plugin.json' -o -path '*/.codex-plugin/plugin.json' -o -path '*/.antigravity-plugin/plugin.json' \) -delete
	@echo "Removed generated files."
