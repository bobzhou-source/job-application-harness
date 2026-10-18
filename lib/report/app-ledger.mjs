// Application ledger + insights. One JSONL row per unique submitted job joining posting metadata,
// submit telemetry, documents/essays, controlled answer keys, same-company context, and mail outcomes.
// `--ledger` writes runs/ledger.jsonl; `--insights` reads that file (or rebuilds) and prints rates by dimension.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadMail } from '../mail/store.mjs';
import { loadPostings } from '../mail/postings.mjs';
import { identity } from '../mail/watch.mjs';
import { loadConfig } from '../config.mjs';
import { collectApplications, jobKey } from './applications.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = `${ROOT}runs/`;
const LEDGER = `${RUNS}ledger.jsonl`;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ET = 'America/New_York';

const CONTROLLED = [
  ['salary', /\b(?:pay_expectation|salary|compensation|wage|hourly|annual pay|desired (?:pay|salary)|pay expectation)\b/i],
  ['relocation', /\b(?:willing_to_relocate|relocat|commutable|willing to (?:relocate|work on[- ]?site))\b/i],
  ['sponsorship', /\b(?:sponsorship|sponsor|visa|immigration|h-?1b|work permit)\b/i],
  ['start_date', /\b(?:internship_start|start.?date|available to start|earliest.*start|proposed start)\b/i],
  ['work_authorization', /\b(?:work_authorization|work authori[sz]ation|authorized to work|legally (?:entitled|eligible)|eligible to work|right to work)\b/i],
  ['citizenship', /\b(?:us_citizen|citizenship|citizen|nationality|u\.?s\.? person)\b/i],
];

const pct = value => `${(100 * value).toFixed(1)}%`;
const hours = value => value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
const days = value => value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
const nonempty = value => value != null && value !== '' && value !== '?' && !(Array.isArray(value) && !value.length);

function modelCalls(row) {
  const models = row.models ?? {};
  return Object.values(models).reduce((sum, model) => sum + (model?.calls ?? 0), 0);
}

function etParts(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return { weekday: null, hour: null };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? null;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  return { weekday, hour: Number.isFinite(hour) ? hour : null };
}

function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function cleanQuestion(question) {
  // Writer traces sometimes prepend Workday/ATS chrome ("Back to Job Posting … Application Questions 1").
  let text = String(question ?? '').replace(/\s+/g, ' ').trim();
  // Prefer the last interrogative / imperative prompt in the blob.
  const prompts = text.match(/(?:(?:why|what|how|where|when|tell|describe|please|share|explain)\b[^?]*\??)/gi);
  if (prompts?.length) {
    const last = prompts[prompts.length - 1].trim();
    if (last.length >= 12) text = last;
  }
  text = text.replace(/^.*?application questions?\s*(?:\d+\s*(?:of\s*\d+\s*)?)*/ig, '');
  text = text.replace(/\b(?:voluntary disclosures?|self identify|review|indicates a required field|my information|my experience|back to (?:job )?posting)\b/ig, ' ');
  return text.replace(/^\d+\s*[.)]\s*/, '').replace(/\s+/g, ' ').trim()
    || String(question ?? '').replace(/\s+/g, ' ').trim();
}

function essayType(question) {
  const text = String(question ?? '').toLowerCase();
  if (/\bwhy\b.*\b(?:us|company|role|position|intern|work for)|interested in (?:this|the|our)\b/.test(text)) return 'why_us';
  if (/\b(?:tell us about|about yourself|background|introduce)\b/.test(text)) return 'about_you';
  if (/\b(?:strength|weakness|skills? you|looking to gain|experience|occupational goals?)\b/.test(text)) return 'skills';
  if (/\b(?:how did you (?:find|hear)|please tell us more about how you heard|referr)/.test(text)) return 'source';
  if (/\b(?:cover letter|motivation)\b/.test(text)) return 'cover';
  return 'other';
}

function controlledClass(key, label = '') {
  const text = `${key} ${label}`;
  for (const [name, pattern] of CONTROLLED) if (pattern.test(text)) return name;
  return null;
}

function valueClass(key, klass) {
  if (klass === 'salary') return 'pay_range';
  if (klass === 'start_date') return 'date';
  if (klass === 'relocation' || klass === 'sponsorship' || klass === 'work_authorization' || klass === 'citizenship') {
    return 'yes_no_or_fact';
  }
  if (String(key).startsWith('facts.')) return 'fact_key';
  return 'controlled_key';
}

function isEssayQuestion(question, words) {
  // Writer events also fill short controlled/fact fields; keep open-response essays only.
  if (words < 20) return false;
  if (controlledClass(question, question)) return false;
  if (/\b(?:notice period|phone|email|linkedin|github|gpa|degree|university|school|major)\b/i.test(question) && words < 40) {
    return false;
  }
  // Reject leftover ATS chrome that never resolved to a real prompt.
  if (/\b(?:voluntary disclosures?|self identify|indicates a required field)\b/i.test(question)) return false;
  if (question.length < 12) return false;
  return true;
}

function readTrace(trace) {
  const path = `${RUNS}${trace}`;
  if (!trace || !existsSync(path)) return { essays: [], grades: [], controlled: [], coverLetter: false, submitAt: null };
  const essays = new Map();
  const grades = new Map();
  const controlled = new Map();
  let coverLetter = false;
  let submitAt = null;
  // Only parse ledger-relevant events; skip the bulk of action/log noise.
  // indexOf beats a RegExp test across multi‑MB traces.
  const keep = line =>
    line.includes('"event":"writer"')
    || line.includes('"event":"grades"')
    || line.includes('"event":"filled"')
    || line.includes('"event":"plan"')
    || line.includes('"event":"upload-result"')
    || line.includes('"event":"log"');
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!keep(line)) continue;
    if (line.includes('"event":"log"') && !line.includes('SUBMITTED')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === 'log') {
      if (/^SUBMITTED\b/.test(event.line ?? '') && event.t) submitAt = event.t;
      continue;
    }
    if (event.event === 'writer') {
      for (const answer of Object.values(event.answers ?? {})) {
        const question = cleanQuestion(answer.question);
        if (!question) continue;
        const words = wordCount(answer.text);
        if (!isEssayQuestion(question, words)) continue;
        essays.set(question, { question, type: essayType(question), words });
      }
      continue;
    }
    if (event.event === 'grades') {
      for (const item of event.items ?? []) {
        const question = cleanQuestion(item.question);
        if (!question) continue;
        const words = wordCount(item.answer);
        grades.set(question, { grade: item.grade ?? null, revised: Boolean(item.revised) });
        if (!essays.has(question) && item.answer && isEssayQuestion(question, words)) {
          essays.set(question, { question, type: essayType(question), words });
        }
      }
      continue;
    }
    if (event.event === 'filled' || event.event === 'plan') {
      const fields = event.fields ?? event.plan?.fields ?? [];
      for (const field of fields) {
        const key = String(field.key ?? '').trim();
        const label = String(field.label ?? '').trim();
        const klass = controlledClass(key, label);
        if (!klass || !key) continue;
        controlled.set(key, { key, class: klass, valueClass: valueClass(key, klass) });
      }
      continue;
    }
    if (event.event === 'upload-result') {
      const blob = line.toLowerCase();
      if (blob.includes('cover') && blob.includes('letter')) coverLetter = true;
    }
  }
  const essayList = [...essays.values()].map(essay => ({
    ...essay,
    grade: grades.get(essay.question)?.grade ?? null,
    revised: grades.get(essay.question)?.revised ?? false,
  }));
  return {
    essays: essayList,
    grades: essayList.filter(essay => essay.grade).map(essay => ({ question: essay.question, grade: essay.grade, revised: essay.revised })),
    controlled: [...controlled.values()],
    coverLetter,
    submitAt,
  };
}

function documentsOf(row, traceInfo) {
  const files = [...(row.submittedWith ?? []), ...(row.uploaded ?? [])];
  const coverFromFiles = files.some(file => /cover/i.test(String(file)));
  const resume = row.resume || files.find(file => /resume|cv/i.test(String(file))) || '';
  return {
    resume: resume || null,
    coverLetter: coverFromFiles || traceInfo.coverLetter,
    transcript: row.transcript || files.find(file => /transcript/i.test(String(file))) || null,
    essayCount: traceInfo.essays.length,
    essays: traceInfo.essays.map(({ question, type, words, grade, revised }) => ({ type, words, grade, revised, question: question.slice(0, 120) })),
    grades: traceInfo.grades,
  };
}

function outcomeHours(submittedAt, events) {
  const first = {};
  for (const kind of ['confirmed', 'assessment', 'interview', 'rejected']) {
    const hit = events.find(event => event.kind === kind && event.date >= submittedAt);
    first[kind] = hit ? hours((hit.date - submittedAt) / HOUR) : null;
  }
  const anyReply = ['confirmed', 'assessment', 'interview', 'rejected', 'incomplete', 'completed', 'update']
    .some(kind => events.some(event => event.kind === kind && event.date >= submittedAt));
  const silentDays = anyReply ? null : days((Date.now() - submittedAt) / DAY);
  return {
    confirmation: first.confirmed,
    assessment: first.assessment,
    interview: first.interview,
    rejection: first.rejected,
    silent: silentDays,
    replied: anyReply,
  };
}

function mailByJob(mail, postings) {
  const byJob = new Map();
  const byEmployer = new Map();
  for (const event of mail?.events ?? []) {
    if (event.job) {
      const key = jobKey(event.job);
      const list = byJob.get(key) ?? [];
      list.push(event);
      byJob.set(key, list);
    }
    const employer = String(identity(event, postings).employer ?? event.employer ?? '').toLowerCase();
    if (employer) {
      const list = byEmployer.get(employer) ?? [];
      list.push(event);
      byEmployer.set(employer, list);
    }
  }
  for (const list of byJob.values()) list.sort((a, b) => a.date - b.date);
  for (const list of byEmployer.values()) list.sort((a, b) => a.date - b.date);
  return { byJob, byEmployer };
}

function companyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildLedger(selectedRows, allRows, { mail = loadMail(), write = true } = {}) {
  const config = loadConfig();
  const postings = loadPostings({ exclude: [config.applicant.displayName] });
  const { rows: apps } = collectApplications(selectedRows, allRows);
  const mailIndex = mailByJob(mail, postings);
  const ledger = [];

  for (const app of apps) {
    const row = app.summary;
    const related = app.related ?? [];
    const traceInfo = readTrace(row.trace);
    const submitIso = traceInfo.submitAt ?? row.t;
    const submittedAt = Date.parse(submitIso);
    const et = etParts(submitIso);
    const attemptsBefore = related.filter(item => item.outcome !== 'submitted' && Date.parse(item.t) < submittedAt).length;
    const docs = documentsOf(row, traceInfo);
    const jobEvents = mailIndex.byJob.get(app.jobKey) ?? [];
    const employerEvents = jobEvents.length ? jobEvents
      : (mailIndex.byEmployer.get(companyKey(app.company)) ?? []).filter(event => event.date >= submittedAt - DAY);
    const outcome = Number.isFinite(submittedAt) ? outcomeHours(submittedAt, employerEvents.length ? employerEvents : jobEvents) : {
      confirmation: null, assessment: null, interview: null, rejection: null, silent: null, replied: false,
    };

    ledger.push({
      job: app.url,
      jobKey: app.jobKey,
      posting: {
        company: app.company,
        title: app.title,
        ats: app.ats,
        tenant: app.tenant,
        lane: app.lane,
        city: app.city || null,
        state: app.state || null,
        country: app.country || null,
        remote: Boolean(app.remote),
        pay_hr: app.pay_hr === '' ? null : Number(app.pay_hr),
        sourceBoard: app.sourceBoard || null,
        sourcePack: app.sourcePack || null,
        postedAt: app.postedAt || null,
        postingAgeDays: (() => {
          if (!app.postedAt || !Number.isFinite(submittedAt)) return null;
          const postedAt = Date.parse(app.postedAt);
          return Number.isFinite(postedAt) ? days((submittedAt - postedAt) / DAY) : null;
        })(),
        // Discover currently drops postedOn before queue write; stays false until that is recorded.
        postedAtRecorded: Boolean(app.postedAt),
      },
      submit: {
        t: submitIso,
        weekdayEt: et.weekday,
        hourEt: et.hour,
        secs: row.secs ?? null,
        cost: row.cost ?? null,
        modelCalls: modelCalls(row),
        attemptsBefore,
        code: row.code ?? null,
        trace: row.trace ?? null,
        host: app.host,
      },
      documents: docs,
      controlledAnswers: traceInfo.controlled,
      sameCompany: { nth: 0, total: 0, daysSincePrev: null, sameDay: 0 },
      outcome,
    });
  }

  // Same-company context after chronological sort.
  const byCompany = new Map();
  for (const item of [...ledger].sort((a, b) => String(a.submit.t).localeCompare(String(b.submit.t)))) {
    const key = companyKey(item.posting.company);
    const list = byCompany.get(key) ?? [];
    list.push(item);
    byCompany.set(key, list);
  }
  for (const list of byCompany.values()) {
    const total = list.length;
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      const prev = list[index - 1];
      const day = String(item.submit.t).slice(0, 10);
      item.sameCompany = {
        nth: index + 1,
        total,
        daysSincePrev: prev ? days((Date.parse(item.submit.t) - Date.parse(prev.submit.t)) / DAY) : null,
        sameDay: list.filter(other => String(other.submit.t).slice(0, 10) === day).length,
      };
    }
  }

  ledger.sort((a, b) => String(a.submit.t).localeCompare(String(b.submit.t)));
  if (write) {
    writeFileSync(LEDGER, `${ledger.map(row => JSON.stringify(row)).join('\n')}${ledger.length ? '\n' : ''}`);
  }
  return ledger;
}

function coverageTable(ledger) {
  const fields = [
    ['posting.company', row => row.posting.company],
    ['posting.title', row => row.posting.title],
    ['posting.ats', row => row.posting.ats],
    ['posting.tenant', row => row.posting.tenant],
    ['posting.lane', row => row.posting.lane && row.posting.lane !== '?' ? row.posting.lane : null],
    ['posting.location', row => row.posting.city || row.posting.state || row.posting.country || row.posting.remote],
    ['posting.pay_hr', row => row.posting.pay_hr],
    ['posting.sourceBoard', row => row.posting.sourceBoard],
    ['posting.postedAt', row => row.posting.postedAt],
    ['submit.t', row => row.submit.t],
    ['submit.weekdayEt', row => row.submit.weekdayEt],
    ['submit.hourEt', row => row.submit.hourEt],
    ['submit.secs', row => row.submit.secs],
    ['submit.cost', row => row.submit.cost],
    ['submit.modelCalls', row => row.submit.modelCalls],
    ['submit.attemptsBefore', row => row.submit.attemptsBefore],
    ['submit.code', row => row.submit.code],
    ['documents.resume', row => row.documents.resume],
    ['documents.coverLetter', row => row.documents.coverLetter === true || row.documents.coverLetter === false],
    ['documents.transcript', row => row.documents.transcript],
    ['documents.essayCount', row => row.documents.essayCount > 0 ? row.documents.essayCount : null],
    ['controlledAnswers', row => row.controlledAnswers?.length ? row.controlledAnswers.length : null],
    ['sameCompany.nth', row => row.sameCompany?.nth],
    ['outcome.confirmation', row => row.outcome.confirmation],
    ['outcome.assessment', row => row.outcome.assessment],
    ['outcome.interview', row => row.outcome.interview],
    ['outcome.rejection', row => row.outcome.rejection],
    ['outcome.silent', row => row.outcome.silent],
  ];
  const n = ledger.length || 1;
  return fields.map(([name, get]) => {
    const hit = ledger.filter(row => nonempty(get(row))).length;
    return { field: name, n: hit, pct: hit / ledger.length };
  });
}

function wilson(successes, n, z = 1.96) {
  if (!n) return { rate: 0, lo: 0, hi: 0 };
  const p = successes / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { rate: p, lo: Math.max(0, (center - margin) / den), hi: Math.min(1, (center + margin) / den) };
}

function bucketPay(pay) {
  if (pay == null || !Number.isFinite(pay)) return 'unstated';
  if (pay < 20) return '<$20';
  if (pay < 30) return '$20–29';
  if (pay < 40) return '$30–39';
  if (pay < 50) return '$40–49';
  return '$50+';
}

function bucketAge() {
  // Posted date is not recorded at apply time today.
  return 'unrecorded';
}

function bucketCompanyCount(total) {
  if (total <= 1) return '1';
  if (total === 2) return '2';
  if (total <= 4) return '3–4';
  return '5+';
}

function bucketAttempts(n) {
  if (!n) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  return '3+';
}

function resumeVariant(name) {
  const match = String(name ?? '').match(/resume[_-]?([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() || (name ? 'other' : 'unknown');
}

function loadLedgerFile() {
  if (!existsSync(LEDGER)) return null;
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Real employer outcome: a rejection or an advance (assessment/interview). Auto-acks are not decisions.
function hasDecision(row) {
  return row.outcome.rejection != null || row.outcome.assessment != null || row.outcome.interview != null;
}
function hasAdvance(row) {
  return row.outcome.assessment != null || row.outcome.interview != null;
}
function hasAck(row) {
  return row.outcome.confirmation != null;
}

function rateTable(title, groups, overall, { atsNote = false } = {}) {
  console.log(`\n${title}`);
  console.log(`  ${'bucket'.padEnd(16)} ${'n'.padStart(5)} ${'dec%'.padStart(8)} ${'95% CI'.padStart(16)} ${'rej%'.padStart(8)} ${'adv%'.padStart(8)} ${'ack%'.padStart(8)} signal`);
  for (const group of groups) {
    const decision = wilson(group.decided, group.n);
    const rej = wilson(group.rejected, group.n);
    const adv = wilson(group.advanced, group.n);
    const ack = wilson(group.acked, group.n);
    const signal = group.n >= 30 && (decision.hi < overall.decision.lo || decision.lo > overall.decision.hi);
    const ci = `${pct(decision.lo)}–${pct(decision.hi)}`;
    console.log(`  ${String(group.name).padEnd(16)} ${String(group.n).padStart(5)} ${pct(decision.rate).padStart(8)} ${ci.padStart(16)} ${pct(rej.rate).padStart(8)} ${pct(adv.rate).padStart(8)} ${pct(ack.rate).padStart(8)} ${signal ? 'SIGNAL' : ''}`);
  }
  if (atsNote) {
    const notes = groups.filter(group => group.n >= 10 && group.topAts)
      .map(group => `${group.name}: ${group.topAts}=${pct(group.topAtsShare)}`)
      .slice(0, 8);
    if (notes.length) console.log(`  ATS mix (top share): ${notes.join('; ')}`);
  }
}

function dimension(ledger, keyFn) {
  const map = new Map();
  for (const row of ledger) {
    const name = String(keyFn(row) ?? '?');
    const group = map.get(name) ?? {
      name, n: 0, decided: 0, rejected: 0, advanced: 0, acked: 0, ats: new Map(),
    };
    group.n++;
    if (hasDecision(row)) group.decided++;
    if (row.outcome.rejection != null) group.rejected++;
    if (hasAdvance(row)) group.advanced++;
    if (hasAck(row)) group.acked++;
    const ats = row.posting.ats || '?';
    group.ats.set(ats, (group.ats.get(ats) ?? 0) + 1);
    map.set(name, group);
  }
  return [...map.values()].map(group => {
    const top = [...group.ats].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      ...group,
      topAts: top?.[0] ?? null,
      topAtsShare: top && group.n ? top[1] / group.n : 0,
    };
  }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

export function ledgerReport(selectedRows, allRows, { mail = loadMail() } = {}) {
  const ledger = buildLedger(selectedRows, allRows, { mail, write: true });
  const coverage = coverageTable(ledger);
  const decided = ledger.filter(hasDecision).length;
  const rejected = ledger.filter(row => row.outcome.rejection != null).length;
  const advanced = ledger.filter(hasAdvance).length;
  const acked = ledger.filter(hasAck).length;
  const replied = ledger.filter(row => row.outcome.replied).length;
  console.log(`Ledger: ${ledger.length} unique submitted applications → ${LEDGER}`);
  console.log(`Outcomes: decided ${decided} (rejected ${rejected}, advanced ${advanced}), acked ${acked}, any reply ${replied}`);
  console.log('\nField coverage (% non-null)');
  for (const row of coverage) {
    console.log(`  ${row.field.padEnd(28)} ${String(row.n).padStart(5)}  ${pct(row.pct)}`);
  }
  const missingPosted = coverage.find(row => row.field === 'posting.postedAt');
  if (missingPosted && missingPosted.n === 0) {
    console.log('\nNote: posting.postedAt / postingAgeDays are not recorded at apply time (discover writes only url/lane/name).');
  }
  const missingCode = coverage.find(row => row.field === 'submit.code');
  if (missingCode && missingCode.n === 0) {
    console.log('Note: submit.code is absent on historical summary rows (lib/trace.mjs writes it for new runs).');
  }
  return { ledger, coverage };
}

export function insightsReport(selectedRows, allRows, { mail = loadMail(), ledger = null } = {}) {
  const rows = ledger ?? loadLedgerFile() ?? buildLedger(selectedRows, allRows, { mail, write: true });
  // Mature cohort only: young apps have not had time for a rejection (median ~28h, p75 ~36h).
  const syncAt = Date.parse(mail?.syncedAt ?? '') || Date.now();
  const matureBefore = syncAt - 3 * DAY;
  const mature = rows.filter(row => Date.parse(row.submit.t) <= matureBefore);
  const young = rows.length - mature.length;
  const n = mature.length;
  const decided = mature.filter(hasDecision).length;
  const rejected = mature.filter(row => row.outcome.rejection != null).length;
  const advanced = mature.filter(hasAdvance).length;
  const acked = mature.filter(hasAck).length;
  const overall = {
    decision: wilson(decided, n),
    rejection: wilson(rejected, n),
    advance: wilson(advanced, n),
    ack: wilson(acked, n),
  };
  console.log(`Insights over ${n} mature applications (excluded ${young} submitted <3d before mail sync ${new Date(syncAt).toISOString()})`);
  console.log(`  overall decision ${pct(overall.decision.rate)} (${pct(overall.decision.lo)}–${pct(overall.decision.hi)}); rejection ${pct(overall.rejection.rate)}; advance ${pct(overall.advance.rate)}; ack ${pct(overall.ack.rate)} (confirmations only)`);

  const dims = [
    ['lane', row => row.posting.lane || '?', false],
    ['resume', row => resumeVariant(row.documents.resume), false],
    ['ATS', row => row.posting.ats, false],
    ['weekday ET', row => row.submit.weekdayEt || '?', true],
    // hour dropped: 24 thin buckets, heavily confounded with ATS mix
    ['posting age', () => bucketAge(), false],
    ['pay', row => bucketPay(row.posting.pay_hr), false],
    ['company apps', row => bucketCompanyCount(row.sameCompany.total), false],
    ['cover letter', row => row.documents.coverLetter ? 'yes' : 'no', false],
    ['essays', row => row.documents.essayCount > 0 ? 'yes' : 'no', false],
    ['attempts', row => bucketAttempts(row.submit.attemptsBefore), false],
  ];
  for (const [label, key, atsNote] of dims) {
    rateTable(`By ${label}`, dimension(mature, key), overall, { atsNote });
  }

  const silent = mature.filter(row => !hasDecision(row))
    .reduce((map, row) => {
      const key = row.posting.company || '?';
      const item = map.get(key) ?? { company: key, n: 0, oldestDays: 0 };
      item.n++;
      const age = days((syncAt - Date.parse(row.submit.t)) / DAY) ?? 0;
      item.oldestDays = Math.max(item.oldestDays, age);
      map.set(key, item);
      return map;
    }, new Map());
  const topSilent = [...silent.values()].sort((a, b) => b.n - a.n || b.oldestDays - a.oldestDays).slice(0, 15);
  console.log('\nTop companies with mature applications and no decision');
  for (const item of topSilent) {
    console.log(`  ${String(item.n).padStart(3)}  ${item.company}  (oldest ${item.oldestDays}d)`);
  }

  const sameDay = mature.filter(row => row.sameCompany.sameDay >= 2);
  const spaced = mature.filter(row => row.sameCompany.daysSincePrev != null && row.sameCompany.daysSincePrev >= 3);
  console.log('\nSame-company spacing (mature)');
  console.log(`  applications on a day with ≥2 to same company: ${sameDay.length}`);
  console.log(`  applications ≥3 days after previous to same company: ${spaced.length}`);
  const burstCompanies = [...mature.reduce((map, row) => {
    if (row.sameCompany.sameDay < 2) return map;
    const key = row.posting.company;
    map.set(key, Math.max(map.get(key) ?? 0, row.sameCompany.sameDay));
    return map;
  }, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (burstCompanies.length) {
    console.log('  densest same-day company bursts:');
    for (const [company, count] of burstCompanies) console.log(`    ${count}  ${company}`);
  }

  const signals = dims.flatMap(([label, key]) => dimension(mature, key)
    .filter(group => group.n >= 30)
    .map(group => {
      const decision = wilson(group.decided, group.n);
      const signal = decision.hi < overall.decision.lo || decision.lo > overall.decision.hi;
      return signal ? { label, bucket: group.name, n: group.n, decision: decision.rate, lo: decision.lo, hi: decision.hi } : null;
    })
    .filter(Boolean));
  console.log('\nSignal dimensions (n≥30, decision CI excludes overall)');
  if (!signals.length) console.log('  none');
  for (const item of signals) {
    console.log(`  ${item.label}=${item.bucket}  n=${item.n}  decision ${pct(item.decision)} (${pct(item.lo)}–${pct(item.hi)})`);
  }
  return { rows: mature, young, overall, signals };
}
