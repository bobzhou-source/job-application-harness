// Answer audit over the ledger (lib/report/ledger.mjs) and the stores (answers.json, aliases.json, learned.json):
//   provenance(rows, text)   every run that committed, filled, stored, or drafted an answer whose label, value, or
//                            key contains `text`, in order, then where that answer lives in the stores today;
//   suspects(rows, stores)   the committed answers the deterministic rules flag: a writer pick with no stored answer
//                            behind it; a site answer composed for one posting and replayed on another title; an
//                            option that equals neither the stored answer nor an alias; a graded draft the grader
//                            called thin or unsupported;
//   siteAnswers(rows, …)     written[site] entries with the posting each was composed for (from the ledger's
//                            REMEMBERED-SITE rows), and --annotate records that posting on the legacy string entries
//                            so overlaySiteAnswers replays them only there.
// No model is called; the same inputs always give the same output.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalize } from '../answers.mjs';
import * as answers from '../answers.mjs';
import { withFileLockSync } from '../lockfile.mjs';
import { siteAnswerEntries, sameTitle, postingOf } from '../apply/accounts.mjs';
import { workAuthorizationExpectation, workAuthorizationAnswerMatches, inferPostingCountry } from '../work-authorization.mjs';
import { loadMail } from '../mail/store.mjs';
import { traceAnswers } from '../mail/watch.mjs';
import { atsFor } from './applications.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readJson = name => existsSync(`${ROOT}${name}`) ? JSON.parse(readFileSync(`${ROOT}${name}`, 'utf8')) : {};
export const stores = () => ({ answers: readJson('answers.json'), aliases: readJson('aliases.json'), learned: readJson('learned.json') });

const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const shortSite = site => String(site ?? '?').replace(/\.(wd\d+\.)?myworkdayjobs\.com$/, '').replace(/^www\./, '');
const when = row => `${row.day} ${String(row.t).slice(11, 16)}`;
const submitted = rows => rows.filter(row => row.outcome === 'submitted');

// The stored text behind a key (facts.x or qa.x) and its aliases, as the picker sees them.
function candidatesFor(key, { answers: data, aliases }) {
  if (!key) return [];
  const [, scope, rest] = /^(facts|qa)\.(.+)$/.exec(key) ?? [];
  const value = scope === 'facts' ? data.facts?.[rest] : scope === 'qa' ? data.qa?.[rest] : undefined;
  if (value == null || value === '') return [];
  const entry = aliases[key];
  return [String(value), ...(entry?.value === String(value) ? entry.aliases ?? [] : [])];
}

// Whether a committed option is what the stored answer or one of its aliases names (the picker's exact / lead rules).
function fits(option, candidates) {
  const shown = normalize(option);
  return candidates.some(text => {
    const want = normalize(text);
    if (!want || !shown) return false;
    if (shown === want || (want.length >= 4 && shown.startsWith(`${want} `))) return true;
    if (want.includes(' ') && want.split(' ').some(word => word.length > 1) && ` ${shown} `.includes(` ${want} `)) return true;
    return want.startsWith(shown) && (want.length === shown.length || ' (-/:'.includes(String(text).replace(/\s+/g, ' ').trim().toLowerCase()[shown.length] ?? '\u0000'));
  });
}

export function provenance(rows, text, { all = false } = {}) {
  const needle = normalize(text);
  const hit = row => [row.label, row.value, row.key].some(part => part && normalize(part).includes(needle));
  const found = rows.filter(hit).sort((a, b) => a.t.localeCompare(b.t));
  console.log(`${found.length} ledger rows match "${text}" (${rows.length} rows indexed).`);
  const show = all ? found : found.slice(-60);
  if (show.length < found.length) console.log(`  (last ${show.length}; --all for every row)`);
  for (const row of show) {
    const who = [row.source, row.how].filter(Boolean).join('/');
    const where = `${when(row)} ${shortSite(row.site).padEnd(14)} ${clip(row.title, 40).padEnd(40)} ${row.outcome.padEnd(9)}`;
    if (row.kind === 'written') console.log(`${where} written [${row.grade}] ${clip(row.label, 50)} → ${clip(row.value, 70)}`);
    else if (row.kind === 'stored') console.log(`${where} stored(${row.scope}) ${clip(row.label, 50)} = ${clip(row.value, 60)}`);
    else console.log(`${where} ${row.kind.padEnd(6)} ${clip(row.label, 50)} = ${clip(row.value ?? '(key text)', 50)} ← ${row.key ?? '?'}${row.sure ? '' : '?'} ${who}`);
  }
  const { answers: data, aliases, learned } = stores();
  const lines = [];
  for (const [key, value] of Object.entries(data.facts ?? {})) if (normalize(key).includes(needle) || normalize(value).includes(needle)) lines.push(`facts.${key} = ${clip(value, 100)}`);
  for (const [key, value] of Object.entries(data.qa ?? {})) if (normalize(key).includes(needle) || normalize(value).includes(needle)) lines.push(`qa.${key} = ${clip(value, 100)}`);
  for (const [site, byKey] of Object.entries(data.written ?? {})) {
    for (const [key, stored] of Object.entries(byKey)) {
      for (const entry of siteAnswerEntries(stored)) {
        if (normalize(key).includes(needle) || normalize(entry.text).includes(needle)) lines.push(`written[${site}].${key} = ${clip(entry.text, 80)}  (posting ${entry.posting ?? '?'}; "${clip(entry.title ?? '?', 50)}")`);
      }
    }
  }
  for (const [key, entry] of Object.entries(aliases)) if (normalize(key).includes(needle) || (entry.aliases ?? []).some(alias => normalize(alias).includes(needle))) lines.push(`aliases ${key}: ${entry.aliases.join(' | ')}`);
  for (const [label, key] of Object.entries(learned.fields ?? {})) if (normalize(label).includes(needle) || normalize(key).includes(needle)) lines.push(`learned.fields "${label}" → ${key}`);
  for (const [value, choices] of Object.entries(learned.choices ?? {})) if (normalize(value).includes(needle) || JSON.stringify(choices).toLowerCase().includes(needle)) lines.push(`learned.choices "${clip(value, 60)}" → ${clip(JSON.stringify(choices), 100)}`);
  for (const [family, data2] of Object.entries(learned.families ?? {})) {
    for (const [field, entry] of Object.entries(data2.fields ?? {})) if (normalize(field).includes(needle) || normalize(entry.key).includes(needle)) lines.push(`learned.families.${family} ${field} → ${entry.key} (${entry.how}, hits ${entry.hits}, misses ${entry.misses})`);
  }
  console.log(lines.length ? `\nIn the stores now:` : `\nNot in answers.json, aliases.json, or learned.json.`);
  for (const line of lines) console.log(`  ${line}`);
}

// Earliest REMEMBERED-SITE row per site+key: the posting the site answer was composed for.
function siteOrigins(rows) {
  const origins = new Map();
  for (const row of rows) {
    if (row.kind !== 'stored' || row.scope !== 'site') continue;
    const id = `${row.site}|${row.key}`;
    if (!origins.has(id) || origins.get(id).t > row.t) origins.set(id, row);
  }
  return origins;
}

export function suspects(rows, { all = false } = {}) {
  const store = stores();
  const sub = submitted(rows);
  const origins = siteOrigins(rows);
  const choices = sub.filter(row => row.kind === 'choice' && row.value != null);
  const group = (list, key) => [...list.reduce((acc, row) => { const k = key(row); (acc.get(k) ?? acc.set(k, []).get(k)).push(row); return acc; }, new Map())]
    .sort((a, b) => b[1].length - a[1].length);
  const print = (title, groups, line) => {
    console.log(`\n${title}: ${groups.reduce((n, [, list]) => n + list.length, 0)} in ${groups.length} groups`);
    for (const [, list] of groups.slice(0, all ? groups.length : 30)) console.log(`  ${String(list.length).padStart(3)} × ${line(list[0], list)}`);
    if (!all && groups.length > 30) console.log(`  … ${groups.length - 30} more groups (--all)`);
  };
  const sites = list => [...new Set(list.map(row => shortSite(row.site)))].slice(0, 6).join(', ');

  const writer = choices.filter(row => row.how === 'writer');
  print('Writer picks (no stored answer or alias named an option; the model chose from the posting and profile)',
    group(writer, row => `${normalize(row.label)}|${normalize(row.value)}`), (row, list) => `${clip(row.label, 70)} = "${clip(row.value, 50)}"  [${sites(list)}]`);

  // A run that stored the site answer itself (its own REMEMBERED-SITE row) composed it; only a run without one
  // received it from the store.
  const composedIn = new Set(rows.filter(row => row.kind === 'stored' && row.scope === 'site').map(row => `${row.run}|${row.site}|${row.key}`));
  const replayed = sub.filter(row => (row.kind === 'choice' || row.kind === 'fill') && row.key?.startsWith('qa.') && row.how !== 'writer'
    && !composedIn.has(`${row.run}|${row.site}|${row.key}`)).filter(row => {
    const origin = origins.get(`${row.site}|${row.key}`);
    return origin && origin.run !== row.run && !sameTitle(origin.title, row.title);
  });
  print('Site answers composed for one posting and replayed on another title (fixed going forward: replay is per posting; --site-answers --annotate pins the legacy entries)',
    group(replayed, row => `${row.site}|${row.key}`), (row, list) => {
      const origin = origins.get(`${row.site}|${row.key}`);
      return `${shortSite(row.site)} ${clip(row.label, 50)} = "${clip(row.value ?? origin.value, 40)}"  composed for "${clip(origin.title, 40)}", replayed on ${[...new Set(list.map(item => clip(item.title, 40)))].slice(0, 4).map(t => `"${t}"`).join(', ')}`;
    });

  const off = choices.filter(row => row.key && !['writer', 'other', 'learned', 'typed', 'nomatch'].includes(row.how)).filter(row => {
    const candidates = candidatesFor(row.key, store);
    return candidates.length && !fits(row.value, candidates);
  });
  print('Options that equal neither the stored answer nor an alias (a model or heuristic stretched; check or add an alias)',
    group(off, row => `${row.key}|${normalize(row.value)}`), (row, list) => `${clip(row.label, 50)} = "${clip(row.value, 40)}" for ${row.key} = "${clip(candidatesFor(row.key, store)[0], 40)}"  [${sites(list)}]`);

  const thin = sub.filter(row => row.kind === 'written' && (row.grade === 'ok' || row.grade === 'terrible')
    && /nowhere in|not in the (sources|facts)|appears? nowhere|unsupported|invent|no (figure|episode)|generic/i.test(row.why ?? ''));
  print('Drafts the grader called thin, generic, or unsupported (ok = shipped; terrible = dropped before submit)',
    group(thin, row => `${normalize(row.label)}|${row.grade}`), (row, list) => `[${row.grade}] ${clip(row.label, 60)}: ${clip(row.why, 110)}  [${sites(list)}]`);

  // A run that answered work rights for a country other than the one the posting URL names: the Workday location
  // slug (/job/Wilmington-Delaware-United-States-of-America/) or a US state slug is the posting's own word.
  const US_SLUG = /united[- ]states|\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;
  const slug = row => { try { return decodeURIComponent(new URL(row.job).pathname).split('/job/')[1]?.split('/')[0]?.replace(/-/g, ' ') ?? ''; } catch { return ''; } };
  const misplaced = sub.filter(row => row.kind === 'policy' && row.value !== 'United States' && US_SLUG.test(slug(row)));
  print('Work-rights answers given for another country on a posting whose URL places it in the US (every authorization and sponsorship answer in the run followed; fixed in lib/work-authorization.mjs)',
    group(misplaced, row => `${row.site}|${row.value}`), (row, list) => `${shortSite(row.site)} read as ${row.value} (${row.how}): ${[...new Set(list.map(item => clip(item.title, 40)))].slice(0, 4).map(t => `"${t}"`).join(', ')}`);
}
// Every submitted answer to a work-authorization, sponsorship, or citizenship question, judged by meaning (the same
// policy the form fill uses). A negative-polarity question keeps its polarity: "without sponsorship, permitted" is
// authorization, while "require sponsorship" is not. Writes runs/audit-workauth.tsv and prints only true contradictions.
export function workAuthAudit(rows, { path = `${ROOT}runs/audit-workauth.tsv` } = {}) {
  const US = 'United States';
  const statusFor = row => {
    const country = inferPostingCountry({ postingText: '', title: row.title ?? '', url: row.job ?? '' }) || US;
    return { country, workAuthorizedCountries: [US], authorized: country === US };
  };
  const names = new Map();
  const results = `${ROOT}runs/queue-results.txt`;
  if (existsSync(results)) {
    for (const line of readFileSync(results, 'utf8').split('\n')) {
      const match = line.match(/^=== (.*) \(([^()\t\r\n]+)\) (\S+)/);
      if (match) names.set(match[3].replace(/[?#].*$/, ''), match[1]);
    }
  }
  const companyOf = row => String(names.get(row.job) ?? row.site ?? row.host ?? '?').split(/\s+—\s+/)[0];
  const cleanCell = text => String(text ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const wrong = [];
  for (const row of submitted(rows)) {
    if (row.kind !== 'choice') continue;
    const expectation = workAuthorizationExpectation(row.label, statusFor(row));
    if (!expectation || workAuthorizationAnswerMatches(expectation, row.value) !== false) continue;
    wrong.push({ ...row, company: companyOf(row) });
  }
  wrong.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const lines = ['t\tcompany/host\ttitle\tquestion\tanswer\tsource',
    ...wrong.map(row => [row.t, companyOf(row), row.title, row.label, row.value, [row.source, row.how].filter(Boolean).join('/') || '?'].map(cleanCell).join('\t'))];
  writeFileSync(path, `${lines.join('\n')}\n`);
  const tally = values => Object.entries(values.reduce((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const companies = [...new Set(wrong.map(companyOf))];
  console.log(`Wrong submitted work-rights answers: ${wrong.length} in ${new Set(wrong.map(row => row.run)).size} applications, ${companies.length} companies`);
  console.log(`By day: ${tally(wrong.map(row => String(row.day))).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`By source: ${tally(wrong.map(row => [row.source, row.how].filter(Boolean).join('/') || '?')).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`Companies: ${companies.join(', ') || 'none'}`);
  console.log(`Written ${path}`);
  return wrong;
}

export function workAuthApplicationsAudit(rows, wrong, { path = `${ROOT}runs/audit-workauth-apps.tsv`, mail = loadMail() } = {}) {
  const clean = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const canonical = value => {
    try { const url = new URL(value); url.hash = ''; url.search = ''; return url.href.replace(/\/$/, ''); }
    catch { return String(value ?? '').replace(/[?#].*$/, '').replace(/\/$/, ''); }
  };
  const key = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const roleOf = title => clean(title).replace(/^Job Application for\s+/i, '').replace(/\s+(?:at|@)\s+[^|]+$/i, '');
  const apps = [];
  const byJob = new Map();
  for (const row of wrong) {
    const job = canonical(row.job);
    let app = byJob.get(job);
    if (!app) {
      const submitAt = traceAnswers(row.run).submitAt;
      app = {
        job: row.job, run: row.run, company: row.company, title: row.title,
        host: (() => { try { return new URL(row.job).hostname; } catch { return row.host; } })(),
        submittedAt: Date.parse(submitAt ?? row.t),
        rows: [], replyAt: null, mail: null,
      };
      app.ats = atsFor(app.host);
      app.role = roleOf(row.title);
      byJob.set(job, app);
      apps.push(app);
    }
    app.rows.push(row);
  }
  const rejected = [...(mail?.events ?? [])].filter(event => event.kind === 'rejected').sort((a, b) => a.date - b.date);
  for (const event of rejected) {
    const subject = clean(event.subject);
    const subjectKey = key(subject);
    let candidates = apps.filter(app => app.submittedAt <= event.date && app.replyAt == null);
    let target = candidates.find(app => canonical(app.job) === canonical(event.job));
    if (!target) target = candidates.filter(app => app.role && subjectKey.includes(key(app.role))).sort((a, b) => b.submittedAt - a.submittedAt)[0];
    // K2's rejection subject names no role; only an employer-named generic rejection may fall back to that employer's
    // most recent prior submission. A role-bearing rejection must match the role rather than land on a sibling.
    const roleBearing = /\b(?:intern(?:ship)?|engineer|analyst|associate|manager|developer|scientist|specialist)\b/i.test(subject);
    if (!target && !roleBearing) {
      const from = key(event.from);
      target = candidates.filter(app => {
        const company = key(app.company);
        return company && (from.includes(company) || company.includes(from));
      }).sort((a, b) => b.submittedAt - a.submittedAt)[0];
    }
    if (!target) continue;
    target.replyAt = event.date;
    target.mail = { subject, date: new Date(event.date).toISOString() };
  }
  const lines = ['application\tcompany\ttitle\tats\thost\turl\tsubmitted_at\twrong_answers\tquestions\tdisposition\trejection_subject\trejection_date'];
  for (const app of apps.sort((a, b) => a.submittedAt - b.submittedAt)) {
    lines.push([
      app.run.replace(/\.jsonl$/, ''), app.company, app.title, app.ats, app.host, app.job,
      new Date(app.submittedAt).toISOString(), app.rows.length,
      app.rows.map(row => `${row.label} = ${row.value}`).join('; '),
      app.replyAt == null ? 'pending' : 'rejected', app.mail?.subject ?? '', app.mail?.date ?? '',
    ].map(clean).join('\t'));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
  const rejectedCount = apps.filter(app => app.replyAt != null).length;
  console.log(`Affected applications: ${apps.length}; rejected ${rejectedCount}, pending ${apps.length - rejectedCount}`);
  console.log(`By ATS: ${Object.entries(apps.reduce((acc, app) => { acc[app.ats] = (acc[app.ats] ?? 0) + 1; return acc; }, {})).map(([name, count]) => `${name} ${count}`).join(', ')}`);
  console.log(`Mail syncedAt: ${mail?.syncedAt ?? 'missing'}; written ${path}`);
  return apps;
}

export function siteAnswers(rows, { annotate = false } = {}) {
  const origins = siteOrigins(rows);
  const data = readJson('answers.json');
  let legacy = 0, pinned = 0, unknown = 0;
  const updates = [];
  for (const [site, byKey] of Object.entries(data.written ?? {})) {
    for (const [key, stored] of Object.entries(byKey)) {
      const entries = siteAnswerEntries(stored);
      const origin = origins.get(`${site}|qa.${key}`);
      const legacyEntry = entries.find(entry => !entry.posting && !entry.title);
      if (legacyEntry) legacy += 1;
      const from = origin ? `"${clip(origin.title, 50)}" (${origin.day}, posting ${postingOf(origin.job)})` : 'no REMEMBERED-SITE row in any trace';
      if (legacyEntry && origin) { pinned += 1; updates.push({ site, key, posting: postingOf(origin.job), title: origin.title, t: origin.t }); } else if (legacyEntry) unknown += 1;
      console.log(`${shortSite(site).padEnd(16)} ${clip(key, 55).padEnd(55)} = ${clip(entries[0]?.text, 40).padEnd(40)} ${legacyEntry ? 'legacy' : 'pinned'}  ${from}`);
    }
  }
  console.log(`\n${legacy} legacy entries (replayed nowhere until pinned): ${pinned} have a posting in the ledger, ${unknown} do not.`);
  if (!annotate) { if (pinned) console.log(`Run with --annotate to pin the ${pinned} on their postings.`); return; }
  if (!updates.length) return;
  withFileLockSync(`${ROOT}answers.json`, () => {
    const stored = answers.load(`${ROOT}answers.json`);
    for (const update of updates) {
      const list = siteAnswerEntries(stored.written?.[update.site]?.[update.key]);
      const at = list.findIndex(entry => !entry.posting && !entry.title);
      if (at < 0) continue;
      list[at] = { ...list[at], posting: update.posting, title: update.title, t: update.t };
      stored.written[update.site][update.key] = list;
    }
    answers.save(`${ROOT}answers.json`, stored);
  });
  console.log(`Pinned ${updates.length} legacy site answers to the posting each was composed for.`);
}
