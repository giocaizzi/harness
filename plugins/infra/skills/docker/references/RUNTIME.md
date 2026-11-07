# Running containers

## User

- Numeric UID and GID (`USER 10001:10001`): Kubernetes `runAsNonRoot` cannot verify a named user. The user owns only what it writes; code stays root-owned and read-only.
- A static binary on `scratch` has no `/etc/passwd`: a numeric `USER` still works. Copy CA certificates and timezone data from the build stage if the app needs them.
- Run with a read-only root filesystem where the app allows it; give it a `tmpfs` or volume for the paths it writes.

## Signals and PID 1

- Exec-form `ENTRYPOINT ["app"]` / `CMD ["--flag"]`. Shell form wraps the command in `sh -c`, and the shell does not forward `SIGTERM`.
- The app handles `SIGTERM`: stop accepting work, drain, exit within the orchestrator's grace period.
- A wrapper script ends with `exec "$@"`. Zombie reaping in a container that forks children: `docker run --init` or `init: true` in compose.
- One process per container; a second process is a second container.

## Health

- Where an orchestrator probes (Kubernetes liveness, readiness, startup), do not duplicate it in the image.
- Elsewhere (compose, plain Docker) add `HEALTHCHECK` calling the app's own health endpoint. A minimal image has no `curl`: have the binary offer a `healthcheck` subcommand.
- Liveness reports the process; readiness reports dependencies. Do not make liveness depend on a database.

## Configuration and secrets

- Environment variables or mounted files at runtime; never baked in. `ENV` in a Dockerfile only for non-secret defaults.
- Secrets are mounted files or injected by the platform, not passed with `docker run -e` into shell history.

## Resources

- Set memory and CPU limits in the deployment, and make the runtime aware of them (Go: `GOMEMLIMIT`; JVM and Node have container-aware flags).
- Log to stdout and stderr, structured; no log files in the container.
