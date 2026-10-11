// Field/control selection and visibility rules: fillable predicates, the active form, and where
// values and generated secrets may be shown or offered.

import { secretForm } from "../rules.mjs";

// ---------------------------------------------------------------------------
// Field/control selection helpers.
// ---------------------------------------------------------------------------

export function isFileField(f) {
  return f.type === "file";
}

export function isPasswordField(f) {
  return f.type === "password";
}

// Same emptiness rule as the executor: `occupied` is set for password/file
// fields; other fields report their current value.
export function isOccupied(f) {
  return f.occupied === true || (f.value != null && String(f.value) !== "");
}

// Fillable = visible/enabled (snapshot already guarantees), not occupied,
// not a password, not a file input.
export function isFillable(f) {
  return (!isOccupied(f) || f.invalid === true) && !isPasswordField(f) && !isFileField(f);
}

// The active form is the formRef group holding the most empty fillable
// fields; ties go to the group seen first in the snapshot. Fields without a
// formRef group under "".
export function activeFormRef(fields) {
  const counts = new Map();
  for (const f of fields) {
    if (!isFillable(f)) continue;
    const key = f.formRef ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount) { best = key; bestCount = n; }
  }
  return best;
}

// Field values are shown to Jev except passwords, files, and anything in an account-security form (a password field
// or a security question on it), where text inputs may hold generated secrets.
export function valueVisible(snapshot, field) {
  if (isPasswordField(field) || isFileField(field)) return false;
  return !secretForm(snapshot.fields, field);
}

// Generated account secrets are offered only for text fields that share a form
// with a password field (an account form). The executor re-checks this rule.
export function secretAllowed(snapshot, field) {
  const type = String(field.type ?? "").toLowerCase();
  // A security-question picker takes any question (the executor picks a distinct one).
  if (type === "select" && /\b(security|secret|challenge|recovery) question\b/i.test(String(field.label ?? ""))) return true;
  if (field.tag !== "input" || !["text", ""].includes(type)) return false;
  return secretForm(snapshot.fields, field);
}
