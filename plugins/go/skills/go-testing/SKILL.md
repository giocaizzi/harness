---
name: go-testing
description: "Go test conventions: the standard testing package with go-cmp instead of testify, table tests with t.Run and t.Parallel, fakes over mocks, golden files, httptest, testing/synctest for time and concurrency, fuzzing, b.Loop benchmarks, the race detector and integration tests behind a build tag. Use when writing, reviewing or debugging Go tests."
---

# Go Testing

- Test behaviour through the package's API, so refactors don't break tests. Cover the failure paths (timeouts, cancellation, partial output, exit codes), not only the happy path.
- TDD for bugs: reproduce with a failing test first, then fix.
- `make test` runs `go test -race -shuffle=on ./...`. Every test passes under both: data races and order dependence are bugs, not flakes.

## Standard library, plus go-cmp

Use `testing` with `if got != want { t.Errorf(...) }`, and `github.com/google/go-cmp/cmp` (`cmp.Diff`) for structs, slices and maps. No testify, no assertion libraries: the Go team's review guidance rejects them, `t.Errorf` keeps a test running to report every failure while `require` stops at the first, and `require` called from a goroutine other than the test's silently misbehaves (`FailNow` must run on the test goroutine).

- Messages read `Func(input) = got, want want`; diffs say `(-want +got)`.
- `t.Fatal` only when continuing is pointless (setup failed, a nil that the next line dereferences); otherwise `t.Error`.
- Helpers call `t.Helper()` and take `testing.TB` when benchmarks or fuzz targets share them.

## Structure

- **Table tests** for one behaviour over many inputs: a slice of structs with a `name`, one `t.Run(tt.name, ...)` per row, `t.Parallel()` in the test and in each subtest (`paralleltest` enforces it). A row that needs different setup or assertions is a separate test.
- **`t.Context()`** for every context in a test (cancelled when the test ends, before cleanups), **`t.TempDir()`** for every file, **`t.Setenv`/`t.Chdir`** instead of mutating process state (both forbid `t.Parallel`, so keep them in serial tests). `t.Cleanup` over `defer` in helpers.
- **Fakes over mocks.** A consumer-defined interface of one to three methods gets a hand-written fake in the test file: a struct with fields to program its answers and record its calls. No mockgen or gomock: generated mocks assert call sequences, which is implementation detail.
- **Real over fake where cheap**: `httptest.NewServer` for HTTP clients, `net.Pipe` for connections, real child processes (`/bin/sh -c`) for process code, the real filesystem under `t.TempDir()`.

## Time and concurrency

- **`testing/synctest`** (stable since 1.25) for anything with timeouts, tickers, backoff or goroutines that must finish: inside `synctest.Test(t, func(t *testing.T) {...})` time is fake and jumps when every goroutine in the bubble is blocked, `synctest.Wait()` waits for them to settle and `synctest.Sleep(d)` (1.27) does both. A goroutine still running when the function returns fails the test, so leaks show up for free.
- **Inject a clock** (`now func() time.Time`, `time.Now` in production) where a timestamp is part of the output (records, logs, golden files): a fixed `now` makes the bytes stable, which synctest's moving clock does not.
- Never `time.Sleep` to wait for something to happen. Wait on a channel, `synctest.Wait()`, or poll with a deadline as a last resort for real processes.

## Kinds of test

- **Golden files** for large or structured output: `testdata/<TestName>.golden`, a `-update` flag that rewrites them, scrubbed of ids and times before comparing. Review golden diffs like code.
- **Fuzz** every parser and decoder of outside input (config, protocol frames, CLI args, paths): `FuzzX(f *testing.F)` with seeds from real cases, asserting properties (no panic, round-trip, no path escape). Failing inputs land in `testdata/fuzz/` and are committed as regression cases.
- **Benchmarks** with `for b.Loop() { ... }`, never `b.N`; compare with `benchstat`, never by eye.
- **Integration tests** (network, real services, Docker) carry `//go:build integration` and run via `make test-integration`. `testing.Short()` skips slow but hermetic tests in a `check-fast` target when the full suite takes minutes; CI runs everything.

Read [references/PATTERNS.md](./references/PATTERNS.md) for a golden helper, fake, synctest, fuzz, benchmark, httptest and process test, all run on Go 1.27.2.

## Gotchas

- `go test` caches passing results; `-count=1` forces a rerun when a test reads files or env the cache can't see.
- `-race` needs `CGO_ENABLED=1` and a C compiler; a test job with `CGO_ENABLED=0` fails with "-race requires cgo".
- The default `-timeout` is 10 minutes and its panic dumps every goroutine: read that dump for the blocked one before raising the limit.
- Coverage (`-coverprofile`) is reported, never gated (org standard). `-coverpkg=./...` counts code exercised by other packages' tests.
- Inside a synctest bubble, real I/O (sockets, pipes to processes, files) does not count as blocked, so time does not advance while a goroutine waits on it; use `net.Pipe` or `httptest.NewTestServer` (1.27, in-memory network) there.
- `t.Parallel()` subtests run after the parent function returns: a `defer` in the parent fires before them; use `t.Cleanup`.
