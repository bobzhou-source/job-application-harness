#!/bin/bash
# Overnight Workday pool runner. Waits for any running queue.mjs pool to finish,
# then loops pools until 12:30Z / empty queue / 2 consecutive zero-submit pools.
set -u

HARNESS=$(cd "$(dirname "$0")/.." && pwd)
BUN=${BUN:-"$HOME/.bun/bin/bun"}
RUNS="$HARNESS/runs"
QUEUE="$RUNS/workday-queue.tsv"
OLOG="$RUNS/smoke/overnight.log"
LOCK="$RUNS/overnight.lock"
MIN_ROWS=40
POOL_LIMIT=30
WORKERS=${WORKDAY_WORKERS:-3}
HOST_ID=${RUNNER_HOST_ID:-"$(id -un)@$(hostname -s 2>/dev/null || hostname)"}
HOST_LOCK=0

cd "$HARNESS" || exit 1
set -a; . "$HARNESS/.env"; set +a

release_host_lock() {
  if [ "$HOST_LOCK" -eq 1 ]; then
    "$HARNESS/runs/runner-host-lock.sh" release "$HOST_ID" >/dev/null 2>&1 || true
    HOST_LOCK=0
  fi
}

if ! "$HARNESS/runs/runner-host-lock.sh" acquire "$HOST_ID"; then
  echo "overnight: runner-host lock is held; exit" >> "$OLOG"
  exit 75
fi
HOST_LOCK=1

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) overnight: lock exists ($LOCK), already running; exit" >> "$OLOG"
  release_host_lock
  exit 1
fi

POOLS_RUN=0
T_SUB=0; T_STOP=0; T_SKIP=0; T_FAIL=0
ZERO_STREAK=0
STOP_REASON="unknown"

ts() { date -u +%FT%TZ; }
epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f "%Y-%m-%d %H:%M:%S" "$1" +%s; }
iso() { date -u -d "@$1" +%FT%TZ 2>/dev/null || date -u -r "$1" +%FT%TZ; }
olog() { echo "$(ts) $*" >> "$OLOG"; }

data_rows() {
  local n
  n=$(grep -cv -e '^#' -e '^[[:space:]]*$' "$QUEUE" 2>/dev/null) || true
  printf '%s\n' "${n:-0}"
}

cleanup() {
  pkill -f 'job-app-chrome-w[123]' 2>/dev/null  # exactly queue.mjs's worker profiles; never -wt*/visible Chrome
  local msg="[From your coding agent] overnight runner done: pools=$POOLS_RUN submitted=$T_SUB stopped=$T_STOP skipped=$T_SKIP failed=$T_FAIL; stop reason: $STOP_REASON"
  olog "exit: $msg"
  if [ -n "${POKE_API_KEY:-}" ]; then
    curl -s -X POST https://poke.com/api/v1/inbound-sms/webhook \
      -H "Authorization: Bearer $POKE_API_KEY" \
      -H 'Content-Type: application/json' \
      --data "$(jq -cn --arg m "$msg" '{message:$m}')" >/dev/null 2>&1 || olog "poke send failed"
  else
    olog "POKE_API_KEY unset; no text sent"
  fi
  rm -rf "$LOCK"
  release_host_lock
}
trap cleanup EXIT

# Stop time: next 12:30Z.
today=$(date -u +%Y-%m-%d)
CUTOFF=$(epoch "$today 12:30:00")
now=$(date -u +%s)
[ "$now" -ge "$CUTOFF" ] && CUTOFF=$((CUTOFF + 86400))
olog "overnight.sh started (pid $$); cutoff $(iso "$CUTOFF")"

# Wait for the currently running pool (pool-11) to finish.
if pgrep -f "bun queue.mjs" >/dev/null 2>&1; then
  olog "waiting for running pool to finish (pids: $(pgrep -f 'bun queue.mjs' | tr '\n' ' '))"
  while pgrep -f "bun queue.mjs" >/dev/null 2>&1; do
    sleep 60
  done
  olog "running pool finished; taking over"
fi

# Start numbering above any pool log already on disk (never clobber a sibling's log), floor 12.
N=12
for f in "$RUNS"/smoke/pool-*.log; do
  [ -e "$f" ] || continue
  num=${f##*/pool-}
  num=${num%.log}
  case $num in ''|*[!0-9]*) continue ;; esac
  [ "$num" -ge "$N" ] && N=$((num + 1))
done
olog "pool numbering starts at $N"

while :; do
  if [ "$(date -u +%s)" -ge "$CUTOFF" ]; then
    STOP_REASON="past 12:30Z cutoff"
    break
  fi

  rows=$(data_rows)
  if [ "$rows" -lt "$MIN_ROWS" ]; then
    olog "queue has $rows rows (< $MIN_ROWS); refilling via discover.mjs --workday --max 150"
    dout=$("$BUN" discover.mjs --workday --max 150 2>&1)
    drc=$?
    if echo "$dout" | grep -q 'new of'; then
      echo "$dout" | grep -E 'new of' | while IFS= read -r line; do olog "discover: $line"; done
    else
      olog "discover: no summary line (rc=$drc); last output: $(echo "$dout" | grep -v '^$' | tail -1)"
    fi
    rows=$(data_rows)
    if [ "$rows" -eq 0 ]; then
      STOP_REASON="queue empty after refill"
      break
    fi
    olog "queue now has $rows rows"
  fi

  # Never overlap a sibling pool: two queue.mjs on one queue file corrupts it, and the
  # worker kill below would break the sibling's browser sessions.
  if pgrep -f "bun queue.mjs" >/dev/null 2>&1; then
    olog "another pool already running before pool $N; waiting for it to finish"
    while pgrep -f "bun queue.mjs" >/dev/null 2>&1; do
      sleep 60
    done
    olog "sibling pool finished; proceeding to pool $N"
  fi

  pkill -f 'job-app-chrome-w[123]' 2>/dev/null  # exactly queue.mjs's worker profiles; never -wt*/visible Chrome
  sleep 3
  # Per-pool dial: `echo 2 > runs/workers.conf` lowers RAM while the owner is at the Mac; no restart needed.
  case $(cat "$RUNS/workers.conf" 2>/dev/null) in 1|2|3) WORKERS=$(cat "$RUNS/workers.conf") ;; esac

  plog="$RUNS/smoke/pool-$N.log"
  olog "pool $N starting (queue rows: $rows; workers $WORKERS)"
  "$BUN" queue.mjs --queue "$QUEUE" --workers "$WORKERS" --headless --retry --limit "$POOL_LIMIT" > "$plog" 2>&1
  rc=$?

  s=$(grep -c '^SUBMITTED' "$plog" || true)
  p=$(grep -c '^STOPPED'  "$plog" || true)
  k=$(grep -c '^SKIPPED'  "$plog" || true)
  f=$(grep -c '^FAILED'   "$plog" || true)
  q=$(grep -c '^QUEUE_DONE' "$plog" || true)
  POOLS_RUN=$((POOLS_RUN + 1))
  T_SUB=$((T_SUB + s)); T_STOP=$((T_STOP + p)); T_SKIP=$((T_SKIP + k)); T_FAIL=$((T_FAIL + f))
  olog "pool $N done (rc=$rc): SUBMITTED=$s STOPPED=$p SKIPPED=$k FAILED=$f QUEUE_DONE=$q | totals: sub=$T_SUB stop=$T_STOP skip=$T_SKIP fail=$T_FAIL"
  if [ "$q" -gt 0 ]; then
    olog "pool $N reported QUEUE_DONE; rows remaining in queue file: $(data_rows)"
  fi
  # A platform outage (every ATS host down) is not evidence about the postings: sleep it out and retry the same
  # queue rather than counting this 0-submit pool toward the two-pool stop rule.
  if grep -q '^QUEUE_HALTED platform-outage' "$plog"; then
    fam=$(grep -o '^QUEUE_HALTED platform-outage [^ ]*' "$plog" | tail -1 | awk '{print $3}')
    olog "pool $N halted: platform-outage $fam; sleeping 20 min and retrying (not counted toward the 0-submit stop rule)"
    N=$((N + 1))
    sleep 1200
    continue
  fi

  # A cost guard halt is a billing stop, not an outage: end the night instead of retrying into the cap.
  if grep -q '^QUEUE_HALTED cost-guard' "$plog"; then
    STOP_REASON="cost guard: $(grep -o '^QUEUE_HALTED cost-guard [^;]*' "$plog" | tail -1)"
    break
  fi
  if [ "$s" -eq 0 ]; then
    ZERO_STREAK=$((ZERO_STREAK + 1))
  else
    ZERO_STREAK=0
  fi
  if [ "$ZERO_STREAK" -ge 2 ]; then
    STOP_REASON="two consecutive pools with 0 SUBMITTED (credits out or systemic break)"
    break
  fi

  N=$((N + 1))
done

olog "stopping: $STOP_REASON"
