// Field and label primitives shared across the apply run: text cleanup, emptiness/type tests, date
// segments, character limits, learned-label normalization, and the stall-detection screen fingerprint.
import * as answers from '../answers.mjs';
import { invalidPlan } from './stop.mjs';

// A parser's row ordinal is not an identity; it must never become a reusable qa/learned answer.
export const POSITIONAL_WORK_LABEL = /\b(?:work|professional)\s+experience\s+\d+\b/i;

export const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export const labelOf = field => clean(field.label || field.name || field.ref || 'unlabeled');

// A dropdown trigger's question without the widget's own announcement ("Country * The selected value is:Choose one...")
// or an attached validation message ("… Error: This field is required").
export const questionOf = label => clean(String(label ?? '').replace(/\s*\*?\s*(the selected value is\b|error:\s).*$/is, '').replace(/\s*\*\s*$/, '')) || clean(label);

export const isEmailField = field => field.type === 'email' || (field.tag === 'input' && ['text', ''].includes(field.type ?? '')
  && /\b(?:email|e mail)\b/.test(answers.normalize(`${field.label ?? ''} ${field.name ?? ''}`)));

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export const isEmpty = field => field.occupied !== true && (field.value == null || String(field.value) === '');

export const fieldType = field => String(field.type ?? '').toLowerCase();

export const isChoiceField = field => field && (field.autocomplete || fieldType(field) === 'select' || field.tag === 'select');

export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A free-text field's character limit: its maxlength, else the largest number in a length rule the site shows for it
// ("Text length should be between 0 and 200"), else a generous default by field kind.
export function limitOf(field) {
  if (field.maxLength > 0) return field.maxLength;
  const rule = /\b(length|characters?|chars?)\b/i.test(field.message ?? '') ? (field.message.match(/\d{2,5}/g) ?? []).map(Number) : [];
  if (rule.length) return Math.max(...rule);
  return fieldType(field) === 'textarea' ? 1500 : 300;
}

// The date part a segmented box takes: its own DOM segment (a Workday spinbutton's `dateSectionMonth-input`, a bare
// "Month"/"YYYY" aria-label or placeholder) when the snapshot exposed one, else its label's last word (Month, Year,
// Day, or MM/YYYY/DD), else — for a choice widget whose question names the part anywhere ("Please select the year you
// anticipate graduating from your academic program.") — that part. The DOM segment comes first because a long group
// question can leave no room for the segment word in the label.
const SEGMENTS = { month: 'month', mm: 'month', m: 'month', year: 'year', yyyy: 'year', yy: 'year', y: 'year', day: 'day', dd: 'day', d: 'day' };
export function datePart(field) {
  if (field.segment && SEGMENTS[field.segment]) return SEGMENTS[field.segment];
  const fromPlaceholder = SEGMENTS[answers.normalize(field.placeholder || '').split(' ').filter(Boolean).at(-1)];
  if (fromPlaceholder) return fromPlaceholder;
  const words = answers.normalize(field.label || field.placeholder || '').split(' ').filter(Boolean);
  const named = words.length ? SEGMENTS[words.at(-1)] : undefined;
  if (named) return named;
  if (isChoiceField(field) && words.length) {
    const tail = words.slice(-8).join(' ');
    for (const part of ['month', 'year', 'day']) if (new RegExp(`\\b${part}\\b`).test(tail)) return part;
  }
  return undefined;
}

// A "today's date" label ("Please enter today's date", "Today's date", "Date signed", "Signature date"). Such a
// field is answered from facts.today, computed at run time, never from a stored qa answer: one remembered under it
// ("today s date" = "10/11/2026") is a past date by the next run, and was submitted as one.
const TODAY_LABEL = /\btoday s date\b|\bdate signed\b|\bsignature date\b|\bdate of signature\b/;
export const isTodayLabel = label => TODAY_LABEL.test(answers.normalize(label));

// A segmented date box (its own label is Month, Year, or Day, or MM/YYYY/DD, alone or after a qualifier such as
// "Start year" / "Education End date month") takes only that part of a stored date ("June 2030", "06/2030",
// "2031-05-24"); typing the whole date into a two-digit box is rejected by the site, and a number box clears it.
// A longer label ending in a segment word ("Have you worked here in the past year") is a date box only when the
// value is a date; a bare segment box given a non-date is a plan error.
export function dateSegment(field, value) {
  const words = answers.normalize(field.label || field.placeholder || '').split(' ').filter(Boolean);
  const part = datePart(field);
  if (!part || /^\d{1,4}$/.test(String(value).trim())) return value;
  if (words.length > 3 && !/\b(19|20)\d{2}\b|\d{1,2}\/\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(String(value))) return value;
  const text = String(value).trim().toLowerCase();
  const year = text.match(/\b(19|20)\d{2}\b/)?.[0];
  const named = MONTHS.findIndex(name => new RegExp(`\\b${name}`).test(text)) + 1;
  const numbers = text.replace(/\b(19|20)\d{2}\b/, ' ').match(/\d{1,2}/g)?.map(Number) ?? [];
  // ISO (2031-05-24) and US (05/24/2031, 06/2030) both put the month before the day. A month-year fact ("May 2029"
  // graduation, "June 2026" job start) names no day: a Day box in its group takes the first of the month.
  const month = named || numbers[0];
  const day = (named ? numbers[0] : numbers[1]) ?? (year && month >= 1 && month <= 12 ? 1 : undefined);
  const pick = { year, month: month >= 1 && month <= 12 ? String(month).padStart(2, '0') : undefined,
    day: day >= 1 && day <= 31 ? String(day).padStart(2, '0') : undefined }[part];
  if (!pick) invalidPlan(`date-segment ${part} of ${labelOf(field)}`);
  // A month list of names ("January" …) takes the name, not its number.
  if (part === 'month') {
    const name = MONTHS[Number(pick) - 1];
    const option = (field.options ?? []).find(option => answers.normalize(option).startsWith(name));
    if (option) return option;
  }
  return pick;
}

// A date part under a question ("…anticipated graduation date? Month", "Start date Year") is a date box, never a text
// question: it takes its part of a stored date. A long label merely ending in a segment word ("Have you worked here
// in the past year?") is still a question. dateStem is the question the box's segments share, without the segment.
export function isDateBox(field) {
  if (!datePart(field)) return false;
  const name = answers.normalize(labelOf(field));
  return /\bdate\b/.test(name) || name.split(' ').length <= 3;
}
export function dateStem(field) {
  return answers.normalize(labelOf(field)).split(' ').filter(Boolean).slice(0, -1).join(' ');
}
// A free-text question that asks for a date or its month/year ("What month and year will you graduate?", "When will
// you graduate? Month") takes the stored date fact like a segmented box: the writer must not compose prose for it.
export const asksDate = field => {
  const name = answers.normalize(labelOf(field));
  return /\b(month|year|date)\b/.test(name)
    && /\b(?:graduat\w*|proposed|anticipated|expected|internship|start|begin|end|completion)\b/.test(name);
};
// The fact key a date question takes, from the question's stem (the label minus its segment word): a graduation
// question (never the high-school one) and an education end/degree-completion date are the stored graduation fact; a
// proposed or internship start date is the internship start; anything else keeps the mapping learned for its stem.
export function dateFactKey(field, learned = {}) {
  const stem = dateStem(field);
  if (/\bgraduat/.test(stem) && !/\bhigh school\b/.test(stem)) return 'facts.graduation';
  if ((/\b(?:education|degree|school)\b/.test(stem) && /\b(?:end|completion|finish)\b/.test(stem))
    || (/\bcompletion\s+date\b/.test(stem) && !/\b(?:work|employ|job|company|role|position)\b/.test(stem))) return 'facts.graduation';
  if (/\bproposed\s+start\b|\binternship\s+(?:start|begin)\b|\b(?:start|begin|available)\s+date\b[^.]{0,40}\binternship\b/.test(stem)) return 'facts.internship_start';
  return learned[stem];
}

// Stable per-screen signature used only for stall detection: labels/types/occupancy, never values — and never refs,
// because a page that re-renders mints new ones, which would read as a different screen and reset every per-screen
// brake (the consult budget, the rule caps, the stall counter) at once. Rows repeating a label ("Remove" on every
// entry row) carry their occurrence index so the rows still tell apart.
const occurrence = rows => {
  const seen = new Map();
  return rows.map(row => {
    const key = JSON.stringify(row);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    return nth ? [...row, nth] : row;
  });
};
export const screenFingerprint = current => JSON.stringify([
  current.url,
  occurrence(current.controls.map(control => [clean(control.label), String(control.type ?? '')])),
  occurrence(current.fields.map(field => [clean(field.label || field.name), fieldType(field), field.occupied === true])),
]);

// The label a field is learned under: its visible label, else its name attribute; never a ref.
export const learnLabel = field => answers.normalize(field.label || field.name || '');

// A label that names a question (at least two words once placeholder/required-marker words are dropped). Bare
// "Month", "Year", or a placeholder like "Select One Required" recur on unrelated questions, so an answer or key
// remembered under them would be reused for the wrong question.
const PLACEHOLDER_WORDS = new Set(['select', 'choose', 'one', 'an', 'option', 'required', 'optional', 'please', 'enter']);

// A job-board search box ("Search for jobs or keywords") is not a question about the applicant.
export const isQuestionLabel = label => !POSITIONAL_WORK_LABEL.test(answers.normalize(label))
  && !/\bsearch (for )?(jobs?|keywords?|positions?|roles?|openings?)\b|\bkeywords?\b/.test(answers.normalize(label))
  && answers.normalize(label).split(' ').filter(word => word && !PLACEHOLDER_WORDS.has(word)).length >= 2;
