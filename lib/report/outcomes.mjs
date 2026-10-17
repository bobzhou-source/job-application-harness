// Rejection latency and outcome rates over submitted applications. One submission per unique job, the earliest
// recorded submit timestamp, and its first rejection; a rejection that names no role falls back to the most
// recent prior submission at the employer. Employer/ATS/lane/day rates share that same cohort.
import { loadConfig } from '../config.mjs';
import { loadMail } from '../mail/store.mjs';
import { loadPostings } from '../mail/postings.mjs';
import { identity, traceAnswers } from '../mail/watch.mjs';
import { atsFor } from './applications.mjs';

const SIX_HOURS = 6 * 3_600_000;
const HOUR = 3_600_000;

const canonical = value => {
  try { const url = new URL(value); url.hash = ''; url.search = ''; return url.href.replace(/\/$/, ''); }
  catch { return String(value ?? '').replace(/[?#].*$/, '').replace(/\/$/, ''); }
};
const hostOf = value => { try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } };
const pct = value => `${(100 * value).toFixed(1)}%`;
const hours = value => value == null ? '-' : `${value.toFixed(1)}h`;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  const low = Math.floor(middle);
  return sorted[low] + ((sorted[low + 1] ?? sorted[low]) - sorted[low]) * (middle - low);
};
function table(title, rows, columns) {
  console.log(`\n${title}`);
  const widths = columns.map(column => Math.max(column.label.length, ...rows.map(row => String(column.value(row)).length)));
  console.log(`  ${columns.map((column, index) => column.label.padEnd(widths[index])).join('  ')}`);
  for (const row of rows) console.log(`  ${columns.map((column, index) => String(column.value(row)).padEnd(widths[index])).join('  ')}`);
}
function grouped(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item) || 'unknown';
    const group = groups.get(name) ?? { name, submitted: 0, rejected: 0, latencies: [], fast: 0 };
    group.submitted++;
    if (item.replyAt != null) {
      group.rejected++;
      group.latencies.push((item.replyAt - item.submittedAt) / HOUR);
      if (item.replyAt - item.submittedAt < SIX_HOURS) group.fast++;
    }
    groups.set(name, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    rate: group.submitted ? group.rejected / group.submitted : 0,
    median: median(group.latencies),
  })).sort((a, b) => b.submitted - a.submitted || b.rejected - a.rejected || a.name.localeCompare(b.name));
}

export function outcomeReport(rows, { laneFor = () => '', mail = loadMail(), postings = null } = {}) {
  if (!mail?.events) {
    console.log('No synced mail in runs/mail.json; run `bun mail.mjs` before `report.mjs --outcomes`.');
    return;
  }
  const config = loadConfig();
  const postingMap = postings ?? loadPostings({ exclude: [config.applicant.displayName] });
  // Earliest submitted row per unique job. A second submitted row for the same posting is a retry, not a new
  // application.
  const submitted = new Map();
  for (const row of rows) {
    if (row.outcome !== 'submitted' || !row.job) continue;
    const key = canonical(row.job);
    if (!submitted.has(key) || Date.parse(row.t) < Date.parse(submitted.get(key).t)) submitted.set(key, row);
  }
  const submittedByJob = new Map();
  for (const [key, row] of submitted) {
    const posting = postingMap.get(row.job) ?? { name: '', title: row.title, job: row.job };
    const label = identity({ job: row.job, employer: posting.name, subject: posting.title }, new Map([[row.job, posting]]));
    const submittedAt = Date.parse(traceAnswers(row.trace).submitAt ?? row.t);
    if (!Number.isFinite(submittedAt)) continue;
    submittedByJob.set(key, {
      job: row.job, employer: label.employer, employerKey: label.employer.toLowerCase(), role: label.role,
      lane: laneFor(row) || '?', ats: atsFor(hostOf(row.job)), day: row.t.slice(0, 10), submittedAt, replyAt: null,
    });
  }
  const applications = [...submittedByJob.values()];
  const byEmployer = new Map();
  for (const item of applications) {
    const list = byEmployer.get(item.employerKey) ?? [];
    list.push(item);
    byEmployer.set(item.employerKey, list);
  }
  // A rejection's matched posting can predate the application it answers (K2 has two submissions, and the
  // second rejection's subject names no role). Prefer the exact posting when it is a fast reply; otherwise the
  // most recent prior submission at that employer wins, so the rejection lands on the application it can answer.
  // Each application counts its first rejection only.
  for (const event of [...mail.events].filter(item => item.kind === 'rejected').sort((a, b) => a.date - b.date)) {
    const exact = event.job ? submittedByJob.get(canonical(event.job)) : null;
    const prior = (byEmployer.get(String(identity(event, postingMap).employer ?? '').toLowerCase()) ?? [])
      .filter(item => item.replyAt == null && item.submittedAt <= event.date)
      .sort((a, b) => a.submittedAt - b.submittedAt);
    const recent = prior.filter(item => event.date - item.submittedAt < SIX_HOURS).at(-1);
    const exactFast = exact && exact.replyAt == null && event.date >= exact.submittedAt && event.date - exact.submittedAt < SIX_HOURS;
    const exactAny = exact && exact.replyAt == null && event.date >= exact.submittedAt;
    const target = exactFast ? exact : recent ?? (exactAny ? exact : (exact ? null : prior.at(-1)));
    if (target) target.replyAt = event.date;
  }
  const replied = applications.filter(item => item.replyAt != null);
  const allLatencies = replied.map(item => (item.replyAt - item.submittedAt) / HOUR);
  const fast = applications.filter(item => item.replyAt != null && item.replyAt - item.submittedAt < SIX_HOURS)
    .sort((a, b) => (a.replyAt - a.submittedAt) - (b.replyAt - b.submittedAt));

  console.log(`Submitted applications: ${applications.length}; first-rejection replies: ${replied.length} (${pct(applications.length ? replied.length / applications.length : 0)})`);
  console.log(`Rejection latency: median ${hours(median(allLatencies))} over ${replied.length} replied application(s); fast (<6h): ${fast.length}`);
  const employers = grouped(applications, item => item.employer);
  table('By employer', employers, [
    { label: 'employer', value: row => row.name },
    { label: 'submitted', value: row => String(row.submitted) },
    { label: 'rejected', value: row => String(row.rejected) },
    { label: 'rate', value: row => pct(row.rate) },
    { label: 'median', value: row => hours(row.median) },
    { label: 'fast', value: row => String(row.fast) },
  ]);
  for (const [label, key] of [['ATS', item => item.ats], ['lane', item => item.lane], ['submit day', item => item.day]]) {
    const groups = grouped(applications, key);
    table(`Rejection rate by ${label}`, groups, [
      { label: label.toLowerCase(), value: row => row.name },
      { label: 'submitted', value: row => String(row.submitted) },
      { label: 'rejected', value: row => String(row.rejected) },
      { label: 'rate', value: row => pct(row.rate) },
      { label: 'median', value: row => hours(row.median) },
    ]);
  }
  console.log('\nFast rejections (<6h)');
  if (!fast.length) console.log('  none');
  for (const item of fast) {
    const latency = ((item.replyAt - item.submittedAt) / HOUR).toFixed(1);
    console.log(`  ${latency.padStart(5)}h  ${item.employer} — ${item.role}  [${item.ats}, ${item.lane}]  submitted ${new Date(item.submittedAt).toISOString()}  rejected ${new Date(item.replyAt).toISOString()}`);
  }
  return { applications, replied, fast, median: median(allLatencies) };
}
