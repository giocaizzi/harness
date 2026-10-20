# Patterns

Each snippet compiled and passed the template's `golangci-lint` (default: all) and race-enabled tests on Go 1.27.2. Imports are omitted.

## main and run

`main` owns the process: signals, exit code. `run` owns the program and takes everything it touches as parameters, so a test calls it with fake args, env and buffers.

```go
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop() // os.Exit skips defers (gocritic exitAfterDefer)
	os.Exit(exitCode(err, os.Stderr))
}

type config struct {
	stateDir string
	timeout  time.Duration
	level    slog.Level
}

func parse(args []string, getenv func(string) string, stderr io.Writer) (config, []string, error) {
	var cfg config
	fs := flag.NewFlagSet("runner", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&cfg.stateDir, "state-dir", envOr(getenv, "RUNNER_STATE_DIR", ".runner"), "where run records live")
	fs.DurationVar(&cfg.timeout, "timeout", 10*time.Minute, "stop the run after this long")
	fs.TextVar(&cfg.level, "log-level", slog.LevelInfo, "debug, info, warn or error")
	if err := fs.Parse(args); err != nil {
		return config{}, nil, fmt.Errorf("parse flags: %w", err)
	}
	return cfg, fs.Args(), nil
}
```

Precedence is flag > env > default. Secrets come from the environment (or a file path given by a flag), never from a flag value, which shows up in `ps`. Report the version from `debug.ReadBuildInfo().Main.Version`, which `go build` stamps from the git tag.

## Errors

```go
var ErrRateLimited = errors.New("rate limited") // callers branch on it: errors.Is

type StatusError struct { // callers need its data: errors.AsType
	Code int
	Body string
}

func (e *StatusError) Error() string { return fmt.Sprintf("status %d: %s", e.Code, e.Body) }

if se, ok := errors.AsType[*StatusError](err); ok && se.Code == http.StatusNotFound { ... }
```

- An error is handled once: either logged or returned, never both.
- `errors.Join(primaryErr, f.Close())` keeps a close error without hiding the original.
- Exported error variables and types are API: changing their text is fine, removing them is a breaking change.

## Bounded worker pool

```go
func Process(ctx context.Context, jobs iter.Seq[Job], limit int, work func(context.Context, Job) error) error {
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(limit) // g.Go blocks while limit goroutines run: backpressure on the producer
	for job := range jobs {
		if ctx.Err() != nil {
			break // a worker failed; stop producing
		}
		g.Go(func() error {
			if ctx.Err() != nil { // cancelled while waiting for a slot; Wait still returns the first error
				return fmt.Errorf("job %s: %w", job.ID, context.Cause(ctx))
			}
			if err := work(ctx, job); err != nil {
				return fmt.Errorf("job %s: %w", job.ID, err)
			}
			return nil
		})
	}
	return g.Wait()
}
```

Without the check inside `g.Go`, a job that was waiting for a slot still runs after another job failed (a test caught exactly that). For independent jobs whose errors should all be collected, return `nil` from the goroutine and send `Result{ID, Err}` to a channel or a mutex-guarded slice instead.

## Iterators

```go
// Pages yields every item of a paginated API until the cursor runs out.
func Pages[T any](ctx context.Context, fetch func(context.Context, string) ([]T, string, error)) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		cursor := ""
		for {
			items, next, err := fetch(ctx, cursor)
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			for _, it := range items {
				if !yield(it, nil) {
					return // the caller broke out of the loop
				}
			}
			if next == "" {
				return
			}
			cursor = next
		}
	}
}
```

Always honour `yield`'s `false`: calling it again panics. Use `iter.Seq2[T, error]` for fallible streams, `slices.Collect`/`slices.Sorted` at the edge where a slice is really needed.

## Files from outside: os.Root

```go
root, err := os.OpenRoot(stateDir) // every path below stays inside stateDir, symlinks included
...
func (s *Store) put(rec Record) error {
	data, err := json.Marshal(rec) // encoding/json/v2
	if err != nil {
		return fmt.Errorf("encode %s: %w", rec.ID, err)
	}
	tmp := rec.ID + ".json.tmp"
	if err := s.root.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", rec.ID, err)
	}
	if err := s.root.Rename(tmp, rec.ID+".json"); err != nil { // atomic: readers never see half a record
		return fmt.Errorf("commit %s: %w", rec.ID, err)
	}
	return nil
}
```

`root.ReadFile("../../etc/passwd")` fails instead of escaping. For durability across power loss, open the temp file, `Sync` it, then rename. IDs from `uuid.NewV7()` (stdlib, 1.27) sort by creation time.

## HTTP client

```go
type Client struct {
	http  *http.Client
	base  string
	token Token // type Token string with LogValue() returning "REDACTED"
	log   *slog.Logger
}

func NewClient(base string, token Token, log *slog.Logger) *Client {
	return &Client{http: &http.Client{Timeout: 30 * time.Second}, base: base, token: token, log: log}
}

func (c *Client) Get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	...
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	...
}
```

- Retries with backoff and jitter only for idempotent requests and for 429/5xx; honour `Retry-After` and GitHub's `x-ratelimit-reset`.
- For the GitHub API, `github.com/google/go-github` is fine for breadth; a small typed client like this is fine for a handful of endpoints. Either way the token arrives as a parameter.
- Instrument with `otelhttp.NewTransport(http.DefaultTransport)` as the client's `Transport`, built in `main` with the providers.

## slog

```go
log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.level}))
log.LogAttrs(ctx, slog.LevelInfo, "run started", slog.String("run_id", rec.ID), slog.Any("token", token))
```

- `log.With(slog.String("run_id", id))` gives each run its own logger; pass that, not the id.
- `slog.DiscardHandler` (1.24) for tests and no-op loggers; `slog.NewMultiHandler` (1.26) to fan out to stderr and an OpenTelemetry bridge.
- The context argument carries the trace span, so the OTel bridge correlates log lines with traces; always use the `...Context`/`LogAttrs(ctx, ...)` forms.
