# Bump examples and release workflow

## Pre-1.0 nuance

In `0.y.z`, backward-compatible additions are `minor` when they materially expand the contract.
- `0.4.2` -> `0.5.0`: breaking or materially additive contract changes
- `0.4.2` -> `0.4.3`: bug fixes

## Typical major

- Removing or renaming a public API, CLI command, config key, event, hook, or manifest field
- Changing signatures, required parameters, return shapes, HTTP status behaviour, or payload schemas incompatibly
- Tightening validation so previously accepted input now fails
- Changing defaults in a way that alters observable behaviour for existing users

## Typical minor

- Adding a new optional parameter, endpoint, command, feature flag, exported helper, or manifest field
- Adding support for a new platform, integration, or configuration mode
- Adding a new event, extension point, or output field while keeping old ones valid

## Typical patch

- Fixing incorrect output, validation bugs, crashes, race conditions, or misleading documentation examples
- Restoring documented behaviour after a regression
- Tightening implementation details without changing the supported contract
- Performance improvements that preserve semantics

## Deprecation notice

Each notice states:
- what is deprecated
- what to use instead
- when removal is expected

## Release decision workflow

1. Identify the public contract affected by the change.
2. Compare old consumer usage with new consumer usage.
3. Pick the smallest honest bump: `major`, `minor`, or `patch`.
4. Check whether multiple changes in the release require a higher bump.
5. Document deprecations and migrations before publishing.
6. Verify all version locations are updated consistently.
