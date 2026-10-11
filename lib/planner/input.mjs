// Caller input validation and the bounded prompt-data projection for planner consults.

import { MAX_PROMPT_BYTES, MAX_RECENT_LINES, MAX_RECENT_CHARS } from './limits.mjs';

function invalidInput(reason = 'shape') {
  throw new Error(`Planner input is invalid or exceeds the safe prompt limit (${reason}).`);
}

function text(value) {
  if (typeof value !== 'string') invalidInput();
  return value;
}

function strings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalidInput();
  return value;
}

// Caller-supplied Goal object: {goal, done_when, guidance}, all strings.
function goalInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['goal', 'done_when', 'guidance'].includes(key))) invalidInput();
  return { goal: text(value.goal), done_when: text(value.done_when), guidance: text(value.guidance) };
}

// Completed entries may be Goal objects or bare goal strings; render the goal text only.
function completedInput(value) {
  if (!Array.isArray(value)) invalidInput();
  return value.map((item) => (typeof item === 'string' ? item : goalInput(item).goal));
}

function ownership(source, target) {
  if (source.formRef !== undefined) target.formRef = text(source.formRef);
  return target;
}

function occupied(field) {
  return typeof field.occupied === 'boolean' ? field.occupied : Boolean(field.value);
}

export function promptData(snapshot, context) {
  if (!snapshot || !context || !Array.isArray(snapshot.controls) || !Array.isArray(snapshot.fields)) invalidInput();
  let url;
  try {
    url = new URL(snapshot.url);
  } catch {
    invalidInput();
  }
  if (!['http:', 'https:'].includes(url.protocol)) invalidInput(`protocol ${url.protocol}`);
  if (typeof context.resumeAvailable !== 'boolean' || !['none', 'pending', 'created'].includes(context.credential?.status)
      || context.credential.host !== url.hostname) invalidInput('resume/credential context');
  const availableKeys = strings(context.availableKeys);
  if (availableKeys.some((key) => !/^(facts|qa|resume)\..+$/u.test(key))) invalidInput();
  const goals = Array.isArray(context.goals) ? context.goals.map(goalInput) : invalidInput();
  const completed = completedInput(context.completed);
  let escalation = null;
  if (context.escalation !== null) {
    if (!context.escalation || typeof context.escalation !== 'object' || Array.isArray(context.escalation)) invalidInput();
    const recent = strings(context.escalation.recent ?? []);
    escalation = {
      goal: goalInput(context.escalation.goal),
      reason: text(context.escalation.reason),
      recent: recent.slice(0, MAX_RECENT_LINES).map((line) => line.slice(0, MAX_RECENT_CHARS)),
    };
  }

  // Explicit projection: never spread a snapshot/context object, never include href, file paths, or secret
  // metadata, and never serialize a password value. Non-secret field values and stored answers ARE sent, clipped
  // to 300 characters each; the caller supplies an already-scrubbed snapshot/context.
  // Key order is the cache order: DeepSeek bills a prompt prefix it has seen before at ~2% of the input price, so
  // the parts that are the same on every consult (answer keys and their values, ~10k tokens) come first, right
  // after the fixed system prompt, and everything about this screen follows.
  const data = {
    // The answer keys are the keys of answers: no separate key list (it doubled ~30 KB of every consult).
    answers: Object.fromEntries(availableKeys.map((key) => [key, String(context.answerValues?.[key] ?? '').slice(0, 300)])),
    resumeAvailable: context.resumeAvailable,
    url: { host: url.host, pathname: url.pathname },
    title: text(snapshot.title),
    gates: strings(snapshot.gates),
    pageMessages: strings(snapshot.messages ?? []),
    pageText: String(snapshot.pageText ?? '').slice(0, 3000),
    controls: snapshot.controls.map((control) => {
      if (!control || !['button', 'link', 'option'].includes(control.kind)
          || !Number.isInteger(control.formFieldCount) || control.formFieldCount < 0) invalidInput();
      const result = ownership(control, {
        ref: text(control.ref),
        kind: control.kind,
        label: text(control.label),
        formFieldCount: control.formFieldCount,
      });
      if (control.type !== undefined) result.type = text(control.type);
      if (typeof control.expanded === 'boolean') result.expanded = control.expanded;
      if (control.current !== undefined) result.current = text(control.current);
      if (control.selected) result.selected = true;
      if (control.multi) result.multiselect = true;
      return result;
    }),
    fields: snapshot.fields.map((field) => {
      if (!field || typeof field.required !== 'boolean') invalidInput();
      const result = ownership(field, {
        ref: text(field.ref),
        tag: text(field.tag),
        type: field.autocomplete ? 'dropdown (combobox: pick a listed choice, never free text)' : text(field.type),
        label: text(field.label),
        name: text(field.name),
        required: field.required,
        occupied: occupied(field),
      });
      if (field.type !== 'password' && field.value) result.value = String(field.value).slice(0, 300);
      if (field.invalid) result.invalid = true;
      if (field.options !== undefined) result.options = strings(field.options);
      if (Array.isArray(field.optionRefs)) result.optionRefs = field.optionRefs;
      return result;
    }),
    credential: { host: url.hostname, status: context.credential.status },
    goals,
    history: strings(context.history ?? []),
    completed,
    escalation,
  };
  let prompt = JSON.stringify(data);
  // Large forms (long skill/country lists, many open options) can exceed the limit: shrink the bulkiest, least
  // decision-relevant parts in steps instead of failing the run: long option lists, then the history and the
  // page text, then the tail of the control list.
  const shrink = [
    () => {
      for (const field of data.fields) if (field.options?.length > 40) { field.options = field.options.slice(0, 40); delete field.optionRefs; }
      // Open lists keep their first 20 entries (a 254-country list adds nothing the planner needs to pick by key).
      const options = data.controls.filter((control) => control.kind === 'option');
      if (options.length > 20) { const keep = new Set(options.slice(0, 20)); data.controls = data.controls.filter((control) => control.kind !== 'option' || keep.has(control)); }
    },
    () => { data.history = data.history.slice(-20); data.pageText = data.pageText.slice(0, 1500); },
    () => { data.answers = Object.fromEntries(Object.entries(data.answers).map(([key, value]) => [key, value.slice(0, 120)])); },
    () => { data.controls = data.controls.slice(0, 200); },
    // The answer registry grows with every remembered question: past that, only stored questions sharing a word with
    // this screen's fields stay (facts always stay).
    () => {
      const words = new Set(data.fields.flatMap((field) => `${field.label} ${field.name}`.toLowerCase().match(/[a-z]{4,}/g) ?? []));
      data.answers = Object.fromEntries(Object.entries(data.answers).filter(([key]) => !key.startsWith('qa.')
        || (key.match(/[a-z]{4,}/g) ?? []).some((word) => words.has(word))));
    },
    () => { data.controls = data.controls.slice(0, 100); data.fields = data.fields.slice(0, 100); data.pageText = data.pageText.slice(0, 800); },
  ];
  for (const step of shrink) {
    if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_BYTES) break;
    step();
    prompt = JSON.stringify(data);
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) invalidInput(`size ${Buffer.byteLength(prompt, 'utf8')} bytes`);
  return { data, prompt };
}
