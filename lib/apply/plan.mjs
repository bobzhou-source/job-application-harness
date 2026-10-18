// Validating and resolving model plan steps: shape checks, fill/upload target resolution, password
// fields, and re-finding planned targets on a fresh snapshot.
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as answers from '../answers.mjs';
import * as rules from '../rules.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, isEmpty, fieldType, isChoiceField, limitOf, dateSegment, PLACEHOLDER_VALUE } from './fields.mjs';
import { activeFields, PLACEHOLDER_OPTION } from './screen.mjs';
import { routeWorkFill } from './workhistory.mjs';
import { applicationExpectation, applicationAnswerMatches, applicationOption } from '../work-authorization.mjs';

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

// The stored answer as the question's own polarity requires it: the canonical answer when the stored value
// contradicts the question, the stored wording when it agrees. Unknown age truth (no birth date/intake evidence)
// stops the plan instead of filling a guess.
function policyValue(label, status, key, value, values = null, options = []) {
  const expectation = applicationExpectation(label, status, key, value, values, options);
  if (!expectation) return { expectation: null, value };
  if (expectation.answer === null) {
    const reason = expectation.family === 'polarity' ? `unknown-polarity ${label}` : `unknown-answer ${expectation.family} ${label}`;
    invalidPlan(reason);
  }
  const agreed = typeof value === 'string' && applicationAnswerMatches(expectation, value) === true;
  return { expectation, value: agreed ? value : expectation.answer };
}

function currentField(current, ref, correction = null, recommit = null, status = null, values = null) {
  const matches = activeFields(current).filter(field => field.ref === ref);
  if (matches.length !== 1) invalidPlan('field-ownership');
  const field = matches[0];
  if (correction && typeof correction.value === 'string') {
    correction = { key: correction.key, value: policyValue(labelOf(field), status, correction.key, correction.value, values, field.options ?? []).value };
  }
  // A value the site rejected (invalid, or longer than the site's stated limit) may be replaced. So may a value the
  // site prefilled (resume parsing) that contradicts a stored applicant fact ("Fairview" in City, "2020" as the
  // start year): the fact is the truth. Any other occupied field is left alone.
  // A stored question answer (qa.*) contradicts only while the screen reports an issue: an ordinary prefilled
  // value is not churned, but on a flagged screen the stored answer is the truth — the site's own prefill (a
  // resume-parsed dial code, say) is what blocks submission, and re-deciding the widget is the only fix.
  // `recommit` is the stalledRecommit predicate: non-null exactly when the screen stalled or shows an issue.
  // A choice field holds the site's display text ("NY" for New York): it contradicts only when neither text contains
  // the other.
  const shown = answers.normalize(field.value);
  const fact = correction && typeof correction.value === 'string' ? answers.normalize(correction.value) : '';
  const stored = Boolean(correction) && (/^facts\./.test(correction.key) || (/^qa\./.test(correction.key) && Boolean(recommit)));
  const contradicts = correction && fact && ((stored && !shown.includes(fact)
    && (!isChoiceField(field) || !fact.includes(shown)))
    // A catch-all choice ("Other") an earlier run picked is replaced by a stored answer that names something concrete.
    || (isChoiceField(field) && /^(other|others)$/.test(shown) && !/^other\b/.test(fact)));
  if (!isEmpty(field) && !field.invalid && !contradicts && (field.valueLength ?? String(field.value ?? '').length) <= limitOf(field)) {
    // On a screen that has demonstrably stalled (its Continue/Next/Save click changed nothing, or a validation
    // message is showing), an occupied choice field may be re-committed once with the very value it already shows:
    // re-selecting it lets the site's own change handler commit the dependent fields that kept the step from
    // advancing. Any other overwrite (a different value, a text field) stays refused.
    const sameValue = Boolean(fact) && (shown.includes(fact) || fact.includes(shown));
    if (recommit && isChoiceField(field) && sameValue && recommit(field)) return { field, recommit: true };
    invalidPlan('occupied-field');
  }
  return { field };
}

// The re-commit allowance for a demonstrably stalled screen (see currentField): the predicate is null unless the
// screen stalled, so ordinary overwrites are refused. It is pure (a re-commit is spent where the fill dispatches).
export function stalledRecommit(ctx) {
  const stalled = ctx.stepStalled === ctx.screen
    || ctx.current.fields.some(field => field.invalid)
    || (ctx.current.messages ?? []).length > 0;
  if (!stalled) return null;
  return field => !ctx.recommitted.has(`${ctx.screen}|${answers.normalize(labelOf(field))}`);
}

// Spend one field's re-commit (by label, so a re-rendered ref does not re-arm it), once that fill dispatched.
export function recordRecommit(ctx, field) {
  ctx.recommitted.add(`${ctx.screen}|${answers.normalize(labelOf(field))}`);
}

// `secret.generated` fills an account-security field (e.g. a security-question
// answer) with a Keychain-generated value. Allowed only for a text input that
// shares its form with a password field; the value is resolved at execution.
export const SECRET_KEY = 'secret.generated';

export function resolveFill(current, item, values, recommit = null, status = null) {
  item = routeWorkFill(current, item, values);
  const { field, recommit: recommitted = false } = currentField(current, item.ref, values.has(item.key) ? { key: item.key, value: values.get(item.key) } : null, recommit, status, values);
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
  const stored = values.get(item.key);
  const corrected = policyValue(labelOf(field), status, item.key, stored, values, field.options ?? []);
  let value = corrected.value;
  let optionRef;
  // Equivalents saved for this answer (aliases.json: CA/California, Male/Man, veteran wording) are exact site
  // spellings, not guesses. A native select or radio offering one of them can be answered here without a model.
  const variants = [...new Set([value, ...[...values].filter(([name]) => name.startsWith(`${item.key}.alias_`)).map(([, alias]) => alias)]
    .map(alias => String(alias ?? '').trim()).filter(Boolean))];
  const sameOption = (option, candidate) => String(option).trim().toLowerCase() === candidate.toLowerCase()
    || answers.normalize(option) === answers.normalize(candidate);
  // A custom dropdown (Workday's "Select One" button) lists no options until it opens: the executor matches the
  // policy value against the opened list and stops on no match (execute.mjs), so only a listed set is checked here.
  // A native select whose only listed value is its placeholder is in the same state: checking the placeholder list
  // refused the standard questions with "no-polarity-option"/"no-workauth-option" instead of letting the opened
  // list answer them.
  const listed = (field.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option))
    && !PLACEHOLDER_VALUE.test(String(option)));
  if (type === 'select' && listed.length) {
    if (corrected.expectation) {
      const option = applicationOption(labelOf(field), field.options, status, item.key, stored, values);
      if (!option) invalidPlan(`no-${corrected.expectation.family}-option ${labelOf(field)}`);
      value = option;
    } else {
      const option = listed.find(candidate => variants.some(alias => sameOption(candidate, alias)));
      if (option) value = String(option).trim();
    }
  }
  if (type === 'radio' || type === 'checkbox') {
    if (!Array.isArray(field.options) || !Array.isArray(field.optionRefs)
      || field.options.length !== field.optionRefs.length) invalidPlan('option-group');
    if (corrected.expectation) {
      const option = applicationOption(labelOf(field), field.options, status, item.key, stored, values);
      if (!option) invalidPlan(`no-${corrected.expectation.family}-option ${labelOf(field)}`);
      const index = field.options.indexOf(option);
      optionRef = field.optionRefs[index];
      if (index < 0 || typeof optionRef !== 'string' || !optionRef
        || field.optionRefs.filter(ref => ref === optionRef).length !== 1) invalidPlan('option-ref');
      return { field, key: item.key, value: option, optionRef, recommit: recommitted };
    }
    // Exact text first; else the same words ignoring case and punctuation ("…employee." vs "…employee").
    let indexes = field.options.flatMap((option, index) => variants.some(alias => sameOption(option, alias)) ? [index] : []);
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
  return { field, key: item.key, value: dateSegment(field, value), optionRef, recommit: recommitted };
}

// The file input a planned upload targets and the document it asks for (rules.documentKind). Resumes, generated
// cover letters, and the configured transcript can be attached; a writing sample or unnamed extra attachment has no stored file.
export function documentField(current, ref, resumeAvailable, transcriptAvailable = false) {
  // A file input may live outside any form (e.g. an upload dialog in its own frame); empty-field rules still apply.
  const files = current.fields.filter(candidate => fieldType(candidate) === 'file');
  const field = files.find(candidate => candidate.ref === ref);
  if (!field || fieldType(field) !== 'file') invalidPlan('resume-field');
  if (!isEmpty(field)) invalidPlan('occupied-field');
  const kind = rules.documentKind(field, files.length);
  if (kind === 'resume' && !resumeAvailable) invalidPlan('resume-unavailable');
  if (kind === 'transcript' && !transcriptAvailable) invalidPlan('transcript-unavailable');
  if (!['resume', 'cover', 'transcript'].includes(kind)) invalidPlan(`no-stored-${kind}`);
  return { field, kind };
}

// The employer's instructions for an upload slot ("Instructions from employer: Include: …"), as the snapshot keeps
// them in full for file inputs; else the slot's own ask for a document to be written ("a brief research supplement
// describing a relevant project you recently completed"), which names what the document must cover; '' when the
// slot carries neither.
export function instructionsOf(field) {
  const text = String(field.instructions ?? '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\binstructions?(?: from (?:the )?employer)?\s*:\s*(.+)/i) ?? text.match(/\b((?:include|attach|provide|submit)\s*:.+)/i);
  if (match && match[1].trim().length >= 15) return match[1].trim();
  if (text.length >= 40 && /\b(describ|explain|summari[sz]|outline|discuss)\w*\b/i.test(text) && rules.documentKind(field) === 'other') return text;
  return '';
}

export function passwordFields(current) {
  const fields = activeFields(current).filter(field => fieldType(field) === 'password');
  if (new Set(fields.map(field => field.formRef ?? '')).size > 1) throw new Stop('credential-form-ambiguous');
  return fields;
}

// Identity never includes `required`: a site's validation upgrades a field to required mid-batch (Workday's date
// segments after the first one is typed), and the element is the same one it was.
export function sameTarget(expected, actual) {
  const keys = ['ref', 'formRef', 'kind', 'tag', 'type', 'label', 'name', 'href', 'formFieldCount', 'options', 'optionRefs'];
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
  const keys = ['tag', 'type', 'label', 'name', 'options'];
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
