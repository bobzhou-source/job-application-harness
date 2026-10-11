// Run telemetry: `bun report.mjs [--last N] [--since ISO]` summarizes runs/summary.jsonl (one row per apply.mjs run,
// written by lib/trace.mjs summary()): outcome, wall time, actions, per-model calls/latency/cost, stop reasons.
// Model cost is metered per run and bucketed by role (driver/planner/writer); the native planner backend's cost is
// estimated from token usage and list price, HTTP backends use the provider's billed usage.
// `bun report.mjs --apps [--since ISO]` is the application tracker instead: one row per posting (all its runs folded
// together) with lane, title, latest status, the employer's latest reply (runs/mail.json, written by `bun mail.mjs`),
// stop category, who must act next, attempts, time, cost, and the resume and documents it went out with; written to
// runs/applications.csv and summarized by category.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const last = Number(arg('--last') ?? 0);
const since = arg('--since');

// Lane reverse-matched from the configured resume filename pattern, e.g. "resume_{lane}.pdf".
const { filePattern, directory: resumeDir, fallbackLane } = loadConfig().resumes;
// The resume apply.mjs uploads for a lane: the lane's own file, else the fallback lane's.
const laneResume = lane => {
  const own = filePattern.replace('{lane}', lane);
  return existsSync(`${resumeDir}/${own}`) || !fallbackLane ? own : filePattern.replace('{lane}', fallbackLane);
};
const [RESUME_PREFIX, RESUME_SUFFIX] = filePattern.split('{lane}');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RESUME_NAME = new RegExp(`^${escapeRegex(RESUME_PREFIX)}(.*)${escapeRegex(RESUME_SUFFIX)}$`);

let rows = [];
try {
  rows = readFileSync(fileURLToPath(new URL('./runs/summary.jsonl', import.meta.url)), 'utf8')
    .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
} catch { /* no runs yet */ }
if (since) rows = rows.filter(row => row.t >= since);
if (last > 0) rows = rows.slice(-last);
if (!rows.length) {
  console.log('no runs in runs/summary.jsonl');
  process.exit(0);
}
const money = n => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const secs = n => n >= 120 ? `${(n / 60).toFixed(1)}m` : `${Math.round(n)}s`;
const model = (row, name) => row.models?.[name] ?? { calls: 0, failed: 0, ms: 0, cost: 0 };
const sum = (list, f) => list.reduce((total, item) => total + f(item), 0);
const tally = (list, key) => Object.entries(list.reduce((acc, item) => { const k = key(item); if (k) acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}))
  .sort((a, b) => b[1] - a[1]).slice(0, 8);
// Trace buckets stay keyed by the model slot; print them under role-neutral names.
const ROLES = { jev: 'driver', deepseek: 'planner', writer: 'writer' };

if (args.includes('--apps')) {
  applications(rows);
  process.exit(0);
}

console.log(['time (UTC)'.padEnd(16), 'outcome'.padEnd(9), 'secs'.padStart(5), 'acts'.padStart(5),
  'drv'.padStart(4), 'pln'.padStart(3), 'wait'.padStart(8), 'writer'.padStart(6), 'cost'.padStart(7),
  ' site / reason'].join(' '));
for (const row of rows) {
  const jev = model(row, 'jev');
  const ds = model(row, 'deepseek');
  const writer = model(row, 'writer');
  const note = row.outcome === 'submitted' ? '' : ` — ${String(row.reason ?? '').slice(0, 70)}`;
  console.log([
    row.t.slice(5, 19).replace('T', ' ').padEnd(16),
    row.outcome.padEnd(9),
    secs(row.secs).padStart(5),
    String(row.actions ?? 0).padStart(5),
    String(jev.calls).padStart(4),
    `${ds.calls}${ds.failed ? `!${ds.failed}` : ''}`.padStart(3),
    secs(ds.ms / 1000).padStart(8),
    `${writer.calls}`.padStart(6),
    money(row.cost ?? 0).padStart(7),
    ` ${row.site ?? row.host ?? '?'}${note}`,
  ].join(' '));
}

const n = rows.length;
const submitted = rows.filter(row => row.outcome === 'submitted');
const totalCost = sum(rows, row => row.cost ?? 0);
const totalSecs = sum(rows, row => row.secs ?? 0);
const totalActions = sum(rows, row => row.actions ?? 0);
const calls = name => sum(rows, row => model(row, name).calls);
const ms = name => sum(rows, row => model(row, name).ms);
const failed = name => sum(rows, row => model(row, name).failed);
const cost = name => sum(rows, row => model(row, name).cost);

console.log('\nTotals');
console.log(`  runs ${n}, submitted ${submitted.length}, wall ${secs(totalSecs)}, actions ${totalActions}`);
console.log(`  cost ${money(totalCost)} = driver ${money(cost('jev'))} + planner ${money(cost('deepseek'))} + writer ${money(cost('writer'))}`);
console.log(`  per run ${money(totalCost / n)}, ${secs(totalSecs / n)}; per submission ${submitted.length ? money(totalCost / submitted.length) : 'n/a'}`);
for (const name of ['jev', 'deepseek', 'writer']) {
  const c = calls(name);
  if (!c) continue;
  console.log(`  ${ROLES[name].padEnd(8)} ${String(c).padStart(5)} calls (${failed(name)} failed), avg ${(ms(name) / c / 1000).toFixed(1)}s, `
    + `${(c / n).toFixed(1)}/run, ${(c / Math.max(totalActions, 1)).toFixed(2)}/action, ${(100 * ms(name) / 1000 / Math.max(totalSecs, 1)).toFixed(0)}% of wall`);
}
console.log(`  planner consults per 10 actions: ${(10 * calls('deepseek') / Math.max(totalActions, 1)).toFixed(1)}; secs/action ${(totalSecs / Math.max(totalActions, 1)).toFixed(1)}`);

const stops = tally(rows.filter(row => row.outcome !== 'submitted'), row => String(row.reason ?? '').split(/[:"(]/)[0].trim().slice(0, 60));
if (stops.length) {
  console.log('\nStop reasons');
  for (const [reason, count] of stops) console.log(`  ${String(count).padStart(3)}  ${reason}`);
}
const refusals = {};
for (const row of rows) for (const [reason, count] of Object.entries(row.refusals ?? {})) refusals[reason] = (refusals[reason] ?? 0) + count;
const topRefusals = Object.entries(refusals).sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topRefusals.length) {
  console.log('\nRefusals (pre-dispatch, re-driven)');
  for (const [reason, count] of topRefusals) console.log(`  ${String(count).padStart(3)}  ${reason}`);
}

// Stop categories, first match wins: what blocked the application and who acts on it next.
function category(row) {
  const reason = String(row.reason ?? '');
  if (row.outcome === 'submitted') return ['submitted', ''];
  const table = [
    [/captcha-rejected/i, 'captcha-rejected', 'user: captcha in held tab'],
    [/^account-blocked/i, 'account-blocked', 'user: contact job-board support'],
    [/already (applied|submitted)|application (is already|was) submitted/i, 'already-applied', ''],
    [/^site-down/i, 'site-down', 'rerun later'],
    [/posting-unavailable|no longer (available|accepting)|registration is closed|posting (is )?closed|no (job )?openings|could not be found|page you are looking for|no .*matching the target role|no link matching|all n(ot|on)[- ]matching|contain no /i, 'posting-gone', ''],
    [/captcha|robot|human verification/i, 'captcha', 'user: captcha in held tab'],
    [/date of birth|\bdob\b|birth ?date/i, 'needs-dob', 'user: DOB'],
    [/needs-user-document|transcript/i, 'needs-document', 'user: provide document'],
    [/sms|phone code|authenticator|gate mfa/i, 'needs-mfa', 'user: code'],
    [/email-code|email-verification|verification link|code not (arriv|received)/i, 'email-verification', 'harness'],
    [/needs-user|could you|please (provide|confirm)|\?$/i, 'needs-user-answer', 'user: answer'],
    [/credential|password|sign[- ]?in\b|log ?in\b/i, 'account', 'harness'],
    [/consult-limit|iteration-limit|planner-error|driver-error|implementation-error|killed|crash|no summary/i, 'harness-stuck', 'harness'],
  ];
  for (const [re, name, who] of table) if (re.test(reason)) return [name, who];
  return ['other', 'review'];
}

function applications(runs) {
  // Lane and name per posting from the queue log ("=== Name (lane) url").
  const results = new URL('./runs/queue-results.txt', import.meta.url);
  const named = new Map();
  if (existsSync(results)) {
    for (const line of readFileSync(results, 'utf8').split('\n')) {
      const m = line.match(/^=== (.*) \(([^()\t\r\n]+)\) (\S+)/);
      if (m) named.set(m[3].replace(/[?#].*$/, ''), { name: m[1], lane: m[2] });
    }
  }
  const byJob = new Map();
  for (const run of runs) {
    if (!run.job) continue;
    const list = byJob.get(run.job) ?? [];
    list.push(run);
    byJob.set(run.job, list);
  }
  // The employer's latest reply per posting, from the last `bun mail.mjs` sync.
  const mailPath = new URL('./runs/mail.json', import.meta.url);
  const mail = existsSync(mailPath) ? JSON.parse(readFileSync(mailPath, 'utf8')) : null;
  const apps = [...byJob].map(([job, list]) => {
    const latest = list.at(-1);
    const done = list.find(run => run.outcome === 'submitted');
    const final = done ?? latest;
    const [status, who] = category(final);
    const info = named.get(job) ?? {};
    const lane = info.lane ?? (final.resume ?? '').match(RESUME_NAME)?.[1] ?? '';
    // Workday-style review pages show no file chip at submit; then the files uploaded during the run stand in.
    const sent = final.submittedWith?.length ? final.submittedWith : final.uploaded ?? [];
    const resumeSent = sent.find(file => /resume|cv/i.test(file)) ?? '';
    // A submission whose recorded resume is not the lane's resume (or the fallback's) is flagged for follow-up.
    const expectedResume = lane ? laneResume(lane) : '';
    const resumeOk = !done ? '' : !resumeSent ? 'unrecorded'
      : expectedResume && resumeSent.split(/[\\/]/).pop() !== expectedResume ? 'WRONG' : 'ok';
    return {
      last: latest.t.slice(0, 16).replace('T', ' '), job: job.replace(/^https?:\/\//, ''), lane,
      name: info.name ?? final.title ?? '', status, reply: mail?.byJob?.[job]?.kind ?? '', who, attempts: list.length,
      secs: Math.round(list.reduce((s, run) => s + (run.secs ?? 0), 0)), cost: list.reduce((s, run) => s + (run.cost ?? 0), 0),
      consults: list.reduce((s, run) => s + (run.models?.deepseek?.calls ?? 0), 0), site: final.site ?? '',
      resume: resumeSent, resumeOk, tailored: final.tailored ? 'yes' : '', documents: sent.join(' ; '), reason: final.outcome === 'submitted' ? '' : String(final.reason ?? '').slice(0, 160),
    };
  });
  const columns = ['last', 'job', 'lane', 'name', 'status', 'reply', 'who', 'attempts', 'secs', 'cost', 'consults', 'site', 'resume', 'resumeOk', 'tailored', 'documents', 'reason'];
  const cell = value => { const text = typeof value === 'number' ? String(Math.round(value * 1e4) / 1e4) : String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  const csv = [columns.join(','), ...apps.map(app => columns.map(column => cell(app[column])).join(','))].join('\n');
  const out = fileURLToPath(new URL('./runs/applications.csv', import.meta.url));
  writeFileSync(out, `${csv}\n`);

  console.log('last              lane      status             reply       tries   time    cost  resume      name / reason');
  for (const app of apps) {
    console.log([
      app.last.padEnd(16), app.lane.padEnd(9), app.status.padEnd(18), (app.reply || '-').padEnd(10), String(app.attempts).padStart(5),
      secs(app.secs).padStart(6), money(app.cost).padStart(7), (app.resumeOk || '-').padEnd(10),
      `${app.name.slice(0, 50)}${app.reason ? ` — ${app.reason.slice(0, 60)}` : ''}`,
    ].join(' '));
  }
  const counts = tally(apps, app => app.status);
  console.log(`\nApplications ${apps.length}: ${counts.map(([k, c]) => `${k} ${c}`).join(', ')}`);
  const submittedApps = apps.filter(app => app.status === 'submitted');
  const spent = apps.reduce((s, app) => s + app.cost, 0);
  console.log(`  cost ${money(spent)} total, ${submittedApps.length ? money(spent / submittedApps.length) : 'n/a'} per submission; `
    + `resume check on submissions: ${tally(submittedApps, app => app.resumeOk).map(([k, c]) => `${k} ${c}`).join(', ')}`);
  if (mail) {
    const replies = tally(apps.filter(app => app.reply), app => app.reply);
    const proved = apps.filter(app => app.status !== 'submitted' && ['confirmed', 'rejected', 'assessment', 'interview'].includes(app.reply)).length;
    console.log(`  employer replies (mail synced ${mail.syncedAt.slice(0, 16).replace('T', ' ')} UTC): ${replies.map(([k, c]) => `${k} ${c}`).join(', ') || 'none'}`
      + `${proved ? `; ${proved} not recorded as submitted but answered by the employer` : ''}`);
  } else console.log('  employer replies: run `bun mail.mjs` to sync them');
  const waiting = tally(apps.filter(app => app.who), app => app.who);
  if (waiting.length) {
    console.log('  next action:');
    for (const [who, count] of waiting) console.log(`    ${String(count).padStart(3)}  ${who}`);
  }
  console.log(`  written ${out}`);
}
