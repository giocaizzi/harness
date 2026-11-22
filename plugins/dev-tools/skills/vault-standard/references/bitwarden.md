# Bitwarden (`bw`)

The standard in [SKILL.md](../SKILL.md) applied to the password-vault CLI. Unlocking, session files and keeping values out of output follow `secrets-handling`.

## Reading

- Find: `bw list items --search <name> | jq '[.[]|{id,name,folderId}]'`. Match the name exactly; use `bw get item <id>` once known.
- Fields: `bw get password <id>`, `bw get username <id>`; a custom field with `jq -r '.fields[]|select(.name=="client-secret")|.value'` over `bw get item <id>`; an attachment with `bw get attachment <file> --itemid <id> --output <path>` into a mode-600 file you delete after use.
- `bw list items` returns every value: write it to a mode-600 file, derive what you need, delete the file.

## Writing

- `jq` builds the item JSON (name, folderId, type, login or notes, fields), the value comes from a file, stdin or the keyring; then `bw encode` and `bw create item <encoded>`. Edit with `bw get item <id> | jq … | bw encode`, then `bw edit item <id> <encoded>`: id, attachments and history stay.
- Nested folders are one folder whose name contains `/`. Create one with `bw create folder "$(jq -n --arg n 'Dev/cloud' '{name:$n}' | bw encode)"`.
- `bw sync` after writing, and before any audit: a stale local cache lists stale items.

## Gotchas

- Each `bw` call takes a few seconds, so a bulk edit of many items takes long: run it in the background. macOS ships bash 3.2 (no associative arrays), and `xargs` cannot call a shell function.
- A `jq` lookup keyed by `folderId` fails on unfiled items (null); default the key.
- An edit can normalise empty keys (`null`, `[]`); to check an edit left a secret alone, compare hashes of the secret fields, not the whole object.
- An encrypted export (`bw export --format encrypted_json --output <file>`, no password) is account-restricted and leaves out attachments.
