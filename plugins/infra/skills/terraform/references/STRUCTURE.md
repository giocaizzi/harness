# Structure

```
modules/<name>/      reusable; no knowledge of any environment; no provider or backend config; tests beside main.tf
envs/<env>/          thin root: only composes modules; own backend config and <env>.tfvars
bootstrap/           state bucket and CI identities; applied once by a human
```

## Rules

- Environments differ by variables, never by copied code. A root that needs logic belongs in a module.
- Separate directories and separate states per environment, not workspaces: a workspace shares code, backend credentials and blast radius.
- The same pinned module versions are promoted dev to prod: change the version in dev, prove it, then change prod.
- Names are `<app>-<env>-<resource>` (for example `acme-dev-invoices-exports`).
- Every root sets the required labels or tags (app, env, owner) through one shared local or provider default.
- The prod apply path stays dormant until an explicit activation checklist is done (identities created, approvers named, drift plan green, rollback owner known). Record the checklist in the repo; do not enable the job before it is complete.
- Module tests live in each module, not in `envs/`.
- `bootstrap/` is applied once by a human; afterwards its own state moves to the remote backend it created.
