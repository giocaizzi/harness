#!/usr/bin/env bash
# lease.sh <class> [--device <id>] [--] <command...>
#   Run a command holding a heavy slot and then the machine-wide lease for a device class
#   (e.g. ios-sim, android-emu): one holder per class. Slot first, lease second: the reverse
#   order deadlocks. With --device, a device that was not running at acquire time is shut
#   down on exit; only the lease holder owns the device.
#
# Env (lib.sh, plus): HOST_DEVICE_RUNNING_CMD (exit 0 if {device} runs),
#   HOST_DEVICE_SHUTDOWN_CMD ({device} is replaced by the id). Examples:
#     iOS simulator: 'xcrun simctl list devices booted | grep -q {device}' / 'xcrun simctl shutdown {device}'
#     Android:       'adb -s {device} get-state'                         / 'adb -s {device} emu kill'
set -u
. "$(dirname "$0")/lib.sh"

usage() { echo "usage: lease.sh <class> [--device <id>] [--] <command...>" >&2; exit 2; }
class=${1:-}; [ -n "$class" ] || usage; shift
device=''
if [ "${1:-}" = --device ]; then device=${2:-}; [ -n "$device" ] || usage; shift 2; fi
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || usage
if [ -n "$device" ] && { [ -z "${HOST_DEVICE_RUNNING_CMD:-}" ] || [ -z "${HOST_DEVICE_SHUTDOWN_CMD:-}" ]; }; then
  echo "lease: --device needs HOST_DEVICE_RUNNING_CMD and HOST_DEVICE_SHUTDOWN_CMD (see the header of lease.sh)" >&2
  exit 2
fi
lease=$HOST_LOCK_DIR/$class.lease
held='' booted=''
device_cmd() { sh -c "${1//\{device\}/$device}"; }

release() {
  if [ -n "$held" ] && [ "$(host_lease_pid "$lease")" = $$ ]; then
    [ -n "$booted" ] && { host_say "shutting down $device (booted under this lease)"; device_cmd "$HOST_DEVICE_SHUTDOWN_CMD" >/dev/null 2>&1; }
    rm -f "$lease"
  fi
  host_slot_release
}

host_disk_check
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
host_slot_acquire "$@"

said=''
until (set -C; echo "$HOST_OWNER $$${device:+ $device}" >"$lease") 2>/dev/null; do
  p=$(host_lease_pid "$lease")
  if [ -n "$p" ] && ! host_alive "$p" "$lease" && host_reclaim "$lease" "$p" host_lease_pid; then continue; fi
  host_timed_out && { host_say "gave up waiting for the $class lease after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
  [ -z "$said" ] && said=1 && host_say "waiting for the $class lease (held by $(cat "$lease" 2>/dev/null))"
  sleep 2
done
held=1
if [ -n "$device" ] && ! device_cmd "$HOST_DEVICE_RUNNING_CMD" >/dev/null 2>&1; then booted=1; fi

"$@"
