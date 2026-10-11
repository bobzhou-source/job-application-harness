// lib/jev.mjs — Jev DRIVER (the OpenRouter Decisions model named by config.models.driver).
//
// See docs/ARCHITECTURE.md: one typed Decisions request per screen → a local action Plan
// plus confidence and goal-done probability. Jev is never a chat model: it picks
// over refs and answer-key names only, never generates free text, and never sees
// passwords, secrets, resume paths, or query strings; bounded non-secret field
// values and stored answer text (each clipped) are sent so choices can be matched.
// Deterministic code here validates every ref/key against the fresh snapshot
// before emitting a Plan.

import * as runlog from "./trace.mjs";
import { classifyControl, documentKind, secretForm } from "./rules.mjs";
import { loadConfig, requireSecret } from "./config.mjs";

// Driver settings come from the ignored config.json (backend openrouter-decisions); the loader caches and freezes it.
let configCache;
function config() {
  return (configCache ??= loadConfig());
}
function driver() {
  return config().models.driver;
}

const CAP_CONTROLS = 60;
const CAP_CONTROLS_MAX = 80;
const CAP_FIELDS = 40;
const CAP_LABEL = 120;
const CAP_FIELD_QUESTIONS = 8;
const CAP_STEP_QUESTIONS = 40;
const CAP_CHECKBOX_QUESTIONS_PER_GROUP = 8;
// Minimum now-probability for the strongest action; below it the driver has no clear step.
const MIN_NOW = 0.5;
const LEADER_MIN = 0.3;
const LEADER_MARGIN = 0.25;
const PLAN_MIN = 0.6;

const STEP_CRITERIA = {
  now: "Do it now: it is a valid next step and nothing must happen first.",
  later: "Needed, but only after other required steps on this screen are done.",
  never: "Not needed for this goal, redundant, already done, or harmful.",
};

// ---------------------------------------------------------------------------
// The driver's key comes from the environment variable the config names
// (.env); nothing is read from a credential database, and it is never logged.
// ---------------------------------------------------------------------------

function openRouterKey() {
  return requireSecret(driver().apiKeyEnv);
}

// ---------------------------------------------------------------------------
// One Decisions POST. Response parsing mirrors legacy liveJevDecide: unknown
// answer types (e.g. a future primitive) are dropped, never guessed.
// ---------------------------------------------------------------------------

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Rate limits (429) and transient server errors (5xx) are retried with backoff, honoring Retry-After,
// for up to ~2 minutes; every attempt is metered so telemetry shows the retries.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

async function decide(request, purpose = "drive") {
  let response;
  let body;
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    try {
      response = await fetch(driver().endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${await openRouterKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      runlog.meter("jev", { purpose, ms: Date.now() - started, ok: false });
      throw error;
    }
    const usage = typeof body === "object" && body !== null && typeof body.usage === "object" && body.usage !== null ? body.usage : {};
    runlog.meter("jev", {
      purpose, ms: Date.now() - started, ok: response.ok, cost: num(usage.cost),
      input: num(usage.prompt_tokens ?? usage.input_tokens), output: num(usage.completion_tokens ?? usage.output_tokens),
    });
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= RETRY_DELAYS_MS.length) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : RETRY_DELAYS_MS[attempt];
    const line = `JEV RETRY HTTP ${response.status} in ${Math.round(wait / 1000)}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`;
    console.log(line);
    runlog.trace("log", { line });
    await Bun.sleep(wait);
  }
  if (!response.ok || typeof body !== "object" || body === null || !("answers" in body) || typeof body.answers !== "object" || body.answers === null) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null
      && "message" in body.error && typeof body.error.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`jev decisions failed: ${message}`);
  }
  const answers = {};
  for (const [key, value] of Object.entries(body.answers)) {
    if (typeof value !== "object" || value === null || !("type" in value)) continue;
    if (value.type === "noul" && "noul" in value && typeof value.noul === "number") answers[key] = { type: "noul", noul: value.noul };
    if (value.type === "choice" && "choice" in value && typeof value.choice === "string") {
      answers[key] = {
        type: "choice",
        choice: value.choice,
        confidence: "confidence" in value ? num(value.confidence) : 0,
        probabilities: "probabilities" in value && typeof value.probabilities === "object" && value.probabilities !== null
          ? Object.fromEntries(Object.entries(value.probabilities).map(([option, p]) => [option, num(p)]))
          : {},
      };
    }
  }
  const cost = "usage" in body && typeof body.usage === "object" && body.usage !== null && "cost" in body.usage ? num(body.usage.cost) : 0;
  return { answers, cost };
}

// ---------------------------------------------------------------------------
// Bounded snapshot state. Passwords, secrets, resume paths, and query strings
// never appear; refs, labels, types, occupied booleans, key names, and clipped
// non-secret values (≤120 chars) are sent.
// ---------------------------------------------------------------------------

function clip(s, cap = CAP_LABEL) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
}

// ARIA comboboxes are text inputs in the DOM but dropdowns to the applicant; name them as such.
function shownType(f) {
  return f.autocomplete ? "dropdown (combobox: pick a listed choice)" : clip(f.type ?? f.tag);
}

// context.goal is a Goal object {goal, done_when, guidance} from the planner.
function goalParts(context) {
  const g = context.goal ?? {};
  return {
    goal: clip(g.goal),
    done_when: clip(g.done_when),
    guidance: clip(g.guidance, 800),
  };
}

function buildState(snapshot, context, shownControls, shownFields) {
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
    url: { host, path },
    title: clip(snapshot.title),
    gates: Array.isArray(snapshot.gates) ? snapshot.gates.slice(0, 8) : [],
    // Validation/error banners the site is showing now; they explain why a continue click did not advance.
    pageMessages: (snapshot.messages ?? []).slice(0, 8).map((m) => clip(m, 300)),
    // Visible page text (untrusted data): reveals collapsed sections, "Required" notes, and progress not shown as controls.
    pageText: String(snapshot.pageText ?? "").slice(0, 2500),
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
    answers: context.availableKeys.slice(0, 80).map((k) => `${clip(k)} = "${clip(context.answerValues?.[k] ?? "")}"`),
    history: (context.history ?? []).slice(-8).map((line) => clip(line, 200)),
    resumeAvailable: !!context.resumeAvailable,
    credential: { host: clip(context.credential?.host ?? ""), status: context.credential?.status ?? "none" },
  };
}

// ---------------------------------------------------------------------------
// Field/control selection helpers.
// ---------------------------------------------------------------------------

function isFileField(f) {
  return f.type === "file";
}

function isPasswordField(f) {
  return f.type === "password";
}

// Same emptiness rule as the executor: `occupied` is set for password/file
// fields; other fields report their current value.
function isOccupied(f) {
  return f.occupied === true || (f.value != null && String(f.value) !== "");
}

// Fillable = visible/enabled (snapshot already guarantees), not occupied,
// not a password, not a file input.
function isFillable(f) {
  return (!isOccupied(f) || f.invalid === true) && !isPasswordField(f) && !isFileField(f);
}

// The active form is the formRef group holding the most empty fillable
// fields; ties go to the group seen first in the snapshot. Fields without a
// formRef group under "".
function activeFormRef(fields) {
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

// ---------------------------------------------------------------------------
// Questions: `step:<action>` (now/later/never), `field:<ref>` (choice, ≤8), `goal_done` (noul).
// ---------------------------------------------------------------------------

function buildQuestions(snapshot, context, shownControls, fillCandidates) {
  // Credentials are offered only while a password field is still empty; a filled one means that step is done.
  const hasPassword = (snapshot.fields ?? []).some((f) => isPasswordField(f) && !isOccupied(f));
  const accountStatus = context.credential?.status ?? "none";
  const allFiles = (snapshot.fields ?? []).filter(isFileField);
  // Only documents the executor can attach: the resume and a generated cover letter (never a transcript or extra file).
  const fileFields = allFiles.filter((f) => !isOccupied(f) && ["resume", "cover"].includes(documentKind(f, allFiles.length)));

  const g = goalParts(context);
  // Custom dropdowns: a popup trigger's `current` text is its selection. An option already
  // selected by a different trigger in the same form is a duplicate choice.
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const popups = (snapshot.controls ?? []).filter((c) => c.current !== undefined);
  const optionNote = (o) => {
    const label = norm(o.label);
    const field = (snapshot.fields ?? []).find((f) => f.ref === o.ownerRef);
    if (field) {
      const typed = context.typed?.[field.ref];
      const intent = typed ? `the stored answer "${clip(typed)}"` : "the applicant's stored answer for that field";
      return ` It is one of the choices listed for the field "${clip(field.label)}"; choose it now if it means the same as ${intent} (e.g. "Bachelor of Arts" matches "Bachelor's degree"). A non-choice like "No matches" never fits.`;
    }
    const owner = popups.find((p) => p.ref === o.ownerRef);
    if (owner && norm(owner.current) === label) return " It is already this list's current choice; choosing it changes nothing.";
    if (popups.some((p) => p.ref !== o.ownerRef && (p.formRef ?? "") === (o.formRef ?? "") && norm(p.current) === label)) {
      return " It is already chosen in another dropdown on this form; prefer a different option.";
    }
    // Unowned options that appeared right after a click belong to the list that click opened.
    if (!o.ownerRef && !owner && context.openedBy) {
      return ` It is one of the choices in the list just opened from "${clip(context.openedBy)}". Choose it now only if it states the same fact as the stored answer for that question (see answers, e.g. a stored "None" means choose "None", never "Other"); a catch-all like "Other" fits only when no listed choice matches.`;
    }
    return "";
  };
  const nextCriteria = {};
  for (const c of shownControls) {
    // A chosen option in a multi-select list: clicking it again un-chooses it, never a forward step.
    if (c.kind === "option" && c.multi && c.selected) continue;
    const name = `"${clip(c.label)}" ${clip(c.kind ?? "control")}`;
    const shows = c.current !== undefined ? ` (currently showing "${clip(c.current)}")` : "";
    nextCriteria[`click:${c.ref}`] = c.kind === "option"
      ? `Choose the option "${clip(c.label)}" from the open list.${c.multi ? " The list allows several choices; each click ticks one more." : ""}${optionNote(c)}`
      : c.expanded === true
        ? `Click the ${name}${shows}; its list is already open, so clicking it again only closes the list without choosing anything.`
        : c.expanded === false
          ? `Click the ${name}${shows} to open its list of choices.`
          : `Click the ${name}.`;
  }
  if (fillCandidates.length > 0 && context.availableKeys.length > 0) {
    nextCriteria.fill = `Fill one or more empty non-password fields (${fillCandidates.map((f) => `"${clip(f.label) || f.ref}"`).join(", ")}) using the answers chosen in the field questions.`;
  }
  for (const f of fileFields) {
    nextCriteria[`upload:${f.ref}`] = documentKind(f, allFiles.length) === "cover"
      ? `Upload a cover letter tailored to this posting (the harness writes it) to the file field "${clip(f.label) || f.ref}" (${clip(f.context ?? "")}). A cover-letter slot is always filled, even when optional.`
      : `Upload the applicant's actual resume file to the file field "${clip(f.label) || f.ref}". When the page asks for a résumé/CV, this upload is preferred over "use my profile", saved, cloud, or social-import alternatives.`;
  }
  // Unticked checkbox options (neutral entry flags such as "This is my most recent education") and the options
  // of radio groups with nothing selected. A single large multi-select group cannot consume the global question
  // budget: retain a bounded set from each checkbox group, while radio groups keep every choice.
  // The executor refuses consent/attestation boxes.
  for (const f of snapshot.fields ?? []) {
    const type = String(f.type ?? "").toLowerCase();
    if (!["checkbox", "radio"].includes(type) || !Array.isArray(f.optionRefs)) continue;
    if (type === "radio" && f.checkedRefs?.length) continue;
    let checkboxQuestions = 0;
    f.optionRefs.forEach((ref, i) => {
      if (!ref || f.checkedRefs?.includes(ref)) return;
      if (type === "checkbox" && checkboxQuestions >= CAP_CHECKBOX_QUESTIONS_PER_GROUP) return;
      const option = clip(f.options?.[i] ?? "");
      const label = clip(f.label);
      nextCriteria[`check:${ref}`] = type === "radio"
        ? `Select the choice "${option}" for the question "${label}". Prefer the choice matching a stored answer; when none is stored, a reasonable or decline-to-answer choice.`
        : `Tick the unticked checkbox ${option && option !== label ? `"${option}" for "${label}"` : `"${label || option}"`}. Tick only options the stored answers support (e.g. languages the applicant speaks), respect any "select 1-N" limit counting boxes already ticked, and answer optional questions too.`;
      if (type === "checkbox") checkboxQuestions += 1;
    });
  }
  if (hasPassword) {
    const passwordLabels = (snapshot.fields ?? []).filter(isPasswordField).map((f) => `"${clip(f.label) || f.ref}"`).join(", ");
    if (accountStatus === "created") {
      nextCriteria["credentials:login"] = `Log in: fill the stored password of the confirmed existing employer account into the password field(s) ${passwordLabels} of this sign-in form.`;
    } else if (accountStatus === "pending") {
      nextCriteria["credentials:login"] = `Log in with the stored password of an account whose registration was started but never confirmed, into the password field(s) ${passwordLabels}; only if the site says that account already exists.`;
    }
    nextCriteria["credentials:register"] = accountStatus === "pending"
      ? `Continue the unconfirmed account registration: fill its already-generated password into the password field(s) ${passwordLabels} (including any re-enter/confirm password field).`
      : `Create a new employer account password: generate one and fill it into the empty password field(s) ${passwordLabels} (including any re-enter/confirm password field).`;
  } else if ((snapshot.fields ?? []).some(isPasswordField)) {
    // Filled password fields: re-entering is the recovery when the site rejects them (e.g. "doesn't match").
    const passwordLabels = (snapshot.fields ?? []).filter(isPasswordField).map((f) => `"${clip(f.label) || f.ref}"`).join(", ");
    nextCriteria[accountStatus === "created" ? "credentials:login" : "credentials:register"] = accountStatus === "created"
      ? `Clear and re-enter the stored password into ${passwordLabels}; only when the page says the password is wrong, invalid, or does not match.`
      : `Clear and re-enter the account password into every password field ${passwordLabels} so they match; only when the page says the password does not match, is invalid, or misses a requirement.`;
  }

  // One now/later/never question per candidate action: independent verdicts, so several
  // interchangeable valid actions (e.g. any unused dropdown option) do not split probability.
  // Forward/final controls must survive the global cap even when a checkbox group is large.
  // After those: non-click actions and radio choices, open-list options, form controls,
  // checkbox choices, then the rest.
  const rank = (key) => {
    if (key.startsWith("click:")) {
      const c = shownControls.find((x) => `click:${x.ref}` === key);
      if (["step", "final-submit"].includes(classifyControl(c))) return 0;
      if (c?.kind === "option") return 2;
      return c?.formRef ? 3 : 5;
    }
    if (key.startsWith("check:")) {
      const ref = key.slice("check:".length);
      const field = (snapshot.fields ?? []).find((f) => f.optionRefs?.includes(ref));
      return String(field?.type ?? "").toLowerCase() === "checkbox" ? 4 : 1;
    }
    return 1;
  };
  const actionKeys = Object.keys(nextCriteria).sort((a, b) => rank(a) - rank(b)).slice(0, CAP_STEP_QUESTIONS);
  const questions = {
    goal_done: {
      type: "noul",
      instructions: `Does the goal's done condition "${g.done_when}" (for active goal "${g.goal}") already hold on this screen, with no further action needed for it?`,
      criteria: { true: "The goal is already achieved on this screen.", false: "The goal still needs an action on this screen." },
    },
  };
  // Only while a registration is unconfirmed and its password form is gone: does the account now exist?
  if (accountStatus === "pending" && !hasPassword) {
    questions.account_created = {
      type: "noul",
      instructions: "An employer account registration was submitted earlier. Does this screen show that the account now exists (signed-in view, welcome or profile page, application form under the account, or an 'account created' / 'verify your email' message)?",
      criteria: {
        true: "The screen shows the account exists or the applicant is signed in.",
        false: "The screen shows a registration error, the registration form, or nothing about the account.",
      },
    };
  }
  // Completeness fact, so a Done/Save/Continue control is judged "now" once nothing required remains.
  const pending = (snapshot.fields ?? []).filter((f) => f.required && (!isOccupied(f) || f.invalid) && !isFileField(f));
  // Optional fields and empty entry sections are never skipped: an empty optional field, or an "Add" control of an
  // Education / Work Experience / Websites section, comes before any Done/Save/Continue on this screen.
  // Fields the executor already knows no stored answer fits (context.skipFields) are neither listed nor asked about.
  const optional = (snapshot.fields ?? []).filter((f) => !f.required && !isOccupied(f) && !isFileField(f)
    && !["password", "checkbox", "radio"].includes(shownType(f)) && !context.skipFields?.has(f.ref));
  const addable = (snapshot.controls ?? []).filter((c) => /^add\b/i.test(String(c.label ?? "").trim()));
  const status = [
    pending.length
      ? `Required fields still empty or rejected on this screen: ${pending.slice(0, 8).map((f) => `"${clip(f.label) || f.ref}"`).join(", ")}.`
      : "Every required field on this screen is filled and none is rejected.",
    optional.length
      ? `Optional fields still empty: ${optional.slice(0, 8).map((f) => `"${clip(f.label) || f.ref}"`).join(", ")}; fill each one a stored answer covers before any Done/Save/Continue.`
      : "",
    addable.length
      ? `Entry sections with an Add control: ${addable.slice(0, 6).map((c) => `"${clip(c.label)}"`).join(", ")}; an Education, Work Experience, or Websites section that shows no entry yet gets one added from the stored answers (school, major, degree, graduation; employer, job title, job dates; LinkedIn) before continuing, even when optional.`
      : "",
    !pending.length && !optional.length && !addable.length
      ? "So a Done/Save/Continue control that commits this entry or page is the next action."
      : "",
  ].filter(Boolean).join(" ");
  for (const key of actionKeys) {
    questions[`step:${key}`] = {
      type: "choice",
      instructions: `Active goal: "${g.goal}". Planner guidance: "${g.guidance}". ${status} Action: ${nextCriteria[key]} Given what is already filled and selected on this screen, the page messages (a validation message names what is still missing; clicking continue again will not help until that is fixed), and the recent attempts in history (do not repeat an attempt whose outcome shows it failed), when should this action happen?`,
      criteria: STEP_CRITERIA,
    };
  }

  const keyCriteria = {};
  for (const k of context.availableKeys.slice(0, 80)) {
    keyCriteria[k] = `Fill this field with the stored answer ${clip(k)} = "${clip(context.answerValues?.[k] ?? "")}".`;
  }
  keyCriteria.none = "Leave this field empty: no stored answer states exactly the fact this question asks (a related fact is not enough — work authorization does not answer citizenship, a country does not answer residency, a yes/no about one topic never answers another).";
  const secretCriteria = {
    ...keyCriteria,
    "secret.generated": "This is an account-security field (e.g. a security-question answer or account-recovery secret): generate a random secret, store it in Keychain, and fill it.",
  };

  for (const f of fillCandidates) {
    questions[`field:${f.ref}`] = {
      type: "choice",
      instructions: f.invalid
        ? `The site rejected the value in the field "${clip(f.label) || f.ref}" (type ${shownType(f)}); see pageText for its error message. Which stored answer, in the format that field asks for (e.g. a bare year for a year field), should replace it?`
        : `Which stored answer belongs in the empty field "${clip(f.label) || f.ref}" (type ${shownType(f)}${Array.isArray(f.options) ? `; choices: ${f.options.slice(0, 12).map((o) => `"${clip(o)}"`).join(", ")}` : ""})? The key name and value must state the very fact the question asks; otherwise choose none. For choice fields the value must equal one of the choices. When several answers hold the same fact in different formats, pick the format the field label asks for (e.g. a bare year for "Graduation year").`,
      criteria: !secretAllowed(snapshot, f) ? keyCriteria
        : shownType(f) === "select" || String(f.type ?? "").toLowerCase() === "select"
          ? { ...keyCriteria, "secret.generated": "This dropdown picks an account-recovery security question: any question is acceptable, the harness picks one and stores its answer in Keychain. Choose this for every security-question dropdown." }
          : secretCriteria,
    };
  }
  return questions;
}

// Field values are shown to Jev except passwords, files, and anything in an account-security form (a password field
// or a security question on it), where text inputs may hold generated secrets.
function valueVisible(snapshot, field) {
  if (isPasswordField(field) || isFileField(field)) return false;
  return !secretForm(snapshot.fields, field);
}

// Generated account secrets are offered only for text fields that share a form
// with a password field (an account form). The executor re-checks this rule.
function secretAllowed(snapshot, field) {
  const type = String(field.type ?? "").toLowerCase();
  // A security-question picker takes any question (the executor picks a distinct one).
  if (type === "select" && /\b(security|secret|challenge|recovery) question\b/i.test(String(field.label ?? ""))) return true;
  if (field.tag !== "input" || !["text", ""].includes(type)) return false;
  return secretForm(snapshot.fields, field);
}

// ---------------------------------------------------------------------------
// drive — the single export. One Decisions request per call; response → Plan.
// ---------------------------------------------------------------------------

// A stored answer that matches no listed choice of a fixed dropdown: Jev picks the choice that states the
// same fact, or none. `preferences` lists acceptable answers in the applicant's order of preference (the answer,
// then its aliases); the choice closest to the earliest one wins. Returns the option text, or null.
export async function pickOption(question, answer, options, preferences = [answer]) {
  const listed = options.slice(0, 40);
  const prefs = [...new Set(preferences.map((p) => clip(p)))].slice(0, 12);
  const criteria = Object.fromEntries(listed.map((option, i) => [`o${i + 1}`, `The choice "${clip(option)}".`]));
  criteria.none = "No listed choice states the same fact as the stored answer.";
  const { answers } = await decide({
    model: driver().model,
    state: { question: clip(question), storedAnswer: clip(answer, 300), acceptableInPreferenceOrder: prefs, choices: listed.map((option) => clip(option)) },
    questions: {
      choice: {
        type: "choice",
        instructions: `The dropdown "${clip(question)}" has fixed choices. The applicant's stored answer is "${clip(answer, 300)}"; acceptable answers in the applicant's order of preference are: ${prefs.map((p) => `"${p}"`).join(", ")}. Choose the listed choice that best matches the EARLIEST acceptable answer it can match (a choice matching an earlier answer beats a closer match to a later one; a broad category such as "Other" only when nothing listed matches any acceptable answer). Choose none only if no choice fits.`,
        criteria,
      },
    },
  }, "pick");
  const result = answers.choice;
  if (config().runtime.debug) process.stderr.write(`pickOption ${JSON.stringify(result ?? answers)}\n`);
  if (!result || result.type !== "choice") return null;
  // Accept the most probable listed choice when it clearly beats "none" (a leader rule, like drive's).
  const p = result.probabilities ?? {};
  const best = Object.keys(criteria).filter((key) => key !== "none").sort((a, b) => num(p[b]) - num(p[a]))[0];
  if (!best || num(p[best]) < 0.35 || num(p[best]) <= num(p.none)) return null;
  return listed[Number(best.slice(1)) - 1] ?? null;
}

export async function drive(snapshot, context) {
  // Keep the default cap unless open listbox options would be truncated; then
  // raise it (bounded) so the option choices stay visible.
  const allControls = snapshot.controls ?? [];
  let controlCap = CAP_CONTROLS;
  if (allControls.length > controlCap
      && allControls.slice(controlCap, CAP_CONTROLS_MAX).some((c) => c.kind === "option")) {
    controlCap = CAP_CONTROLS_MAX;
  }
  const controls = allControls.slice(0, controlCap);
  const fields = (snapshot.fields ?? []).slice(0, CAP_FIELDS);
  const formRef = activeFormRef(fields);
  const fillCandidates = formRef === null
    ? []
    : fields.filter((f) => isFillable(f) && (f.formRef ?? "") === formRef && !context.skipFields?.has(f.ref)
        // An autocomplete box whose suggestion list is open is answered by picking a suggestion, never by retyping.
        && !(f.autocomplete && (snapshot.controls ?? []).some((c) => c.kind === "option" && c.ownerRef === f.ref)))
      .slice(0, CAP_FIELD_QUESTIONS);

  const questions = buildQuestions(snapshot, context, controls, fillCandidates);
  // Jev reasons internally and answers with probabilities. Independent now/later/never verdicts spread probability
  // across interchangeable valid actions, so a low top "now" is not confusion. The same request also asks Jev to
  // weigh the candidates against each other ("which ONE action"): its argmax is the step when no verdict leads.
  const stepKeys = Object.keys(questions).filter((key) => key.startsWith("step:"));
  const g = goalParts(context);
  if (stepKeys.length > 1) {
    questions.next = {
      type: "choice",
      instructions: `Plan the applicant's next move on this screen toward the active goal "${g.goal}" (done when: ${g.done_when}). Guidance: "${g.guidance}". Read the page messages (a validation message names exactly what is still missing; continuing again will not help until it is fixed), what is already filled and selected, and the history of recent attempts and their outcomes (never repeat an attempt whose outcome shows it failed). Which ONE action makes real progress now?`,
      criteria: Object.fromEntries(stepKeys.map((key) => [key.slice("step:".length),
        questions[key].instructions.split("Action: ")[1]?.split(" Given what")[0] ?? key.slice("step:".length)])),
    };
  }
  const request = { model: driver().model, state: buildState(snapshot, context, controls, fields), questions };
  const { answers, cost } = await decide(request);

  const done = answers.goal_done;
  const goalDone = done && done.type === "noul" ? done.noul : 0;
  const created = answers.account_created;
  const accountCreated = created && created.type === "noul" ? created.noul : 0;

  // The strongest "now" action wins; its now-probability is the confidence.
  // `steps` keeps every verdict (sorted by now) for the run trace.
  const steps = [];
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith("step:") || answer.type !== "choice") continue;
    const p = answer.probabilities ?? {};
    const text = request.questions[key]?.instructions.split("Action: ")[1]?.split(" Given what")[0] ?? "";
    steps.push({ action: key.slice("step:".length), text, now: num(p.now), later: num(p.later), never: num(p.never) });
  }
  steps.sort((a, b) => b.now - a.now);
  const fieldAnswers = Object.fromEntries(fillCandidates.map((f) => [f.ref, answers[`field:${f.ref}`]?.choice ?? null]));
  const fillable = Object.values(fieldAnswers).some((c) => c && c !== "none");
  // Refused actions never win; neither does a fill when every field question answered "none".
  const eligible = steps.filter((s) => !context.exclude?.has(s.action) && (s.action !== "fill" || fillable));
  const verdict = eligible[0];
  // A clear leader (well ahead of every other eligible action) is acted on below MIN_NOW.
  const margin = (verdict?.now ?? 0) - (eligible[1]?.now ?? 0);
  const accepted = verdict && (verdict.now >= MIN_NOW || (verdict.now >= LEADER_MIN && margin >= LEADER_MARGIN));
  // No leading verdict: Jev's own "which ONE action" ranking decides when it is decisive (>= PLAN_MIN). A weak
  // ranking is noise that wanders off the form (home, search, other postings), so the executor consults instead.
  const pNext = answers.next?.type === "choice" ? answers.next.probabilities ?? {} : {};
  const ranked = accepted ? [verdict]
    : eligible.filter((s) => s.never < 0.9 && num(pNext[s.action]) >= PLAN_MIN).sort((a, b) => num(pNext[b.action]) - num(pNext[a.action]));
  const trace = { state: request.state, steps, fieldAnswers, goalDone, accountCreated, margin, next: pNext };
  for (const step of ranked) {
    const plan = planFor(step.action, snapshot, context, controls, fields, fillCandidates, answers);
    if (!plan) continue;
    const confidence = accepted ? step.now : num(pNext[step.action]);
    return { plan, confidence, goalDone, accountCreated, cost, trace, planned: !accepted };
  }
  // Nothing valid to do (every action refused, judged never needed, or invalid) → the executor consults the planner.
  return { plan: null, confidence: verdict?.now ?? 0, goalDone, accountCreated, cost, trace };
}

// A choice key → executable Plan, validated against the snapshot the decision was made on. Refs may themselves
// contain ":" (child-frame refs), so match by prefix.
function planFor(choice, snapshot, context, controls, fields, fillCandidates, answers) {
  if (choice.startsWith("click:")) {
    const ref = choice.slice("click:".length);
    return controls.some((c) => c.ref === ref) ? { action: "click", ref } : null;
  }
  if (choice.startsWith("upload:")) {
    const ref = choice.slice("upload:".length);
    return fields.some((f) => f.ref === ref && isFileField(f)) ? { action: "upload_resume", ref } : null;
  }
  if (choice.startsWith("check:")) {
    const ref = choice.slice("check:".length);
    return fields.some((f) => Array.isArray(f.optionRefs) && f.optionRefs.includes(ref)) ? { action: "check", ref } : null;
  }
  if (choice === "credentials:login" || choice === "credentials:register") {
    return { action: "credentials", mode: choice.endsWith(":login") ? "login" : "register" };
  }
  if (choice === "fill") {
    const out = [];
    for (const f of fillCandidates) {
      const a = answers[`field:${f.ref}`];
      if (!a || a.type !== "choice" || a.choice === "none") continue;
      const secret = a.choice === "secret.generated" && secretAllowed(snapshot, f);
      if (!secret && !context.availableKeys.includes(a.choice)) continue;
      out.push({ ref: f.ref, key: a.choice });
    }
    return out.length > 0 ? { action: "fill", fields: out } : null;
  }
  return null;
}

// Jev as planner: when the independent now/later/never verdicts leave no clear step, Jev weighs the same candidate
// actions against each other in one choice ("which ONE action makes real progress now"), reading the page messages
// and the attempt history. Replaces most DeepSeek consults (~0.4 s and ~$0.0002 each vs ~9 s and ~$0.006). `tried`
// holds actions this planner already chose on this screen without progress; they are never offered again.
export async function plan(snapshot, context, previous, tried = new Set()) {
  const allControls = snapshot.controls ?? [];
  const controls = allControls.slice(0, allControls.length > CAP_CONTROLS
    && allControls.slice(CAP_CONTROLS, CAP_CONTROLS_MAX).some((c) => c.kind === "option") ? CAP_CONTROLS_MAX : CAP_CONTROLS);
  const fields = (snapshot.fields ?? []).slice(0, CAP_FIELDS);
  const fillCandidates = (snapshot.fields ?? []).filter((f) => previous.trace.fieldAnswers?.[f.ref] !== undefined);
  const fillable = Object.values(previous.trace.fieldAnswers ?? {}).some((c) => c && c !== "none");
  const candidates = (previous.trace.steps ?? []).filter((s) => !context.exclude?.has(s.action) && !tried.has(s.action)
    && (s.action !== "fill" || fillable) && s.never < 0.9);
  if (candidates.length < 1) return { plan: null, confidence: 0, choice: null };
  const g = goalParts(context);
  const request = {
    model: driver().model,
    state: previous.trace.state,
    questions: {
      next: {
        type: "choice",
        instructions: `You are planning the applicant's next move on this screen toward the active goal "${g.goal}" (done when: ${g.done_when}). Guidance: "${g.guidance}". Read the page messages (a validation message names exactly what is still missing; continuing again will not help until it is fixed), what is already filled and selected, and the history of recent attempts and their outcomes (never repeat an attempt whose outcome shows it failed). Which ONE action makes real progress now?`,
        criteria: Object.fromEntries(candidates.map((s) => [s.action, s.text || s.action])),
      },
    },
  };
  const { answers } = await decide(request, "plan");
  const p = answers.next?.type === "choice" ? answers.next.probabilities ?? {} : {};
  const ranked = candidates.map((s) => s.action).sort((a, b) => num(p[b]) - num(p[a]));
  // Field answers come from the drive call: a planned fill reuses its per-field verdicts.
  const fieldAnswers = Object.fromEntries(Object.entries(previous.trace.fieldAnswers ?? {}).map(([ref, choice]) => [`field:${ref}`, { type: "choice", choice }]));
  for (const choice of ranked) {
    const planned = planFor(choice, snapshot, context, controls, fields, fillCandidates, fieldAnswers);
    if (planned) return { plan: planned, confidence: num(p[choice]), choice };
  }
  return { plan: null, confidence: 0, choice: null };
}

// Jev selects a plan: given candidate plans ({id, goal, done_when, guidance}), which one should the applicant
// pursue now on this screen? Jev reasons internally over the same bounded state it drives on; the chosen plan
// becomes the active goal. Returns the plan and its probability, or null when no plan is offered.
export async function selectPlan(snapshot, context, plans) {
  if (!plans.length) return null;
  const controls = (snapshot.controls ?? []).slice(0, CAP_CONTROLS_MAX);
  const fields = (snapshot.fields ?? []).slice(0, CAP_FIELDS);
  const criteria = Object.fromEntries(plans.map((p) => [p.id, `${clip(p.goal, 200)} (done when: ${clip(p.done_when, 200)}). How: ${clip(p.guidance, 400)}`]));
  const { answers } = await decide({
    model: driver().model,
    state: buildState(snapshot, context, controls, fields),
    questions: {
      plan: {
        type: "choice",
        instructions: "The applicant is completing a job application and the last attempts on this screen did not make progress. Read the page messages (a validation message or issue count names exactly what blocks progress), which fields and entries are filled, any open list or entry form, and the recent attempts and their outcomes. Which ONE plan should the applicant pursue now to make progress?",
        criteria,
      },
    },
  }, "select-plan");
  const p = answers.plan?.type === "choice" ? answers.plan.probabilities ?? {} : {};
  const best = plans.slice().sort((a, b) => num(p[b.id]) - num(p[a.id]))[0];
  return best && num(p[best.id]) > 0 ? { plan: best, probability: num(p[best.id]) } : null;
}
