// lib/jev.mjs — Jev DRIVER (the OpenRouter Decisions model named by config.models.driver).
//
// See docs/ARCHITECTURE.md: one typed Decisions request per screen → a local action Plan
// plus confidence and goal-done probability. Jev is never a chat model: it picks
// over refs and answer-key names only, never generates free text, and never sees
// passwords, secrets, resume paths, or query strings; bounded non-secret field
// values and stored answer text (each clipped) are sent so choices can be matched.
// Deterministic code here validates every ref/key against the fresh snapshot
// before emitting a Plan.

import { CAP_CONTROLS, CAP_CONTROLS_MAX, CAP_FIELDS, CAP_FIELD_QUESTIONS,
  MIN_NOW, LEADER_MIN, LEADER_MARGIN, PLAN_MIN } from "./jev/constants.mjs";
import { config, driver, decide, num } from "./jev/transport.mjs";
import { isFileField, isFillable, activeFormRef, secretAllowed } from "./jev/fields.mjs";
import { clip, goalParts, buildState } from "./jev/state.mjs";
import { buildQuestions, screenStatus } from "./jev/questions.mjs";

// ---------------------------------------------------------------------------
// drive — the single export. One Decisions request per call; response → Plan.
// ---------------------------------------------------------------------------

// The last request's key and answers (one entry: a run works one screen at a time).
let lastDecision = null;

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
  // Field questions are capped; a rejected value, then a required field, is asked before any optional one (a long
  // Workday screen's optional boxes otherwise take every slot and its empty required dropdown is never asked).
  const urgency = (f) => (f.invalid ? 0 : f.required ? 1 : 2);
  const fillCandidates = formRef === null
    ? []
    : fields.filter((f) => isFillable(f) && (f.formRef ?? "") === formRef && !context.skipFields?.has(f.ref)
        // An autocomplete box whose suggestion list is open is answered by picking a suggestion, never by retyping.
        && !(f.autocomplete && (snapshot.controls ?? []).some((c) => c.kind === "option" && c.ownerRef === f.ref)))
      .sort((a, b) => urgency(a) - urgency(b))
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
        questions[key].instructions.split("Action: ")[1]?.split(" Judge it by the state")[0] ?? key.slice("step:".length)])),
    };
  }
  const request = { model: driver().model, state: buildState(snapshot, context, controls, fields, screenStatus(snapshot, context)), questions };
  // Verdicts are reused while the screen and the questions are unchanged. Every step question is judged on its own
  // (now/later/never per action), so after the executor refuses one action, or after the second look re-reads a
  // page that did not change, the other actions' verdicts already exist: a second request would re-judge byte-
  // identical input (today: one drive call in six, 94% of the second looks coming back as empty as the first).
  // The refusal itself is applied through context.exclude below; history (the only state line that changes) is
  // left out of the key for that reason. Any change on the page, or in the goal, is a new request.
  const key = JSON.stringify({ model: request.model, state: { ...request.state, history: undefined }, questions });
  const reused = lastDecision?.key === key;
  const { answers, cost } = reused ? { answers: lastDecision.answers, cost: 0 } : await decide(request);
  if (!reused) lastDecision = { key, answers };

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
    const text = request.questions[key]?.instructions.split("Action: ")[1]?.split(" Judge it by the state")[0] ?? "";
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
  const trace = { state: request.state, steps, fieldAnswers, goalDone, accountCreated, margin, next: pNext, reused };
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
    state: buildState(snapshot, context, controls, fields, screenStatus(snapshot, context)),
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
