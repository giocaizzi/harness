# Dev mode for components

A dev mode relaxes a component's checks so development is fast. It must never let dev behaviour pass as prod.

- **Add one only where it measurably speeds up development.** Never use it to bypass a safety or trust check silently: a relaxed safety check becomes a warning, never disappears.
- **One switch per component:** a `--dev` flag or a `<APP>_DEV=1` env var. Never the default, never saved in shipped config.
- **A closed list of relaxations.** Each is named in code and documented in a "Dev mode" section of the component's docs. Anything not listed behaves exactly as in prod.
- **Guards refuse dev in prod contexts and fail closed**, with the reason and no override flag. Prod contexts:
  - an installed service (launchd, systemd, a prod container stack)
  - a release build (a version from a release tag)
  - CI on the default branch
  - an unattended run (`GUARD_UNATTENDED=1`)
  - prod config, endpoints or credentials
- **Always visible:**
  - a startup warning naming each relaxation in use
  - telemetry `deployment.environment.name=development`
  - outputs other systems read (comments, result files, artifacts) tagged as dev, so nothing from dev passes as prod
- **Tested in both directions:** each relaxation works in dev, and each guard refuses it in prod.
