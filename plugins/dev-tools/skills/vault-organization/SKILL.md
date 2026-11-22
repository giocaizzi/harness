---
name: vault-organization
description: "Use when a password manager vault (Bitwarden, 1Password) is messy: inconsistent item names, unfiled items, scattered keys, GitHub App keys with no metadata, or when naming, filing or auditing machine secrets, SSH keys, tokens and service accounts there; also reorganizing, renaming or deduplicating a vault."
---

# Vault organization

Goal: a vault where every machine secret is findable by name alone, filed in one predictable place, and stable enough that other systems can reference it by item id. Human web logins stay as they are; this governs everything a machine uses. Handling rules (never print a value, unlock in the user's terminal) come from `secrets-handling` and apply throughout.

## The convention

- **Name:** `<scope>-<system>-<kind>[-<qualifier>][-<env>]`, lowercase kebab-case. Scope is who owns it (org, product, host), system is what it authenticates to, kind comes from a fixed list, qualifier says which one, env is `dev` or `prod` only when more than one exists. Kinds, examples and the GitHub App item model: [references/convention.md](references/convention.md).
- **Folders:** context first, then system (`Personal`, `Work/<employer>`, `Dev/<system or product>`, `_archive`). Nested folders are one folder whose name contains `/`. Never one folder per item or per service; a folder with fewer than about five items is merged up.
- **Web logins** keep the site's own name. A self-hosted service login is `<scope>-<service>-ui-login`.
- **One item per secret, one home per secret.** Different values are different items; identical values are merged.

## Procedure

1. **Unlock in the user's terminal**, then `bw sync`. Read only through a session file the user created; delete it at the end.
2. **Audit**, value-free: `scripts/bw-audit.sh <dir>` writes `meta.json` (names, folder, type, field names, attachment names, note lengths, never values) and deletes the raw export. Look for: unfiled items, folders of one to three items, mixed naming styles, secrets of one kind in several places, items whose type does not fit (key in a note, login without password), identical values under different names (compare hashes, print only group sizes and names).
3. **Design with the owner, one question at a time**: folder model, naming grammar, how to treat duplicates (archive first, delete later). Present the grammar with examples from their own vault before applying it.
4. **Write the mapping** as `mapping.tsv` (`id old new old_folder new_folder note`). Names the owner cannot explain are asked one by one and recorded; unknown purpose is flagged `CHECK`, never guessed into a final name. Everything the owner calls dead goes to `_archive`, never deleted.
5. **Back up** with `bw export --format encrypted_json --output <file>` (no password gives an account-restricted file). It excludes attachments; say so.
6. **Apply** with `scripts/bw-apply.sh mapping.tsv` (`DRY_RUN=1` first). It creates folders, edits name and folder in place so item ids never change, and checks each item's content signature before and after.
7. **Verify**, then delete emptied folders, `bw lock`, delete the session file and every scratch export. Report a table of what changed, what was archived and what is flagged `CHECK`.

## Gotchas

- Item ids must survive: other systems reference them. Rename and move in place with `bw edit`, never delete and recreate. Tell the owner and any session that uses an item before renaming it.
- Renaming a GitHub App in GitHub changes its slug; App id and client id do not change. Record the slug in the item after the rename, not before.
- Rotating a key or client secret breaks every consumer holding a copy (a cell, a CI secret, a secret manager). Ask who holds it first.
- A listing that prints notes or custom fields leaks values. Print names, counts and hashes only; if a value leaked, tell the owner to rotate it.
- `bw list items` returns every value; keep it out of output and delete the file the moment `meta.json` exists.
- Each `bw` call costs a few seconds, so applying about 150 items takes tens of minutes: run it in the background and wait on the process.
- macOS ships bash 3.2 (no associative arrays) and `xargs` cannot call a shell function; the scripts avoid both.
- A `jq` lookup keyed by `folderId` fails on unfiled items (null): default the key.
