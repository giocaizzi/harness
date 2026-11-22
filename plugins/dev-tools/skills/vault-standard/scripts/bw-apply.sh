#!/usr/bin/env bash
# Apply mapping.tsv (id, old, new, old_folder, new_folder, note) to the vault in place.
# Usage: [DRY_RUN=1] bw-apply.sh mapping.tsv     Prints ids, names and status, never values.
# Item ids never change; each item's content signature must match before and after.
set -u
map="${1:?mapping.tsv}"; sf="${BW_SESSION_FILE:-$HOME/.bw-session}"
S="$(cat "$sf")"
bw() { command bw --session "$S" "$@"; }
# Secret-bearing content only: an edit may normalise empty keys (null, []), which is not a change.
sig() { jq -S -c '[(.login.username//null),(.login.password//null),(.login.totp//null),([.login.uris[]?.uri]),(.notes//null),([.fields[]?|[.name,.value,.type]]),(.sshKey//null),(.card//null),(.identity//null),(.attachments|length)]' | shasum -a 256 | cut -c1-16; }
folders="$(mktemp)"; trap 'rm -f "$folders"' EXIT
bw sync >/dev/null
bw list folders > "$folders"
fid() { jq -r --arg n "$1" '.[]|select(.name==$n)|.id' "$folders" | head -1; }
for f in $(tail -n +2 "$map" | cut -f5 | sort -u | tr ' ' '\037'); do
  f="$(printf '%s' "$f" | tr '\037' ' ')"
  [ -n "$(fid "$f")" ] && continue
  if [ "${DRY_RUN:-}" = 1 ]; then echo "would create folder: $f"; continue; fi
  enc="$(jq -n --arg n "$f" '{name:$n}' | bw encode)"
  bw create folder "$enc" >/dev/null && echo "created folder: $f"
  bw list folders > "$folders"
done
tail -n +2 "$map" | while IFS=$'\t' read -r id old new of nf note; do
  [ "$old" = "$new" ] && [ "$of" = "$nf" ] && continue
  if [ "${DRY_RUN:-}" = 1 ]; then echo "would: $old -> $new [$nf]"; continue; fi
  cur="$(bw get item "$id")" || { echo "FAIL get $id $old"; continue; }
  before="$(printf '%s' "$cur" | sig)"
  enc="$(printf '%s' "$cur" | jq --arg n "$new" --arg f "$(fid "$nf")" '.name=$n | .folderId=$f' | bw encode)"
  bw edit item "$id" "$enc" >/dev/null 2>&1 || { echo "FAIL edit $id $old"; continue; }
  after="$(bw get item "$id" | sig)"
  if [ "$before" = "$after" ]; then echo "OK   $old -> $new [$nf]"; else echo "DIFF $id $old (content signature changed)"; fi
done
