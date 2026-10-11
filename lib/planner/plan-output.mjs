// Planner output validation: the allowed plan schemas and their per-action checks.

import { MAX_GOALS, MAX_GOAL_CHARS, MAX_GUIDANCE_CHARS } from './limits.mjs';

export class PlanRejected extends Error {}

// `reason` is always a fixed string written here, never model output or page text.
function invalidPlan(reason = 'a shape other than the allowed schemas') {
  throw new PlanRejected(reason);
}

function objectWithKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidPlan();
  if (required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalidPlan();
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Plan strings carry intents and hints only: reject refs, URLs, and code/fences.
function validText(value, maxChars) {
  if (!nonempty(value)) invalidPlan('an empty string');
  if (value.trim().length > maxChars) invalidPlan(`a string longer than ${maxChars} characters`);
  if (/\be\d+\b/i.test(value)) invalidPlan('an element ref such as e12 (describe controls by their label instead)');
  if (/https?:\/\/|\bwww\./i.test(value)) invalidPlan('a URL');
  if (/`/.test(value)) invalidPlan('a backtick');
  return true;
}

function goalOutput(value) {
  objectWithKeys(value, ['goal', 'done_when', 'guidance']);
  return { goal: clippedText(value.goal, MAX_GOAL_CHARS), done_when: clippedText(value.done_when, MAX_GOAL_CHARS), guidance: clippedText(value.guidance, MAX_GUIDANCE_CHARS) };
}

// Plan prose is advisory: over-long text is truncated, not rejected (a rejection here stops the whole run).
function clippedText(value, maxChars) {
  if (!nonempty(value)) invalidPlan('an empty string');
  // A stray element ref in prose ("click e12") carries no meaning to the executor: it is dropped, not fatal.
  const clipped = value.replace(/\s*\(?\be\d+\b\)?/gi, '').trim().slice(0, maxChars);
  validText(clipped, maxChars);
  return clipped;
}

// Exactly one of {actions, note?}, {goals}, {stop, questions?}. Actions answer an escalation: each names a ref
// on the current screen and, for fill, an available key; the executor re-validates every one before acting.
export function parsePlan(output, data) {
  const source = output.trim();
  if (!source.startsWith('{') || !source.endsWith('}') || source.includes('`')) invalidPlan();
  let result;
  try { result = JSON.parse(source); } catch { invalidPlan(); }
  // A plain in-form "captcha" waits for the user at final submit (the executor enforces that); every other gate stops.
  if (data.gates.some((gate) => gate !== 'captcha') && !Object.hasOwn(result, 'stop')) invalidPlan();

  const shapes = ['actions', 'goals', 'stop'].filter((key) => Object.hasOwn(result, key));
  if (shapes.length !== 1) invalidPlan();

  if (shapes[0] === 'goals') {
    objectWithKeys(result, ['goals']);
    if (!Array.isArray(result.goals) || result.goals.length < 1 || result.goals.length > MAX_GOALS) invalidPlan();
    return { goals: result.goals.map(goalOutput) };
  }

  if (shapes[0] === 'actions') {
    objectWithKeys(result, ['actions'], ['note']);
    if (!Array.isArray(result.actions) || result.actions.length < 1 || result.actions.length > 8) invalidPlan('an actions list that is not 1 to 8 items');
    const controlRefs = new Set(data.controls.map((control) => control.ref));
    const fieldRefs = new Set(data.fields.map((field) => field.ref));
    const optionRefs = new Set(data.fields.flatMap((field) => field.optionRefs ?? []));
    const keys = new Set(Object.keys(data.answers));
    // Each action is validated alone: an unusable one is dropped (the executor re-observes after the rest), and
    // only a plan with no usable action is rejected.
    const dropped = [];
    const actions = result.actions.map((action) => { try { return validAction(action); } catch (error) {
      if (!(error instanceof PlanRejected)) throw error;
      dropped.push(error.message);
      return null;
    } }).filter(Boolean);
    if (!actions.length) invalidPlan(dropped[0].replace(/^[^:]*: /, ''));
    return { actions, note: typeof result.note === 'string' ? result.note.trim().slice(0, 300) : '' };
    function validAction(action) {
      if (!action || typeof action !== 'object') invalidPlan('an action that is not an object');
      const { do: kind, ref, key, mode } = action;
      if (kind === 'write') {
        const field = data.fields.find((candidate) => candidate.ref === ref);
        if (!field || !['text', 'textarea', 'email', 'url', 'number', 'search', ''].includes(field.type)) {
          invalidPlan('a write action whose ref is not a free-text field');
        }
        return { do: kind, ref };
      }
      if (kind === 'click' && (controlRefs.has(ref) || data.fields.some(field => field.ref === ref
        && (field.tag === 'select' || field.type === 'select' || /combobox/.test(field.type))))) return { do: kind, ref };
      if (kind === 'check' && (optionRefs.has(ref) || fieldRefs.has(ref))) return { do: kind, ref };
      if (kind === 'upload_resume' && fieldRefs.has(ref)) return { do: kind, ref };
      if (kind === 'fill' && fieldRefs.has(ref) && keys.has(key)) return { do: kind, ref, key };
      // A custom dropdown is a trigger control showing its current selection: "fill" it to pick the matching option.
      if (kind === 'fill' && keys.has(key) && data.controls.some((control) => control.ref === ref && control.current !== undefined)) {
        return { do: 'choose', ref, key };
      }
      if (kind === 'credentials' && ['register', 'login'].includes(mode)) return { do: kind, mode };
      invalidPlan(`an action with an unknown do, ref, or key (${JSON.stringify(action).slice(0, 120)})`);
    }
  }

  objectWithKeys(result, ['stop'], ['questions']);
  const stop = { stop: clippedText(result.stop, MAX_GOAL_CHARS) };
  if (Object.hasOwn(result, 'questions')) {
    if (!Array.isArray(result.questions)) invalidPlan();
    stop.questions = result.questions.map((question) => clippedText(question, MAX_GOAL_CHARS));
  }
  return stop;
}
