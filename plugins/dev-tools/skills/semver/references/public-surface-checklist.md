# Public surface checklist

Inspect every affected surface before choosing a bump. If any becomes incompatible for existing consumers, the change is breaking.

- package exports and documented entry points
- CLI commands, flags, exit codes, output formats
- configuration keys, defaults, environment variables
- HTTP routes, status codes, schemas, auth requirements, pagination
- events, hooks, callback order, plugin manifests
- file formats, database compatibility promises, migration requirements
- supported runtime and dependency ranges

| Change | Bump |
|---|---|
| Add a new optional CLI flag | minor |
| Remove a deprecated config key | major |
| Fix incorrect JSON serialization, schema unchanged | patch |
| Rename a plugin manifest field | major |
| Add a response field, keep old ones | minor |
| Drop support for Python 3.10 | major |
