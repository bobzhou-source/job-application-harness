// lib/blocked-hosts.mjs — the owner's standing brake list, runs/blocked-hosts.tsv ("host<TAB>reason").
// queue.mjs never dispatches a row on one of these hosts (it skips the row and drops it) and discover.mjs never emits
// one, so a host the owner has taken out of rotation (a gate only they can clear, a submission switch they turned
// off) stops costing runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BLOCKED_HOSTS_FILE = fileURLToPath(new URL('../runs/blocked-hosts.tsv', import.meta.url));

// host (lowercased) → reason. Reread on every call: the file is a live brake the owner edits between pools.
export function blockedHosts(file = BLOCKED_HOSTS_FILE) {
  const blocked = new Map();
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return blocked; }
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [host, ...rest] = line.split('\t');
    if (host?.trim()) blocked.set(host.trim().toLowerCase(), rest.join(' ').trim() || 'blocked by the owner');
  }
  return blocked;
}

// The hostname a row or posting URL names, lowercased; a value that is not a URL stands for itself.
export function hostOfUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url).toLowerCase(); }
}
