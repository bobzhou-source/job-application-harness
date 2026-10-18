// The applicant's stored answers as fillable values: facts/Q&A maps with format variants, resume
// bullets, planner aliases, and learned.json persistence of what past runs found to work.
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as answers from '../answers.mjs';
import { expandAliases } from '../planner.mjs';
import { Stop } from './stop.mjs';
import { MONTHS, POSITIONAL_WORK_LABEL, isTodayLabel } from './fields.mjs';
import { loadConfig } from '../config.mjs';
import { workAuthorizationStatus, applyWorkAuthorization } from '../work-authorization.mjs';
import { withFileLock } from '../lockfile.mjs';

// facts.work.N.{title,employer,location,start,end,description}: N=1 is the primary/recent role.
// Dates accept month/year strings; end may be "Present". The first entry and the legacy singular
// facts are one value, including every derived date/alias suffix; structured facts win a conflict.
const WORK_ALIASES = { employer: 'employer', title: 'job_title', location: 'job_location',
  start: 'job_start', end: 'job_end', description: 'job_description' };
function workAliases(values) {
  for (const [part, legacy] of Object.entries(WORK_ALIASES)) {
    const structured = `facts.work.1.${part}`;
    const singular = `facts.${legacy}`;
    const keys = [...values.keys()].filter(key => key === structured || key.startsWith(`${structured}.`)
      || key === singular || key.startsWith(`${singular}.`));
    for (const key of keys) {
      const suffix = key.startsWith(structured) ? key.slice(structured.length) : key.slice(singular.length);
      const value = values.get(`${structured}${suffix}`) ?? values.get(`${singular}${suffix}`);
      values.set(`${structured}${suffix}`, value);
      values.set(`${singular}${suffix}`, value);
    }
  }
  return values;
}

export function localAnswers(data) {
  // Run-only facts for dry runs: {"facts": {"work.2.title": "...", ...}}. Never merged into answers.json.
  const overlayPath = process.env.JOB_APP_FACTS_OVERLAY;
  if (overlayPath) {
    let overlay;
    try { overlay = JSON.parse(readFileSync(overlayPath, 'utf8')); }
    catch { throw new Stop('facts-overlay-unreadable', 1); }
    if (!overlay?.facts || typeof overlay.facts !== 'object' || Array.isArray(overlay.facts)
      || Object.values(overlay.facts).some(value => !['string', 'number', 'boolean'].includes(typeof value))) {
      throw new Stop('facts-overlay-invalid: expected an object of scalar facts', 1);
    }
    data = { ...data, facts: { ...data.facts, ...overlay.facts } };
  }
  const values = new Map();
  for (const section of ['facts', 'qa']) {
    for (const [name, value] of Object.entries(data[section] ?? {})) {
      if ((section === 'facts' && name === 'resume') || /password|passwd|passphrase|secret|token|credential|api[_ -]?key/i.test(name)) continue;
      // A "today's date"/signature-date answer must not be served from storage: only the run-time fact (below) may
      // answer such a field, so a remembered one (a date that was today on an earlier run) is dropped outright.
      if (section === 'qa' && isTodayLabel(name)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value) === '') continue;
      const key = `${section}.${section === 'qa' ? answers.normalize(name) : name}`;
      // Entry ordinals describe this page's parser output, not a reusable applicant answer.
      if (section === 'qa' && POSITIONAL_WORK_LABEL.test(key.slice(3))) continue;
      if (key === `${section}.`) continue;
      if (values.has(key) && values.get(key) !== String(value)) throw new Stop('ambiguous-answer-keys', 1);
      values.set(key, String(value));
    }
  }
  // The configured date of birth fills DOB fields; an answers.json value of the same key wins.
  const dateOfBirth = loadConfig().applicant.dateOfBirth;
  if (dateOfBirth && !values.has('facts.date_of_birth')) {
    const [year, month, day] = dateOfBirth.split('-');
    values.set('facts.date_of_birth', dateOfBirth);
    values.set('facts.date_of_birth.us', `${month}/${day}/${year}`);
  }
  return workAliases(withVariants(workAliases(values)));
}

// Deterministic format variants of stored values, offered as extra answers so Jev can match a field's format
// (e.g. "Graduation year" or "Please enter a valid year" wants 2030, not "May 2030"). Code derives them; no model writes text.

function withVariants(values) {
  // Preferred display name; legal-name fields use facts.legal_* instead.
  const first = values.get('facts.first_name');
  const last = values.get('facts.last_name');
  if (first && last && !values.has('facts.preferred_full_name')) values.set('facts.preferred_full_name', `${first} ${last}`);
  // Today's date for signature-date fields, in the common US forms.
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  values.set('facts.today', `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`);
  values.set('facts.today.iso', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  for (const [key, value] of [...values]) {
    const date = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(value.trim());
    const month = date ? MONTHS.indexOf(date[1].slice(0, 3).toLowerCase()) + 1 : 0;
    if (date && month) {
      const mm = String(month).padStart(2, '0');
      values.set(`${key}.year`, date[2]);
      values.set(`${key}.month`, mm);
      values.set(`${key}.mm_yyyy`, `${mm}/${date[2]}`);
      values.set(`${key}.yyyy_mm`, `${date[2]}-${mm}`);
    }
    const digits = value.replace(/\D/g, '');
    if (/^[+\d\s().-]+$/.test(value) && digits.length >= 7 && digits !== value) values.set(`${key}.digits`, digits);
  }
  return values;
}

// Resume bullets become stored answers keyed by their role ("resume.<employer>_<n>"), so free-text questions
// such as Responsibilities are answered by Jev choosing the applicant's own words, never generated text.
export async function resumeBullets(path) {
  let text;
  try { ({ stdout: text } = await promisify(execFile)('pdftotext', ['-layout', path, '-'], { timeout: 10000 })); }
  catch { return []; }
  const bullets = [];
  let heading = '';
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { current = null; continue; }
    if (line.startsWith('•')) {
      current = { heading, text: line.slice(1).trim() };
      bullets.push(current);
    } else if (current && /^\s{2,}/.test(raw) && !/\s{4,}\S+\s*$/.test(raw.trimStart())) {
      current.text += ` ${line}`;
    } else {
      current = null;
      heading = line.replace(/\s{3,}.*$/, '');
    }
  }
  const counts = {};
  return bullets.slice(0, 16).map(b => {
    const slug = b.heading.split(/\s[—–-]\s/)[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'experience';
    counts[slug] = (counts[slug] ?? 0) + 1;
    return [`resume.${slug}_${counts[slug]}`, b.text.replace(/\s+/g, ' ').slice(0, 600)];
  });
}

// Equivalent forms of stored answers live in aliases.json by key and value: planner-expanded aliases for short
// categorical facts, plus learned replacements the site accepted after rejecting a value. They become extra
// answers "<key>.alias_<n>". Contact and identity facts are never sent for expansion.
const aliasPath = fileURLToPath(new URL('../../aliases.json', import.meta.url));

const NO_ALIAS = /email|phone|address|street|zip|postal|name|linkedin|website|url|resume|birth|ssn/;

async function readAliases() {
  try { return JSON.parse(await readFile(aliasPath, 'utf8')); } catch { return {}; }
}

export async function addAliases(values) {
  const cache = await readAliases();
  const wanted = Object.fromEntries([...values].filter(([key, value]) => key.startsWith('facts.')
    && (key.split('.').length === 2 || /^facts\.work\.(?:[2-9]|[1-9]\d+)\.(title|employer|location|start|end|description)$/.test(key))
    && !NO_ALIAS.test(key) && value.length <= 40 && !/^(yes|no|true|false|[\d.\s/-]+)$/i.test(value.trim())));
  const missing = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => cache[key]?.value !== value));
  // The planner call stays outside the lock (slow); only the merge into the latest aliases.json is locked.
  const fresh = Object.keys(missing).length ? await expandAliases(missing) : null;
  const merged = fresh ? await withFileLock(aliasPath, async () => {
    const latest = await readAliases();
    for (const [key, list] of Object.entries(fresh)) latest[key] = { value: missing[key], aliases: list };
    await writeFile(aliasPath, `${JSON.stringify(latest, null, 2)}\n`);
    return latest;
  }) : cache;
  for (const [key, entry] of Object.entries(merged)) {
    if (values.get(key) === entry.value) (entry.aliases ?? []).forEach((alias, i) => values.set(`${key}.alias_${i + 1}`, alias));
  }
  workAliases(values);
}

// The per-posting view of the stored answers: work-right answers are rewritten for the posting's country, then planner
// aliases are added. Built from baseValues (stored answers and resume bullets), so each call replaces the previous
// posting's rewrite instead of stacking on it.
export async function applyPostingPolicy(ctx, posting) {
  const values = new Map(ctx.baseValues);
  // Age is a date, not a yes/no fact: the age policy reads the birth date and the intake's start date.
  ctx.workAuthorization = {
    ...workAuthorizationStatus(posting, loadConfig().applicant),
    internshipStart: values.get('facts.internship_start') ?? null,
    atLeast18: values.get('facts.at_least_18') ?? null,
  };
  applyWorkAuthorization(values, ctx.workAuthorization);
  await addAliases(values);
  ctx.values = values;
}

export async function learnAlias(key, original, accepted) {
  await withFileLock(aliasPath, async () => {
    const cache = await readAliases();
    if (cache[key]?.value !== original) cache[key] = { value: original, aliases: [] };
    if (!cache[key].aliases.includes(accepted)) cache[key].aliases.unshift(accepted);
    await writeFile(aliasPath, `${JSON.stringify(cache, null, 2)}\n`);
  });
}

// learned.json — what past runs found to work, replayed without any model call:
//   fields:  normalized field label/name → answer key the site accepted for it (the executor fills these first);
//   choices: normalized stored answer → dropdown choice texts it was mapped to (no model call next time);
//   lessons: one-line notes from DeepSeek consults that got a stuck screen moving, per host (Jev reads them);
//   noAnswer: optional field labels Jev judged no stored answer fits ("Employee ID (if applicable)", "Phone
//             Extension"): left empty, they no longer hold back the deterministic Next/Submit rule.
//   families: per ATS family (lib/apply/template.mjs), locator → accepted answer key or step role, with hit/miss counts
const learnedPath = fileURLToPath(new URL('../../learned.json', import.meta.url));

export async function loadLearned() {
  try {
    const data = JSON.parse(await readFile(learnedPath, 'utf8'));
    const fields = Object.fromEntries(Object.entries(data.fields ?? {}).filter(([label, key]) =>
      !POSITIONAL_WORK_LABEL.test(label) && !POSITIONAL_WORK_LABEL.test(String(key).replace(/^qa\./, ''))));
    return { fields, choices: data.choices ?? {}, lessons: data.lessons ?? [], noAnswer: data.noAnswer ?? [], families: data.families ?? {}, questions: data.questions ?? {} };
  } catch { return { fields: {}, choices: {}, lessons: [], noAnswer: [], families: {}, questions: {} }; }
}

// Read-merge-write under the lock: a parallel worker may have recorded other families or entries since this run loaded.
export async function saveLearned(learned) {
  await withFileLock(learnedPath, async () => {
    let disk = {};
    try { disk = JSON.parse(await readFile(learnedPath, 'utf8')); } catch { /* first save, or unreadable: rewrite */ }
    const families = { ...(disk.families ?? {}) };
    for (const [family, bucket] of Object.entries(learned.families ?? {})) {
      const old = disk.families?.[family] ?? {};
      families[family] = { fields: { ...old.fields, ...bucket.fields }, controls: { ...old.controls, ...bucket.controls } };
    }
    // Question memory merges per entry too: a parallel worker records other tenants' answers since this run loaded.
    const questions = { ...(disk.questions ?? {}) };
    for (const [id, entry] of Object.entries(learned.questions ?? {})) {
      const old = disk.questions?.[id];
      questions[id] = old ? { ...old, ...entry, hits: Math.max(old.hits ?? 0, entry.hits ?? 0), misses: Math.max(old.misses ?? 0, entry.misses ?? 0) } : entry;
    }
    await writeFile(learnedPath, `${JSON.stringify({ ...learned, families, questions }, null, 2)}\n`);
  });
}
