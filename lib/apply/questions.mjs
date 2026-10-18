// Cross-tenant question memory: what a past run answered for one question's exact text and option set, replayed on
// any tenant of the ATS family with no model call. Workday mints its own questionnaire ids per tenant but the
// standard application questions are the same text everywhere, so the key is the normalized question plus the
// sorted normalized option list ("Yes/No" and "Yes/No/Not applicable" can take different truthful picks). A free
// text box keys on its question alone (`text`). Names never: a name field takes its fact or stops, and controlled
// questions (work rights, age, EEO, salary, GPA) are answered by the policy before this store is read.
//
// The entry keeps the run's answer key and the chosen option text (a choice's answer is the site's own wording,
// as in learned.choices). Every replay still passes the executor's guards, and entries carry hit/miss counts so a
// decision the site rejected stops replaying.
import * as answers from '../answers.mjs';
import { learnLabel, isQuestionLabel } from './fields.mjs';
import { isControlledNameQuestion } from '../controlled-answers.mjs';

const CAP_OPTIONS = 40;

// The option set a question offers, normalized and sorted; empty for a free-text box.
export const optionSet = item => (Array.isArray(item?.options) ? item.options : [])
  .map(option => answers.normalize(String(option))).filter(Boolean).sort().slice(0, CAP_OPTIONS);

export function questionId(label, options) {
  const question = learnLabel({ label });
  if (!question) return null;
  const set = (Array.isArray(options) ? options : []).map(option => answers.normalize(String(option))).filter(Boolean).sort().slice(0, CAP_OPTIONS);
  return `${question}|${set.length ? set.join('/') : 'text'}`;
}

// Whether a question belongs in the cross-tenant store at all: it asks something (two real words), names no
// person, and the policy does not own it.
export function memorableQuestion(label, policyKey = null) {
  return Boolean(label) && isQuestionLabel(label) && !isControlledNameQuestion(label) && !policyKey;
}

const trusted = entry => Boolean(entry) && entry.hits > entry.misses;

// A trusted decision for this field, or null. `key` is the answer key the past run used, `value` its option text
// (null for a free-text answer, whose value lives in answers.json under `key`).
export function questionAnswer(learned, field, policyKey = null) {
  const label = learnLabel({ label: field?.label || field?.name, name: field?.name });
  if (!memorableQuestion(label, policyKey)) return null;
  const entry = learned?.questions?.[questionId(field?.label || field?.name, field?.options)];
  if (!trusted(entry) || typeof entry.key !== 'string' || !entry.key.startsWith('qa.')) return null;
  return { key: entry.key, value: typeof entry.value === 'string' ? entry.value : null };
}

// Record a decision the executor is about to confirm on the next snapshot (mirrors a family template entry).
export function stageQuestion(learned, { label, options, key, value }) {
  if (!memorableQuestion(label)) return null;
  const id = questionId(label, options);
  if (!id) return null;
  const entry = (learned.questions ??= {})[id] ??= { q: learnLabel({ label }), key, value: value ?? null, hits: 0, misses: 0 };
  entry.key = key;
  if (value !== undefined && value !== null) entry.value = String(value);
  return { id, entry };
}

// Settle a staged entry against the next snapshot: the question's field still empty or flagged invalid is a miss;
// a field the next screen no longer shows is a hit (the answer was accepted and the step moved on).
export function confirmQuestion(learned, id, field) {
  const entry = learned?.questions?.[id];
  if (!entry) return false;
  const missed = Boolean(field) && (Boolean(field.invalid) || (!field.occupied && !String(field.value ?? '').trim()));
  if (missed) entry.misses += 1;
  else entry.hits += 1;
  return true;
}
