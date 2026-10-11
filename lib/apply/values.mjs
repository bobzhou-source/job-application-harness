// The applicant's stored answers as fillable values: facts/Q&A maps with format variants, resume
// bullets, planner aliases, and learned.json persistence of what past runs found to work.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as answers from '../answers.mjs';
import { expandAliases } from '../planner.mjs';
import { Stop } from './stop.mjs';
import { MONTHS } from './fields.mjs';

export function localAnswers(data) {
  const values = new Map();
  for (const section of ['facts', 'qa']) {
    for (const [name, value] of Object.entries(data[section] ?? {})) {
      if ((section === 'facts' && name === 'resume') || /password|passwd|passphrase|secret|token|credential|api[_ -]?key/i.test(name)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value) === '') continue;
      const key = `${section}.${section === 'qa' ? answers.normalize(name) : name}`;
      if (key === `${section}.`) continue;
      if (values.has(key) && values.get(key) !== String(value)) throw new Stop('ambiguous-answer-keys', 1);
      values.set(key, String(value));
    }
  }
  return withVariants(values);
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

export async function addAliases(values) {
  let cache = {};
  try { cache = JSON.parse(await readFile(aliasPath, 'utf8')); } catch { /* first run */ }
  const wanted = Object.fromEntries([...values].filter(([key, value]) => key.startsWith('facts.') && key.split('.').length === 2
    && !NO_ALIAS.test(key) && value.length <= 40 && !/^(yes|no|true|false|[\d.\s/-]+)$/i.test(value.trim())));
  const missing = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => cache[key]?.value !== value));
  if (Object.keys(missing).length) {
    const fresh = await expandAliases(missing);
    for (const [key, list] of Object.entries(fresh)) cache[key] = { value: missing[key], aliases: list };
    await writeFile(aliasPath, `${JSON.stringify(cache, null, 2)}\n`);
  }
  for (const [key, entry] of Object.entries(cache)) {
    if (values.get(key) === entry.value) (entry.aliases ?? []).forEach((alias, i) => values.set(`${key}.alias_${i + 1}`, alias));
  }
}

export async function learnAlias(key, original, accepted) {
  let cache = {};
  try { cache = JSON.parse(await readFile(aliasPath, 'utf8')); } catch { /* first save */ }
  if (cache[key]?.value !== original) cache[key] = { value: original, aliases: [] };
  if (!cache[key].aliases.includes(accepted)) cache[key].aliases.unshift(accepted);
  await writeFile(aliasPath, `${JSON.stringify(cache, null, 2)}\n`);
}

// learned.json — what past runs found to work, replayed without any model call:
//   fields:  normalized field label/name → answer key the site accepted for it (the executor fills these first);
//   choices: normalized stored answer → dropdown choice texts it was mapped to (no model call next time);
//   lessons: one-line notes from DeepSeek consults that got a stuck screen moving, per host (Jev reads them);
//   noAnswer: optional field labels Jev judged no stored answer fits ("Employee ID (if applicable)", "Phone
//             Extension"): left empty, they no longer hold back the deterministic Next/Submit rule.
const learnedPath = fileURLToPath(new URL('../../learned.json', import.meta.url));

export async function loadLearned() {
  try {
    const data = JSON.parse(await readFile(learnedPath, 'utf8'));
    return { fields: data.fields ?? {}, choices: data.choices ?? {}, lessons: data.lessons ?? [], noAnswer: data.noAnswer ?? [] };
  } catch { return { fields: {}, choices: {}, lessons: [], noAnswer: [] }; }
}

export async function saveLearned(learned) {
  await writeFile(learnedPath, `${JSON.stringify(learned, null, 2)}\n`);
}
