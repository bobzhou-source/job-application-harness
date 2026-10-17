#!/bin/bash
# Mac-side sync for the laptop runner. The laptop owns all runner state and works alone while the Mac is off; the
# Mac only mirrors it back when it can reach the laptop (com.bob.jobsync pulls every 30 min and at login).
#   runs/sync-laptop.sh push          Mac -> laptop: code (fast-forward to origin/main), portable config, .env,
#                                     profile, Gmail runtime/token files, resumes. Never the runner's state.
#   runs/sync-laptop.sh push --seed   also overwrite the laptop's state (answers, aliases, learned, queues, blocked
#                                     hosts) with the Mac copy; needs the runner-host lock (no runner active).
#   runs/sync-laptop.sh pull          laptop -> Mac: that state plus reports, mail state and traces (read-only copy).
set -euo pipefail
umask 077

HARNESS=$(cd "$(dirname "$0")/.." && pwd)
REMOTE_SSH=${JOB_HARNESS_REMOTE_SSH:-windows}
REMOTE_ROOT=${JOB_HARNESS_REMOTE_ROOT:-/home/bob/job-harness}
REMOTE_HOME=${JOB_HARNESS_REMOTE_HOME:-/home/bob}
RSYNC_PATH='wsl -d Ubuntu -- rsync'
HOST_ID="${USER:-$(id -un)}@$(hostname -s 2>/dev/null || hostname)"
MODE=${1:-}

case "$MODE" in
  push|pull) ;;
  *) echo "usage: runs/sync-laptop.sh push|pull" >&2; exit 64 ;;
esac

SEED=0; [ "${2:-}" = --seed ] && SEED=1
if [ "$SEED" = 1 ] && ! "$HARNESS/runs/runner-host-lock.sh" acquire "sync:$HOST_ID:$$"; then
  echo "refusing push --seed: runner-host lock is held" >&2
  exit 75
fi
release_lock() {
  "$HARNESS/runs/runner-host-lock.sh" release "sync:$HOST_ID:$$" >/dev/null 2>&1 || true
}
trap release_lock EXIT
trap 'exit 130' INT TERM HUP

remote_run() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_SSH" \
    "wsl -d Ubuntu -- $*"
}

remote_mkdir() {
  remote_run mkdir -p "$@"
}

rsync_to_remote() {
  rsync -rlptD --rsync-path="$RSYNC_PATH" "$@" \
    -- "$REMOTE_SSH:$REMOTE_ROOT/"
}

remote_mkdir "$REMOTE_ROOT/runs" "$REMOTE_ROOT/runs/smoke" "$REMOTE_HOME/resumes" "$REMOTE_HOME/.omp/tools"

if [ "$MODE" = push ]; then
  required=(.env profile.md)
  state=(answers.json aliases.json learned.json queue.tsv runs/blocked-hosts.tsv runs/workday-queue.tsv)
  [ "$SEED" = 1 ] && required+=("${state[@]}")
  [ "$SEED" = 1 ] && [ -e "$HARNESS/runs/workers.conf" ] && required+=(runs/workers.conf)
  for file in "${required[@]}"; do
    [ -s "$HARNESS/$file" ] || { echo "missing or empty: $file" >&2; exit 1; }
  done

  (cd "$HARNESS" && rsync_to_remote -R "${required[@]}")

  # Rewrite only machine-specific paths. Secrets and all other settings are copied unchanged.
  config_tmp=$(mktemp)
  trap 'rm -f "$config_tmp"; release_lock' EXIT
  chmod 600 "$config_tmp"
  jq --arg home "$REMOTE_HOME" '
    .browser.executable = "/usr/bin/google-chrome-stable"
    | .browser.profileDir = ($home + "/.job-app-chrome")
    | .email.mcpServer = ($home + "/.omp/tools/multi-gmail-mcp/node_modules/multi-gmail-mcp/bin/gmail-mcp.js")
    | .email.tokenDatabase = ($home + "/.gmail-mcp-tokens.db")
    | .email.oauthCredentials = ($home + "/.gmail-mcp-oauth.json")
    | .resumes.directory = ($home + "/resumes")
    | .documents.transcript = ($home + "/resumes/" + (.documents.transcript | split("/") | last))
    | .credentials.backend = "file"
    | .notifications.backend = "console"
  ' "$HARNESS/config.json" > "$config_tmp"
  rsync -lpt --rsync-path="$RSYNC_PATH" \
    -- "$config_tmp" "$REMOTE_SSH:$REMOTE_ROOT/config.json"

  resume_dir=$(jq -r '.resumes.directory' "$HARNESS/config.json")
  rsync -rlptD --rsync-path="$RSYNC_PATH" \
    --include='*.pdf' --include='*.tex' --include='MASTER-FACTS.md' --exclude='*' \
    -- "$resume_dir/" "$REMOTE_SSH:$REMOTE_HOME/resumes/"

  transcript=$(jq -r '.documents.transcript // empty' "$HARNESS/config.json")
  transcript_name=$(basename "$transcript")
  if [ -n "$transcript" ] && [ -f "$transcript" ] && [ "$(dirname "$transcript")" != "$resume_dir" ]; then
    rsync -lpt --rsync-path="$RSYNC_PATH" \
      -- "$transcript" "$REMOTE_SSH:$REMOTE_HOME/resumes/$transcript_name"
  fi

  # Gmail MCP runtime dependencies install on the laptop; only its manifests and token files cross the wire.
  gmail_dir="$REMOTE_HOME/.omp/tools/multi-gmail-mcp"
  rsync -lpt --rsync-path="$RSYNC_PATH" \
    -- "$HOME/.omp/tools/multi-gmail-mcp/package.json" "$HOME/.omp/tools/multi-gmail-mcp/package-lock.json" \
    "$REMOTE_SSH:$gmail_dir/"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_SSH" \
    "wsl -d Ubuntu -- test -d $gmail_dir/node_modules/multi-gmail-mcp"; then
    remote_run /home/bob/.bun/bin/bun install --production --cwd "$gmail_dir"
  fi
  rsync -lpt --rsync-path="$RSYNC_PATH" \
    -- "$HOME/.gmail-mcp-tokens.db" "$HOME/.gmail-mcp-oauth.json" "$REMOTE_SSH:$REMOTE_HOME/"

  remote_run chmod 700 "$REMOTE_ROOT" "$REMOTE_ROOT/runs" "$REMOTE_HOME/resumes" "$REMOTE_HOME/.omp/tools" "$gmail_dir"
  remote_run chmod 600 "$REMOTE_ROOT/answers.json" "$REMOTE_ROOT/aliases.json" "$REMOTE_ROOT/learned.json" \
    "$REMOTE_ROOT/.env" "$REMOTE_ROOT/profile.md" "$REMOTE_ROOT/config.json" "$REMOTE_ROOT/queue.tsv" \
    "$REMOTE_ROOT/runs/blocked-hosts.tsv" "$REMOTE_ROOT/runs/workday-queue.tsv" "$REMOTE_HOME/.gmail-mcp-tokens.db" \
    "$REMOTE_HOME/.gmail-mcp-oauth.json"
  remote_run chmod -R go-rwx "$REMOTE_HOME/resumes"

  # Code travels through git: the laptop checkout must run exactly what the Mac pushed to origin/main.
  if [ -n "$(git -C "$HARNESS" status --porcelain --untracked-files=no)" ] || [ "$(git -C "$HARNESS" rev-parse HEAD)" != "$(git -C "$HARNESS" rev-parse '@{u}')" ]; then
    echo "warning: Mac checkout has uncommitted or unpushed code; the laptop gets origin/main only" >&2
  fi
  remote_run git -C "$REMOTE_ROOT" fetch -q origin
  remote_run git -C "$REMOTE_ROOT" merge -q --ff-only origin/main
  echo "pushed inputs$([ "$SEED" = 1 ] && echo ' and seeded state') to $REMOTE_SSH:$REMOTE_ROOT; code at $(remote_run git -C "$REMOTE_ROOT" log --oneline -1)"
  exit 0
fi

# Pull mirrors the laptop's state onto the Mac (never config, credentials, or browser profiles). Quiet no-op when
# the laptop is unreachable, so a schedule can run it blindly.
trap - EXIT
ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_SSH" "wsl -d Ubuntu -- true" >/dev/null 2>&1 \
  || { echo "laptop unreachable; nothing pulled"; exit 0; }
rsync -lpt --rsync-path="$RSYNC_PATH" \
  -- "$REMOTE_SSH:$REMOTE_ROOT/answers.json" "$REMOTE_SSH:$REMOTE_ROOT/aliases.json" "$REMOTE_SSH:$REMOTE_ROOT/learned.json" \
  "$REMOTE_SSH:$REMOTE_ROOT/queue.tsv" "$HARNESS/"
rsync -rlpt --rsync-path="$RSYNC_PATH" \
  --include='summary.jsonl' --include='[0-9]*.jsonl' --include='mail*.json' --include='mail-digest.txt' \
  --include='knockout-flags.tsv' --include='workday-queue.tsv' --include='blocked-hosts.tsv' --include='queue-results.txt' \
  --include='applications.tsv' --include='applications.csv' --include='workers.conf' --exclude='*' \
  -- "$REMOTE_SSH:$REMOTE_ROOT/runs/" "$HARNESS/runs/"
echo "$(date -u +%FT%TZ) pulled state, reports and traces from $REMOTE_SSH:$REMOTE_ROOT"
