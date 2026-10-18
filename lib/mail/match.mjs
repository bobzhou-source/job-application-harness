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
// Role-noun detector shared by employerKeys (reject role-as-company phrases) and roleText captures.
const ROLE = /\b(intern(ship)?|analyst|engineer(ing)?|developer|scientist|associate|co-?op|fellow(ship)?|program(me)?)\b/i;

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
  const seasonPart = value => /^(?:summer|fall|winter|spring|autumn)?\s*20\d{2}$/i.test(String(value ?? '').trim());
  // Role strings must never become employer phrases: a nameless Workday row titled "Product Management Intern" would
  // otherwise outrank the real employer named only in the From domain (Roblox mail → ABB posting).
  const add = value => {
    const phrase = words(String(value ?? '').split(/ - | \(|, /)[0]).trim();
    if (phrase.length >= 3 && !excluded.has(phrase) && !ROLE.test(phrase) && !seasonPart(phrase)) phrases.add(phrase);
  };
  if (name) add(name.split(' — ')[0]);
  const titled = String(title ?? '');
  // "Role | Company" and "Role | Company | Handshake": the company is the second part once the board name is dropped.
  // Handshake also emits "Source | Role | Program | Handshake" (UKG | … | Blackstone LaunchPad): if parts[1] is a
  // role/season, take the last remaining part instead. Jobvite "Company - Role | Summer 2027" drops the season.
  const parts = titled.split(' | ').filter(part => !/^handshake$/i.test(part.trim()));
  if (parts.length >= 2) {
    const companyPart = (ROLE.test(parts[1]) || seasonPart(parts[1])) && parts.length >= 3
      ? parts[parts.length - 1]
      : parts[1];
    add(companyPart);
  }
  if (titled.includes(' @ ')) add(titled.split(' @ ').at(-1));
  // A short queue label can concatenate company and role ("BAE Embedded SW"). Its leading acronym is still a full
  // employer token; exact-token matching below never treats it as a prefix of a longer company name.
  const label = String(name ?? '').split(' — ')[0].trim();
  const acronym = label.match(/^([A-Z][A-Z0-9&]{1,5})\b/)?.[1];
  if (acronym && label.split(/\s+/).length > 1 && !ROLE.test(label)) phrases.add(words(acronym).trim());
  // Parenthetical board labels ("HP Inc. (HPIQ)") are the Greenhouse/Workday tenant people write in mail.
  const parenthetical = label.match(/\(([A-Z][A-Z0-9&]{1,7})\)/)?.[1];
  if (parenthetical) phrases.add(words(parenthetical).trim());
  // Greenhouse page titles are "Job Application for Role at Company" when the queue left no Company — Role name.
  const atCompany = titled.match(/\bat\s+(.+?)$/i)?.[1];
  if (atCompany) add(atCompany);
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
  // Workday tenants are often two letters (rb.wd5 = Federal Reserve). Shared-platform hosts already scoped the
  // slug to the tenant label, so a short one is still employer-specific; length-4+ boards keep the old floor.
  return {
    phrases: [...phrases].filter(phrase => !PLATFORM_NAMES.has(phrase)),
    slugs: [...slugs].map(compact).filter(slug => slug.length >= (slug.length <= 3 ? 2 : 4) && !PLATFORM_NAMES.has(slug) && !GENERIC_WORDS.has(slug)),
    domain,
  };
}

// How strongly a message points at an employer (0 = not at all). An employer phrase stated in the subject counts
// most, then one stated in the body, then one in the sender. Matching is by the complete phrase (or its unspaced
// form), never by a shared leading word: "Constellation Brands" is not "Constellation Energy". A shared-platform
// sender's mailbox name often carries the tenant (acmecorp@myworkday.com), and the posting's own domain identifies it.
export function employerScore(headers, keys, body = '') {
  const from = headers.from ?? '';
  const address = addressOf(from);
  const senderDomain = domainOf(address);
  const ownSender = senderDomain && !SHARED_DOMAINS.has(senderDomain);
  const sender = words(`${displayName(from)} ${ownSender ? senderDomain.split('.')[0] : address.split('@')[0]}`);
  const subject = words(headers.subject);
  const message = words(body);
  const dense = text => compact(text);
  const forms = text => {
    const tokens = words(text).trim().split(' ').filter(Boolean);
    const all = new Set();
    for (let i = 0; i < tokens.length; i++) for (let n = 1; n <= 3 && i + n <= tokens.length; n++) all.add(compact(tokens.slice(i, i + n).join('')));
    return all;
  };
  const subjectForms = forms(headers.subject);
  const messageForms = forms(body);
  const senderForms = forms(sender);
  const hasPhrase = (hay, phrase) => hay.includes(` ${phrase} `)
    || (compact(phrase).length >= 6 && dense(hay).includes(compact(phrase)));
  // Longer phrases outrank shared leading words: "hp iq" in the subject beats a posting whose only phrase is "hp".
  const phraseScore = (base, phrase) => base + Math.min(3, Math.max(0, phrase.trim().split(/\s+/).filter(Boolean).length - 1));
  let score = 0;
  for (const phrase of keys.phrases) {
    if (hasPhrase(subject, phrase)) score = Math.max(score, phraseScore(4, phrase));
    else if (hasPhrase(message, phrase)) score = Math.max(score, phraseScore(3, phrase));
    else if (hasPhrase(sender, phrase)) score = Math.max(score, phraseScore(2, phrase));
  }
  // "Message from the Federal Reserve Bank of Dallas: …" names the employer when the Workday display name is only
  // the tenant ("FRB Workday") and the posting phrase is the system name ("federal reserve system").
  const messageFrom = String(headers.subject ?? '').match(/^\s*message from (?:the )?(.+?)\s*:/i)?.[1];
  if (messageFrom) {
    const named = words(messageFrom).trim();
    for (const phrase of keys.phrases) {
      if (named === phrase || named.includes(` ${phrase} `) || phrase.includes(named) || compact(named) === compact(phrase))
        score = Math.max(score, phraseScore(4, phrase.length >= named.length ? phrase : named));
    }
  }
  for (const slug of keys.slugs) {
    // Shared-platform mailboxes carry the tenant (rb@myworkday.com, mufgub@myworkday.com, poet@myworkday.com).
    if (!ownSender && compact(address.split('@')[0]) === slug) score = Math.max(score, 4);
    else if (ownSender && compact(senderDomain.split('.')[0]) === slug) score = Math.max(score, 3);
    else if (senderForms.has(slug) || subjectForms.has(slug) || messageForms.has(slug)) score = Math.max(score, 2);
  }
  if (keys.domain && senderDomain === keys.domain) score = Math.max(score, 3);
  return score;
}

// The application a message answers, or null. Candidates are postings attempted before the message. An employer must
// be named by a complete distinctive phrase (or its tenant/domain), and the role stated in the subject or body must
// agree with the posting: a "Pre-Interview Assessment" that names the quantitative internship cannot answer a software
// engineering application. Generic words (intern, summer, analyst) never decide a match, and an unresolved tie between
// two postings is null rather than a guess. A requisition number repeated in the posting's title or URL is decisive.
const ROLE_CAPTURES = [
  /\bposition of\s+([^\n.!?]{3,220}?)(?=\s+(?:at|with|has|was|is|and|after|for)\b|[.!?]|$)/gi,
  /\brole of\s+([^\n.!?]{3,220}?)(?=\s+(?:at|with|has|was|is|and|after|for)\b|[.!?]|$)/gi,
  /(?:\binterest in|\bappl(?:ication|ying|y) (?:to|for)|\bcandidacy for|\bcandidate for|\bselected for|\bregarding|\babout|\bupdate (?:you )?regarding)\s+(?:the|our|this|a|an)?\s*([^\n.!?]{3,220}?)\s+(?:position|role|opening|opportunity)\b/gi,
  /\bapplication for\s+(?:the|our|this)?\s*([^\n.!?]{3,160}?)(?=\s*(?:\band\b|\bhas\b|\bwas\b|\bis\b|\bposition\b|\brole\b|[.!?]))/gi,
  /\b(?:position|role|opening|opportunity)\s+(?:for|of)\s+([^\n.!?]{3,220}?)(?=\s+(?:at|with|has|was|is|and|after|for)\b|[.!?]|$)/gi,
];
const ROLE_NOISE = new Set(['about', 'after', 'and', 'application', 'applications', 'applied', 'applying', 'are', 'assessment',
  'assessments', 'be', 'been', 'before', 'candidate', 'candidacy', 'career', 'careers', 'campus', 'challenge', 'code', 'codesignal', 'coding', 'complete',
  'completing', 'could', 'during', 'employment', 'for', 'from', 'graduate', 'has', 'have', 'hiring', 'industry', 'intern',
  'internship', 'into', 'invitation', 'invite', 'invited', 'is', 'job', 'jobs', 'level', 'may', 'might', 'next', 'online', 'open',
  'opening', 'opportunity', 'our', 'platform', 'position', 'process', 'program', 'programme', 'received', 'receiving', 'recruit',
  'recruiting', 'recruitment', 'review', 'reviewing', 'role', 'sent', 'should', 'specific', 'spring', 'status', 'step', 'steps', 'student',
  'summer', 'system', 'talent', 'team', 'technical', 'test', 'thank', 'thanks', 'their', 'this', 'through', 'to', 'undergraduate', 'update', 'us',
  'using', 'via', 'video', 'virtual', 'was', 'we', 'were', 'will', 'with', 'would', 'you', 'your', 'fall', 'winter', 'fed', 'gm', 'cod',
  'interest', 'each', 'time', 'tak', 'take', 'apply', 'joining', 'member', 'becoming', 'dear']);
const stem = word => {
  if (word.length > 5 && word.endsWith('ing')) return word.endsWith('lling') ? word.slice(0, -4) : word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
};
const roleText = message => {
  const subject = String(message.headers.subject ?? '');
  // Single newlines are wrapping inside one sentence; blank lines still separate paragraphs.
  const body = String(message.body ?? message.snippet ?? '').replace(/\r/g, '').replace(/\n(?![ \t]*\n)/g, ' ');
  const cleanRole = value => String(value)
    .replace(/^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s+)/, '') // "Sioux Falls, SD Finance Intern" → role
    .split(/\s+(?:after|before|although|because|careful|regret|progressing)\b/i)[0].trim();
  const captures = [];
  for (const pattern of ROLE_CAPTURES) {
    pattern.lastIndex = 0;
    for (const match of `${subject}\n${body}`.matchAll(pattern)) {
      const role = cleanRole(match[1]);
      // "applying for a job … grateful for the opportunity" is not a role title; require a job noun in the capture.
      if (!ROLE.test(role)) continue;
      // "interest in DoorDash and for taking the time to apply to the ROLE position" is the apply-to capture, not interest-in.
      if (/\b(?:taking the time|apply to|applying to)\b/i.test(role)) continue;
      captures.push(role);
    }
  }
  // "Thank you for your interest in <role>" has no position/opening noun; keep only captures that name a job noun.
  for (const match of `${subject}\n${body}`.matchAll(/\binterest in\s+(?:the|our|this|a|an)?\s*([^\n.!?]{3,180}?)(?=\s+(?:As|as|and|at|with)\b|[.!?]|$)/gi)) {
    if (ROLE.test(match[1]) && !/\b(?:taking the time|apply to)\b/i.test(match[1])) captures.push(cleanRole(match[1]));
  }
  for (const match of `${subject}\n${body}`.matchAll(/\b(?:for our|our)\s+([^\n.!?]{3,160}?)(?=\s+(?:on|at|with|and)\b|[.!?]|$)/gi)) {
    if (ROLE.test(match[1])) captures.push(cleanRole(match[1]));
  }
  // "apply to the Software Engineer, Intern (Summer 2027) - US position"
  for (const match of `${subject}\n${body}`.matchAll(/\bapply(?:ing)? to\s+(?:the|our|this|a|an)?\s*([^\n.!?]{3,160}?)(?=\s+(?:position|role|opening|opportunity)\b|[.!?]|$)/gi)) {
    if (ROLE.test(match[1])) captures.push(cleanRole(match[1]));
  }
  if (ROLE.test(subject)) captures.push(cleanRole(subject)); // subject-only mails still name their role
  return captures.join(' ');
};
const roleTokens = (text, employerWords) => new Set(words(String(text ?? '')
  .replace(/\bC\+\+\b/gi, 'cplusplus').replace(/\bSWE\b/gi, 'software engineer')
  .replace(/\bSDE\b/gi, 'software developer').replace(/\bSW\b/gi, 'software'))
  .split(' ').map(stem).filter(word => word.length >= 3 && !/\d/.test(word) && !ROLE_NOISE.has(word) && !employerWords.has(word)));
const requisitions = text => new Set([...String(text ?? '').matchAll(/(?<![A-Za-z0-9])(?:[A-Z]{1,3}-?)?\d{6,}(?:-\d+)?[A-Z]*\b/gi)]
  .map(match => match[0].toUpperCase().replace(/[^A-Z0-9]/g, '')));
const statedEmployer = message => {
  const subject = String(message.headers.subject ?? '');
  const body = String(message.body ?? message.snippet ?? '');
  const patterns = [
    /^\s*(.{2,60}?)\s+invites\b/i,
    /\b(?:application|interest|candidacy)\s+(?:to|with|at)\s+([A-Z][\w&.'’-]*(?:\s+(?:[A-Z][\w&.'’-]*|of|and)){0,4})/,
    /\bat\s+([A-Z][\w&.'’-]*(?:\s+(?:[A-Z][\w&.'’-]*|of|and)){0,4})/,
  ];
  for (const pattern of patterns) {
    const found = `${subject}\n${body}`.match(pattern)?.[1]?.replace(/[.,;:]+$/, '').trim();
    if (found) return found;
  }
  return '';
};
export function matchApplication(message, apps) {
  const subject = String(message.headers.subject ?? '');
  const text = roleText(message);
  const requested = requisitions(`${subject}\n${message.body ?? message.snippet ?? ''}`);
  const roleCount = roleTokens(text, new Set()).size;
  let candidates = [];
  for (const app of apps) {
    if (Date.parse(app.t) > message.date + 5 * 60_000) continue;
    const employer = employerScore(message.headers, app.keys, message.body ?? message.snippet ?? '');
    if (employer) candidates.push({ app, employer });
  }
  const appReqs = candidate => requisitions(`${candidate.app.title} ${candidate.app.name} ${candidate.app.job}`);
  if (requested.size && candidates.some(candidate => [...requested].some(req => appReqs(candidate).has(req)))) {
    candidates = candidates.filter(candidate => [...requested].some(req => appReqs(candidate).has(req)));
    if (candidates.length === 1) return candidates[0].app;
  }
  if (!candidates.length && roleCount) {
    // A few tenants abbreviate the employer out of every posting field (Cbrands' "Constellation Brands"). The last
    // distinctive word the message states ("Brands") must occur in the posting's name, title or URL, so a role alone
    // can never attach this employer's mail to another company's application.
    const stated = words(statedEmployer(message)).split(' ').filter(word => word.length >= 5).pop();
    if (stated) {
      candidates = apps.filter(app => Date.parse(app.t) <= message.date + 5 * 60_000
        && compact(`${app.name} ${app.title} ${app.job}`).includes(stated))
        .map(app => ({ app, employer: 0 }));
    }
  }
  if (!candidates.length) return null;
  const scored = candidates.map(candidate => {
    // Drop employer tokens from role coverage. Use the company side of "Company — Role", the leading acronym of a
    // concatenated queue label ("BAE Embedded SW" → bae only), every phrase's first word, and the board slug — not
    // every phrase word, or role words inside the label ("embedded") would erase the title match.
    const name = String(candidate.app.name ?? '');
    const company = /\s+[—–]\s+/.test(name) ? name.split(/\s+[—–]\s+/)[0] : name.trim().split(/\s+/)[0] ?? '';
    const employerWords = new Set(words(company).trim().split(' ').map(stem).filter(Boolean));
    for (const phrase of candidate.app.keys.phrases) {
      const first = stem(phrase.trim().split(/\s+/)[0] ?? '');
      if (first) employerWords.add(first);
    }
    for (const slug of candidate.app.keys.slugs ?? []) {
      if (slug.length >= 3) employerWords.add(stem(slug));
    }
    const nameRole = /\s+[—–]\s+/.test(name) ? name.split(/\s+[—–]\s+/).slice(1).join(' — ') : name;
    const titleTokens = roleTokens(`${candidate.app.title} ${nameRole}`, employerWords);
    const own = roleTokens(text, employerWords);
    const hits = [...own].filter(word => titleTokens.has(word)).length;
    const coverage = own.size ? hits / own.size : 0;
    const score = own.size + titleTokens.size ? (2 * hits) / (own.size + titleTokens.size) : 0;
    return { ...candidate, hits, coverage, score, titleKey: [...titleTokens].sort().join(' ') };
  });
  if (roleCount) {
    const eligible = scored.filter(candidate => candidate.hits && candidate.coverage >= 0.6);
    if (!eligible.length) {
      // A noisy subject (a reminder wrapper around the role) can leave no role agreement. One posting under the
      // employer is still unambiguous; several stay null rather than guessing. Phrase-length bonuses ("bae systems"
      // = 5 vs acronym "bae" = 4) must not hide sibling roles at the same employer — but a score-3 stranger
      // (Persona in a McKinsey body) must not join the sibling set.
      const topEmployer = Math.max(...candidates.map(candidate => candidate.employer));
      const leaders = candidates.filter(candidate => candidate.employer === topEmployer);
      const leaderKeys = new Set(leaders.flatMap(candidate => [
        ...candidate.app.keys.phrases.map(compact),
        ...candidate.app.keys.slugs,
      ]).filter(Boolean));
      const sameEmployer = candidate => {
        const keys = [...candidate.app.keys.phrases.map(compact), ...candidate.app.keys.slugs];
        return keys.some(key => leaderKeys.has(key))
          || leaders.some(leader => leader.app.keys.phrases[0] && candidate.app.keys.phrases[0]
            && (leader.app.keys.phrases[0].startsWith(candidate.app.keys.phrases[0].split(' ')[0])
              || candidate.app.keys.phrases[0].startsWith(leader.app.keys.phrases[0].split(' ')[0])));
      };
      const strong = candidates.filter(candidate =>
        candidate.employer >= topEmployer - 1 && (candidate.employer === topEmployer || sameEmployer(candidate)));
      return strong.length === 1 ? strong[0].app : null;
    }
    // The stated role decides first; the tenant's naming of the employer only breaks a genuine role tie.
    const topCoverage = Math.max(...eligible.map(candidate => candidate.coverage));
    let winners = eligible.filter(candidate => Math.abs(candidate.coverage - topCoverage) < 1e-9);
    if (winners.length > 1) {
      const topEmployer = Math.max(...winners.map(candidate => candidate.employer));
      winners = winners.filter(candidate => candidate.employer === topEmployer);
    }
    if (winners.length > 1) {
      const topScore = Math.max(...winners.map(candidate => candidate.score));
      winners = winners.filter(candidate => Math.abs(candidate.score - topScore) < 1e-9);
    }
    // Prefer the posting whose own domain sent the mail (campusus@imc.com → imc.com) before collapsing ties —
    // otherwise a Greenhouse mirror with the same titleKey wins by array order.
    if (winners.length > 1) {
      const senderDomain = domainOf(addressOf(message.headers.from ?? ''));
      const owned = winners.filter(candidate => candidate.app.keys.domain && candidate.app.keys.domain === senderDomain);
      if (owned.length === 1) return owned[0].app;
      if (owned.length > 1) winners = owned;
    }
    // Same ATS job id on the company site and Greenhouse (imc.com/.../4823924101 vs job-boards.../imc/jobs/4823924101).
    if (winners.length > 1) {
      const ids = winners.map(candidate => (String(candidate.app.job).match(/\/(\d{6,})(?:\/|$)/) || [])[1]).filter(Boolean);
      if (ids.length === winners.length && new Set(ids).size === 1) return winners[0].app;
    }
    // Duplicate queue/manual rows for one posting role are not an ambiguity.
    if (winners.length > 1 && new Set(winners.map(candidate => candidate.titleKey)).size === 1) return winners[0].app;
    return winners.length === 1 ? winners[0].app : null;
  }
  return candidates.length === 1 ? candidates[0].app : null;
}
export { roleText, roleTokens, requisitions };

// The employer a sender speaks for, when the mail matches no posting: an employer the subject names ("Update on Your
// Application with HP IQ" → HP IQ), then its display name without recruiting words, then the sending host's
// distinctive label (blackrock.tal.net → blackrock, mail.amazon.jobs → amazon), then the address. A no-reply/regional
// Greenhouse mailbox has no employer in its host: `us` is never returned as one.
export function senderEmployer(from, subject) {
  const text = String(subject ?? '');
  const named = text.match(/^\s*(?:update on your (?:application|candidacy) with|thank you for your (?:interest in|application to)|thank you for applying to|your application (?:to|with)|your candidacy with|application (?:to|with)|interview invitation from)\s+(.+?)(?:\s*[|]|\s+-\s+|\s*:\s+|\s+application status\s*$|$)/i)?.[1]
    ?.replace(/\s*\(formerly[^)]*\)/i, '').replace(/\s*[,.].*$/, '').trim();
  if (named && !/^application$/i.test(named)) return named;
  // "Your Application with Integra FEC", "DoorDash Application Status", "Message from the Federal Reserve Bank of Dallas:"
  const alt = text.match(/^\s*(?:your application with|message from (?:the )?)(.+?)(?:\s*[|]|\s*:\s*|\s*$)/i)?.[1]?.trim()
    || text.match(/^\s*(.+?)\s+application status\s*$/i)?.[1]?.trim();
  if (alt && !/@/.test(alt) && !PLATFORM_NAMES.has(alt.toLowerCase()) && !/^(your|the|an?)$/i.test(alt)) return alt;
  const display = String(from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '')
    .replace(/\b(university )?(recruiting|recruitment|talent( acquisition)?|careers?|jobs|team|hr|human resources|no-?reply|do not reply|notifications?|via \w+|workday)\b/gi, '')
    .replace(/[|,:\-–]+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (display && !display.includes('@') && !PLATFORM_NAMES.has(display.toLowerCase())) return display;
  const host = (addressOf(from).split('@')[1] ?? '').split('.');
  const generic = /^(mail|email|e|em|us|na|jobs|careers|talent|notifications?|hr|no-?reply|myworkday|workday|greenhouse|greenhouse-mail|smartrecruiters|lever|icims|brassring|trm)$/i;
  return host.slice(0, -1).find(label => !generic.test(label))
    ?? text.match(/^\s*([^|:\-–]{2,40}?)\s+[|:\-–]\s/)?.[1] ?? addressOf(from);
}

