#!/usr/bin/env bash
# Value-free audit export of a Bitwarden vault. Usage: bw-audit.sh <output-dir>
# Needs a session file made by the user: (umask 077; bw unlock --raw > "$BW_SESSION_FILE").
set -euo pipefail
out="${1:?output dir}"; sf="${BW_SESSION_FILE:-$HOME/.bw-session}"
mkdir -p "$out"; chmod 700 "$out"
S="$(cat "$sf")"
bw() { command bw --session "$S" "$@"; }
[ "$(bw status | jq -r .status)" = unlocked ] || { echo "vault is locked" >&2; exit 1; }
bw sync >/dev/null
bw list folders > "$out/folders.json"
raw="$(mktemp "$out/raw.XXXXXX")"; trap 'rm -f "$raw"' EXIT
bw list items > "$raw"
jq --slurpfile f "$out/folders.json" '
  ($f[0] | map({(.id // "x"): .name}) | add) as $fm
  | [.[] | {id, name, type,
      folder: ($fm[(.folderId // "x")] // "(none)"),
      rev: .revisionDate[0:10],
      hasPw: (.login.password != null),
      uris: [.login.uris[]?.uri | sub("^https?://"; "") | .[0:50]],
      fields: [.fields[]?.name],
      att: [.attachments[]?.fileName],
      notesLen: ((.notes // "") | length)}]' "$raw" > "$out/meta.json"
jq -r 'length|"items: \(.)"' "$out/meta.json"
jq -r 'group_by(.folder)|map("\(length)\t\(.[0].folder)")|.[]' "$out/meta.json" | sort -rn
