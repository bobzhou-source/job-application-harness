#!/bin/bash
# Daytime chain: boards runner (2 workers) until 23:00Z, then the Workday overnight runner (3 workers unless
# runs/workers.conf says otherwise) until 12:30Z. Detached from any agent shell; logs under runs/smoke/.
HARNESS=$(cd "$(dirname "$0")/.." && pwd)
cd "$HARNESS" || exit 1
mkdir -p runs/smoke
# Run exactly origin/main: a checkout left behind (the laptop once ran pre-fix code for an hour) refuses to start.
git fetch -q origin && git merge -q --ff-only origin/main || { echo "$(date -u +%FT%TZ) chain: code not at origin/main; exit" >> runs/smoke/overnight-boards.log; exit 1; }
BOARDS_CUTOFF=23:00 BOARDS_WORKERS=2 bash runs/overnight-boards.sh >> runs/smoke/overnight-boards.log 2>&1
[ -s runs/workers.conf ] || echo 3 > runs/workers.conf
bash runs/overnight.sh >> runs/smoke/overnight.log 2>&1
