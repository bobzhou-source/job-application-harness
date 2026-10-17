#!/bin/bash
# Mac-side sync for the laptop runner. Code moves through Git; this script moves ignored personal state.
#   runs/sync-laptop.sh push   Mac -> laptop: private inputs, queues, portable config, Gmail runtime/token files
#   runs/sync-laptop.sh pull   laptop -> Mac: reports, mail index, and per-run JSONL traces
# push takes the single-writer runner-host lock and fails closed if a runner is active; pull only copies report
# inputs back to the Mac (never queues, config, or credentials), so it runs while the laptop runner holds the lock.
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

if [ "$MODE" = push ] && ! "$HARNESS/runs/runner-host-lock.sh" acquire "sync:$HOST_ID:$$"; then
  echo "refusing push: runner-host lock is held" >&2
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
  required=(answers.json aliases.json learned.json .env profile.md queue.tsv runs/blocked-hosts.tsv runs/workday-queue.tsv)
  [ -e "$HARNESS/runs/workers.conf" ] && required+=(runs/workers.conf)
  for file in "${required[@]}"; do
    [ -s "$HARNESS/$file" ] || { echo "missing or empty: $file" >&2; exit 1; }
  done

  (cd "$HARNESS" && rsync_to_remote -R "${required[@]}")

  # The credential backend and importer are small and must match the rewritten backend before the owner commits.
  code=(lib/credentials.mjs lib/config.mjs lib/setup/checks.mjs tools/credentials-import.mjs)
  for file in "${code[@]}"; do
    [ -s "$HARNESS/$file" ] || { echo "missing or empty: $file" >&2; exit 1; }
  done
  (cd "$HARNESS" && rsync_to_remote -R "${code[@]}")

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

  echo "pushed private inputs and queues to $REMOTE_SSH:$REMOTE_ROOT"
  exit 0
fi

# Pull only report inputs, never config, queues, credentials, or browser profiles.
trap - EXIT
rsync -rlpt --rsync-path="$RSYNC_PATH" \
  --include='summary.jsonl' --include='[0-9]*.jsonl' --include='mail.json' --include='mail-done.json' \
  --include='applications.tsv' --include='applications.csv' --exclude='*' \
  -- "$REMOTE_SSH:$REMOTE_ROOT/runs/" "$HARNESS/runs/"
echo "pulled reports and traces from $REMOTE_SSH:$REMOTE_ROOT/runs"
