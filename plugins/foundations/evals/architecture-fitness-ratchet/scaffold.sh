#!/usr/bin/env bash
# A Go module with a golangci-lint config and code that has a lint backlog.
set -euo pipefail
mkdir -p internal/billing
cat > go.mod <<'MOD'
module acme/app

go 1.24
MOD
cat > .golangci.yml <<'YAML'
version: "2"
linters:
  default: standard
  enable:
    - errcheck
    - unused
    - revive
YAML
cat > Makefile <<'MAKE'
.PHONY: lint test check
lint:
	golangci-lint run ./...
test:
	go test ./...
check: lint test
MAKE
cat > internal/billing/invoice.go <<'GO'
package billing

import "os"

func Total(lines []float64) float64 {
	unused := 0
	sum := 0.0
	for _, l := range lines {
		sum += l
	}
	os.Remove("/tmp/invoice.lock")
	return sum
}

func Tax(total float64) float64 {
	os.Remove("/tmp/tax.lock")
	return total * 0.2
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
