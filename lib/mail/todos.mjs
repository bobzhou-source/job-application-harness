// lib/mail/todos.mjs — what the indexed mail means: each posting's latest status, and the to-dos it asks of you.
import { deadline, actionLink, ACTION_KINDS } from './classify.mjs';

// Each posting's status is its latest decision (offer / rejected / completed / assessment / interview); without one,
// the latest of 'confirmed' / 'incomplete' beats 'update'. A later confirmation or update never hides a decision.
const weight = kind => ({ update: 0, confirmed: 1, incomplete: 1 })[kind] ?? 2;
export function statusByJob(events) {
  const byJob = {};
  for (const event of events) {
    if (!event.job) continue;
    const current = byJob[event.job];
    if (!current || weight(event.kind) >= weight(current.kind)) byJob[event.job] = { kind: event.kind, date: event.date, subject: event.subject, from: event.from };
  }
  return byJob;
}

// Later kinds that show an item's step handled.
const CLOSES = {
  assessment: ['completed', 'interview', 'rejected', 'offer'],
  interview: ['rejected', 'offer'],
  incomplete: ['confirmed', 'completed', 'assessment', 'interview', 'rejected', 'offer'],
  offer: [],
};

// To-dos from action events (offer / assessment / interview / incomplete), oldest first: {id, kind, employer, job,
// subject, date, count, due, link, state ('open' | 'closed' | 'done'), closedBy}. Repeats (the same reminder resent)
// fold into the newest one. A later email on the same posting closes an item when it shows the step handled; mail
// matching no posting closes only on that employer's later decision. `done` holds item ids you marked handled.
export function buildItems(events, { bodies, links }, done) {
  const groups = new Map();
  for (const event of events.filter(event => ACTION_KINDS.has(event.kind))) {
    const key = `${event.job ?? event.employer.toLowerCase()}\n${event.kind}\n${String(event.subject).toLowerCase().replace(/\W+/g, ' ').trim()}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()].map(group => {
    const latest = group.at(-1);
    const later = events.filter(event => event.date > latest.date && (latest.job ? event.job === latest.job
      : !event.job && event.employer === latest.employer && ['rejected', 'offer'].includes(event.kind)));
    const closedBy = later.find(event => CLOSES[latest.kind].includes(event.kind));
    return {
      id: latest.id, kind: latest.kind, employer: latest.employer, job: latest.job, subject: latest.subject, date: latest.date,
      count: group.length, due: deadline(bodies[latest.id], latest.date), link: actionLink(links[latest.id], latest.kind),
      state: group.some(event => done[event.id]) ? 'done' : closedBy ? 'closed' : 'open',
      closedBy: closedBy ? { kind: closedBy.kind, date: closedBy.date } : null,
    };
  }).sort((a, b) => a.date - b.date);
}

// Open to-dos, most urgent first: dated items by deadline, then undated ones newest first.
export function openItems(items) {
  return items.filter(item => item.state === 'open').sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || b.date - a.date);
}

// An item by its number in the open list or by (a suffix of) its id; null when none matches.
export function findItem(items, ref) {
  if (/^\d{1,3}$/.test(ref ?? '')) return openItems(items)[Number(ref) - 1] ?? null;
  return (ref && items.find(item => item.id.endsWith(ref))) || null;
}
