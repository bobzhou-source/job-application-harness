// Bounded snapshot state sent to the driver: clipping, shown types, goal parts, and the state object.

import { CAP_LABEL } from "./constants.mjs";
import { isOccupied, valueVisible } from "./fields.mjs";
import { offeredKeys } from "./keys.mjs";

// ---------------------------------------------------------------------------
// Bounded snapshot state. Passwords, secrets, resume paths, and query strings
// never appear; refs, labels, types, occupied booleans, key names, and clipped
// non-secret values (≤120 chars) are sent.
// ---------------------------------------------------------------------------

export function clip(s, cap = CAP_LABEL) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
}

// Keep both ends of a long text within the same character budget: the per-section "Fields to fix: N" markers that
// say which sections are still incomplete are the LAST lines of a long form, so a head-only cut hides them.
function headTail(s, cap) {
  const text = String(s ?? "");
  if (text.length <= cap) return text;
  const marker = "\n…\n";
  const tail = Math.max(0, Math.floor(cap * 0.4) - marker.length);
  return text.slice(0, cap - tail - marker.length) + marker + text.slice(-tail);
}

// ARIA comboboxes are text inputs in the DOM but dropdowns to the applicant; name them as such.
export function shownType(f) {
  return f.autocomplete ? "dropdown (combobox: pick a listed choice)" : clip(f.type ?? f.tag);
}

// context.goal is a Goal object {goal, done_when, guidance} from the planner.
export function goalParts(context) {
  const g = context.goal ?? {};
  return {
    goal: clip(g.goal),
    done_when: clip(g.done_when),
    guidance: clip(g.guidance, 800),
  };
}

export function buildState(snapshot, context, shownControls, shownFields, progress = "") {
  let host = "", path = "";
  try {
    const u = new URL(snapshot.url);
    host = u.host;
    path = u.pathname;
  } catch { /* leave empty */ }
  const g = goalParts(context);
  return {
    goal: g.goal,
    done_when: g.done_when,
    guidance: g.guidance,
    // The screen's progress line (questions.mjs screenStatus): which required/optional fields and Add sections are open.
    progress: clip(progress, 1200),
    url: { host, path },
    title: clip(snapshot.title),
    gates: Array.isArray(snapshot.gates) ? snapshot.gates.slice(0, 8) : [],
    // Validation/error banners the site is showing now; they explain why a continue click did not advance.
    pageMessages: (snapshot.messages ?? []).slice(0, 8).map((m) => clip(m, 300)),
    // Visible page text (untrusted data): reveals collapsed sections, "Required" notes, and progress not shown as controls.
    pageText: headTail(snapshot.pageText ?? "", 2500),
    controls: shownControls.map((c) =>
      [c.ref, clip(c.label), clip(c.kind ?? c.type ?? "control"), c.formRef ?? "",
       c.current !== undefined ? `currently "${clip(c.current)}"` : ""].join(" | ")),
    fields: shownFields.map((f) =>
      [f.ref, clip(f.label), shownType(f), f.required ? "required" : "optional",
       isOccupied(f) ? "occupied" : "empty",
       f.invalid ? "INVALID (site rejected this value)" : "",
       valueVisible(snapshot, f) && f.value ? `value "${clip(f.value)}"` : "",
       f.autocomplete ? "autocomplete: the site keeps only a value picked from its suggestion list" : "",
      Array.isArray(f.options) ? f.options.slice(0, 12).map((o) => clip(o)).join(", ") : ""].join(" | ")),
    // The offered facts and the qa answers relevant to this screen's questions (lib/jev/keys.mjs), each with its value.
    answers: offeredKeys(context.availableKeys, [...shownFields.map((f) => f.label), ...shownControls.filter((c) => c.current !== undefined).map((c) => c.label)])
      .map((k) => `${clip(k)} = "${clip(context.answerValues?.[k] ?? "")}"`),
    history: (context.history ?? []).slice(-8).map((line) => clip(line, 200)),
    resumeAvailable: !!context.resumeAvailable,
    credential: { host: clip(context.credential?.host ?? ""), status: context.credential?.status ?? "none" },
  };
}
