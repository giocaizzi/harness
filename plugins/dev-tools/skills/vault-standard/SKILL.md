---
name: vault-standard
description: "Use whenever a task reads, writes, names, files or renames a secret in any store: a password manager (Bitwarden, 1Password), a cloud secret manager (GCP, AWS, Azure), Vault, pass, a keyring or a CI secret. The one standard for secret names, folders, item types and ids, so every secret is findable by name."
---

# Vault standard

One standard for every machine secret, in any store, so it is found by name alone and referenced without surprises. It governs names, places and shapes, not how a value is kept out of output (`secrets-handling`). Human web logins are outside it and keep the site's own name.

## Name

`<scope>-<system>-<kind>[-<qualifier>][-<env>]`, lowercase kebab-case.

- **scope:** who owns it (org, product, host).
- **system:** what it authenticates to.
- **kind:** one of a fixed list.
- **qualifier:** which one (machine, repo, purpose, service).
- **env:** `dev` or `prod`, only when more than one exists.

The same name is used for the same secret in every store, so a password-manager item, a cloud secret and a CI secret for one credential differ only where the store forces it (case, separators). Kinds, examples and multi-part items: [references/convention.md](references/convention.md).

## Place

- `<context>/<system or product>` plus one `_archive`; a store without folders puts the context in the name's scope or in labels.
- Contexts are the owner's (personal, work, dev). Work stays apart from everything else.
- One folder per system or product, never per item. A folder under about five items is merged up.

## Shape

- A single token or key is one single-value item.
- A credential of several parts is one item with fields for the non-secret identifiers and hidden fields for each secret part; a key file is its attachment.
- Every item records what it is for, who holds a copy and when it expires, never a secret, in notes or fields.

## Rules

- One item per secret and one home per secret: different values are different items, identical values are merged.
- Look a secret up by its exact name; several hits means ask. Not found: search by system and kind, then `_archive`, then ask. Never create a duplicate to get unblocked.
- Write only after searching for the name; if it exists, edit it in place.
- Ids are stable, names are not: other systems hold ids. Rename and move in place, never delete and recreate; tell the holders of a copy about a rename.
- Dead or superseded items go to `_archive` before any deletion.

## Gotchas

- Rotating a key or client secret breaks every holder of a copy (a cluster, a CI secret, another store). Ask who holds it first.
- Renaming what a secret belongs to (an app, a service account, a repo) can change identifiers stored beside it, such as a slug, while its ids stay. Record the new identifier after the rename.
