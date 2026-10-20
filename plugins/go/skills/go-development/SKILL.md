---
name: go-development
description: Go 1.26+ conventions for modules and toolchain, go tool dependencies, golangci-lint v2 with every linter on, errors, context, slog, concurrency, process supervision, cross-builds and goreleaser releases, with make targets. Use when writing, reviewing or scaffolding Go code, a go.mod, a .golangci.yml or a .goreleaser.yaml.
---

# Go Development (1.26+)

The floor is the oldest supported Go release (two are supported at a time; 1.26 while 1.27 is current). Libraries declare the lowest `go` version whose features they use, never above that floor. Binaries we ship track the latest release: `go 1.27.0` plus `toolchain go1.27.x`, so `GOTOOLCHAIN=auto` and `actions/setup-go` with `go-version-file: go.mod` build with the same compiler everywhere. Bump both with `go get go@1.N.0 toolchain@go1.N.x`.

## Tooling

- **Tools are module dependencies, not host installs.** Pin them in the repo and run them with `go tool`: `go get -tool golang.org/x/vuln/cmd/govulncheck`, then `go tool govulncheck ./...`. The host needs only `go` (and `goreleaser` for local snapshots). No `go install` of tools, no `tools.go`.
- **golangci-lint lives in its own modfile** (`golangci-lint.mod`), because upstream warns its dependencies must never mix with yours or be updated by hand: `go get -tool -modfile=golangci-lint.mod github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.x`. It is the only linter and formatter entry point: `govet`, `staticcheck` (which absorbed gosimple and stylecheck in v2), `gofumpt` and `gci` all run inside it.
- **Every linter on**, the way Python starts from ruff `ALL`: `linters.default: all`, then `disable` a linter only with the reason inline. Start from [references/golangci.yml](./references/golangci.yml). Silence one finding with `//nolint:<linter> // reason`; `nolintlint` rejects a bare one.
- **Make is the command surface**: `help`, `fmt`, `lint`, `vuln`, `test`, `check` (= `lint` + `test`), `build`. `lint` runs golangci-lint once per target `GOOS`, because files behind `//go:build windows` are invisible to a Linux or macOS run. `vuln` needs the network, so it runs in CI as its own job, not inside `check`.
- `go fix ./...` (the modernizers since 1.26) runs in `make fmt`: it rewrites code to current idioms (`for range n`, `min`/`max`, `slices`, `strings.Cut`, `wg.Go`). Accept its diff; the `modernize` linter flags what it would change.

Read [references/PROJECT_SETUP.md](./references/PROJECT_SETUP.md) when scaffolding: layout, `go.mod`, the tool modfile, the Makefile, CI and Dependabot.

## Layout

- One module per repo. `cmd/<name>/main.go` is thin; everything else is under `internal/`, which the compiler keeps private.
- No `pkg/`. A library module puts its public API in the root package and its helpers in `internal/`; an application has no public packages at all.
- Packages are named for what they provide (`supervise`, `runstate`), never `util`, `common`, `models` or `types`.

## Design

- **No global state.** No package-level `var` other than sentinel errors, no `init()`, no `flag.CommandLine`, no `slog.SetDefault` outside `main`. `main` builds the dependencies and calls `run(ctx, args, getenv, stdout, stderr) error`, which tests call directly. Configuration is flags on a `flag.FlagSet` with env fallbacks read through the injected `getenv`.
- **Interfaces are small and declared by the consumer**, next to the code that needs them; constructors return concrete types. Don't define an interface for a single implementation unless a test needs the seam.
- **Generics remove real duplication** (containers, `iter.Seq` helpers, typed wrappers), not hypothetical future types. Generic methods (1.27) cannot satisfy interface methods.
- Use the current standard library before a dependency: `slices`, `maps`, `iter` (return `iter.Seq`/`iter.Seq2` for streams instead of callbacks or full slices), `log/slog`, `uuid` (1.27), `encoding/json/v2` in modules on 1.27 (strict UTF-8, no duplicate names, `omitzero`), `os.Root` for every path that comes from outside, `errors.AsType` (1.26).
- An `http.Client` always has a `Timeout` or a per-request deadline, every request takes a `context`, and every body is closed (`noctx`, `bodyclose` enforce it). Never `http.DefaultClient`.

## Errors

- Wrap with context at every boundary: `fmt.Errorf("open state %s: %w", dir, err)`, lowercase, no "failed to". `%v` deliberately cuts the chain.
- **Sentinel** (`var ErrNotFound = errors.New(...)`) when callers branch on the condition; **typed** (`*ExitError`) when they need data from it, always returned and matched as a pointer; match with `errors.Is` and `errors.AsType[*T]`, never `==` or a type assertion (`errorlint`).
- `errors.Join` for several failures (cleanup after a failed operation, closing many resources).
- No panics across a package boundary. A panic is a bug in our own code; recover only at a boundary that must survive it (an HTTP handler, a supervised goroutine), and log the stack there.

## Context, logging, concurrency

- `ctx context.Context` is the first parameter of anything that blocks or does I/O; never stored in a struct. Use `context.WithTimeoutCause`/`WithCancelCause` so `context.Cause` says why; `context.WithoutCancel` for work that must finish after the request ends (a final state write, telemetry flush); `context.AfterFunc` instead of a goroutine waiting on `ctx.Done()`.
- `log/slog` with a JSON handler for daemons, built in `main` and passed down. Attributes only (`slog.String`, `LogAttrs`), constant messages, snake_case keys (`sloglint` enforces it). Secrets implement `slog.LogValuer` and redact themselves. OpenTelemetry providers are built in `main` and shut down with a `WithoutCancel` context and a timeout.
- **Every goroutine has an owner that waits for it.** `errgroup.WithContext` when goroutines can fail, with `SetLimit(n)` for a bounded pool; `sync.WaitGroup.Go` when they cannot. Every blocking send or receive selects on `ctx.Done()`. The sender closes a channel, never the receiver.

Read [references/PATTERNS.md](./references/PATTERNS.md) for the `main`/`run` skeleton, error types, worker pool, graceful shutdown, `iter.Seq`, `os.Root` atomic writes and HTTP client code.

## Processes, builds, releases

- Running and stopping child processes (process groups, job objects, signal escalation, output streaming): read [references/PROCESS_SUPERVISION.md](./references/PROCESS_SUPERVISION.md) before writing any `os/exec` code that outlives a single short command.
- Shipped binaries are static: `CGO_ENABLED=0 go build -trimpath`, set per command, never exported globally (the race detector needs cgo). The version comes from the git tag that `go build` stamps since 1.24 (`debug.ReadBuildInfo().Main.Version`), not `-ldflags -X` into a global.
- Releases: release-please owns the version, tag and notes; goreleaser builds, archives, checksums, SBOMs and the Homebrew cask from that tag, and the workflow attests the artifacts. Read [references/RELEASE.md](./references/RELEASE.md) when setting it up.

## Gotchas

- `GOOS=windows go tool golangci-lint run` builds the linter itself for Windows and fails with `exec format error`. Resolve the host binary once with `go tool -n` and set `GOOS` only on that (the Makefile in PROJECT_SETUP.md does).
- A `go` line above the installed toolchain makes `GOTOOLCHAIN=auto` download a toolchain; a repackaged Go with `GOTOOLCHAIN=local` refuses to build instead. Read the error, then upgrade the host Go rather than lowering the `go` line.
- `go mod tidy -diff` (in `lint`) fails on an untidy module without touching files; `make fmt` tidies.
- Since 1.27, `go vet` flags `fmt.Errorf("%w", p)` when `p` is `*E` and `E` (not `*E`) implements `error`: give the `Error` method one receiver kind and use it everywhere.
- `encoding/json` in 1.27 is backed by v2 even in v1 code; error texts changed. Never match on JSON error strings.
