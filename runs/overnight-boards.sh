#!/bin/bash
# Board-queue handoff: never share the Workday runner's worker browsers while it owns them.
set -u
HARNESS=$(cd "$(dirname "$0")/.." && pwd)
BUN=${BUN:-"$HOME/.bun/bin/bun"}
export PATH="$HOME/.bun/bin:$PATH"
RUNS="$HARNESS/runs"
QUEUE="$HARNESS/queue.tsv"
LOCK="$RUNS/overnight-boards.lock"
WORKDAY_LOCK="$RUNS/overnight.lock"
HOST_ID=${RUNNER_HOST_ID:-"$(id -un)@$(hostname -s 2>/dev/null || hostname)"}
HOST_LOCK=0
cd "$HARNESS" || exit 1
set -a; . "$HARNESS/.env"; set +a
mkdir -p "$RUNS/smoke"

release_host_lock() {
  if [ "$HOST_LOCK" -eq 1 ]; then
    "$HARNESS/runs/runner-host-lock.sh" release "$HOST_ID" >/dev/null 2>&1 || true
    HOST_LOCK=0
  fi
}

if ! "$HARNESS/runs/runner-host-lock.sh" acquire "$HOST_ID"; then
  echo "boards: runner-host lock is held; exit"
  exit 75
fi
HOST_LOCK=1

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) boards: lock exists; already running"
  release_host_lock
  exit 1
fi
POOLS_RUN=0; T_SUB=0; T_STOP=0; T_SKIP=0; T_FAIL=0
ZERO_STREAK=0; STOP_REASON="unexpected exit"; POOL_PID=""
olog() { echo "$(date -u +%FT%TZ) boards: $*"; }
busy() { [ -d "$WORKDAY_LOCK" ] || pgrep -f '[b]un queue.mjs' >/dev/null 2>&1; }
data_rows() {
  local n
  n=$(grep -cv -e '^#' -e '^[[:space:]]*$' "$QUEUE" 2>/dev/null) || true
  printf '%s\n' "${n:-0}"
}
clean_workers() {
  # A signal/cutoff while waiting must never terminate the sibling's browsers.
  if ! busy; then pkill -f 'job-app-chrome-w[123]' 2>/dev/null || true; fi
}
cleanup() {
  trap '' INT TERM HUP
  if [ -n "$POOL_PID" ]; then
    kill -TERM "$POOL_PID" 2>/dev/null || true
    wait "$POOL_PID" 2>/dev/null || true
  fi
  clean_workers
  local msg="[From your coding agent] boards runner done: pools=$POOLS_RUN submitted=$T_SUB stopped=$T_STOP skipped=$T_SKIP failed=$T_FAIL; stop reason: $STOP_REASON"
  olog "exit: $msg"
  if [ -n "${POKE_API_KEY:-}" ]; then
    curl -fsS --max-time 20 -X POST https://poke.com/api/v1/inbound-sms/webhook \
      -H "Authorization: Bearer $POKE_API_KEY" -H 'Content-Type: application/json' \
      --data "$(jq -cn --arg m "$msg" '{message:$m}')" >/dev/null 2>&1 || olog 'Poke send failed'
  else
    olog 'POKE_API_KEY unset; no text sent'
  fi
  rmdir "$LOCK"
  release_host_lock
}
trap cleanup EXIT
trap 'STOP_REASON="interrupted"; exit 130' INT TERM HUP
# This run's deadline (UTC HH:MM, default 15:00), never silently roll an already-passed cutoff to tomorrow.
CUTOFF_HM=${BOARDS_CUTOFF:-15:00}
WORKERS=${BOARDS_WORKERS:-3}
CUTOFF=$(date -u -d "$(date -u +%F) $CUTOFF_HM:00" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$(date -u +%F) $CUTOFF_HM:00" +%s) || exit 1
olog "waiting for runs/overnight.lock to disappear AND no bun queue.mjs (pid $$; cutoff ${CUTOFF_HM}Z; workers $WORKERS)"
N=1
for f in "$RUNS"/smoke/boards-*.log; do
  [ -e "$f" ] || continue
  num=${f##*/boards-}; num=${num%.log}
  case $num in ''|*[!0-9]*) continue ;; esac
  [ "$num" -ge "$N" ] && N=$((num + 1))
done
while :; do
  if [ "$(date -u +%s)" -ge "$CUTOFF" ]; then STOP_REASON="${CUTOFF_HM}Z cutoff"; break; fi
  if busy; then sleep 15; continue; fi
  rows=$(data_rows)
  if [ "$rows" -eq 0 ]; then STOP_REASON='queue.tsv empty'; break; fi
  clean_workers
  sleep 3
  # Recheck after cleanup; a sibling can start during the pause.
  if busy; then continue; fi
  if [ "$(date -u +%s)" -ge "$CUTOFF" ]; then STOP_REASON="${CUTOFF_HM}Z cutoff"; break; fi
  plog="$RUNS/smoke/boards-$N.log"
  # Per-pool dial shared with overnight.sh: `echo 2 > runs/workers.conf`.
  case $(cat "$RUNS/workers.conf" 2>/dev/null) in 1|2|3) WORKERS=$(cat "$RUNS/workers.conf") ;; esac
  olog "pool $N starting (queue rows: $rows; workers $WORKERS)"
  # Own process group makes the hard deadline local to this pool, including its apply children.
  python3 - "$CUTOFF" "$BUN" queue.mjs --queue queue.tsv --workers "$WORKERS" --headless --retry --limit 30 >"$plog" 2>&1 <<'PY' &
import os, signal, subprocess, sys, time
child = subprocess.Popen(sys.argv[2:], start_new_session=True)
def stop(signum=None, frame=None):
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=10)
    except subprocess.TimeoutExpired: pass
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    if child.poll() is None: child.wait()
    if signum is not None: sys.exit(128 + signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    sys.exit(child.wait(timeout=max(0, int(sys.argv[1]) - time.time())))
except subprocess.TimeoutExpired:
    print('BOARDS_CUTOFF 15:00Z', flush=True)
    stop()
    sys.exit(124)
PY
  POOL_PID=$!
  wait "$POOL_PID"; rc=$?
  POOL_PID=""
  s=$(grep -c '^SUBMITTED' "$plog" || true)
  p=$(grep -c '^STOPPED' "$plog" || true)
  k=$(grep -c '^SKIPPED' "$plog" || true)
  f=$(grep -c '^FAILED' "$plog" || true)
  POOLS_RUN=$((POOLS_RUN + 1))
  T_SUB=$((T_SUB + s)); T_STOP=$((T_STOP + p)); T_SKIP=$((T_SKIP + k)); T_FAIL=$((T_FAIL + f))
  olog "pool $N done (rc=$rc): SUBMITTED=$s STOPPED=$p SKIPPED=$k FAILED=$f; remaining=$(data_rows)"
  clean_workers
  if [ "$rc" -eq 124 ]; then STOP_REASON='15:00Z cutoff'; break; fi
  # A platform outage is not evidence about the postings: sleep it out and retry the same queue rather than
  # counting this 0-submit pool toward the two-pool stop rule.
  if grep -q '^QUEUE_HALTED platform-outage' "$plog"; then
    fam=$(grep -o '^QUEUE_HALTED platform-outage [^ ]*' "$plog" | tail -1 | awk '{print $3}')
    olog "pool $N halted: platform-outage $fam; sleeping 20 min and retrying (not counted toward the 0-submit stop rule)"
    N=$((N + 1))
    sleep 1200
    continue
  fi
  if [ "$s" -eq 0 ]; then ZERO_STREAK=$((ZERO_STREAK + 1)); else ZERO_STREAK=0; fi
  if [ "$ZERO_STREAK" -ge 2 ]; then STOP_REASON='two consecutive 0-submit pools'; break; fi
  N=$((N + 1))
done
olog "stopping: $STOP_REASON"
