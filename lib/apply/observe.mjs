// Snapshot intake for the apply run: retrying mid-navigation snapshots, hiding stale validation
// messages, and remembering abandoned optional fields and completed uploads for the run.
import { snapshot, PageLoading } from '../snapshot.mjs';
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

// The site's own validation outranks the snapshot's reading of the markup. An empty field the page says must be
// filled ("Address2 is required" in a message, or a described-by "This field is required") is required whatever its
// attributes claim: sites that mark required fields in no readable way (a bare class name, a colour) say so the
// moment a step is tried without the field. A filled field a non-emptiness message names is rejected, so its value
// may be replaced like an aria-invalid one.
function markBySite(current) {
  for (const field of current.fields) {
    const label = labelOf(field);
    if (isEmpty(field)) {
      if (EMPTINESS.test(messageFor(current, label) ?? '') || EMPTINESS.test(field.message ?? '')) field.required = true;
      continue;
    }
    if (rejectionFor(current, label)) field.invalid = true;
    // aria-invalid that only restates a stale "required" message is the same leftover.
    else if (field.invalid && messageFor(current, label) && !field.autocomplete) field.invalid = false;
  }
  return current;
}

// One field's identity on a screen, without its ref: two fields sharing one label (the address block's Country and
// an education entry's) are told apart by their occurrence among the same-label fields in document order, and a
// re-render that re-mints refs keeps the identity. The fill ladder and the abandoned-field set key on it.
export function fieldIdentity(snap, field) {
  const label = learnLabel(field);
  const same = (snap?.fields ?? []).filter(candidate => learnLabel(candidate) === label);
  const index = same.findIndex(candidate => candidate === field || candidate.ref === field.ref);
  return `${label}#${index < 0 ? same.length : index}`;
}

// The same element across snapshots: its ref (a live element keeps the one it was stamped with), else the identity a
// re-render preserves (see findField).
export function sameElement(before, after) {
  return Boolean(before && after && (before.ref === after.ref
    || ['tag', 'type', 'label', 'name'].every(key => before[key] === after[key])));
}

// A snapshot taken mid-navigation (redirect chains after sign-up/login) is retried until the page settles.
// Optional fields given up on this run, by `${url}|${fieldIdentity}` (see needsField).
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
      if (abandonedFields.size) current.fields = current.fields.filter(field => field.required || !abandonedFields.has(`${page.url()}|${fieldIdentity(current, field)}`));
      dropStaleUploadMessages(current);
      return markBySite(current);
    } catch (error) {
      // A navigation in flight (snapshot's PageLoading, a destroyed context) is waited out, not reported: 8 tries of
      // snapshot's own 10 s main-frame wait is well over any form step's page load. A main frame still without a
      // world after four of them is a navigation the renderer dropped (seen under memory pressure right after
      // Workday's "Apply Manually"): the page is reloaded once before the remaining tries.
      if (attempt >= 8 || !(error instanceof PageLoading || /navigation|execution context|cannot find context|frame.*detach|context.*destroy|target closed/i.test(String(error?.message)))) throw error;
      if (error instanceof PageLoading && attempt === 3) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
      await delay(500);
    }
  }
}
