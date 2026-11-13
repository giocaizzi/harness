# Where to cut, by symptom

Measure first, cut one lever, then measure again over an equal window with similar volume. Read the run history for: runs per merged change, wall-time p50 and p90, the longest path through the job graph, queue-to-green, eject rate (gate runs per merged change above 1), skipped share, re-run share, and minutes per runner type. Use the repo's own CI health target (for example `make ci-health`) or its run-history report. Levers are in priority order.

| Symptom in the run history | Likely cause | Lever | Confirm |
|---|---|---|---|
| Change-request runs per merged change rising | superseded runs left running; one push per fix; many small changes or stacked layers (each layer pays its own runs) | cancel superseded change-request runs; push a review round as one commit; batch related work in one change | runs per merged change and cancelled share |
| Hung or very long outliers; p90 far above p50 | a job with no timeout, or a hang that holds the gate | a timeout on every job, from measured duration plus headroom | longest run falls; no timeout hits on healthy runs |
| Gate runs per merged change rising; queue ejects | a flaky or slow job in the full tier; full checks repeated after the merge | find the failing job first; run the full tier once per tree | eject rate; mainline minutes drop |
| p90 or queue-to-green rising while runner wait stays near zero | not saturation: the critical path grew (serial jobs, one long job, cold caches) | drop false edges; shard the longest job; cache dependencies; build once and pass the artifact | the longest job and the sum along the path shrink |
| Runner wait (queued time) rising | not enough runners for the fan-out, or one expensive label | fewer, larger jobs (setup paid once); heavy legs only where gated; more runners is the owner's call (billing) | queued time per job |
| High skipped share; noise in the checks list | wide triggers that start runs that do nothing | narrow triggers (events, branches); job-level change detection behind one aggregate gate | skipped share falls; the gate still reports |
| A required check stuck pending | a trigger-level path filter on a required pipeline: no run, so no status | move the filter to a detection job; the aggregate gate always runs | the check reports on a change touching only ignored paths |
| One runner type dominates minutes (macOS, Windows, multi-arch, GPU) | heavy legs on every change-request push | heavy legs where the merge is gated and nightly; on change requests only when their paths change | minutes per runner type; the leg still runs at the gate |
| Whole matrix cancelled on one failure, then re-run | fail-fast hides which legs fail | fail-fast off where legs are independent | re-run count falls |
| Cache hit rate low | key too narrow (includes a commit SHA) or too wide (never invalidates, restores stale); caches written from every branch evict each other | key on lockfile, toolchain and OS; write from mainline only | hit rate; restore time against install time |

- **Trust trade-off.** Moving a suite or an OS leg off change requests delays its signal: a break fails the gate instead of the change. Record that in the change that moves it; how much signal to trade is the owner's call: propose, do not decide.
- **No gated merge** (no merge queue or train): the change-request run, with the branch required up to date, or the mainline run is the gate. Heavy legs go nightly plus changes whose paths touch them.
- Fewer minutes with a higher eject rate is a loss: each eject pays the full tier again.
- A quiet week flatters any change: compare windows of similar volume.
