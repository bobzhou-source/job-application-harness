// lib/mail/postings.mjs — every posting the harness attempted, as mail match candidates.
import { readFileSync, existsSync } from 'node:fs';
import { employerKeys } from './match.mjs';
import { runsPath } from './store.mjs';

const readLines = name => (existsSync(runsPath(name)) ? readFileSync(runsPath(name), 'utf8').split('\n') : []);
// A run started on an account page (an ATS sign-in or registration URL) is not a posting; mail answers the posting
// that led there.
const ACCOUNT_PAGE = /\/(log-?in|sign-?in|register|create-?account|account)(\/|$|\?)/i;

// Early runs recorded no title in their summary row; their traces still carry the page titles they saw. The most
// frequent title wins, multi-part ones ("Role | Company | Board") weighted up since they name the posting.
function traceTitle(traces) {
  const counts = {};
  for (const trace of traces) {
    if (!trace || !existsSync(runsPath(trace))) continue;
    for (const m of readFileSync(runsPath(trace), 'utf8').matchAll(/"title":"([^"\\]{3,160})"/g)) counts[m[1]] = (counts[m[1]] ?? 0) + (m[1].includes(' | ') ? 3 : 1);
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

// Postings keyed by job URL: {job, t (first run), title, name (queue's "Company — Role"), submitted (a run recorded the
// submission), keys (employer match keys)}. A confirmation can prove a run recorded as stopped did submit, so every
// attempted posting is a candidate. `exclude` names are never employer keys (the applicant's own name).
export function loadPostings({ exclude = [] } = {}) {
  const named = new Map();
  for (const line of readLines('queue-results.txt')) {
    const m = line.match(/^=== (.*) \(([^()\t\r\n]+)\) (\S+)/);
    if (m) named.set(m[3].replace(/[?#].*$/, ''), m[1]);
  }
  // applications.tsv keeps the ledger company + full "Role | Company | Board" title when summary.jsonl truncated
  // the page title (Handshake often cuts before "| BAE Systems").
  const fromApps = new Map();
  for (const line of readLines('applications.tsv').slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const company = cols[1] ?? '';
    const title = cols[2] ?? '';
    const url = (cols[12] ?? '').replace(/[?#].*$/, '');
    if (!url) continue;
    const prev = fromApps.get(url);
    if (!prev || title.length > prev.title.length) fromApps.set(url, { company, title });
  }
  const postings = new Map();
  for (const line of readLines('summary.jsonl')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.job || ACCOUNT_PAGE.test(new URL(row.job).pathname)) continue;
    const known = postings.get(row.job);
    if (known) { known.submitted ||= row.outcome === 'submitted'; known.title ||= row.title ?? ''; known.traces.push(row.trace); continue; }
    postings.set(row.job, { job: row.job, t: row.t, title: row.title ?? '', name: named.get(row.job) ?? '', submitted: row.outcome === 'submitted', traces: [row.trace] });
  }
  for (const posting of postings.values()) {
    const app = fromApps.get(posting.job.replace(/[?#].*$/, ''));
    if (app) {
      // Queue sometimes stores only the role ("Product Management Intern - Summer 2027") with no company;
      // applications.tsv still has ABB / BAE Systems for employerKeys.
      if (app.company && (!posting.name || !/\s+[—–]\s+/.test(posting.name))) {
        const role = (/\s+[—–]\s+/.test(posting.name) ? posting.name.split(/\s+[—–]\s+/).slice(1).join(' — ') : posting.name)
          || app.title.split(' | ')[0].trim()
          || posting.title.split(' | ')[0].trim();
        posting.name = role ? `${app.company} — ${role}` : app.company;
      }
      if (app.title && (!posting.title || (app.title.includes(' | ') && !posting.title.includes(' | '))))
        posting.title = app.title;
    }
    if (!posting.title && !posting.name) posting.title = traceTitle(posting.traces);
    delete posting.traces;
    posting.keys = employerKeys(posting, { exclude });
  }
  return postings;
}
