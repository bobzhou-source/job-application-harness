#!/bin/bash
# One-shot export: every harness-owned macOS Keychain credential -> laptop file backend.
# Secret values travel only through Node stdout into SSH stdin; they are never printed or written on the Mac.
set -euo pipefail

HARNESS=$(cd "$(dirname "$0")/.." && pwd)
REMOTE_SSH=${JOB_HARNESS_REMOTE_SSH:-windows}
REMOTE_ROOT=${JOB_HARNESS_REMOTE_ROOT:-/home/bob/job-harness}

[ "$(uname -s)" = Darwin ] || { echo "run this on macOS" >&2; exit 64; }
[ -r "$HARNESS/config.json" ] || { echo "missing config.json" >&2; exit 1; }
for tool in security jq node ssh; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

prefix=$(jq -r '.credentials.servicePrefix // "job-app:"' "$HARNESS/config.json")
[ -n "$prefix" ] || { echo "empty credentials.servicePrefix" >&2; exit 1; }
export CRED_PREFIX="$prefix"

node --input-type=module - <<'NODE' | ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$REMOTE_SSH" \
  "wsl -d Ubuntu --cd $REMOTE_ROOT -- /usr/bin/node tools/credentials-import.mjs"
import { execFileSync } from 'node:child_process';

const prefix = process.env.CRED_PREFIX;
const base = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
const createdComment = `${base}-status:created`;

let dump;
try {
  dump = execFileSync('/usr/bin/security', ['dump-keychain'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  console.error('Keychain metadata could not be read; unlock the login Keychain and rerun.');
  process.exit(2);
}

const records = new Map();
for (const block of dump.split(/\n(?=keychain:)/)) {
  if (!/^class: "genp"$/m.test(block)) continue;
  const service = /"svce"<blob>="([^"]*)"/.exec(block)?.[1];
  const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
  if (!service?.startsWith(prefix) || !account) continue;
  const host = service.slice(prefix.length);
  if (!host) continue;
  const comment = /"icmt"<blob>="([^"]*)"/.exec(block)?.[1] ?? '';
  records.set(`${host}\0${account}`, {
    host,
    account,
    status: comment === createdComment ? 'created' : 'pending',
  });
}

if (!records.size) {
  console.error(`no Keychain items found with service prefix ${prefix}`);
  process.exit(2);
}

console.error(`Reading ${records.size} keychain credentials...`);
const items = [];
for (const record of records.values()) {
  let secret;
  try {
    secret = execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s', `${prefix}${record.host}`,
      '-a', record.account,
      '-w',
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  } catch (err) {
    const prompt = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT';
    console.error(prompt
      ? `Keychain access prompt for ${record.host} did not complete; click Allow in the Keychain dialog and rerun.`
      : `Keychain denied or could not read ${record.host}; grant access and rerun.`);
    process.exit(2);
  }
  if (!secret) {
    console.error(`Keychain returned an empty secret for ${record.host}; refusing to export.`);
    process.exit(2);
  }
  items.push({ ...record, secret });
}

process.stdout.write(JSON.stringify({
  version: 1,
  source: 'macos-keychain',
  exportedAt: new Date().toISOString(),
  items,
}));
NODE
