---
name: vault-organization
description: "Use whenever a task reads from or writes to a password vault (Bitwarden bw, 1Password): looking up a token, key, SSH key or GitHub App credential, adding, renaming or moving an item. The vault follows one standard for names, folders and item types; this gives it, plus lookup, write and audit recipes."
---

# Vault organization

The vault follows one standard, and every read and write follows it, whether the vault is tidy or not. `secrets-handling` says how to keep values out of output; this skill says where things live, what they are called and how to find and add them. A messy vault is one use of it (the last section), not the reason to load it.

Goal: every machine secret is findable by name alone, filed in one predictable place, and stable enough that other systems can reference it by item id. Human web logins stay as they are; this governs everything a machine uses.

## The convention

- **Name:** `<scope>-<system>-<kind>[-<qualifier>][-<env>]`, lowercase kebab-case. Scope is who owns it (org, product, host), system is what it authenticates to, kind comes from a fixed list, qualifier says which one, env is `dev` or `prod` only when more than one exists. Kinds, examples and the GitHub App item model: [references/convention.md](references/convention.md).
- **Folders:** context first, then system (`Personal`, `Work/<employer>`, `Dev/<system or product>`, `_archive`). Nested folders are one folder whose name contains `/`. Never one folder per item or per service; a folder with fewer than about five items is merged up.
- **Web logins** keep the site's own name. A self-hosted service login is `<scope>-<service>-ui-login`.
- **One item per secret, one home per secret.** Different values are different items; identical values are merged.

## Reading

- Derive the name from the grammar, then look it up by name: `bw list items --search <name> | jq '[.[]|{id,name,folder:.folderId}]'`. A name match is exact; several hits means ask, never pick one. Prefer the item id once known: ids survive renames, names do not.
- Fields: `bw get password <id>`, `bw get username <id>`, a custom field with `jq -r '.fields[]|select(.name=="client-secret")|.value'` over `bw get item <id>`, an attachment with `bw get attachment <file> --itemid <id> --output <path>` into a mode-600 file you delete after use.
- Hand the value straight to the process that needs it (stdin, an env var for one command, a secret manager write). Never print it, never put it in an argument, never leave it in a file.
- Not found: search by system and kind (`--search github-app`), then the `_archive` folder, then ask. Never create a duplicate to get unblocked.

## Writing

- Check first: `bw list items --search <name>` must return nothing, otherwise edit that item in place.
- Name per the grammar, file in the folder for its context, type by shape: a login item with the value in the password field for one token or key; a secure note with fields and an attachment for a multi-part credential (GitHub App, service account, OAuth client).
- Build the JSON with `jq`, take the value from a file, stdin or the keyring (never a literal on the command line or in history), then `bw encode` and `bw create item`. Put non-secret context in the notes: what it is for, who consumes it, the expiry date in a field.
- Sync after writing (`bw sync`) and re-read only names and hashes to confirm. Tell the owner and any session that consumes the item about a rename or a rotation.

## Reorganizing an existing vault: procedure

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
