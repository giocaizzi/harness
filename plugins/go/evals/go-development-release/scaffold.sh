#!/usr/bin/env bash
# A Go CLI with a Makefile and a CI workflow that only runs tests.
set -euo pipefail
mkdir -p cmd/acme .github/workflows
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > cmd/acme/main.go <<'G'
package main

import "fmt"

var version = "dev"

func main() {
	fmt.Println("acme", version)
}
G
cat > Makefile <<'M'
.PHONY: build test

build:
	go build -o bin/acme ./cmd/acme

test:
	go test ./...
M
cat > .github/workflows/ci.yml <<'Y'
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: make test
Y
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
