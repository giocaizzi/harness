---
name: vault-standard
description: "Use whenever a task reads from or writes to a password vault or secret store (Bitwarden, 1Password, pass): looking up a token, key, SSH key, certificate or service credential, adding, renaming or moving an item. One standard for names, folders and item types, with lookup, write and audit recipes."
---

# Vault standard

Every machine secret in a vault is named, filed and typed by one standard, so it can be found by name alone and referenced by id without surprises. Every read and write follows it, in a tidy vault and a messy one. `secrets-handling` keeps values out of output; this skill says where things live, what they are called and how to find and add them. Human web logins are outside it and keep the site's own name.

## The standard

- **Name:** `<scope>-<system>-<kind>[-<qualifier>][-<env>]`, lowercase kebab-case. Scope is who owns it (org, product, host), system is what it authenticates to, kind comes from a fixed list, qualifier says which one, env (`dev`, `prod`) only when more than one exists. Kinds, examples and the multi-part model: [references/convention.md](references/convention.md).
- **Folders:** context first, then system: `<context>/<system or product>` plus one `_archive`. Contexts are the owner's (personal, work, dev), and work stays apart from the rest. One folder per system or product, never per item; a folder with fewer than about five items is merged up.
- **Item type follows shape:** one token or key is a single-value item; a credential of several parts is one item with fields and an attachment.
- **One item per secret, one home per secret.** Different values are different items; identical values are merged. A self-hosted service's own login is `<scope>-<service>-ui-login`.
- **Ids are stable, names are not.** Other systems hold item ids. Rename and move in place; never delete and recreate.

## Reading

- Derive the name from the grammar and look it up by exact name. Several hits means ask, never pick one. Use the item id from then on.
- Hand the value straight to the process that needs it (stdin, an environment variable for one command, a secret-manager write). Never print it, put it in an argument or leave it in a file.
- Not found: search by system and kind, then `_archive`, then ask. Never create a duplicate to get unblocked.

## Writing

- Search for the name first; if it exists, edit that item in place.
- Name per the grammar, file in the context's folder, type by shape. Take the value from a file, stdin or the keyring, never a literal on a command line or in history.
- Record non-secret context on the item: what it is for, who holds a copy, the expiry date.
- Re-read only names and hashes to confirm. Tell the owner and any session that uses an item about a rename or a rotation.

## Reorganizing an existing vault

1. **Unlock in the user's terminal**; read through a session the user created and delete it at the end.
2. **Audit without values:** names, folders, types, field and attachment names, note lengths, and hashes to find identical secrets. Look for unfiled items, tiny folders, mixed naming styles, one kind of secret in several places, items of the wrong type.
3. **Design with the owner, one question at a time:** folder model, grammar, how to treat duplicates (archive first, delete later). Show the grammar on their own items before applying it.
4. **Write a mapping** (`id old new old_folder new_folder note`). An item the owner cannot explain is asked about one by one; an unknown purpose is flagged `CHECK`, never guessed into a final name. What the owner calls dead goes to `_archive`, never deleted.
5. **Back up** with an encrypted export first, and say what it excludes (attachments).
6. **Apply** in place, a dry run first, checking each item's content before and after.
7. **Verify**, remove emptied folders, lock the vault, delete the session and every scratch file, and report what changed, what was archived and what is flagged.

## Providers

Commands, scripts and quirks per vault live in one reference each: [references/bitwarden.md](references/bitwarden.md) (`bw`, with `scripts/bw-audit.sh` and `scripts/bw-apply.sh`). For any other vault, apply the standard through its CLI and check its docs before relying on a flag you have not used.

## Gotchas

- Rotating a key or client secret breaks every holder of a copy (a cluster, a CI secret, a secret manager). Ask who holds it first.
- Renaming the thing a secret belongs to (an app, a service account, a repo) can change identifiers stored beside the secret, such as a slug, while its ids stay. Record the new identifier after the rename, not before.
- A listing that prints notes or custom fields leaks values. Print names, counts and hashes only; a value that leaked is rotated.
