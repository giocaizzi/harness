# Project setup

Everything below was run end to end on Go 1.27.2 with golangci-lint v2.15.0, govulncheck v1.9.0 and goreleaser v2.18.3: `make fmt`, `make check` (lint per GOOS clean, race tests green), `make vuln`, `make build`, `goreleaser release --snapshot`.

## Layout

```
.
├── go.mod / go.sum              module, go + toolchain lines, `tool` deps (govulncheck, generators)
├── golangci-lint.mod / .sum     golangci-lint pinned apart from the module's own dependencies
├── .golangci.yml                from references/golangci.yml
├── .goreleaser.yaml             binaries only (RELEASE.md)
├── Makefile
├── cmd/<name>/main.go           signal context, run(), exit code; nothing else
├── internal/<pkg>/              all code; *_test.go next to it, fixtures in testdata/
└── docs/  AGENTS.md  README.md
```

`testdata/` is ignored by the go tool, so fixtures and golden files live there. Platform code is split by file suffix (`tree_unix.go` with `//go:build unix`, `tree_windows.go`), with the shared API in an untagged file.

## Starting a module

```sh
go mod init github.com/<owner>/<repo>
go get go@1.27.0 toolchain@go1.27.2
go get -tool golang.org/x/vuln/cmd/govulncheck@latest
go mod init -modfile=golangci-lint.mod github.com/<owner>/<repo>/golangci-lint
go get -tool -modfile=golangci-lint.mod github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
```

Resulting `go.mod` (no hand edits; `go get` and `go mod tidy` own it):

```
module github.com/<owner>/<repo>

go 1.27.0

toolchain go1.27.2

tool golang.org/x/vuln/cmd/govulncheck

require (...)
```

Commit `go.sum`, `golangci-lint.mod` and `golangci-lint.sum`. Code generators such as `stringer` go in `go.mod` as tools too and run from `//go:generate go tool stringer -type=State`.

## Makefile

```makefile
GOLANGCI := go tool -modfile=golangci-lint.mod golangci-lint
LINT_GOOS ?= linux darwin windows

.PHONY: help fmt lint vuln test test-integration check build snapshot tools

help: ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

fmt: ## Format, tidy and apply modernizers
	go mod tidy
	go fix ./...
	$(GOLANGCI) fmt

lint: ## Tidy check, then format check and lint (vet, staticcheck) per target OS
	go mod tidy -diff
	@bin=$$(go tool -n -modfile=golangci-lint.mod golangci-lint) && \
	for os in $(LINT_GOOS); do echo "golangci-lint run (GOOS=$$os)"; GOOS=$$os $$bin run || exit 1; done

vuln: ## Reachable known vulnerabilities (needs the network)
	go tool govulncheck ./...

test: ## Unit tests with the race detector, in random order
	go test -race -shuffle=on -coverprofile=coverage.out ./...

test-integration: ## Tests behind the integration build tag
	go test -race -shuffle=on -tags=integration ./...

check: lint test ## lint + test

build: ## Static binaries for this platform into bin/
	CGO_ENABLED=0 go build -trimpath -o bin/ ./cmd/...

snapshot: ## Local cross-build of every release target, nothing published
	goreleaser release --snapshot --clean

tools: ## Upgrade the pinned tools
	go get -tool golang.org/x/vuln/cmd/govulncheck@latest
	go get -tool -modfile=golangci-lint.mod github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
```

- `golangci-lint run` also reports unformatted files (the `formatters` section), so `lint` needs no separate format check; `fmt` rewrites them.
- `-race` needs cgo and a C compiler (Xcode CLT on macOS, gcc on Linux and on GitHub's Windows runners). Never export `CGO_ENABLED=0` in the shell or CI env; set it on the build command.
- `.gitignore`: `bin/`, `dist/`, `coverage.out`.

## CI

One `ci.yml`, jobs aggregated by `check` (org standard). Tests run on every OS the binary ships for, because process, signal and path code differs per OS.

```yaml
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod      # honours the toolchain line
      - if: runner.os != 'Windows'
        run: make check
      - if: runner.os == 'Windows'
        run: go test -race -shuffle=on ./...   # `make test`; Windows runners have no make (they do have gcc for -race)

  vuln:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod
      - run: make vuln
```

Add `test` and `vuln` (and the gitleaks job) to `check.needs`. Run `vuln` on a weekly `schedule` too: a new advisory fails it without any code change.

## Dependabot

```yaml
  - package-ecosystem: gomod
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: "chore(deps)"
    groups:
      minor-patch: {update-types: [minor, patch]}
      major: {update-types: [major]}
      security: {applies-to: security-updates, patterns: ["*"]}
```

It updates `go.mod`, tool requirements included. It does not read `golangci-lint.mod` (not named `go.mod`), which is what upstream wants: bump golangci-lint as a whole with `make tools`, in its own PR, and fix the new findings there.
