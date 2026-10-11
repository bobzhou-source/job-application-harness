// lib/mailtrack.mjs — employer-response and outreach-thread tracking over already-fetched Gmail messages.
// Deterministic and local: no model sees any mail. mail.mjs does the (read-only) fetching.
import { getDomain } from 'tldts';

// Domains shared by many employers (ATS, assessment and mail platforms, webmail): a sender or posting on one of
// them says nothing about which employer it is.
const SHARED_DOMAINS = new Set([
  'myworkdayjobs.com', 'myworkday.com', 'workday.com', 'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com',
  'icims.com', 'smartrecruiters.com', 'successfactors.com', 'successfactors.eu', 'sapsf.com', 'taleo.net', 'oraclecloud.com',
  'oracle.com', 'brassring.com', 'jobvite.com', 'avature.net', 'eightfold.ai', 'phenompeople.com', 'joinhandshake.com',
  'applytojob.com', 'jazzhr.com', 'bamboohr.com', 'paylocity.com', 'ultipro.com', 'ukg.com', 'adp.com', 'dayforcehcm.com',
  'hirevue.com', 'hackerrank.com', 'codesignal.com', 'codility.com', 'pymetrics.ai', 'karat.io', 'sendgrid.net',
  'amazonses.com', 'mailgun.org', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'wellfound.com',
]);
// Words that do not identify an employer ("Pure Storage, Inc." and "Pure Storage" are one company).
const FILLER = /\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|plc|lp|llp|the|and|of|usa|us|na|international|global|careers?|jobs|recruiting|talent|acquisition|team|handshake|hr|no|reply|noreply|do|not)\b/g;
// Names of the shared platforms themselves: an employer phrase or tenant equal to one ("Workday") cannot be told
// apart from the platform's mail for every other employer, so it is not a key.
const PLATFORM_NAMES = new Set([...SHARED_DOMAINS].map(domain => domain.split('.')[0]).concat('myworkday'));
// A company's first word alone identifies it unless it is this common ("American Family" vs "American Express").
const GENERIC_WORDS = new Set(['american', 'national', 'first', 'united', 'general', 'new', 'north', 'northern', 'south', 'southern',
  'east', 'eastern', 'west', 'western', 'capital', 'financial', 'bank', 'insurance', 'state', 'city', 'advanced', 'applied', 'data',
  'digital', 'health', 'energy', 'pacific', 'atlantic', 'central', 'mutual', 'premier', 'summit', 'blue', 'green', 'red', 'golden',
  'royal', 'great', 'smart', 'technologies', 'technology', 'systems', 'solutions', 'services', 'partners', 'investments', 'real']);

const words = text => ` ${String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()} `;
const compact = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function addressOf(header) {
  return (String(header ?? '').match(/<([^>]+)>/)?.[1] ?? String(header ?? '')).trim().toLowerCase();
}
const displayName = header => String(header ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
const domainOf = address => getDomain(address.split('@')[1] ?? '') ?? '';

// The employer a posting belongs to, as match keys: `phrases` (company names as normalized words, from the queue's
// "Company — Role" name and the page title's "Role | Company | Handshake" / "Role @ Company"), `slugs` (the ATS
// tenant: acme.wd1.myworkdayjobs.com, job-boards.greenhouse.io/acme, jobs.ashbyhq.com/acme, careers-acme.icims.com),
// and `domain` (the posting's own registrable domain when it is not a shared platform).
export function employerKeys({ job, title, name }) {
  const phrases = new Set();
  const add = value => { const phrase = words(String(value ?? '').split(/ - | \(|, /)[0]).trim(); if (phrase.length >= 3) phrases.add(phrase); };
  if (name) add(name.split(' — ')[0]);
  const titled = String(title ?? '');
  if (/ \| Handshake$/.test(titled)) add(titled.split(' | ').at(-2));
  if (titled.includes(' @ ')) add(titled.split(' @ ').at(-1));
  const slugs = new Set();
  let domain = '';
  try {
    const url = new URL(job);
    const host = url.hostname.toLowerCase();
    const registrable = getDomain(host) ?? host;
    const firstPath = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (/myworkdayjobs\.com$|applytojob\.com$|avature\.net$/.test(host)) slugs.add(host.split('.')[0]);
    else if (/icims\.com$/.test(host)) slugs.add(host.split('.')[0].replace(/^(careers|jobs)-/, ''));
    else if (/greenhouse\.io$|lever\.co$|ashbyhq\.com$/.test(host)) slugs.add(firstPath);
    else if (!SHARED_DOMAINS.has(registrable)) {
      domain = registrable;
      slugs.add(registrable.split('.')[0].replace(/careers?$|jobs$/, ''));
    }
  } catch { /* no posting URL */ }
  return {
    phrases: [...phrases].filter(phrase => !PLATFORM_NAMES.has(phrase)),
    slugs: [...slugs].map(compact).filter(slug => slug.length >= 4 && !PLATFORM_NAMES.has(slug)),
    domain,
  };
}

// How strongly a message's sender and subject point at an employer (0 = not at all). Bodies are not used: newsletters
// and job alerts name many employers. A shared-platform sender's mailbox name often carries the tenant
// (acmecorp@myworkday.com). A company phrase matches whole or by its leading words ("Voya" for "Voya Financial"),
// scoring higher the more of it matches.
export function employerScore(headers, keys) {
  const from = headers.from ?? '';
  const address = addressOf(from);
  const senderDomain = domainOf(address);
  const ownSender = senderDomain && !SHARED_DOMAINS.has(senderDomain);
  const evidence = `${displayName(from)} ${ownSender ? senderDomain.split('.')[0] : address.split('@')[0]} ${headers.subject ?? ''}`;
  const hay = words(evidence);
  const dense = compact(evidence);
  let score = 0;
  if (keys.domain && senderDomain === keys.domain) score = Math.max(score, 3);
  for (const phrase of keys.phrases) {
    const parts = phrase.split(' ');
    for (let k = parts.length; k >= 1; k--) {
      const prefix = parts.slice(0, k).join(' ');
      if (k === 1 && (prefix.length < 4 && parts.length > 1 || GENERIC_WORDS.has(prefix))) break;
      if (hay.includes(` ${prefix} `) || (compact(prefix).length >= 6 && dense.includes(compact(prefix)))) {
        score = Math.max(score, 1.5 + (0.5 * k) / parts.length + Math.min(prefix.length, 30) / 1000);
        break;
      }
    }
  }
  for (const slug of keys.slugs) {
    if (ownSender && compact(senderDomain.split('.')[0]) === slug) score = Math.max(score, 3);
    else if (hay.includes(` ${slug} `) || (slug.length >= 5 && dense.includes(slug))) score = Math.max(score, 2);
  }
  return score;
}

// The submitted application a message answers, or null. Candidates are applications submitted before the message;
// the best-scoring employer wins, and among one employer's several postings the one whose title words the subject
// and snippet repeat most, then the most recent.
const outranks = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
export function matchApplication(message, apps) {
  const said = words(`${message.headers.subject} ${message.snippet}`);
  let best = null;
  for (const app of apps) {
    if (Date.parse(app.t) > message.date + 5 * 60_000) continue;
    const score = employerScore(message.headers, app.keys);
    if (!score) continue;
    const titleHits = words(app.title).split(' ').filter(word => word.length >= 4 && said.includes(` ${word} `)).length;
    const rank = [score, titleHits, Date.parse(app.t)];
    if (!best || outranks(rank, best.rank)) best = { app, rank };
  }
  return best?.app ?? null;
}

// What a message says, first match wins: 'account' (verification/reset mail; not a response), 'rejected',
// 'assessment', 'interview', 'incomplete' (the employer says the application is unfinished), 'confirmed', else
// 'update'. Rejection, assessment and interview cues inside conditional sentences ("if selected, a recruiter will
// reach out to schedule an interview"; "if we choose not to move forward…") are confirmation boilerplate, not decisions.
const KINDS = [
  ['account', /verify your (e-?mail|account|identity)|confirm your (e-?mail( address)?|account|identity)|verification code|one[- ]time (pass)?code|password reset|reset your password|activate your account|security code/i],
  ['rejected', /unfortunately,? (we|after|at this time|this time|your application|the (position|role))|regret to inform|not (be )?mov(e|ing) forward|decided (not )?to (move forward|proceed|pursue) with (other|another)|other candidates (whose|who)|not (been )?selected|no longer (being )?(under )?consider|position has (now )?been filled|will not be (moving|proceeding|advancing)|move in a different direction|not able to offer|unable to offer/i],
  ['assessment', /\b(online assessment|coding (challenge|assessment|test)|technical assessment|interactive assessment|assessment (request|invitation|link)|hackerrank|codesignal|codility|hirevue|pymetrics|karat|take-?home|(complete|take) (the|your|this|an) (online |interactive )?(assessment|challenge|test)|game-?based assessment|aptitude test)\b/i],
  ['interview', /\b(invite you to (an? )?(interview|phone|video|virtual)|invitation to interview|interview (invitation|request)|schedule (your|an|a) (interview|phone screen|call)|(select|choose|book|pick) a (time|slot)|phone screen|first[- ]round|next round|superday|would (like|love) to (speak|chat|meet|connect) with you|share your availability|let us know your availability)\b/i],
  ['incomplete', /complete your (job )?application|finish your application|application (is )?(still )?incomplete|not yet (been )?submitted/i],
  ['confirmed', /thank(s| you) for (applying|your application|submitting|your interest|taking the time to apply)|application (has been |was |is )?(received|submitted|complete)|received your application|we (have )?received|successfully (applied|submitted)/i],
];
const CONDITIONAL = /\b(if|should|may|might|once|whether|in the event)\b/i;

export function classify(subject, text) {
  const full = `${subject ?? ''}\n${String(text ?? '').slice(0, 6000)}`;
  const definite = full.split(/(?<=[.!?\n])\s+/).filter(sentence => !CONDITIONAL.test(sentence)).join(' ');
  for (const [kind, pattern] of KINDS) {
    const scope = kind === 'account' || kind === 'confirmed' || kind === 'incomplete' ? full : definite;
    if (pattern.test(scope)) return kind;
  }
  return 'update';
}

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
