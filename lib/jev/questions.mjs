// Question construction: one step:<action> now/later/never question per candidate action, field:<ref>
// answer-key choices, and the goal_done noul, with per-action criteria text; screenStatus is the state's progress line.

import { CAP_STEP_QUESTIONS, CAP_CHECKBOX_QUESTIONS_PER_GROUP } from "./constants.mjs";
import { classifyControl, documentKind } from "../rules.mjs";
import { clip, shownType, goalParts } from "./state.mjs";
import { isPasswordField, isOccupied, isFileField, secretAllowed } from "./fields.mjs";
import { relevantFacts, relevantQa } from "./keys.mjs";

// The screen's progress line, stated once in the state (state.progress) so a Done/Save/Continue control is judged
// "now" exactly when nothing required remains. Optional fields and empty entry sections are never skipped: an empty
// optional field, or an "Add" control of an Education / Work Experience / Websites section, comes before any
// Done/Save/Continue on this screen. Fields the executor already knows no stored answer fits (context.skipFields)
// are neither listed nor asked about.
export function screenStatus(snapshot, context) {
  const pending = (snapshot.fields ?? []).filter((f) => f.required && (!isOccupied(f) || f.invalid) && !isFileField(f));
  const optional = (snapshot.fields ?? []).filter((f) => !f.required && !isOccupied(f) && !isFileField(f)
    && !["password", "checkbox", "radio"].includes(shownType(f)) && !context.skipFields?.has(f.ref));
  const addable = (snapshot.controls ?? []).filter((c) => /^add\b/i.test(String(c.label ?? "").trim()));
  return [
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
}

const STEP_CRITERIA = {
  now: "Do it now: it is a valid next step and nothing must happen first.",
  later: "Needed, but only after other required steps on this screen are done.",
  never: "Not needed for this goal, redundant, already done, or harmful.",
};

// ---------------------------------------------------------------------------
// Questions: `step:<action>` (now/later/never), `field:<ref>` (choice, ≤8), `goal_done` (noul).
// ---------------------------------------------------------------------------

export function buildQuestions(snapshot, context, shownControls, fillCandidates) {
  // Credentials are offered only while a password field is still empty; a filled one means that step is done.
  const hasPassword = (snapshot.fields ?? []).some((f) => isPasswordField(f) && !isOccupied(f));
  const accountStatus = context.credential?.status ?? "none";
  const allFiles = (snapshot.fields ?? []).filter(isFileField);
  // Only documents the executor can attach: the resume, a generated cover letter, and the configured transcript (never an extra file).
  const fileFields = allFiles.filter((f) => !isOccupied(f) && ["resume", "cover", ...(context.transcriptAvailable ? ["transcript"] : [])].includes(documentKind(f, allFiles.length)));

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
    const kind = documentKind(f, allFiles.length);
    nextCriteria[`upload:${f.ref}`] = kind === "cover"
      ? `Upload a cover letter tailored to this posting (the harness writes it) to the file field "${clip(f.label) || f.ref}" (${clip(f.context ?? "")}). A cover-letter slot is always filled, even when optional.`
      : kind === "transcript"
        ? `Upload the applicant's unofficial transcript to the file field "${clip(f.label) || f.ref}" (${clip(f.context ?? "")}). A transcript slot is always filled, even when optional.`
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
  for (const key of actionKeys) {
    questions[`step:${key}`] = {
      type: "choice",
      // The goal's guidance and the screen's progress (state.guidance, state.progress) are stated once in the state,
      // not repeated in each of the ~10–20 step questions of a screen read.
      instructions: `Active goal: "${g.goal}". Action: ${nextCriteria[key]} Judge it by the state: the planner guidance, the progress line (which required and optional fields and Add sections are still open), what is already filled and selected on this screen, the page messages (a validation message names what is still missing; clicking continue again will not help until that is fixed), and the recent attempts in history (do not repeat an attempt whose outcome shows it failed). When should this action happen?`,
      criteria: STEP_CRITERIA,
    };
  }

  // Each field question offers only the facts and the qa answers relevant to that field's own question
  // (lib/jev/keys.mjs). The state already lists the union for this screen; repeating every applicant fact in every
  // field question was most of a questionnaire's prompt.
  const describe = (k) => `${clip(k)} = "${clip(context.answerValues?.[k] ?? "")}"`;
  const noneCriterion = "Leave this field empty: no stored answer states exactly the fact this question asks (a related fact is not enough).";
  const criteriaFor = (f) => {
    const keyCriteria = {};
    for (const k of [...relevantFacts(context.availableKeys, f.label), ...relevantQa(context.availableKeys, f.label)]) keyCriteria[k] = describe(k);
    keyCriteria.none = noneCriterion;
    if (!secretAllowed(snapshot, f)) return keyCriteria;
    return shownType(f) === "select" || String(f.type ?? "").toLowerCase() === "select"
      ? { ...keyCriteria, "secret.generated": "This dropdown picks an account-recovery security question: any question is acceptable, the harness picks one and stores its answer in Keychain. Choose this for every security-question dropdown." }
      : { ...keyCriteria, "secret.generated": "This is an account-security field (e.g. a security-question answer or account-recovery secret): generate a random secret, store it in Keychain, and fill it." };
  };

  for (const f of fillCandidates) {
    questions[`field:${f.ref}`] = {
      type: "choice",
      instructions: f.invalid
        ? `The site rejected the value in the field "${clip(f.label) || f.ref}" (type ${shownType(f)}); see pageText for its error message. Which stored answer, in the format that field asks for (e.g. a bare year for a year field), should replace it?`
        : `Which stored answer belongs in the empty field "${clip(f.label) || f.ref}" (type ${shownType(f)})? The state lists its choices, if any. The key name and value must state the very fact the question asks; otherwise choose none. For choice fields the value must equal one of the choices. When several answers hold the same fact in different formats, pick the format the field label asks for (e.g. a bare year for "Graduation year").`,
      criteria: criteriaFor(f),
    };
  }
  return questions;
}
