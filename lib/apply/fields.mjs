// Field and label primitives shared across the apply run: text cleanup, emptiness/type tests, date
// segments, character limits, learned-label normalization, and the stall-detection screen fingerprint.
import * as answers from '../answers.mjs';
import { invalidPlan } from './stop.mjs';

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

// A segmented date box (its own label is Month, Year, or Day, or MM/YYYY/DD, alone or after a short qualifier such
// as "Start year" / "End month") takes only that part of a stored date ("June 2030", "06/2030", "2031-05-24");
// typing the whole date into a two-digit box is rejected by the site.
export function dateSegment(field, value) {
  const words = answers.normalize(field.label || field.placeholder || '').split(' ').filter(Boolean);
  const segments = { month: 'month', mm: 'month', year: 'year', yyyy: 'year', yy: 'year', day: 'day', dd: 'day' };
  const part = words.length && words.length <= 3 ? segments[words.at(-1)] : undefined;
  if (!part || /^\d{1,4}$/.test(String(value).trim())) return value;
  const text = String(value).trim().toLowerCase();
  const year = text.match(/\b(19|20)\d{2}\b/)?.[0];
  const named = MONTHS.findIndex(name => new RegExp(`\\b${name}`).test(text)) + 1;
  const numbers = text.replace(/\b(19|20)\d{2}\b/, ' ').match(/\d{1,2}/g)?.map(Number) ?? [];
  // ISO (2031-05-24) and US (05/24/2031, 06/2030) both put the month before the day.
  const month = named || numbers[0];
  const day = named ? numbers[0] : numbers[1];
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

// Stable per-screen signature used only for stall detection: refs/labels/occupancy, never values.
export const screenFingerprint = current => JSON.stringify([
  current.url,
  current.controls.map(control => [control.ref, clean(control.label)]),
  current.fields.map(field => [field.ref, field.occupied === true]),
]);

// The label a field is learned under: its visible label, else its name attribute; never a ref.
export const learnLabel = field => answers.normalize(field.label || field.name || '');

// A label that names a question (at least two words once placeholder/required-marker words are dropped). Bare
// "Month", "Year", or a placeholder like "Select One Required" recur on unrelated questions, so an answer or key
// remembered under them would be reused for the wrong question.
const PLACEHOLDER_WORDS = new Set(['select', 'choose', 'one', 'an', 'option', 'required', 'optional', 'please', 'enter']);

// A job-board search box ("Search for jobs or keywords") is not a question about the applicant.
export const isQuestionLabel = label => !/\bsearch (for )?(jobs?|keywords?|positions?|roles?|openings?)\b|\bkeywords?\b/.test(answers.normalize(label))
  && answers.normalize(label).split(' ').filter(word => word && !PLACEHOLDER_WORDS.has(word)).length >= 2;
