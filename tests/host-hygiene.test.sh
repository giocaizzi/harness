#!/usr/bin/env bash
# Tests for plugins/dev-tools/skills/host-hygiene/scripts/heavy.sh (run by `make test`).
set -u
heavy="$(cd "$(dirname "$0")/.." && pwd)/plugins/dev-tools/skills/host-hygiene/scripts/heavy.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HEAVY_STATE_DIR="$tmp/state" HEAVY_LOAD_MAX=100000 HEAVY_DISK_MIN_GB=0
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }

# Two concurrent runs serialize: the second starts only after the first ends.
"$heavy" sh -c "echo start >>'$tmp/log'; sleep 1; echo end >>'$tmp/log'" 2>/dev/null &
sleep 0.3
"$heavy" sh -c "echo start >>'$tmp/log'; echo end >>'$tmp/log'" 2>/dev/null
wait
check "concurrent runs serialize" "$(tr '\n' ' ' <"$tmp/log")" "start end start end "

"$heavy" sh -c 'exit 7'
check "exit code propagates" "$?" 7

sh -c 'exit 0' & dead=$!; wait "$dead"
mkdir -p "$HEAVY_STATE_DIR/slot.1"; echo "$dead" >"$HEAVY_STATE_DIR/slot.1/pid"
"$heavy" true 2>/dev/null
check "stale lock recovered" "$?" 0
check "slot released" "$([ -e "$HEAVY_STATE_DIR/slot.1" ] && echo held)" ""

HEAVY_DISK_MIN_GB=999999999 "$heavy" touch "$tmp/ran" 2>/dev/null
check "low disk refuses" "$?:$([ -e "$tmp/ran" ] && echo ran)" "1:"

"$heavy" sleep 2 & sleep 0.3
check "--status shows the holder" "$("$heavy" --status | grep -c 'held: pid .* sleep 2')" 1
wait

exit "$fails"
