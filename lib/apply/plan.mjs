// Validating and resolving model plan steps: shape checks, fill/upload target resolution, password
// fields, and re-finding planned targets on a fresh snapshot.
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as answers from '../answers.mjs';
import * as rules from '../rules.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, isEmpty, fieldType, isChoiceField, limitOf, dateSegment } from './fields.mjs';
import { activeFields } from './screen.mjs';

function exactShape(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export function validatePlan(plan, values) {
  if (!plan || typeof plan !== 'object') invalidPlan('shape');
  const shapes = {
    click: ['action', 'ref'],
    fill: ['action', 'fields'],
    upload_resume: ['action', 'ref'],
    check: ['action', 'ref'],
    credentials: ['action', 'mode'],
    choose: ['action', 'ref', 'key'],
  };
  if (!Object.hasOwn(shapes, plan.action) || !exactShape(plan, shapes[plan.action])) invalidPlan('shape');
  if (['click', 'upload_resume', 'check', 'choose'].includes(plan.action) && (typeof plan.ref !== 'string' || !plan.ref)) invalidPlan('ref');
  if (plan.action === 'choose' && !values.has(plan.key)) invalidPlan('choose-key');
  if (plan.action === 'credentials' && !['login', 'register'].includes(plan.mode)) invalidPlan('credential-mode');
  if (plan.action === 'fill') {
    if (!Array.isArray(plan.fields) || !plan.fields.length || plan.fields.length > 8) invalidPlan('fill-batch');
    const refs = new Set();
    for (const item of plan.fields) {
      if (!exactShape(item, ['ref', 'key']) || typeof item.ref !== 'string' || !item.ref || typeof item.key !== 'string'
        || !(values.has(item.key) || item.key === SECRET_KEY) || refs.has(item.ref)) invalidPlan('fill-field');
      refs.add(item.ref);
    }
  }
}

function currentField(current, ref, correction = null) {
  const matches = activeFields(current).filter(field => field.ref === ref);
  if (matches.length !== 1) invalidPlan('field-ownership');
  const field = matches[0];
  // A value the site rejected (invalid, or longer than the site's stated limit) may be replaced. So may a value the
  // site prefilled (resume parsing) that contradicts a stored applicant fact ("Fairview" in City, "2020" as the
  // start year): the fact is the truth. Any other occupied field is left alone.
  // A choice field holds the site's display text ("NY" for New York): it contradicts only when neither text contains
  // the other.
  const shown = answers.normalize(field.value);
  const fact = correction && typeof correction.value === 'string' ? answers.normalize(correction.value) : '';
  const contradicts = correction && fact && ((/^facts\./.test(correction.key) && !shown.includes(fact)
    && (!isChoiceField(field) || !fact.includes(shown)))
    // A catch-all choice ("Other") an earlier run picked is replaced by a stored answer that names something concrete.
    || (isChoiceField(field) && /^(other|others)$/.test(shown) && !/^other\b/.test(fact)));
  if (!isEmpty(field) && !field.invalid && !contradicts && (field.valueLength ?? String(field.value ?? '').length) <= limitOf(field)) invalidPlan('occupied-field');
  return field;
}

// `secret.generated` fills an account-security field (e.g. a security-question
// answer) with a Keychain-generated value. Allowed only for a text input that
// shares its form with a password field; the value is resolved at execution.
export const SECRET_KEY = 'secret.generated';

export function resolveFill(current, item, values) {
  const field = currentField(current, item.ref, values.has(item.key) ? { key: item.key, value: values.get(item.key) } : null);
  const type = fieldType(field);
  if (item.key === SECRET_KEY) {
    // A security-question picker: any question will do; the executor picks a distinct one per picker.
    if ((type === 'select' || field.tag === 'select') && /\b(security|secret|challenge|recovery) question\b/i.test(labelOf(field))) {
      return { field, key: item.key, value: null, secretChoice: true };
    }
    if (field.tag !== 'input' || !['text', ''].includes(type) || !rules.secretForm(current.fields, field)) invalidPlan('secret-target');
    return { field, key: item.key, value: null, secret: true };
  }
  if (['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'].includes(type) || !values.has(item.key)) invalidPlan('fill-target');
  const value = values.get(item.key);
  let optionRef;
  if (type === 'radio' || type === 'checkbox') {
    if (!Array.isArray(field.options) || !Array.isArray(field.optionRefs)
      || field.options.length !== field.optionRefs.length) invalidPlan('option-group');
    // Exact text first; else the same words ignoring case and punctuation ("…employee." vs "…employee").
    let indexes = field.options.flatMap((option, index) => String(option).trim().toLowerCase() === value.trim().toLowerCase() ? [index] : []);
    if (!indexes.length) indexes = field.options.flatMap((option, index) => answers.normalize(option) === answers.normalize(value) ? [index] : []);
    // A checkbox group ("select all that apply") with a list answer ("English, Spanish"): the first unchecked
    // option the list names as whole words, parentheticals dropped; the remaining named options are ticked next.
    if (!indexes.length && type === 'checkbox' && field.options.length > 1) {
      const listed = ` ${answers.normalize(value)} `;
      indexes = field.options.flatMap((option, index) => {
        const text = answers.normalize(String(option).replace(/\([^)]*\)/g, ' '));
        return text && listed.includes(` ${text} `) && !field.checkedRefs?.includes(field.optionRefs[index]) ? [index] : [];
      }).slice(0, 1);
    }
    if (indexes.length !== 1) invalidPlan(`unmatched-option ${labelOf(field)}`);
    optionRef = field.optionRefs[indexes[0]];
    if (typeof optionRef !== 'string' || !optionRef
      || field.optionRefs.filter(ref => ref === optionRef).length !== 1) invalidPlan('option-ref');
  }
  return { field, key: item.key, value: dateSegment(field, value), optionRef };
}

// The file input a planned upload targets and the document it asks for (rules.documentKind). Resumes and generated
// cover letters can be attached; a transcript, writing sample, or unnamed extra attachment has no stored file.
export function documentField(current, ref, resumeAvailable) {
  // A file input may live outside any form (e.g. an upload dialog in its own frame); empty-field rules still apply.
  const files = current.fields.filter(candidate => fieldType(candidate) === 'file');
  const field = files.find(candidate => candidate.ref === ref);
  if (!field || fieldType(field) !== 'file') invalidPlan('resume-field');
  if (!isEmpty(field)) invalidPlan('occupied-field');
  const kind = rules.documentKind(field, files.length);
  if (kind === 'resume' && !resumeAvailable) invalidPlan('resume-unavailable');
  if (kind !== 'resume' && kind !== 'cover') invalidPlan(`no-stored-${kind}`);
  return { field, kind };
}

// The employer's instructions for an upload slot ("Instructions from employer: Include: …"), as the snapshot keeps
// them in full for file inputs; '' when the slot carries none.
export function instructionsOf(field) {
  const text = String(field.instructions ?? '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\binstructions?(?: from (?:the )?employer)?\s*:\s*(.+)/i) ?? text.match(/\b((?:include|attach|provide|submit)\s*:.+)/i);
  return match && match[1].trim().length >= 15 ? match[1].trim() : '';
}

export function passwordFields(current) {
  const fields = activeFields(current).filter(field => fieldType(field) === 'password');
  if (new Set(fields.map(field => field.formRef ?? '')).size > 1) throw new Stop('credential-form-ambiguous');
  return fields;
}

export function sameTarget(expected, actual) {
  const keys = ['ref', 'formRef', 'kind', 'tag', 'type', 'label', 'name', 'href', 'required', 'formFieldCount', 'options', 'optionRefs'];
  const changed = keys.find(key => JSON.stringify(expected[key]) !== JSON.stringify(actual?.[key]));
  if (changed) invalidPlan(`stale-target ${changed} of ${clean(labelOf(expected)).slice(0, 60)}`);
}

// The ref a planned field has on a fresh snapshot. Sites re-render a whole group after one answer (new nodes, new
// refs), so a field missing or changed at its ref is re-found as the one fresh field with the same identity (form,
// tag, type, label, name, options); none or several is stale.
export function freshRef(fresh, field) {
  const atRef = fresh.fields.find(candidate => candidate.ref === field.ref);
  if (atRef) {
    try { sameTarget(field, atRef); return field.ref; } catch {}
  }
  const keys = ['tag', 'type', 'label', 'name', 'required', 'options'];
  const same = fresh.fields.filter(candidate => keys.every(key => JSON.stringify(field[key]) === JSON.stringify(candidate[key])));
  if (same.length !== 1) invalidPlan(`stale-target ${same.length} matches for ${clean(labelOf(field)).slice(0, 60)}`);
  return same[0].ref;
}

export async function resumeIsReadable(path) {
  if (typeof path !== 'string' || !path) return false;
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}
