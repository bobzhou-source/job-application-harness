#!/bin/bash
# Single-writer runner-host lock. The laptop checkout is the authority because the Mac has no SSH server.
# Both hosts mutate the same lock directory over SSH; a stale lock fails closed and needs an explicit
# `force-release` after the operator has confirmed no runner process is alive.
set -euo pipefail

REMOTE_SSH=${JOB_HARNESS_REMOTE_SSH:-windows}
REMOTE_ROOT=${JOB_HARNESS_REMOTE_ROOT:-/home/bob/job-harness}
REMOTE_LOCK="$REMOTE_ROOT/runs/runner-host-lock.sh"
LOCK_DIR="$(cd "$(dirname "$0")" && pwd)/runner-host"

usage() {
  echo "usage: runs/runner-host-lock.sh acquire|release|status|force-release [holder]" >&2
  exit 64
}

command=${1:-}
[ -n "$command" ] || usage
case "$command" in
  acquire|release|force-release|status) ;;
  *) usage ;;
esac

case "$command" in
  acquire|release)
    holder=${2:-"${USER:-$(id -un)}@$(hostname -s 2>/dev/null || hostname)"}
    case "$holder" in
      ''|*[!A-Za-z0-9_.:@-]*) echo "invalid holder (use [A-Za-z0-9_.:@-])" >&2; exit 64 ;;
    esac
    ;;
  *) holder=${2:-} ;;
esac

# The Mac delegates every operation to the laptop's authoritative checkout. On the laptop, run locally.
if [ "$(uname -s)" != "Linux" ]; then
  remote_command="$REMOTE_LOCK $command"
  [ -n "$holder" ] && remote_command="$remote_command $holder"
  exec ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_SSH" \
    "wsl -d Ubuntu -- $remote_command"
fi

mkdir -p "$(dirname "$LOCK_DIR")"

case "$command" in
  acquire)
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      umask 077
      printf '%s\n' "$holder" > "$LOCK_DIR/owner"
      echo "runner-host acquired by $holder"
      exit 0
    fi
    current=$(cat "$LOCK_DIR/owner" 2>/dev/null || printf 'unknown')
    echo "runner-host already held by $current" >&2
    exit 75
    ;;
  release)
    [ -d "$LOCK_DIR" ] || { echo "runner-host is free"; exit 0; }
    current=$(cat "$LOCK_DIR/owner" 2>/dev/null || printf 'unknown')
    if [ "$current" != "$holder" ]; then
      echo "runner-host held by $current, not $holder; refusing release" >&2
      exit 75
    fi
    rm -f "$LOCK_DIR/owner"
    rmdir "$LOCK_DIR"
    echo "runner-host released by $holder"
    ;;
  force-release)
    if [ ! -d "$LOCK_DIR" ]; then echo "runner-host is free"; exit 0; fi
    current=$(cat "$LOCK_DIR/owner" 2>/dev/null || printf 'unknown')
    rm -f "$LOCK_DIR/owner"
    rmdir "$LOCK_DIR"
    echo "runner-host force-released (was $current)"
    ;;
  status)
    if [ -d "$LOCK_DIR" ]; then
      current=$(cat "$LOCK_DIR/owner" 2>/dev/null || printf 'unknown')
      echo "runner-host held by $current"
      exit 75
    fi
    echo "runner-host free"
    ;;
esac
