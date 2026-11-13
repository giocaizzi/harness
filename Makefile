.PHONY: help check lint typecheck format format-check test e2e contract-test install build validate new-agent new-skill clean agent-review pr-graph ci-health eval eval-record eval-scores eval-clean-temp

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Compile TypeScript, then generate plugins/*/.generated and plugin manifests.
	@npm run build:typescript
	@node scripts/build_agents.mjs

validate: ## Run all repo invariant checks (build sync, manifests, skills, marketplace, README).
	@node scripts/validate.mjs

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
# nor append fake decisions to a runner's run events file (GUARD_RUN_EVENTS_FILE), nor see a run's registration or
# legacy run variables from the caller's shell (RUN_ENV): hooks spawned with the inherited env would read them.
# GNU make 3.81 (macOS) has no target-specific unexport, so the unexport is makefile-wide.
RUN_ENV := GUARD_RUN_MANIFEST GUARD_RUN_ID GUARD_RUN_MODE GUARD_RUN_TICKET GUARD_RUN_FILE GUARD_RUN_PROTECTED_PATHS \
	FACTORY_RUN_ID FACTORY_ATTENDED_RUN_ID FACTORY_TICKET FACTORY_ATTENDED_TICKET FACTORY_RUN_FILE FACTORY_PROTECTED_PATHS FACTORY_EVENTS_FILE FACTORY_RESULT_CHECKER
unexport $(RUN_ENV)
test: export GUARD_OTEL := off
test: export GUARD_LIFECYCLE := off
test: export GUARD_PUSH_SCAN := off
test: export GUARD_RUN_EVENTS_FILE :=
test: ## Run the plugins' hook tests (Node 22+), their mod tests (`claude plugin test`), then the skill script tests.
	@node --test $(wildcard plugins/*/core/*.test.mjs plugins/*/hooks/*.test.mjs plugins/*/pi/*.test.mjs tests/*.test.mjs tests/contract/*.test.mjs)
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

contract-test: export GUARD_OTEL := off
contract-test: export GUARD_LIFECYCLE := off
contract-test: export GUARD_PUSH_SCAN := off
contract-test: export GUARD_STOP_CHECK := off
contract-test: export GUARD_RUN_EVENTS_FILE :=
contract-test: ## Run contract v2 kit against a runner's manifest (docs/guard.md).  Usage: make contract-test MANIFEST=<absolute path>
	@test -n "$(MANIFEST)" || { echo "Usage: make contract-test MANIFEST=<absolute path>"; exit 2; }
	@CONTRACT_MANIFEST="$(MANIFEST)" node --test $(wildcard tests/contract/*.test.mjs)

EVAL_PLUGINS = $(if $(PLUGIN),plugins/$(PLUGIN),$(patsubst %/evals/,%,$(sort $(dir $(wildcard plugins/*/evals/)))))

eval: ## Run the plugins' skill evals and record their scores (calls a model, costs money, not part of check or CI).  Usage: make eval [PLUGIN=<plugin>] [TAG=trigger|routing] [MODEL=<model>] [RUNS=<n>] [ALLOW=<tools>] [MAX_COST=<usd>] [CASE=<glob>] [J=<n>]  [KEEP_TEMP=1]  (ALLOW defaults to the tools the cases declare that need a grant; KEEP_TEMP keeps and prints each run's trace)
	@for d in $(EVAL_PLUGINS); do \
		test -d $$d/evals || { echo "$$d has no evals/"; exit 1; }; \
		since=$$(date -u +%Y-%m-%dT%H:%M:%SZ); \
		allow="$(ALLOW)"; test -n "$$allow" || allow=$$(node scripts/eval-record.mjs $$d --print-allow $(or $(TAG),trigger)) || exit 1; \
		echo "== $$d"; claude plugin eval $$d --tag $(or $(TAG),trigger) --ablation none --scaffold --trust-plugin --no-publish --keep-temp $(if $(MODEL),--model $(MODEL)) $(if $(RUNS),--runs $(RUNS)) $${allow:+--allow-tools $$allow} $(if $(MAX_COST),--max-cost-usd $(MAX_COST)) $(if $(CASE),--case '$(CASE)') $(if $(J),-j $(J)); s=$$?; \
		node scripts/eval-record.mjs $$d --since $$since --dirty auto $(if $(KEEP_TEMP),--show-traces,--clean-temp) --allow "$$allow" $(if $(MODEL),--model $(MODEL)) || exit 1; \
		test $$s -eq 0 || exit $$s; \
	done

eval-record: ## Append eval results to the plugins' committed evals/scores.jsonl (skips rows already there).  Usage: make eval-record [PLUGIN=<plugin>] [DIRS="<results dir>..."] [COMMIT=<sha>] [MODEL=<model id>] [DIRTY=true|false] [ALLOW="<granted tools>"]
	@for d in $(EVAL_PLUGINS); do \
		node scripts/eval-record.mjs $$d $(DIRS) $(if $(COMMIT),--commit $(COMMIT)) $(if $(MODEL),--model $(MODEL)) $(if $(DIRTY),--dirty $(DIRTY)) $(if $(ALLOW),--allow "$(ALLOW)") || exit 1; \
	done

eval-clean-temp: ## Delete kept eval temp dirs (e-*/out/trace.jsonl in the temp dir and /tmp) that earlier runs left; not while an eval is running.
	@node scripts/eval-record.mjs --sweep-temp

eval-scores: ## Print the latest recorded score of each eval case (needs jq).  Usage: make eval-scores [PLUGIN=<plugin>]
	@cat $(wildcard $(addsuffix /evals/scores.jsonl,$(EVAL_PLUGINS))) /dev/null | jq -s -r 'group_by(.plugin, .case) | map(max_by(.date))[] | [.plugin, .case, "\(.passes)/\(.runs | length)", .model, .commit[0:7], .date[0:10]] | @tsv'

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
