// Response tracking: `bun mail.mjs [--since ISO] [--follow-up DAYS]` reads the configured inbox (read-only) and
// writes runs/mail.json, which `bun report.mjs --apps` folds into its `reply` column.
// - Employer responses: mail since --since (default: the first submitted application) is classified locally
//   (confirmed / rejected / assessment / interview / update) and matched to the submitted application it answers by
//   sender and subject. Job-like mail that matches no application is listed so nothing is missed.
// - Outreach: emails you sent with your resume attached (the configured resume file pattern) are tracked as threads:
//   replied, bounced, auto-reply, waiting, or follow-up once --follow-up days (default 7) pass without a reply.
// No model sees any mail; message text stays on this machine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import * as email from './lib/email.mjs';
import { employerKeys, matchApplication, classify, outreachStatus, addressOf } from './lib/mailtrack.mjs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const followUpDays = Number(arg('--follow-up') ?? 7);
const config = loadConfig();
if (!config.email.enabled) {
  console.error('email.enabled is false in config.json; response tracking needs read-only inbox access.');
  process.exit(1);
}
const account = config.email.accountLabel;
const path = name => fileURLToPath(new URL(`./runs/${name}`, import.meta.url));
const readLines = name => existsSync(path(name)) ? readFileSync(path(name), 'utf8').split('\n') : [];

// Every attempted posting, keyed by job, from its first run (a confirmation can prove a run recorded as stopped did
// submit), with whether a run recorded the submission and its employer match keys.
const named = new Map();
for (const line of readLines('queue-results.txt')) {
  const m = line.match(/^=== (.*) \(([^()\t\r\n]+)\) (\S+)/);
  if (m) named.set(m[3].replace(/[?#].*$/, ''), m[1]);
}
const apps = new Map();
for (const line of readLines('summary.jsonl')) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (!row?.job) continue;
  const known = apps.get(row.job);
  if (known) { known.submitted ||= row.outcome === 'submitted'; known.title ||= row.title ?? ''; continue; }
  const name = named.get(row.job) ?? '';
  apps.set(row.job, { job: row.job, t: row.t, title: row.title ?? '', name, submitted: row.outcome === 'submitted' });
}
for (const app of apps.values()) app.keys = employerKeys(app);
const applications = [...apps.values()];
const since = arg('--since') ?? applications.filter(app => app.submitted).map(app => app.t).sort()[0] ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
const after = Math.floor(Date.parse(since) / 1000);

const previous = existsSync(path('mail.json')) ? JSON.parse(readFileSync(path('mail.json'), 'utf8')) : {};
// Matched messages' text (subject + first 6,000 body characters) is cached, not their classification, so a
// classifier change applies to every message on the next sync.
const bodies = previous.bodies ?? {};
const me = await email.accountAddress(account);

// Bounded-concurrency map, so a few hundred metadata reads stay polite to the API.
async function pool(items, size, task) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await task(items[i]); }
  }));
  return out;
}

// Employer responses.
const query = `-in:sent -in:chats -in:spam after:${after} (application OR applying OR applied OR candidacy OR candidate OR interview OR assessment OR position OR internship OR opportunity OR "next steps")`;
const ids = await email.searchMessageIds(account, query, 1500);
const metas = await pool(ids, 8, id => email.getMessage(account, id));
const responses = [];
const unmatched = [];
for (const message of metas) {
  if (addressOf(message.headers.from) === me) continue;
  const app = matchApplication(message, applications);
  if (!app) {
    const kind = classify(message.headers.subject, message.snippet);
    if (kind !== 'update' && kind !== 'account') unmatched.push({ date: message.date, from: message.headers.from, subject: message.headers.subject, kind });
    continue;
  }
  if (!(message.id in bodies)) {
    const full = await email.getMessage(account, message.id, { full: true });
    bodies[message.id] = (full.text || full.snippet).slice(0, 6000);
  }
  const kind = classify(message.headers.subject, bodies[message.id]);
  if (kind === 'account') continue;
  responses.push({ id: message.id, date: message.date, from: message.headers.from, subject: message.headers.subject, kind, job: app.job });
}
responses.sort((a, b) => a.date - b.date);
// Each application's status is its latest decision (rejected / assessment / interview); without one, the latest of
// 'confirmed' / 'incomplete' beats 'update'. A later confirmation or update never hides a decision.
const weight = kind => ({ update: 0, confirmed: 1, incomplete: 1 })[kind] ?? 2;
const byJob = {};
for (const response of responses) {
  const current = byJob[response.job];
  if (!current || weight(response.kind) >= weight(current.kind)) byJob[response.job] = { kind: response.kind, date: response.date, subject: response.subject, from: response.from };
}

// Outreach threads: sent mail carrying a resume file.
const [resumePrefix, resumeSuffix] = config.resumes.filePattern.split('{lane}');
const sentIds = await email.searchMessageIds(account, `in:sent has:attachment after:${after}`, 300);
const sent = (await pool(sentIds, 8, id => email.getMessage(account, id, { full: true })))
  .filter(message => message.attachments.some(name => name.startsWith(resumePrefix) && name.endsWith(resumeSuffix)));
const threads = new Map();
for (const message of sent) if (!threads.has(message.threadId)) threads.set(message.threadId, message);
const now = Date.now();
const outreach = await pool([...threads.values()], 8, async first => {
  const thread = await email.getThread(account, first.threadId);
  const opener = thread.find(message => addressOf(message.headers.from) === me) ?? first;
  return { threadId: first.threadId, sentAt: opener.date, to: opener.headers.to, subject: opener.headers.subject, ...outreachStatus(thread, me, now, followUpDays) };
});
outreach.sort((a, b) => a.sentAt - b.sentAt);
writeFileSync(path('mail.json'), `${JSON.stringify({ syncedAt: new Date(now).toISOString(), since, followUpDays, byJob, responses, unmatched, outreach, bodies }, null, 1)}\n`);

// Report.
const day = ms => new Date(ms).toISOString().slice(5, 10);
const nameOf = job => { const app = apps.get(job); return (app.name || app.title || new URL(job).host).slice(0, 48); };
const statusCounts = {};
for (const { kind } of Object.values(byJob)) statusCounts[kind] = (statusCounts[kind] ?? 0) + 1;
console.log(`Employer responses since ${since.slice(0, 10)}: ${responses.length} messages on ${Object.keys(byJob).length} of ${applications.length} attempted postings`);
console.log(`  status: ${Object.entries(statusCounts).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'no responses yet'}`);
const notable = responses.filter(response => response.kind !== 'confirmed');
if (notable.length) console.log('  beyond confirmations:');
for (const response of notable) console.log(`  ${day(response.date)}  ${response.kind.padEnd(10)} ${nameOf(response.job).padEnd(48)}  ${String(response.subject).slice(0, 60)}`);
const provedSubmitted = Object.entries(byJob).filter(([job, status]) => !apps.get(job).submitted && ['confirmed', 'rejected', 'assessment', 'interview'].includes(status.kind));
if (provedSubmitted.length) {
  console.log(`\nRecorded as stopped, but the employer answered as for a submitted application: ${provedSubmitted.length}`);
  for (const [job, status] of provedSubmitted) console.log(`  ${day(status.date)}  ${status.kind.padEnd(10)} ${nameOf(job).padEnd(48)}  ${job.replace(/^https?:\/\//, '').slice(0, 70)}`);
}
if (unmatched.length) {
  const decisions = unmatched.filter(message => message.kind !== 'confirmed');
  const senders = {};
  for (const message of unmatched) { const sender = String(message.from).replace(/<[^>]*>/, '').replace(/"/g, '').trim().slice(0, 30); senders[sender] = (senders[sender] ?? 0) + 1; }
  console.log(`\nJob-like mail matching no attempted posting (applied outside the harness?): ${unmatched.length}`);
  console.log(`  senders: ${Object.entries(senders).sort((a, b) => b[1] - a[1]).map(([sender, n]) => `${sender}${n > 1 ? ` ×${n}` : ''}`).join('; ')}`);
  for (const message of decisions) console.log(`  ${day(message.date)}  ${message.kind.padEnd(10)} ${String(message.from).replace(/<[^>]*>/, '').trim().slice(0, 30).padEnd(30)}  ${String(message.subject).slice(0, 60)}`);
}
console.log(`\nOutreach (sent with a resume attached): ${outreach.length}`);
for (const thread of outreach) {
  const note = thread.status === 'replied' ? ` — ${day(thread.reply.date)} ${String(thread.reply.snippet).slice(0, 60)}` : ` — ${thread.days}d since your last email`;
  console.log(`  ${day(thread.sentAt)}  ${thread.status.padEnd(10)} ${String(thread.to).slice(0, 32).padEnd(32)}  ${String(thread.subject).slice(0, 50)}${note}`);
}
console.log(`\nwritten ${path('mail.json')}`);
