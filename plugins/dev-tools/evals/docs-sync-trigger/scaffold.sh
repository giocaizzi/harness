#!/usr/bin/env bash
# A small service repo whose docs and runbook reference `make deploy`, so renaming the target leaves them stale.
set -euo pipefail
mkdir -p docs
cat > Makefile <<'MK'
.PHONY: help build deploy

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' Makefile | sed 's/:.*## /\t/'

build: ## Build the image
	docker build -t app:latest .

deploy: build ## Push the image and roll out
	docker push app:latest
	./scripts/rollout.sh app:latest
MK
cat > README.md <<'MD'
# app

Build with `make build`, ship with `make deploy`. Operations: [docs/runbook.md](docs/runbook.md).
MD
cat > docs/runbook.md <<'MD'
# Runbook

## Deploy

1. `make deploy` builds, pushes `app:latest` and rolls it out.
2. Roll back by re-running `make deploy` from the previous commit.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
