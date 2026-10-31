# Sync workspace MCP

**When:** setting up this checkout for Codex or pi, or after changing its `.mcp.json`.
**Preconditions:** Node.js 22+, `make`, and a shell whose existing credential-manager setup injects the non-secret hostname identifier `MCP_CONNECTOR_ACCOUNT`. Do not put credentials in the source or environment substitutions.

## Steps

1. Edit only `.mcp.json`. The converter supports HTTP entries with `type: "http"` and `url`; other fields, transports, URL userinfo, query strings, fragments, and variable names are rejected.
2. Run `make mcp` from this checkout. It writes `.codex/config.toml` and `.pi/mcp.json` with restricted permissions. Both files are ignored by Git because their URLs contain the local account identifier. A missing identifier fails with its variable name, without printing its value.
3. If a native file already exists without the generator's ownership marker, preserve it outside these destinations before generating. Both destinations are checked before either is written. Generated files are fully owned by the converter; rerunning it replaces their contents, including removed servers.
4. Start a new Codex session in this checkout; in pi, start here or use `/reload` after generation. Grant the client's project trust when prompted. Sign in to the server through the client's MCP interface if requested.

`make build` does not generate these local files. Run `make mcp` separately in each checkout or worktree; user-level MCP configuration is unaffected.

## Verify

- Run `make test-mcp` for conversion and destination-protection tests.
- Run `make validate` to validate `.mcp.json` without using private environment values or reading/writing local native files. This checks supported conversion, not local-file freshness or server connectivity.
- In Codex, run `codex mcp list --json` and inspect the server names without sharing endpoint values. In pi, `/mcp` shows the configured servers and their connection state. A configured server is not proof of a successful connection.

## Rollback

Remove only the two generated files, `.codex/config.toml` and `.pi/mcp.json`, then restart Codex or reload pi. Restore any native configuration preserved before generation. To undo a source edit, restore `.mcp.json` and rerun `make mcp`.

**Last verified:** 2026-10-31 by automated conversion tests; live authentication is separate.
