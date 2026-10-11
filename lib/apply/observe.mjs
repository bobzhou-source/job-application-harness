// Snapshot intake for the apply run: retrying mid-navigation snapshots, hiding stale validation
// messages, and remembering abandoned optional fields and completed uploads for the run.
import { snapshot } from '../snapshot.mjs';
import * as answers from '../answers.mjs';
import { delay, isEmpty, fieldType, labelOf, learnLabel } from './fields.mjs';

// A dropdown's status row while a remote search runs or finds nothing; never a choice.
export const LIST_STATUS = /^(searching|loading|no (results|matches|options)( found)?|please enter \d+ or more characters)\b/i;

// A filled field the site's own message names (e.g. "Responsibilities contains emojis") counts as rejected,
// so its value may be replaced like an aria-invalid one. A "required"/"enter a value" message is about emptiness:
// left over from an earlier validation pass (sites revalidate on blur or the next Continue), it never rejects a value.
const EMPTINESS = /\b(is|are) required\b|\brequired field\b|\bcannot be (blank|empty)\b|\bmust not be (blank|empty)\b/i;

export function messageFor(current, label) {
  const name = answers.normalize(label);
  return name.length >= 3 ? (current.messages ?? []).find(message => answers.normalize(message).includes(name)) : undefined;
}

// The site's message rejecting a filled field's value: not an emptiness message, unless it also names a format.
export function rejectionFor(current, label) {
  const message = messageFor(current, label);
  return message && (!EMPTINESS.test(message) || /\b(valid|invalid|format)\b/i.test(message)) ? message : undefined;
}

function markRejected(current) {
  for (const field of current.fields) {
    if (isEmpty(field)) continue;
    if (rejectionFor(current, labelOf(field))) field.invalid = true;
    // aria-invalid that only restates a stale "required" message is the same leftover.
    else if (field.invalid && messageFor(current, labelOf(field)) && !field.autocomplete) field.invalid = false;
  }
  return current;
}

// A snapshot taken mid-navigation (redirect chains after sign-up/login) is retried until the page settles.
// Optional fields given up on this run, by `${url}|${label}` (see needsField).
export const abandonedFields = new Set();

// Normalized labels of file fields this run uploaded to. A site that swaps the file input for the file name keeps
// its earlier "Resume/CV is required" message until the next submit; while no empty file field with that label is
// back, that emptiness message is stale and is hidden from the models (it otherwise drives re-upload loops).
export const uploadedLabels = new Set();

function dropStaleUploadMessages(current) {
  if (!uploadedLabels.size || !current.messages?.length) return;
  const emptySlots = current.fields.filter(field => fieldType(field) === 'file' && isEmpty(field)).map(field => answers.normalize(labelOf(field)));
  current.messages = current.messages.filter(message => {
    const text = answers.normalize(message);
    return !(EMPTINESS.test(message) && [...uploadedLabels].some(label => label && text.includes(label) && !emptySlots.includes(label)));
  });
}

export async function observe(page) {
  for (let attempt = 0; ; attempt++) {
    try {
      const current = await snapshot(page);
      // Multi-select editors clear their search after a pick; their own selection announcement is occupancy.
      for (const field of current.fields) {
        if (field.autocomplete && /\b[1-9]\d* items? selected\b/i.test(field.message ?? '')) field.occupied = true;
        // A field that now holds a value cannot be missing: its own "This field is required" error is left over from an
        // earlier submit (sites re-validate only on the next one), and reading it as a rejection loops on a good fill.
        if (field.invalid && !field.autocomplete && !isEmpty(field) && EMPTINESS.test(field.message ?? '')) {
          field.invalid = false;
          delete field.message;
        }
      }
      // An optional field whose choices could not be committed is left blank: it is dropped from every later view so
      // neither model keeps retrying it, and the application goes on without it.
      if (abandonedFields.size) current.fields = current.fields.filter(field => field.required || !abandonedFields.has(`${page.url()}|${learnLabel(field)}`));
      dropStaleUploadMessages(current);
      return markRejected(current);
    } catch (error) {
      if (attempt >= 8 || !/navigation|execution context|cannot find context|frame.*detach|context.*destroy|target closed/i.test(String(error?.message))) throw error;
      await delay(500);
    }
  }
}
