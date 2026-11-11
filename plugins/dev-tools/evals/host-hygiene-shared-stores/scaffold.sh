#!/usr/bin/env bash
# A small Go operator-like repo whose Makefile installs tools into the worktree.
set -euo pipefail
cat > go.mod <<'EOF'
module example.com/acme/app

go 1.26
EOF
cat > main.go <<'EOF'
package main

func main() {}
EOF
printf 'bin/\n' > .gitignore
cat > Makefile <<'EOF'
LOCALBIN ?= $(CURDIR)/bin
GOLANGCI_LINT_VERSION ?= v2.6.0
GOLANGCI_LINT = $(LOCALBIN)/golangci-lint-$(GOLANGCI_LINT_VERSION)-$(shell go env GOVERSION)
ENVTEST_K8S_VERSION ?= 1.34.1

.PHONY: help
help: ## Show targets.
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

$(LOCALBIN):
	mkdir -p $(LOCALBIN)

$(GOLANGCI_LINT): $(LOCALBIN)
	GOBIN=$(LOCALBIN) go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)
	mv $(LOCALBIN)/golangci-lint $(GOLANGCI_LINT)

.PHONY: setup-envtest
setup-envtest: $(LOCALBIN) ## Install setup-envtest.
	GOBIN=$(LOCALBIN) go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

.PHONY: lint
lint: $(GOLANGCI_LINT) ## Run the linter.
	$(GOLANGCI_LINT) run ./...

.PHONY: test
test: ## Run unit tests.
	go test ./...

.PHONY: test-envtest
test-envtest: setup-envtest ## Run tests against envtest assets.
	KUBEBUILDER_ASSETS="$$($(LOCALBIN)/setup-envtest use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" go test ./...

.PHONY: check
check: lint test test-envtest ## Lint and test.
EOF
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
