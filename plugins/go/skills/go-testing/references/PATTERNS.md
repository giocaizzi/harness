# Test patterns

Every snippet ran under `go test -race -shuffle=on` on Go 1.27.2 and passed the go-development golangci-lint template. Imports are omitted.

## Table test

```go
func TestGetMissing(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		id   string
	}{
		{name: "unknown id", id: "nope"},
		{name: "escape attempt", id: "../../etc/passwd"},
	}
	s := openStore(t) // helper: t.Helper(), t.TempDir(), t.Cleanup(Close)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if _, err := s.Get(tt.id); err == nil {
				t.Errorf("Get(%q) error = nil, want an error", tt.id)
			}
		})
	}
}
```

Since Go 1.22 each iteration has its own `tt`; the old `tt := tt` copy is dead code (`copyloopvar` flags it).

## Fake for a consumer interface

The package under test declares what it needs; the test file supplies a fake that answers from a script and records calls.

```go
// in poll.go
type Checker interface {
	Status(ctx context.Context, id string) (Status, error)
}

// in poll_test.go
type fakeChecker struct {
	answers []poll.Status
	asked   []time.Time
}

func (f *fakeChecker) Status(context.Context, string) (poll.Status, error) {
	f.asked = append(f.asked, time.Now())
	st := f.answers[0]
	if len(f.answers) > 1 {
		f.answers = f.answers[1:]
	}
	return st, nil
}
```

Assert on what the fake observed (`asked`), not on the order of calls into it.

## synctest: backoff and timeouts in zero real time

```go
func TestWaitBacksOff(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		fake := &fakeChecker{answers: []poll.Status{"queued", "running", "running", poll.Done}}

		err := poll.Wait(t.Context(), fake, "run-1", 10, 3*time.Second)
		if err != nil {
			t.Fatalf("Wait() error = %v", err)
		}
		got := make([]time.Duration, 0, len(fake.asked))
		for _, at := range fake.asked {
			got = append(got, at.Sub(start))
		}
		// Delays 1s, 2s, then capped at 3s: asks at +0, +1s, +3s, +6s of fake time.
		want := []time.Duration{0, time.Second, 3 * time.Second, 6 * time.Second}
		if diff := cmp.Diff(want, got); diff != "" {
			t.Errorf("ask times (-want +got):\n%s", diff)
		}
	})
}

func TestWaitStopsOnCancel(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		ctx, cancel := context.WithTimeout(t.Context(), 90*time.Minute)
		defer cancel()
		fake := &fakeChecker{answers: []poll.Status{"running"}}

		err := poll.Wait(ctx, fake, "run-1", 1000, time.Hour)

		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Wait() = %v, want DeadlineExceeded", err)
		}
		if got := time.Since(start); got != 90*time.Minute {
			t.Errorf("returned after %v of fake time, want 90m", got)
		}
	})
}
```

Both finish in microseconds. The production code needs no clock parameter: `time.After`, `time.Now` and context deadlines are all fake inside the bubble. Inside, use the bubble's `t` (no `t.Run`, `t.Parallel` or `t.Deadline`), and create every channel, timer and `WaitGroup` the code under test uses inside the bubble.

## Injected clock for stable output

```go
func fixedClock() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }

s, err := runstate.Open(t.TempDir(), fixedClock) // production passes time.Now
```

## Golden files

```go
var update = flag.Bool("update", false, "rewrite golden files") // test files are the exception to "no flag.CommandLine"

func golden(t *testing.T, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", t.Name()+".golden")
	if *update {
		if err := os.WriteFile(path, got, 0o600); err != nil {
			t.Fatalf("update golden: %v", err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run go test -update): %v", err)
	}
	if diff := cmp.Diff(string(want), string(got)); diff != "" {
		t.Errorf("golden mismatch (-want +got):\n%s", diff)
	}
}

// in the test: scrub what varies, then compare
golden(t, bytes.ReplaceAll(raw, []byte(rec.ID), []byte("ID")))
```

`go test ./internal/runstate -run TestStartThenGet -update` rewrites; the diff goes through review. Subtest names contain `/`, so give table rows golden files in a directory (`testdata/TestX/row.golden`) and create it in the update branch.

## httptest

```go
srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusTooManyRequests)
}))
t.Cleanup(srv.Close)
c := patterns.NewClient(srv.URL, "secret", slog.New(slog.DiscardHandler))

_, err := c.Get(t.Context(), "/repos")

if !errors.Is(err, patterns.ErrRateLimited) {
	t.Errorf("Get() = %v, want ErrRateLimited", err)
}
```

Inside a synctest bubble use `httptest.NewTestServer` (1.27), whose in-memory network lets the bubble's clock advance.

## Real processes

```go
func TestRunKillsTreeOnTimeout(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("spawns real processes")
	}
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	err := r.Run(t.Context(), supervise.Spec{
		Path:    "/bin/sh",
		Args:    []string{"-c", `trap '' TERM; sleep 60 & echo $! > "$0"; echo started; wait`, pidFile},
		Timeout: 200 * time.Millisecond,
		Grace:   100 * time.Millisecond,
	}, out)
	if !errors.Is(err, supervise.ErrTimeout) {
		t.Fatalf("Run() = %v, want ErrTimeout", err)
	}
	// read the pid, then poll syscall.Kill(pid, 0) until it fails, with a 2 s deadline
}
```

The test ignores SIGTERM on purpose so the escalation path runs, and asserts on the grandchild, the process a naive implementation leaks. Put it in a `_unix_test.go` file; the Windows twin spawns `cmd /c` or a helper binary.

For a portable helper process, re-exec the test binary: `exec.Command(os.Args[0], "-test.run=TestHelperProcess")` with an env var that makes `TestHelperProcess` act as the child and `os.Exit`.

## Fuzz

```go
func FuzzGet(f *testing.F) {
	f.Add("abc")
	f.Add("../x")
	s := openStore(f)
	f.Fuzz(func(_ *testing.T, id string) {
		_, _ = s.Get(id) // the property: no panic, no read outside the root
	})
}
```

`go test -run=^$ -fuzz=FuzzGet -fuzztime=30s ./internal/runstate` explores; plain `go test` replays the seeds and `testdata/fuzz/FuzzGet/*`. Run fuzzing locally or in a scheduled job, never in `make check`.

## Benchmark

```go
func BenchmarkGet(b *testing.B) {
	s := openStore(b)
	rec, err := s.Start(b.Context(), "x") // setup runs once per -count, not per iteration
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		if _, err := s.Get(rec.ID); err != nil {
			b.Fatal(err)
		}
	}
}
```

`go test -run=^$ -bench=Get -count=10 ./... > new.txt`, then `go run golang.org/x/perf/cmd/benchstat old.txt new.txt`.

## Integration tests

```go
//go:build integration

package github_test // talks to the real API with a token from the environment

func TestListRuns(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}
	...
}
```

`make test-integration` adds `-tags=integration`; the golangci-lint template sets `run.build-tags: [integration]` so these files are linted too.
