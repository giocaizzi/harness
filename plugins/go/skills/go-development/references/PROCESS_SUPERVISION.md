# Process supervision

For code that starts child processes and must stop all of them: on timeout, on cancel, on its own shutdown. The code below compiles and passes `golangci-lint` (default: all) for linux, darwin and windows, and its Unix half is covered by race-enabled tests that kill a TERM-ignoring grandchild. The Windows half is compile- and lint-checked only: run its tests on a Windows CI runner before relying on it.

## The model

1. **One tree per run.** The child leads a new process group (Unix) or is put in a job object (Windows), so one call reaches every descendant, including the ones the child forks after we start it.
2. **Graceful, then forced.** Cancel sends SIGTERM (Ctrl+Break on Windows) to the tree; after a grace period the tree gets SIGKILL (the job is terminated). `exec.Cmd.WaitDelay` is the last resort that unblocks `Wait`.
3. **Always reap.** After `Wait` returns, kill whatever is left of the tree, even after a clean exit. A supervisor that leaves daemonised grandchildren running leaks processes across runs.
4. **Output is streamed through `cmd.Stdout`/`cmd.Stderr` as `io.Writer`s**, never read from `StdoutPipe` before `Wait`.

## Run

```go
func (r *Runner) Run(ctx context.Context, spec Spec, out chan<- Line) error {
	ctx, cancel := context.WithTimeoutCause(ctx, spec.Timeout, ErrTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	tree := newTree(cmd, spec.Grace) // per-OS file below

	// exec copies output in its own goroutines, so WaitDelay bounds them even when a
	// descendant keeps the pipe open; reading StdoutPipe before Wait would never time out.
	stdout := &lineWriter{stream: "stdout", out: out, done: ctx.Done()}
	stderr := &lineWriter{stream: "stderr", out: out, done: ctx.Done()}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", spec.Path, err)
	}
	if err := tree.started(); err != nil {
		return errors.Join(fmt.Errorf("contain %s: %w", spec.Path, err), tree.kill(), cmd.Wait())
	}

	waitErr := cmd.Wait()
	killErr := tree.kill() // reap anything left in the tree, also after a clean exit
	stdout.flush()
	stderr.flush()

	if cause := context.Cause(ctx); cause != nil { // ErrTimeout, or the caller's cause (e.g. the signal)
		return errors.Join(fmt.Errorf("run %s: %w", spec.Path, cause), killErr)
	}
	if exitErr, ok := errors.AsType[*exec.ExitError](waitErr); ok {
		return errors.Join(&ExitError{Code: exitErr.ExitCode()}, killErr)
	}
	if waitErr != nil {
		return errors.Join(fmt.Errorf("wait %s: %w", spec.Path, waitErr), killErr)
	}
	return killErr
}
```

`lineWriter` buffers bytes, sends each complete line (and lines over 64 KiB in chunks) to `out` in a `select` with `done`, and `flush` sends the unterminated tail after `Wait`. It holds `ctx.Done()`, not the context (`containedctx`). The caller drains `out` until `Run` returns; a log sink, an SSE stream or a ring buffer for the persisted record all sit behind that channel.

## Unix: process group

```go
//go:build unix

type tree struct {
	cmd      *exec.Cmd
	mu       sync.Mutex // guards escalate: set from exec's goroutine, stopped from Run's
	escalate *time.Timer
}

func newTree(cmd *exec.Cmd, grace time.Duration) *tree {
	t := &tree{cmd: cmd}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// WaitDelay below SIGKILLs only the leader, so the group gets its own escalation.
		t.mu.Lock()
		t.escalate = time.AfterFunc(grace, func() { _ = signalGroup(cmd, syscall.SIGKILL) })
		t.mu.Unlock()
		return signalGroup(cmd, syscall.SIGTERM)
	}
	cmd.WaitDelay = 2 * grace // last resort: close the pipes even if a descendant escaped the group
	return t
}

func (t *tree) started() error { return nil }

func (t *tree) kill() error {
	t.mu.Lock()
	if t.escalate != nil {
		t.escalate.Stop()
	}
	t.mu.Unlock()
	err := signalGroup(t.cmd, syscall.SIGKILL)
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func signalGroup(cmd *exec.Cmd, sig syscall.Signal) error {
	// A negative pid addresses the process group whose id is the leader's pid.
	err := syscall.Kill(-cmd.Process.Pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	if err != nil {
		return &os.SyscallError{Syscall: "kill", Err: err}
	}
	return nil
}
```

## Windows: job object

```go
//go:build windows

type tree struct {
	cmd      *exec.Cmd
	mu       sync.Mutex // guards job and escalate: Cancel's timer and Run's goroutine both kill
	job      windows.Handle
	escalate *time.Timer
}

func newTree(cmd *exec.Cmd, grace time.Duration) *tree {
	t := &tree{cmd: cmd}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		t.mu.Lock()
		t.escalate = time.AfterFunc(grace, func() { _ = t.kill() })
		t.mu.Unlock()
		// Ctrl+Break is the closest thing to SIGTERM; it reaches only console children sharing our console.
		pid := uint32(cmd.Process.Pid) //nolint:gosec // Windows pids are DWORDs
		if err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, pid); err != nil {
			return t.kill()
		}
		return nil
	}
	cmd.WaitDelay = 2 * grace
	return t
}

// started assigns the child to a kill-on-close job. Anything it spawned before this call escapes the job.
func (t *tree) started() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("create job: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))) //nolint:gosec // Win32 takes the struct by pointer
	if err != nil {
		return errors.Join(fmt.Errorf("limit job: %w", err), windows.CloseHandle(job))
	}
	var assignErr error
	err = t.cmd.Process.WithHandle(func(h uintptr) { // Go 1.26+: no pid-reuse race
		assignErr = windows.AssignProcessToJobObject(job, windows.Handle(h))
	})
	if err = errors.Join(err, assignErr); err != nil {
		return errors.Join(fmt.Errorf("assign job: %w", err), windows.CloseHandle(job))
	}
	t.mu.Lock()
	t.job = job
	t.mu.Unlock()
	return nil
}

// kill terminates the job (the whole tree) once; without a job it kills the child alone.
func (t *tree) kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.escalate != nil {
		t.escalate.Stop()
	}
	if t.job == 0 {
		err := t.cmd.Process.Kill()
		if err == nil || errors.Is(err, os.ErrProcessDone) {
			return nil
		}
		return fmt.Errorf("kill: %w", err)
	}
	job := t.job
	t.job = 0
	return errors.Join(windows.TerminateJobObject(job, 1), windows.CloseHandle(job))
}
```

`KILL_ON_JOB_CLOSE` also means the tree dies with the supervisor, since the OS closes the handle when our process exits.

## The supervisor's own lifecycle

```go
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop() // os.Exit skips defers, so release the signal handler first
	os.Exit(exitCode(err, os.Stderr))
}
```

- Since 1.26 the context's cause names the signal (`context.Cause(ctx)` reads "terminated signal received"), so a run stopped by shutdown is reported as such, not as a timeout.
- After the first signal, call `stop()` as soon as shutdown begins if a second Ctrl+C should kill the supervisor immediately (default signal behaviour returns).
- A daemon runs its parts (API server, scheduler, run workers) in one `errgroup.WithContext`; each part returns when `ctx` is done; `http.Server.Shutdown` gets a fresh `context.WithTimeout(context.WithoutCancel(ctx), grace)`, as do the final state write and the OpenTelemetry `Shutdown`.
- Concurrent runs are bounded with `g.SetLimit(n)`; a run's record is written when it starts and when it ends, so a crash leaves a "started, never finished" record the next start can reconcile.

## Gotchas

- **`WaitDelay` kills the leader only.** On expiry exec SIGKILLs `cmd.Process` and closes the pipes; grandchildren survive. Escalate on the group yourself (the timer above).
- **Reading `StdoutPipe` before `Wait` hangs forever** when a grandchild inherits the pipe: `WaitDelay` only starts inside `Wait`. Seen in practice: a test that should take 300 ms took 60 s, the grandchild's `sleep 60`. Use `io.Writer` outputs.
- **`Setpgid` takes the child out of the terminal's foreground group**: Ctrl+C reaches the supervisor only, which must forward the stop. That is the point, but an interactive child (one that reads the TTY) needs `Foreground: true` and a `Ctty` instead.
- **A descendant that calls `setsid` or `setpgid` leaves the group.** On Linux, put each run in its own cgroup v2 and write `1` to `cgroup.kill` for complete containment; macOS has no equivalent.
- **`Pdeathsig` (Linux) fires when the *thread* that started the child exits**, not the process; Go moves goroutines between threads. Only use it with `runtime.LockOSThread` around `Start`, or rely on the job/cgroup instead.
- **Pid reuse.** Signal by pid only while the leader is unreaped (before `Wait` returns) or for the group right after it; never store pids to signal later. `Process.WithHandle` (pidfd on Linux 5.4+, a handle on Windows) pins the process.
- **Windows has no SIGTERM.** `os.Interrupt` via `Process.Signal` is not implemented there; Ctrl+Break works only for console processes sharing our console, and GUI or service children get the hard kill after the grace period. A Windows service supervisor uses `golang.org/x/sys/windows/svc` for its own stop requests.
- **Environment.** `cmd.Env == nil` inherits everything, secrets included. Build the child's environment explicitly (an allowlist over `os.Environ()`) and pass tokens per run.
- `gosec` G204 (subprocess with variable arguments) is disabled in the template because launching configured commands is the job; validate the command against the run's spec instead, and never pass user input through `sh -c`.
