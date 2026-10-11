// lib/mail/print.mjs — console views of a mail sync. Action links carry access tokens, so only their host is shown.
import { openItems } from './todos.mjs';

const day = ms => new Date(ms).toISOString().slice(5, 10);

export function printTodo(mail, now = Date.now()) {
  const open = openItems(mail.items);
  console.log(`To do: ${open.length} open (mail synced ${String(mail.syncedAt).slice(0, 16).replace('T', ' ')} UTC)`);
  open.forEach((item, i) => {
    const due = item.due == null ? 'no deadline' : `${item.due < now ? 'OVERDUE ' : 'due '}${day(item.due)}`;
    const host = item.link ? new URL(item.link).host : 'no link';
    console.log(`  ${String(i + 1).padStart(2)}. ${item.kind.padEnd(10)} ${item.employer.slice(0, 44).padEnd(44)}  ${due.padEnd(16)} from ${day(item.date)}${item.count > 1 ? ` ×${item.count}` : ''}  [${host}] id ${item.id.slice(-6)}`);
    console.log(`      ${String(item.subject).slice(0, 100)}`);
  });
  if (open.length) console.log('  `bun mail.mjs open N` opens the link; `bun mail.mjs done N` marks it handled.');
  const handled = mail.items.filter(item => item.state !== 'open');
  if (handled.length) console.log(`  handled: ${handled.map(item => `${item.employer.slice(0, 30)} ${item.kind} (${item.state === 'done' ? 'marked done' : `${item.closedBy.kind} ${day(item.closedBy.date)}`})`).join('; ')}`);
}

// Outcomes (status tally, offers / interview requests / rejections), postings the employer answered though no run
// recorded the submission, mail from employers the harness never applied to, and outreach threads.
export function printReport(mail, postings) {
  const { events, byJob, outreach, since } = mail;
  const label = event => `${event.employer.slice(0, 48).padEnd(48)}  ${String(event.subject).slice(0, 60)}`;
  const statusCounts = {};
  for (const { kind } of Object.values(byJob)) statusCounts[kind] = (statusCounts[kind] ?? 0) + 1;
  console.log(`\nOutcomes since ${since.slice(0, 10)}: ${events.length} job emails; ${Object.keys(byJob).length} of ${postings.size} attempted postings answered`);
  console.log(`  posting status: ${Object.entries(statusCounts).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'no responses yet'}`);
  for (const [kind, title] of [['offer', 'Offers'], ['interview', 'Interview requests'], ['rejected', 'Rejections']]) {
    const list = events.filter(event => event.kind === kind);
    if (!list.length) continue;
    console.log(`  ${title} (${list.length}):`);
    for (const event of list) console.log(`    ${day(event.date)}  ${event.job ? '' : '(outside harness) '}${label(event)}`);
  }

  const proved = Object.entries(byJob).filter(([job, status]) => !postings.get(job)?.submitted && ['confirmed', 'rejected', 'completed', 'assessment', 'interview', 'offer'].includes(status.kind));
  if (proved.length) {
    console.log(`\nRecorded as stopped, but the employer answered as for a submitted application: ${proved.length}`);
    for (const [job, status] of proved) console.log(`  ${day(status.date)}  ${status.kind.padEnd(10)} ${events.find(event => event.job === job).employer.slice(0, 48).padEnd(48)}  ${job.replace(/^https?:\/\//, '').slice(0, 60)}`);
  }
  const unmatched = events.filter(event => !event.job);
  if (unmatched.length) {
    const senders = {};
    for (const event of unmatched) senders[event.employer] = (senders[event.employer] ?? 0) + 1;
    console.log(`\nJob email matching no attempted posting (applied outside the harness?): ${unmatched.length}`);
    console.log(`  ${Object.entries(senders).sort((a, b) => b[1] - a[1]).map(([sender, n]) => `${sender.slice(0, 30)}${n > 1 ? ` ×${n}` : ''}`).join('; ')}`);
  }
  console.log(`\nOutreach (sent with a resume attached): ${outreach.length}`);
  for (const thread of outreach) {
    const note = thread.status === 'replied' ? ` — ${day(thread.reply.date)} ${String(thread.reply.snippet).slice(0, 60)}` : ` — ${thread.days}d since your last email`;
    console.log(`  ${day(thread.sentAt)}  ${thread.status.padEnd(10)} ${String(thread.to).slice(0, 32).padEnd(32)}  ${String(thread.subject).slice(0, 50)}${note}`);
  }
}
