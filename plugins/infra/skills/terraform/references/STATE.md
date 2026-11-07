# State

- Remote backend with locking, versioning and encryption at rest, access limited to the CI identities and a break-glass group. One state per environment and per root; keep blast radius small (a root per lifecycle, not one for everything).
- State is a secret: it holds resource attributes in plain text, including values marked `sensitive`.
- Never edit state by hand. Use `moved`, `import` and `removed` blocks in code so the change is reviewed and applied by CI. `terraform state` subcommands are a human escape hatch, run on a backed-up state with no run live.
- Backend configuration cannot use variables; give each `envs/<env>/` its own backend block or `-backend-config` file.
- `force-unlock` is human-only: `terraform force-unlock [-force] LOCK_ID`. The lock ID is the one the failed command printed; its form depends on the backend, so read it from the error rather than guessing. It removes the lock without touching infrastructure; run it only after confirming no process still holds it. Local state cannot be unlocked by another process.
- A local plan takes the lock like any run; if killed it can leave the lock behind. Hence plans run in CI, and a local one needs explicit human approval.
- Imports are `import` blocks reviewed in a PR, followed by a plan showing no changes beyond the import.
- Backend changes that migrate state (`init -migrate-state`) are their own change, done by a human with a state backup.
