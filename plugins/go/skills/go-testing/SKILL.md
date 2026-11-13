---
name: go-testing
description: "Use when you write, fix, review or debug Go tests (_test.go), including flaky, slow or hanging tests, tests that sleep, hit the network or use testify. Table tests, go-cmp, fakes, httptest, synctest, fuzzing, -race."
---

# Go Testing

Baseline: the test sections of the [Google Go Style Guide](https://google.github.io/styleguide/go/decisions#useful-test-failures) (decisions and best practices): no assertion libraries, `got` before `want`, `(-want +got)` diffs, `t.Error` to keep going and `t.Fatal` only when the rest cannot run, never `t.Fatal` off the test goroutine. The rules below add to it.

- Test behaviour through the package's API, so refactors don't break tests. Cover the failure paths (timeouts, cancellation, partial output, exit codes), not only the happy path.
- TDD for bugs: reproduce with a failing test first, then fix.
- `make test` runs `go test -race -shuffle=on ./...`. Every test passes under both: data races and order dependence are bugs, not flakes.

## Standard library, plus go-cmp

- `testing` plus `github.com/google/go-cmp/cmp` (`cmp.Diff`) for structs, slices and maps; no testify (`depguard` in the lint template rejects it).
- Helpers call `t.Helper()` (`thelper` enforces it) and take `testing.TB` when benchmarks or fuzz targets share them.

## Structure

- **Parallel execution from the start.** Call `t.Parallel()` at the top of the test function AND inside every `t.Run()` table subtest (`paralleltest` enforces it). Ensure parallel safety: `t.TempDir()`, `t.Context()`, and passing dependencies cleanly. Never call `t.Setenv` or `t.Chdir` in parallel tests (keep those in serial tests).
- **Table tests** for one behaviour over many inputs: a slice of structs with a `name`, one `t.Run(tt.name, ...)` per row. A row that needs fundamentally different setup or assertions is a separate test.
- **Test maintenance and compacting.** Keep test suites tidy, maintained, and refactored. Compact multi-scenario tests into table-driven tests (`tests := []struct{ name string; ... }`) without dropping any branch coverage, edge cases, or error checks.
- **x-Failures for bug demonstration and handoff.** Go has no native `@xfail` attribute. The house pattern for x-failures is a subtest with `t.Skip`:
  ```go
  t.Run("xfail: bug description / issue #123", func(t *testing.T) {
      t.Skip("xfail: pending driver fix for ...")
      // reproduction assertions here
  })
  ```
  Reviewers add this to demonstrate bugs; drivers resolve the source bug, remove `t.Skip`, and verify that the test passes.
- **`t.Context()`** for every context in a test (cancelled when the test ends, before cleanups), **`t.TempDir()`** for every file, **`t.Setenv`/`t.Chdir`** instead of mutating process state (both forbid `t.Parallel`, so keep them in serial tests). `t.Cleanup` over `defer` in helpers.
- **Fakes over mocks.** A consumer-defined interface of one to three methods gets a hand-written fake in the test file: a struct with fields to program its answers and record its calls. No mockgen or gomock (`depguard` rejects them): generated mocks assert call sequences, which is implementation detail. A double other packages' tests need lives in a `<pkg>test` package (`runstatetest.NewStore`), never exported from the package itself.
- **Real over fake where cheap**: `httptest.NewServer` for HTTP clients, `net.Pipe` for connections, real child processes (`/bin/sh -c`) for process code, the real filesystem under `t.TempDir()`.

## Time and concurrency

- **`testing/synctest`** (stable since 1.25) for anything with timeouts, tickers, backoff or goroutines that must finish: inside `synctest.Test(t, func(t *testing.T) {...})` time is fake and jumps when every goroutine in the bubble is blocked, `synctest.Wait()` waits for them to settle and `synctest.Sleep(d)` (1.27) does both. `Test` waits for every goroutine in the bubble, and one blocked forever fails it as a deadlock, so leaks surface (a goroutine stuck on real I/O hangs the test instead).
- **Inject a clock** (`now func() time.Time`, `time.Now` in production) where a timestamp is part of the output (records, logs, golden files): a fixed `now` makes the bytes stable, which synctest's moving clock does not.
- Never `time.Sleep` to wait for something to happen. Wait on a channel, `synctest.Wait()`, or poll with a deadline as a last resort for real processes.

## Kinds of test

- **Golden files** for large or structured output: `testdata/<TestName>.golden`, a `-update` flag that rewrites them, scrubbed of ids and times before comparing. Review golden diffs like code.
- **Fuzz** every parser and decoder of outside input (config, protocol frames, CLI args, paths): `FuzzX(f *testing.F)` with seeds from real cases, asserting properties (no panic, round-trip, no path escape). Failing inputs land in `testdata/fuzz/` and are committed as regression cases.
- **Benchmarks** with `for b.Loop() { ... }`, never `b.N`; compare with `benchstat`, never by eye.
- **Integration tests** (network, real services, Docker) carry `//go:build integration` and run via `make test-integration`. `testing.Short()` skips slow but hermetic tests in a `check-fast` target when the full suite takes minutes; CI runs everything. Binaries and assets a suite downloads (envtest, browsers, fixtures) come from per-user shared stores, never a dir in the worktree (`host-hygiene`, Shared stores).

Read [references/PATTERNS.md](./references/PATTERNS.md) for table test with fake, test compacting, xfail subtest, golden helper, fake, synctest, fuzz, benchmark, httptest and process test, all run on Go 1.27.2.

## Gotchas

- `go test` caches passing results; `-count=1` forces a rerun when a test reads files or env the cache can't see.
- On Linux and Windows `-race` needs `CGO_ENABLED=1` and a C compiler; a test job with `CGO_ENABLED=0` fails with "-race requires cgo" there (macOS does not need cgo for it).
- The default `-timeout` is 10 minutes and its panic dumps every goroutine: read that dump for the blocked one before raising the limit.
- Coverage (`-coverprofile`) is reported, never gated (org standard). `-coverpkg=./...` counts code exercised by other packages' tests.
- Inside a synctest bubble, real I/O (sockets, pipes to processes, files) does not count as blocked, so time does not advance while a goroutine waits on it; use `net.Pipe` or `httptest.NewTestServer` (1.27, in-memory network) there.
- `t.Parallel()` subtests run after the parent function returns: a `defer` in the parent fires before them; use `t.Cleanup`.
