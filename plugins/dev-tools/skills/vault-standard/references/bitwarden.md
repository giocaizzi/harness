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

## Reorganizing

- `scripts/bw-audit.sh <dir>`: value-free `meta.json` (names, folder, type, field and attachment names, note lengths), raw export deleted.
- `bw export --format encrypted_json --output <file>` without a password gives an account-restricted file; attachments are not included.
- `scripts/bw-apply.sh mapping.tsv` (`DRY_RUN=1` first): creates folders, edits name and folder in place, compares each item's secret-bearing content before and after, prints ids and names only.

## Gotchas

- Each `bw` call takes a few seconds: about 150 edits take tens of minutes, so run the apply in the background and wait on the process.
- macOS ships bash 3.2 (no associative arrays), and `xargs` cannot call a shell function; the scripts avoid both.
- A `jq` lookup keyed by `folderId` fails on unfiled items (null); default the key.
- An edit can normalise empty keys (`null`, `[]`), so compare secret-bearing fields, not the whole object.
