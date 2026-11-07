#!/usr/bin/env bash
# A tiny Terraform repo whose README has a typo.
set -euo pipefail
mkdir -p envs/dev
cat > envs/dev/main.tf <<'TF'
provider "aws" {
  region = "eu-west-1"
}
TF
cat > README.md <<'MD'
# acme infra

## Deploy

Deploys run from CI. Mearge to main to trigger the apply.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
