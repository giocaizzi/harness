---
name: typescript-testing
description: "TypeScript and Node.js test rules: Vitest, table tests with test.for, hand-written fakes instead of vi.mock, fake timers, MSW for HTTP, property tests with fast-check, test maintenance and compacting, test.fails for bug handoff, concurrent execution, snapshot discipline, isolation and timeouts. Use whenever you write, fix, review or debug TypeScript or JavaScript tests (*.test.ts, *.spec.ts, vitest.config.ts), including flaky, slow or hanging tests, tests that sleep, mock modules or hit the network, and adding tests for a function, a retry or an HTTP client."
---

# TypeScript Testing

- Test behaviour through the module's exported API, so a refactor that keeps behaviour keeps the tests green. Cover the failure paths (rejections, timeouts, aborts, invalid input), not only the happy path.
- TDD for bugs: reproduce with a failing test first, then fix.
- Tests sit beside the code (`retry.ts`, `retry.test.ts`); fakes shared by several features go in `src/testing/`. `make test` runs the `unit` project of the config with coverage, in shuffled order: an order dependence is a bug, not a flake.
- The javascript-typescript rules hold in tests too (no `as`, no `any`); the one relaxation is `@ts-expect-error` with a description, to test what a caller without types could pass.
- **Test maintenance and compacting**: maintain and refactor tests e2e to keep suites tidy, fast, and compact. Replace bloated repetitive tests with typed `test.for` table tests while preserving all test cases and edge conditions. Remove sleeps and fixture bloat.

## Vitest

Vitest 5 is the runner for every package, with the config in [references/vitest.config.ts](./references/vitest.config.ts): it runs TypeScript as written (parameter properties included), has fake timers, coverage and type tests, and shares the Vite config of a React app. `node:test` only for a dependency-free script that Node runs as `.ts` directly; nothing else mixes runners. Jest is not added to new code.

- `test`, never `it` (lint enforces it); `describe` only to share setup, not to mirror the file.
- `toStrictEqual` over `toEqual` (it checks `undefined` keys and classes; lint enforces it). Expectations on promises are awaited: `await expect(p).rejects.toThrow(...)`.
- **Parallel & concurrent test execution**: Vitest runs test files in parallel; use `test.concurrent` / `describe.concurrent` for async I/O tests. Ensure concurrency safety: isolate mock state, use port 0 for servers, stub environment with `vi.stubEnv` rather than direct mutation.
- **x-Failures for bug demonstration and handoff**: demonstrate failing tests and edge cases using `test.fails('reproduction: ...', () => { ... })` or `test.todo('...')`. Vitest fails when a `test.fails` passes unexpectedly, ensuring the driver removes `test.fails` once the source fix is in place. No `.only`, no `.skip` in a commit (lint enforces both).

## Structure

- **Table tests** with `test.for([...])('%s', ([input, want]) => ...)` for one behaviour over many inputs, typed through its generic (`test.for<[Input, string]>`). A row that needs different setup or assertions is a separate test.
- **Fakes over mocks.** A consumer-declared interface gets a hand-written fake: a class or object that implements it, answers from a script and records its calls. Assert on what the fake recorded, never on call order. `vi.mock` and `vi.doMock` are banned by lint: they test the import graph, and the code under test should take the dependency as a parameter instead. `vi.fn()` only stands in for a callback whose calls are the behaviour.
- **Real over fake where cheap**: the real filesystem under `fs.mkdtemp(os.tmpdir())`, a real `node:http` server on port 0 for server code, a real child process for process code. **MSW** (`setupServer` from `msw/node`) for code that calls an HTTP API: the request leaves `fetch` for real, and an unhandled request fails the test.
- Isolation: Vitest runs each file in its own worker, files in parallel; nothing a test changes may outlive it. `vi.stubEnv` and `vi.stubGlobal` instead of assigning to `process.env` or globals (the config restores them), and every server or temp dir is closed in `afterEach`/`afterAll`.

## Time

- **Fake timers** (`vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`) for anything with delays, timeouts, backoff or `Date.now()`. Advance with the async APIs (`vi.advanceTimersByTimeAsync`, `vi.runAllTimersAsync`), which let awaited callbacks run between timers; the sync ones are banned by lint.
- Never wait for real time to pass. A test that needs a real wait polls with `expect.poll(...)` and a deadline.
- Inject a clock (`now: () => Date`) where a timestamp is part of the output (records, logs, snapshots).

## Kinds of test

- **Snapshots** only for large structured output a reviewer can read: `toMatchFileSnapshot('__snapshots__/<name>.json')` or a short `toMatchInlineSnapshot()`, scrubbed of ids and times. Never snapshot a component tree or an error stack. Review snapshot diffs like code; `vitest -u` is not a fix.
- **Property tests** with fast-check for every parser and decoder of outside input: `fc.assert(fc.property(arbitrary, input => ...))` asserting properties (never throws, round-trips, rejects what it should). A counterexample becomes a plain regression test.
- **Type tests** for a library's public generics: `expectTypeOf` in `*.test-d.ts`, which the `unit` project type-checks.
- **Integration tests** (a real database, Docker, a real third-party API) live in `*.int.test.ts`: the `integration` project, run by `make test-integration` in CI, not by `make test`.
- **Timeouts**: the 5 s default stays. A test that needs more is slow for a reason to fix (real I/O, real sleeps), not a timeout to raise.

Read [references/PATTERNS.md](./references/PATTERNS.md) for a table test, compacting repetitive tests, concurrent table tests, bug reproduction with test.fails, a fake, fake-timer backoff, an MSW client test and a fast-check property, all run with Vitest 5.1.

## Gotchas

- `vi.useFakeTimers()` patches the globals only: `setTimeout` from `node:timers/promises` and `AbortSignal.timeout()` keep running on real time. Code that must be testable sleeps through the global `setTimeout`; a test passes an `AbortController` signal and aborts it itself.
- A promise that rejects while fake timers advance is unhandled unless its expectation is already attached: `await Promise.all([expect(p).rejects.toThrow(...), vi.runAllTimersAsync()])`, not the expectation after the advance.
- MSW 3 renamed the listen option: `server.listen({onUnhandledFrame: 'error'})`; the v2 `onUnhandledRequest` no longer type-checks.
- `toMatchObject` and `expect.objectContaining` pass with extra keys: use them only where extra keys are allowed by design.
- Coverage (`--coverage`, v8) is reported, never gated (org standard, as in Go): a threshold rewards tests that execute lines without asserting.
- Watch mode is for humans; agents and CI run `vitest run`, which exits.
