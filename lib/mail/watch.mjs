// lib/mail/watch.mjs — incremental mail outcomes: text genuinely new actionable mail, a daily digest, and a
// knockout detector over fast or bursty rejections. Reads mail state only through the normal sync and writes its own
// state under runs/mail-watch.json, so a watcher run never changes mail matching or to-do semantics.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classify, deadline, ACTION_KINDS } from './classify.mjs';
import { loadPostings } from './postings.mjs';
import { loadMail, runsPath } from './store.mjs';
import { loadConfig } from '../config.mjs';
import { syncMail } from './sync.mjs';
import { withFileLockSync } from '../lockfile.mjs';

const STATE_FILE = 'mail-watch.json';
const DIGEST_FILE = 'mail-digest.txt';
const KNOCKOUT_FILE = 'knockout-flags.tsv';
const POKE_URL = 'https://poke.com/api/v1/inbound-sms/webhook';
const ACTIONABLE = new Set([...ACTION_KINDS]);
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function formatEt(ms) {
  return Number.isFinite(ms) ? ET.format(new Date(ms)) : 'none stated';
}

export function loadWatchState() {
  const path = runsPath(STATE_FILE);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function saveWatchState(state) {
  const path = runsPath(STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(path, () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* not created */ }
      throw error;
    }
  });
}

// Job-board identity is "Company — Role"; the company is the stable part for grouping rejection bursts.
export function identity(event, postings) {
  const posting = event.job ? postings.get(event.job) : null;
  const named = [posting?.name, event.employer].find(value => value && /\s+[—–]\s+/.test(value)) ?? '';
  let employer = '';
  let role = '';
  if (named) {
    const parts = named.split(/\s+[—–]\s+/);
    employer = parts.shift() ?? '';
    role = parts.join(' — ');
  }
  employer = employer || posting?.name?.split(/\s+[—–]\s+/)[0] || event.employer || '';
  role = role || posting?.title || event.subject || 'role not stated';
  if (!employer || /^unknown employer$/i.test(employer)) {
    const title = String(posting?.title ?? event.subject ?? '');
    const at = title.match(/\s+(?:at|@)\s+([^|@]+?)\s*$/i);
    const pipes = title.split('|').map(part => part.trim());
    employer = at?.[1] || (pipes.length >= 3 && pipes.at(-1) === 'Handshake' ? pipes.at(-2) : '') || employer;
  }
  employer = employer || 'Unknown employer';
  role = role.replace(/^Job Application for\s+/i, '').replace(/\s+(?:at|@)\s+[^|]+$/i, '').trim();
  return { employer: employer.replace(/\s+/g, ' ').trim(), role: role.replace(/\s+/g, ' ').trim() };
}

const canonicalJob = value => {
  try { const url = new URL(value); url.hash = ''; url.search = ''; return url.href.replace(/\/$/, ''); }
  catch { return String(value ?? '').replace(/[?#].*$/, '').replace(/\/$/, ''); }
};
const normalizedText = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The audit's hard graduate-only rows. A role in this set is never texted as an action item; the digest names it as
// ignored instead of silently dropping it.
export function loadGradOnly() {
  const path = runsPath('audit-degree-submitted.tsv');
  const urls = new Set();
  const titles = new Set();
  if (!existsSync(path)) return { urls, titles };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    if (String(columns[4]).toLowerCase() !== 'true') continue;
    if (columns[6]) urls.add(canonicalJob(columns[6]));
    if (columns[2]) titles.add(normalizedText(columns[2]));
  }
  return { urls, titles };
}

export function isGradOnly(event, postings, gradOnly) {
  if (event.job && gradOnly.urls.has(canonicalJob(event.job))) return true;
  const posting = event.job ? postings.get(event.job) : null;
  const candidates = [posting?.title, event.subject, identity(event, postings).role]
    .map(value => normalizedText(value?.replace(/^Job Application for\s+/i, '').replace(/\s+at\s+[^|]+$/i, '')))
    .filter(Boolean);
  return candidates.some(title => gradOnly.titles.has(title));
}

export async function sendPoke(message, { fetchImpl = fetch, env = process.env } = {}) {
  const key = String(env.POKE_API_KEY ?? '').trim();
  if (!key) throw new Error('POKE_API_KEY is not set; notification left pending for the next run');
  const response = await fetchImpl(POKE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `[From your coding agent] ${message}` }),
  });
  if (!response.ok) throw new Error(`Poke returned HTTP ${response.status}`);
}

function actionMessage(event, postings, due) {
  const { employer, role } = identity(event, postings);
  return `${event.kind[0].toUpperCase()}${event.kind.slice(1)}: ${employer} — ${role}\nDeadline: ${formatEt(due)}\n${event.subject}`;
}

function dueKey(item) {
  return `due:${item.id}:${item.due}`;
}

function readSummaryRows() {
  const path = runsPath('summary.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function readAnswers() {
  const path = runsPath('../answers.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { facts: {}, qa: {} }; }
}

function tracePath(trace) {
  return trace ? runsPath(trace) : null;
}

// The important answers a trace records. Choice labels and writer text are already in the trace; plain learned
// field fills do not carry a value, so they cannot be compared and are omitted rather than guessed.
export function traceAnswers(trace) {
  const path = tracePath(trace);
  if (!path || !existsSync(path)) return { answers: [], submitAt: null };
  const answers = [];
  let submitAt = null;
  const add = (question, answer, source = '') => {
    question = String(question ?? '').replace(/\s+/g, ' ').trim();
    answer = String(answer ?? '').replace(/\s+/g, ' ').trim();
    if (!question || !answer) return;
    const key = normalizedText(question);
    const existing = answers.find(item => normalizedText(item.question) === key && item.answer === answer);
    if (existing) return;
    answers.push({ question, answer, source });
  };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === 'log') {
      const text = String(event.line ?? '');
      if (/^SUBMITTED\b/.test(text) && event.t) submitAt = event.t;
      const choice = text.match(/^CHOOSE (.*?) = (".*?")(?: ← (.*))?$/);
      if (choice) {
        let answer = choice[2];
        try { answer = JSON.parse(choice[2]); } catch { /* keep the quoted text */ }
        add(choice[1], answer, choice[3] ?? '');
      }
      continue;
    }
    if (event.event === 'writer' && event.answers) {
      for (const entry of Object.values(event.answers)) add(entry?.question, entry?.text, 'writer');
    }
  }
  return { answers, submitAt };
}

const CATEGORIES = [
  ['sponsorship', /\b(sponsor(ship)?|visa (transfer|status)|immigration benefit)\b/i],
  ['work authorization', /\b(work authori[sz]ation|authori[sz]ed to work|authori[sz]ation to work|legally (entitled|eligible)|lawfully authorized|eligible to work|right to work|work permit|visa type)\b/i],
  ['citizenship', /\b(citizenship|citizen|nationality|u\.?s\.? person|export control)\b/i],
  ['clearance', /\b(security clearance|active clearance|clearance eligibility|government clearance)\b/i],
  ['graduation date', /\b(expected graduation|graduation (date|year|month)|graduating (in|between|before|after)|when will you graduate|graduation)\b/i],
  ['class standing', /\b(class (year|standing)|academic classification|enrollment class|education classification|year of study)\b/i],
  ['degree', /\b(degree|education level|highest education)\b/i],
  ['GPA', /\b(gpa|grade point average)\b/i],
  ['relocation', /\b(relocat(e|ion)|commutable|willing to work (on-?site|in (the|our) office)|based in or willing)\b/i],
  ['start date', /\b(start date|earliest.*start|available to start|internship start|when can you start)\b/i],
  ['age 18+', /\b(18|eighteen)\b.*\b(age|older|years)\b|\b(age|older)\b.*\b(18|eighteen)\b/i],
];

function categoryOf(question) {
  return CATEGORIES.find(([, pattern]) => pattern.test(question))?.[0] ?? null;
}

function yesNo(value) {
  const text = String(value ?? '').toLowerCase().replace(/[’']/g, "'");
  if (/\b(no|false|none|never)\b/.test(text) || /\bdo not\b|\bnot (authorized|eligible|willing|able)\b/.test(text)) return false;
  if (/\b(yes|true)\b/.test(text) || /\b(i am|authorized|eligible|willing|have)\b/.test(text)) return true;
  return null;
}

function yearsIn(value) {
  return [...String(value ?? '').matchAll(/\b(20\d{2})\b/g)].map(match => Number(match[1]));
}

function classRank(value) {
  const text = String(value ?? '').toLowerCase();
  if (/\bfreshman\b|first[- ]year/.test(text)) return 1;
  if (/\bsophomore\b|second[- ]year/.test(text)) return 2;
  if (/\bjunior\b|third[- ]year/.test(text)) return 3;
  if (/\bsenior\b|fourth[- ]year/.test(text)) return 4;
  return null;
}

const RANK_NAME = ['', 'Freshman', 'Sophomore', 'Junior', 'Senior'];

function expectedRank(question, submitAt, facts) {
  const when = new Date(submitAt ?? Date.now());
  const match = String(question).match(/\b(Spring|Summer|Fall|Winter)?\s*(20\d{2})\b/i);
  let year = match ? Number(match[2]) : when.getUTCFullYear();
  let month = when.getUTCMonth() + 1;
  if (match?.[1]) {
    const season = match[1].toLowerCase();
    month = season === 'spring' ? 5 : season === 'summer' ? 7 : season === 'fall' ? 10 : 1;
  } else if (!match) {
    month = when.getUTCMonth() + 1;
  }
  if (!match && /next academic year/i.test(question)) year += 1;
  const academicStart = month >= 8 ? year : year - 1;
  const collegeStart = yearsIn(facts.college_start)[0];
  if (!collegeStart) return null;
  const rank = academicStart - collegeStart + 1;
  return Math.max(1, Math.min(4, rank));
}

function gpaRange(value) {
  const text = String(value ?? '').toLowerCase();
  const numbers = [...text.matchAll(/\b([0-4](?:\.\d{1,2})?)\b/g)].map(match => Number(match[1])).filter(number => number <= 4);
  if (!numbers.length) return null;
  if (/above|or higher|\+/.test(text) && numbers.length === 1) return [numbers[0], 4];
  if (numbers.length >= 2) return [Math.min(...numbers), Math.max(...numbers)];
  return [numbers[0], numbers[0]];
}

// Null means compatible (or not enough evidence); a string is the expected value to put in the alert/TSV.
export function contradictionOf(question, answer, facts, submitAt) {
  const category = categoryOf(question);
  if (!category) return null;
  const text = String(answer ?? '').toLowerCase().replace(/[’']/g, "'");
  const expected = {
    'work authorization': `Yes (${facts.work_authorization ?? 'authorized'})`,
    sponsorship: `No (${facts.sponsorship ?? 'no sponsorship needed'})`,
    citizenship: `U.S. citizen (${facts.us_citizen ?? 'Yes'})`,
    clearance: `None (${facts.security_clearance ?? 'no clearance'})`,
    'graduation date': String(facts.graduation ?? 'May 2029'),
    'class standing': RANK_NAME[expectedRank(question, submitAt, facts)] ?? '',
    degree: String(facts.degree ?? 'Bachelor of Arts'),
    GPA: String(facts.gpa ?? '3.02'),
    relocation: `Yes (${facts.willing_to_relocate ?? 'willing'})`,
    'start date': String(facts.internship_start ?? 'June 2027'),
    'age 18+': 'Yes (at least 18)',
  }[category];
  if (category === 'work authorization') {
    if (/\b(visa type|basis for employment)\b/i.test(question) && /\bn\/a\b/i.test(text)) return null;
    if (yesNo(answer) === false && !/\b(swiss|canada|canadian|uk|europe|eu)\b/i.test(question)) return expected;
    return null;
  }
  if (category === 'sponsorship') {
    if (yesNo(answer) === true && !/\bno\b/.test(text)) return expected;
    return null;
  }
  if (category === 'citizenship') {
    if (/\b(more than one|dual citizenship|other country|additional citizenship)\b/i.test(question)) return null;
    if (/\b(u\.?s\.?|united states|american)\b/.test(text) && /\bcitizen|national\b/.test(text)) return null;
    if (/\b(no|other|non[- ]?citizen|not a citizen|permanent resident)\b/.test(text)) return expected;
    return null;
  }
  if (category === 'clearance') {
    if (yesNo(answer) === true && !/\b(no|never|none)\b/.test(text)) return expected;
    return null;
  }
  if (category === 'graduation date') {
    const years = yearsIn(answer);
    if (/\bother\b/.test(text)) return expected;
    if (years.length && !years.includes(2029)) return expected;
    return null;
  }
  if (category === 'class standing') {
    const rank = classRank(answer);
    const expectedClass = expectedRank(question, submitAt, facts);
    if (rank && expectedClass && rank !== expectedClass) return expected;
    return null;
  }
  if (category === 'degree') {
    if (/\b(master|mba|ph\.?d|doctor|associate)\b/.test(text)) return expected;
    if (/\bother\b/.test(text)) return expected;
    return null;
  }
  if (category === 'GPA') {
    const range = gpaRange(answer);
    if (!range) return null;
    if (range[0] > 3.07 || range[1] < 2.97) return expected;
    return null;
  }
  if (category === 'relocation') {
    if (/\b(willing|open) to relocat/i.test(text)) return null;
    if (yesNo(answer) === false && /\brelocat|\bbased in or willing\b/i.test(question)) return expected;
    return null;
  }
  if (category === 'start date') {
    if (/\bother\b/.test(text)) return expected;
    const years = yearsIn(answer);
    if (years.length && !years.includes(2027)) return expected;
    return null;
  }
  if (category === 'age 18+') {
    if (yesNo(answer) === false) return expected;
  }
  return null;
}

const jobKey = value => canonicalJob(value);
const employerKey = value => normalizedText(value);

function submissionRows(rows) {
  const byJob = new Map();
  for (const row of rows) {
    if (row.outcome !== 'submitted' || !row.job) continue;
    const key = jobKey(row.job);
    const list = byJob.get(key) ?? [];
    list.push(row);
    byJob.set(key, list);
  }
  for (const list of byJob.values()) list.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return byJob;
}

const submissionKey = row => row.trace ? `trace:${row.trace}` : `${jobKey(row.job)}:${row.t}`;

function submissionFor(rejection, byJob, submissions, postings, used = new Set()) {
  const exact = rejection.job ? (byJob.get(jobKey(rejection.job)) ?? []).filter(row => !used.has(submissionKey(row))) : [];
  const exactBefore = exact.filter(row => Date.parse(row.t) <= rejection.date);
  const exactRow = exactBefore.at(-1) ?? exact[0] ?? null;
  const employer = identity(rejection, postings).employer;
  const employerKeyValue = employerKey(employer);
  const candidates = submissions.filter(row => {
    if (!row.job || used.has(submissionKey(row)) || Date.parse(row.t) > rejection.date) return false;
    const posting = postings.get(row.job);
    return employerKey(identity({ job: row.job, employer: posting?.name, subject: posting?.title }, postings).employer) === employerKeyValue;
  });
  const recent = candidates.at(-1) ?? null;
  // A posting can be re-used in mail matching (K2's two Greenhouse roles both resolved to the older posting). Prefer
  // an exact posting inside the fast window; otherwise the most recent unassigned application at the employer is the
  // one the rejection can answer. Each application counts its first rejection only.
  if (exactRow && rejection.date - Date.parse(exactRow.t) < 6 * 3_600_000) return exactRow;
  if (recent && rejection.date - Date.parse(recent.t) < 6 * 3_600_000) return recent;
  return exactRow ?? recent;
}

function inspectApplication(rejection, row, facts) {
  const trace = row?.trace ?? null;
  const parsed = trace ? traceAnswers(trace) : { answers: [], submitAt: null };
  const contradictions = [];
  for (const answer of parsed.answers) {
    const expected = contradictionOf(answer.question, answer.answer, facts, parsed.submitAt ?? row?.t ?? rejection.date);
    if (expected) contradictions.push({ ...answer, expected, category: categoryOf(answer.question) });
  }
  return {
    job: row?.job ?? rejection.job,
    title: row?.title ?? '',
    trace,
    submitAt: parsed.submitAt ?? row?.t ?? null,
    rejectionAt: new Date(rejection.date).toISOString(),
    hours: parsed.submitAt || row?.t ? Math.round(((rejection.date - Date.parse(parsed.submitAt ?? row.t)) / 3_600_000) * 10) / 10 : null,
    answers: parsed.answers,
    contradictions,
  };
}

// Flags:
// - fast: a rejection less than six hours after that application's submit timestamp.
// - burst: at least three rejections from one employer inside any rolling hour. Overlapping windows merge.
// `seedAll` is the first run, where the existing backlog is inspected and logged but not urgently texted.
export function detectKnockouts({ events, rows, facts, postings, newIds = new Set(), seedAll = false }) {
  const byJob = submissionRows(rows);
  const submissions = [...byJob.values()].flat().sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const rejected = events.filter(event => event.kind === 'rejected');
  const relevant = event => seedAll || newIds.has(event.id);
  const assignments = new Map();
  const used = new Set();
  for (const event of [...rejected].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id))) {
    const row = submissionFor(event, byJob, submissions, postings, used);
    assignments.set(event.id, row);
    if (row) used.add(submissionKey(row));
  }
  const flags = [];
  for (const event of rejected) {
    if (!relevant(event)) continue;
    const app = inspectApplication(event, assignments.get(event.id), facts);
    if (app.hours != null && app.hours < 6) {
      const { employer, role } = identity(event, postings);
      flags.push({
        id: `fast:${event.id}`, kind: 'fast', employer, role,
        detectedAt: new Date().toISOString(), triggerAt: event.date,
        applications: [app],
      });
    }
  }
  const byEmployer = new Map();
  for (const event of rejected) {
    const { employer } = identity(event, postings);
    const key = employerKey(employer);
    // A generic sender ("us", "Unknown employer") is not an employer, so it cannot establish a burst.
    if (!key || key.length < 3 || /^unknown employer$/i.test(key)) continue;
    byEmployer.set(key, [...(byEmployer.get(key) ?? []), event]);
  }
  for (const [key, list] of byEmployer) {
    list.sort((a, b) => a.date - b.date);
    const windows = [];
    for (let start = 0; start < list.length; start++) {
      let end = start;
      while (end + 1 < list.length && list[end + 1].date - list[start].date <= 3_600_000) end++;
      if (end - start + 1 >= 3) windows.push([start, end]);
    }
    // Merge windows that share any event, so six rejections at one minute do not produce four flags.
    const groups = [];
    for (const window of windows) {
      const current = groups.at(-1);
      if (current && window[0] <= current[1]) current[1] = Math.max(current[1], window[1]);
      else groups.push([...window]);
    }
    for (const [start, end] of groups) {
      const members = list.slice(start, end + 1);
      if (!members.some(relevant)) continue;
      const first = members[0];
      const { employer, role } = identity(first, postings);
      flags.push({
        id: `burst:${key}:${first.id}`, kind: 'burst', employer, role,
        detectedAt: new Date().toISOString(), triggerAt: first.date,
        applications: [...new Map(members.map(event => {
          const app = inspectApplication(event, assignments.get(event.id), facts);
          return [`${app.job}:${app.trace}:${app.submitAt}`, app];
        })).values()],
      });
    }
  }
  return flags.sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id));
}

function kotLine(flag, app) {
  if (!app) return [[new Date().toISOString(), flag.kind, flag.employer, flag.id, '', '', '', '', 'no matched application trace', '', '', '']];
  const { employer } = flag;
  if (!app.contradictions.length) {
    return [[new Date().toISOString(), flag.kind, employer, flag.id, app.job ?? '', app.trace ?? '', app.submitAt ?? '', app.rejectionAt ?? '',
      'no knockout contradiction in traced answers', '', '', '']];
  }
  return app.contradictions.map(item => [
    new Date().toISOString(), flag.kind, employer, flag.id, app.job ?? '', app.trace ?? '', app.submitAt ?? '', app.rejectionAt ?? '',
    item.category ?? '', item.question, item.answer, item.expected,
  ]);
}

function appendKnockoutRows(flags, now) {
  const path = runsPath(KNOCKOUT_FILE);
  const header = ['detected_at', 'kind', 'employer', 'flag_id', 'job', 'trace', 'submitted_at', 'rejected_at', 'category', 'question', 'answer', 'expected'].join('\t');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const rows = [];
  for (const flag of flags) {
    for (const app of flag.applications.length ? flag.applications : [null]) {
      for (const row of kotLine(flag, app)) {
        row[0] = new Date(now).toISOString();
        rows.push(row.map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t'));
      }
    }
  }
  appendFileSync(path, `${!existing ? `${header}\n` : ''}${rows.join('\n')}${rows.length ? '\n' : ''}`);
}

function urgentMessages(flags) {
  const messages = [];
  for (const flag of flags) {
    for (const app of flag.applications) {
      for (const item of app.contradictions ?? []) {
        messages.push({ key: `kot:${flag.id}:${normalizedText(item.question)}:${normalizedText(item.answer)}`, message: `KNOCKOUT? ${flag.employer} ${item.question} = ${item.answer}` });
      }
    }
  }
  return messages;
}

function openAssessments(mail) {
  return (mail.items ?? []).filter(item => item.state === 'open' && item.kind === 'assessment');
}

export function buildDigest({ mail, rows, state, now = Date.now(), gradOnly = loadGradOnly(), postings = loadPostings() }) {
  const since = now - 86_400_000;
  const recent = (mail.events ?? []).filter(event => event.date >= since && event.date <= now);
  const submitted = new Set();
  for (const row of rows) {
    if (row.outcome === 'submitted' && row.job && Date.parse(row.t) >= since && Date.parse(row.t) <= now) submitted.add(jobKey(row.job));
  }
  const rejections = recent.filter(event => event.kind === 'rejected');
  const interviews = recent.filter(event => event.kind === 'interview');
  const offers = recent.filter(event => event.kind === 'offer');
  const assessments = openAssessments(mail);
  const dated = assessments.filter(item => Number.isFinite(item.due));
  const dueSoon = assessments.filter(item => Number.isFinite(item.due) && item.due >= now && item.due <= now + 2 * 86_400_000);
  const gradIgnored = recent.filter(event => ACTIONABLE.has(event.kind) && isGradOnly(event, postings, gradOnly));
  const flags = Object.values(state?.knockouts ?? {}).filter(flag => Date.parse(flag.detectedAt) >= since);
  const lines = [
    `Daily job-mail digest (${formatEt(now)})`,
    `New submits: ${submitted.size}`,
    `Rejections: ${rejections.length}`,
    `Assessments open: ${assessments.length} (${dated.length} with deadlines)`,
    `Interviews: ${interviews.length}`,
    `Offers: ${offers.length}`,
    `Knockout flags: ${flags.length}`,
  ];
  if (rejections.length) {
    lines.push('Rejected:');
    for (const event of rejections.slice(-10)) {
      const { employer, role } = identity(event, postings);
      lines.push(`- ${employer} — ${role}`);
    }
    if (rejections.length > 10) lines.push(`- … and ${rejections.length - 10} more`);
  }
  if (gradIgnored.length) {
    lines.push('Grad-only (ignore):');
    for (const event of gradIgnored.slice(0, 10)) {
      const { employer, role } = identity(event, postings);
      lines.push(`- ${employer} — ${role} (ignore (grad-only))`);
    }
  }
  if (dueSoon.length) {
    lines.push('Assessments due within 48h:');
    for (const item of dueSoon.slice(0, 8)) lines.push(`- ${item.employer} — ${formatEt(item.due)}`);
  }
  if (flags.length) {
    lines.push('Knockout flags:');
    for (const flag of flags.slice(-5)) {
      const app = flag.applications?.find(item => item.contradictions?.length);
      if (app) lines.push(`- KNOCKOUT? ${flag.employer} ${app.contradictions[0].question} = ${app.contradictions[0].answer}`);
      else lines.push(`- ${flag.kind} flag: ${flag.employer}`);
    }
  }
  return lines.join('\n');
}

function freshState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seededAt: null,
    seen: {},
    alerts: {},
    pending: {},
    digestDay: null,
    knockouts: {},
    urgentSent: {},
  };
}

export async function watchOnce({ now = Date.now(), shouldSync = true, send = sendPoke, quiet = false } = {}) {
  const config = loadConfig();
  if (!config.email.enabled) throw new Error('email.enabled is false in config.json; mail watch needs read-only inbox access.');
  if (shouldSync) await syncMail({ quiet: true });
  const mail = loadMail();
  if (!mail?.events) throw new Error('No indexed mail; run `bun mail.mjs` once.');
  const previous = loadWatchState();
  const state = previous ?? freshState();
  const initial = !state.seededAt;
  const gradOnly = loadGradOnly();
  const postings = loadPostings({ exclude: [config.applicant.displayName] });
  const rows = readSummaryRows();
  const answers = readAnswers();
  const facts = answers.facts ?? {};
  const newIds = new Set((mail.events ?? []).filter(event => !state.seen[event.id]).map(event => event.id));
  if (initial) for (const event of mail.events ?? []) newIds.add(event.id);
  const itemById = new Map((mail.items ?? []).map(item => [item.id, item]));
  let sent = 0;
  let failed = 0;

  const notify = async (event, due, kindLabel = '') => {
    try {
      await send(actionMessage(event, postings, due));
      sent++;
      state.seen[event.id] = { ...(state.seen[event.id] ?? {}), status: 'alerted', kind: event.kind, date: event.date };
      delete state.pending[event.id];
      if (event.kind === 'assessment' && Number.isFinite(due)) state.alerts[`due:${event.id}:${due}`] = new Date(now).toISOString();
      if (!quiet) console.log(`texted ${kindLabel}${identity(event, postings).employer} — ${event.kind}`);
    } catch (error) {
      failed++;
      state.pending[event.id] = { reason: error.message, at: new Date(now).toISOString() };
      if (!quiet) console.error(`notification pending for ${identity(event, postings).employer}: ${error.message}`);
    }
  };

  // Existing actionable items are texted only when they are genuinely new. A first run seeds the backlog and
  // suppresses those texts, except assessments whose stated deadline is inside 48 hours.
  for (const event of mail.events ?? []) {
    if (!newIds.has(event.id)) continue;
    if (!ACTIONABLE.has(event.kind)) {
      state.seen[event.id] = { status: event.kind === 'rejected' ? 'digest' : 'seen', kind: event.kind, date: event.date };
      continue;
    }
    if (isGradOnly(event, postings, gradOnly)) {
      state.seen[event.id] = { status: 'grad-only', kind: event.kind, date: event.date };
      continue;
    }
    if (initial) {
      state.seen[event.id] = { status: 'seeded', kind: event.kind, date: event.date };
      continue;
    }
    const item = itemById.get(event.id);
    const due = item?.due ?? deadline(mail.bodies?.[event.id], event.date);
    await notify(event, due, '');
  }
  // Retry actionable notifications that failed on a previous run.
  for (const [id, pending] of Object.entries(state.pending ?? {})) {
    const event = (mail.events ?? []).find(candidate => candidate.id === id);
    if (!event || !pending || Date.parse(pending.at) >= now || state.seen[id]?.status === 'alerted') { delete state.pending[id]; continue; }
    const item = itemById.get(id);
    await notify(event, item?.due ?? deadline(mail.bodies?.[id], event.date), '');
  }
  // Due-soon assessments: the one first-run exception, then a single reminder per deadline. Open items can be older
  // than the current event set, so they are selected from mail.items rather than from new events.
  for (const item of openAssessments(mail)) {
    if (!Number.isFinite(item.due) || item.due < now || item.due > now + 2 * 86_400_000) continue;
    const key = dueKey(item);
    if (state.alerts[key]) continue;
    if (state.seen[item.id]?.status === 'alerted') { state.alerts[key] = new Date(now).toISOString(); continue; }
    const event = (mail.events ?? []).find(candidate => candidate.id === item.id)
      ?? { id: item.id, kind: 'assessment', employer: item.employer, job: item.job, subject: item.subject, date: item.date };
    try {
      await send(`Assessment due in <48h: ${identity(event, postings).employer} — ${identity(event, postings).role}\nDeadline: ${formatEt(item.due)}\n${event.subject}`);
      sent++;
      state.alerts[key] = new Date(now).toISOString();
      state.seen[item.id] = { ...(state.seen[item.id] ?? {}), status: 'alerted', kind: 'assessment', date: item.date };
      if (!quiet) console.log(`texted due-soon ${identity(event, postings).employer}`);
    } catch (error) {
      failed++;
      state.pending[item.id] = { reason: error.message, at: new Date(now).toISOString() };
      if (!quiet) console.error(`due-soon notification pending for ${identity(event, postings).employer}: ${error.message}`);
    }
  }

  // Knockout flags: inspect all rejections for context, but only emit flags touched by a new rejection (or the seed).
  const newFlags = detectKnockouts({ events: mail.events ?? [], rows, facts, postings, newIds, seedAll: initial })
    .filter(flag => !state.knockouts[flag.id]);
  if (newFlags.length) {
    appendKnockoutRows(newFlags, now);
    for (const flag of newFlags) {
      state.knockouts[flag.id] = {
        id: flag.id, kind: flag.kind, employer: flag.employer, role: flag.role,
        detectedAt: new Date(now).toISOString(), triggerAt: flag.triggerAt,
        applications: flag.applications.map(app => ({
          job: app.job, title: app.title, trace: app.trace, submitAt: app.submitAt, rejectionAt: app.rejectionAt, hours: app.hours,
          contradictions: app.contradictions.map(item => ({ question: item.question, answer: item.answer, expected: item.expected, category: item.category })),
        })),
      };
      if (initial) for (const payload of urgentMessages([flag])) state.urgentSent[payload.key] = new Date(now).toISOString();
    }
  }
  const urgent = newFlags.flatMap(flag => urgentMessages([flag]))
    .filter(payload => !state.urgentSent[payload.key]);
  for (const payload of urgent) {
    try {
      await send(payload.message);
      sent++;
      state.urgentSent[payload.key] = new Date(now).toISOString();
      if (!quiet) console.log(`texted urgent knockout: ${payload.message.split(' = ')[0]}`);
    } catch (error) {
      failed++;
      if (!quiet) console.error(`urgent knockout pending: ${error.message}`);
    }
  }
  // Retry any urgent contradiction whose previous send failed.
  for (const flag of Object.values(state.knockouts ?? {})) {
    if (initial && !state.seededAt) continue;
    for (const payload of urgentMessages([flag])) {
      if (state.urgentSent[payload.key]) continue;
      try {
        await send(payload.message);
        sent++;
        state.urgentSent[payload.key] = new Date(now).toISOString();
        if (!quiet) console.log(`texted urgent knockout: ${payload.message.split(' = ')[0]}`);
      } catch (error) {
        failed++;
        if (!quiet) console.error(`urgent knockout pending: ${error.message}`);
      }
    }
  }

  // Daily digest at 13:00Z, once per UTC day. The seeding day stays silent; the digest is reviewable in
  // runs/mail-digest.txt and via buildDigest even when it was not sent.
  const day = new Date(now).toISOString().slice(0, 10);
  const digestText = buildDigest({ mail, rows, state, now, gradOnly, postings });
  writeFileSync(runsPath(DIGEST_FILE), `${digestText}\n`, { mode: 0o600 });
  if (initial) state.digestDay = day;
  if (!initial && state.seededAt && state.digestDay !== day && new Date(now).getUTCHours() >= 13) {
    try {
      await send(digestText);
      sent++;
      state.digestDay = day;
      if (!quiet) console.log('texted daily digest');
    } catch (error) {
      failed++;
      if (!quiet) console.error(`daily digest pending: ${error.message}`);
    }
  }

  state.seededAt ||= new Date(now).toISOString();
  state.updatedAt = new Date(now).toISOString();
  saveWatchState(state);
  if (!quiet) {
    console.log(`mail watch: ${newIds.size} new event(s), ${sent} text(s), ${failed} pending, ${newFlags.length} new flag(s), seeded=${initial}`);
  }
  return { newEvents: newIds.size, sent, failed, flags: newFlags.length, seeded: initial, digest: digestText, state };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function watch({ once = false, intervalMs = 900_000, ...options } = {}) {
  for (;;) {
    try {
      await watchOnce(options);
    } catch (error) {
      console.error(`mail watch failed: ${error.message}`);
      if (once) throw error;
    }
    if (once) return;
    await sleep(intervalMs);
  }
}
