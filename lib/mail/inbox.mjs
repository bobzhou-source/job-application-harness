// lib/mail/inbox.mjs — read-only inbox passes: index job email into events, and track outreach threads.
import * as email from '../email.mjs';
import { matchApplication, senderEmployer, addressOf } from './match.mjs';
import { classify } from './classify.mjs';
// A cold email's thread state: 'replied' (a person answered), 'bounced', 'auto-reply' (only out-of-office or
// auto-responders answered), else 'follow-up' once `followUpDays` passed since the last message you sent, or 'waiting'.
export function outreachStatus(thread, me, now, followUpDays) {
  const mine = thread.filter(message => addressOf(message.headers.from) === me);
  const lastMine = Math.max(...mine.map(message => message.date));
  const theirs = thread.filter(message => addressOf(message.headers.from) !== me && message.date > Math.min(...mine.map(m => m.date)));
  const bounce = message => /mailer-daemon|postmaster/i.test(addressOf(message.headers.from)) || /delivery status notification|undeliverable|delivery has failed/i.test(message.headers.subject ?? '');
  const auto = message => (message.headers['auto-submitted'] && message.headers['auto-submitted'] !== 'no') || message.headers['x-autoreply']
    || /out of (the )?office|automatic reply|auto-?reply|autoreply/i.test(message.headers.subject ?? '');
  const human = theirs.filter(message => !bounce(message) && !auto(message));
  const days = Math.floor((now - lastMine) / 86_400_000);
  const latest = list => list.reduce((a, b) => (b.date > a.date ? b : a));
  if (human.length) { const reply = latest(human); return { status: 'replied', days, reply: { date: reply.date, from: reply.headers.from, snippet: reply.snippet } }; }
  if (theirs.some(bounce)) return { status: 'bounced', days };
  const base = theirs.some(auto) ? 'auto-reply' : null;
  return { status: days >= followUpDays ? 'follow-up' : base ?? 'waiting', days, followUps: mine.length - 1 };
}

// Bounded-concurrency map, so a few hundred reads stay polite to the API.
export async function pool(items, size, task) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await task(items[i]); }
  }));
  return out;
}

const JOB_QUERY = '(application OR applying OR applied OR candidacy OR candidate OR interview OR assessment OR position OR internship OR opportunity OR offer OR "next steps")';

// Job email received after `after` (unix seconds) as events {id, date, from, subject, kind, job, employer}, oldest
// first. `job` is the matched posting (null when none matches; `employer` then names the sender's employer). Matched
// mail is always indexed, unmatched mail only when its snippet reads as job mail. `cache` ({bodies, links}, keyed by
// message id) is filled in place, so each message body is fetched once across syncs.
export async function indexJobMail(account, { applications, after, me, cache }) {
  const ids = await email.searchMessageIds(account, `-in:sent -in:chats -in:spam after:${after} ${JOB_QUERY}`, 1500);
  const metas = await pool(ids, 8, id => email.getMessage(account, id));
  const candidates = metas.filter(message => addressOf(message.headers.from) !== me)
    .map(message => ({ message, app: matchApplication(message, applications) }))
    .filter(({ message, app }) => app || !['update', 'account'].includes(classify(message.headers.subject, message.snippet)));
  await pool(candidates.filter(({ message }) => !(message.id in cache.bodies && message.id in cache.links)), 8, async ({ message }) => {
    const full = await email.getMessage(account, message.id, { full: true });
    cache.bodies[message.id] = (full.text || full.snippet).slice(0, 6000);
    cache.links[message.id] = full.links.filter(link => /^https?:/i.test(link.href)).slice(0, 25)
      .map(link => ({ href: link.href, context: link.context.slice(0, 320) }));
  });
  const events = [];
  for (const { message, app } of candidates) {
    const kind = classify(message.headers.subject, cache.bodies[message.id]);
    if (kind === 'account' || (!app && kind === 'update')) continue;
    const employer = app ? (app.name || app.title.split(' | ').slice(0, 2).reverse().join(' — ') || new URL(app.job).host)
      : senderEmployer(message.headers.from, message.headers.subject);
    events.push({ id: message.id, date: message.date, from: message.headers.from, subject: message.headers.subject, kind, job: app?.job ?? null, employer });
  }
  return events.sort((a, b) => a.date - b.date);
}

// Outreach threads: mail you sent after `after` carrying a resume file (`filePattern`, with `{lane}` as wildcard),
// one row per thread with its outreachStatus, oldest first.
export async function syncOutreach(account, { after, me, now, followUpDays, filePattern }) {
  const [prefix, suffix] = filePattern.split('{lane}');
  const ids = await email.searchMessageIds(account, `in:sent has:attachment after:${after}`, 300);
  const sent = (await pool(ids, 8, id => email.getMessage(account, id, { full: true })))
    .filter(message => message.attachments.some(name => name.startsWith(prefix) && name.endsWith(suffix)));
  const threads = new Map();
  for (const message of sent) if (!threads.has(message.threadId)) threads.set(message.threadId, message);
  const outreach = await pool([...threads.values()], 8, async first => {
    const thread = await email.getThread(account, first.threadId);
    const opener = thread.find(message => addressOf(message.headers.from) === me) ?? first;
    return { threadId: first.threadId, sentAt: opener.date, to: opener.headers.to, subject: opener.headers.subject, ...outreachStatus(thread, me, now, followUpDays) };
  });
  return outreach.sort((a, b) => a.sentAt - b.sentAt);
}
