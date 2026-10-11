// lib/mail/match.mjs — which posting (or, failing that, which employer) a job email answers, from its sender and
// subject. Deterministic and local: no model sees any mail.
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
// and `domain` (the posting's own registrable domain when it is not a shared platform). `exclude` names that are never
// an employer (the applicant's own name, which a profile page's title carries where a company would be).
export function employerKeys({ job, title, name }, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map(value => words(value).trim()).filter(Boolean));
  const phrases = new Set();
  const add = value => { const phrase = words(String(value ?? '').split(/ - | \(|, /)[0]).trim(); if (phrase.length >= 3 && !excluded.has(phrase)) phrases.add(phrase); };
  if (name) add(name.split(' — ')[0]);
  const titled = String(title ?? '');
  // "Role | Company" and "Role | Company | Handshake": the company is the second part once the board name is dropped.
  const parts = titled.split(' | ').filter(part => !/^handshake$/i.test(part.trim()));
  if (parts.length >= 2) add(parts[1]);
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

// The application a message answers, or null. Candidates are postings attempted before the message; the
// best-scoring employer wins, and among one employer's several postings the one whose title words the subject and
// snippet repeat most, then one a run recorded as submitted, then the most recent. A subject naming a role ("…
// Application Status for Software Engineering Intern") that shares no distinctive word with a posting's title is about
// another posting at that employer, so that posting is not a candidate.
const ROLE = /\b(intern(ship)?|analyst|engineer(ing)?|developer|scientist|associate|co-?op|fellow(ship)?|program(me)?)\b/i;
const COMMON_TITLE_WORDS = new Set(['intern', 'internship', 'summer', 'fall', 'spring', 'winter', 'program', 'programme', '2025', '2026', '2027', '2028', '2029', 'student', 'analyst', 'undergraduate']);
const outranks = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
export function matchApplication(message, apps) {
  const said = words(`${message.headers.subject} ${message.snippet}`);
  const subject = words(message.headers.subject);
  const namesRole = ROLE.test(message.headers.subject ?? '');
  let best = null;
  for (const app of apps) {
    if (Date.parse(app.t) > message.date + 5 * 60_000) continue;
    const score = employerScore(message.headers, app.keys);
    if (!score) continue;
    const titleWords = words(`${app.title} ${String(app.name ?? '').split(' — ').slice(1).join(' ')}`).split(' ').filter(word => word.length >= 4);
    if (namesRole) {
      const employerWords = new Set(app.keys.phrases.join(' ').split(' '));
      const distinctive = titleWords.filter(word => !COMMON_TITLE_WORDS.has(word) && !employerWords.has(word) && word !== 'handshake');
      if (distinctive.length && !distinctive.some(word => subject.includes(` ${word} `))) continue;
    }
    const titleHits = titleWords.filter(word => said.includes(` ${word} `)).length;
    const rank = [score, titleHits, app.submitted ? 1 : 0, Date.parse(app.t)];
    if (!best || outranks(rank, best.rank)) best = { app, rank };
  }
  return best?.app ?? null;
}

// The employer a sender speaks for, when the mail matches no posting: its display name without recruiting words,
// else the sending host's distinctive label (blackrock.tal.net → blackrock, mail.amazon.jobs → amazon), else a short
// subject prefix ("BAE Systems - Application Status" → BAE Systems), else the address.
export function senderEmployer(from, subject) {
  const display = String(from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '')
    .replace(/\b(university )?(recruiting|recruitment|talent( acquisition)?|careers?|jobs|team|hr|human resources|no-?reply|do not reply|notifications?|via \w+)\b/gi, '')
    .replace(/[|,:\-–]+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (display && !display.includes('@')) return display;
  const host = (addressOf(from).split('@')[1] ?? '').split('.');
  const generic = /^(mail|email|e|em|jobs|careers|talent|notifications?|hr|no-?reply|myworkday|workday|smartrecruiters|greenhouse|lever|icims|brassring|trm)$/i;
  return host.slice(0, -1).find(label => !generic.test(label))
    ?? String(subject ?? '').match(/^\s*([^|:\-–]{2,40}?)\s+[|:\-–]\s/)?.[1] ?? addressOf(from);
}

