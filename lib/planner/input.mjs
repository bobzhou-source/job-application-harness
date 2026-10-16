// Caller input validation and the bounded prompt-data projection for planner consults.

import { MAX_PROMPT_BYTES, MAX_RECENT_LINES, MAX_RECENT_CHARS, MAX_FIELD_OPTIONS, MAX_OPTION_CHARS,
  MAX_FIELD_VALUE_CHARS, MAX_ANSWER_CHARS, MAX_GUIDANCE_CHARS, MIN_ANSWER_BYTES } from './limits.mjs';
import { normalize } from '../answers.mjs';

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

// Keep both ends of a long text within the same character budget: a page's own section/issue markers ("Fields to
// fix: 3") are its LAST lines, so a head-only cut hides exactly the part the models need.
function headTail(text, cap) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  const marker = '\n…\n';
  const tail = Math.max(0, Math.floor(cap * 0.4) - marker.length);
  return s.slice(0, cap - tail - marker.length) + marker + s.slice(-tail);
}

function clipValues(values, cap) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.slice(0, cap)]));
}

// Screen relevance for the answer registry: the words a qa key must share to be worth sending (the visible field
// labels/names plus the page text), and the keys that are exactly this screen's question (the registryKey
// lib/apply/choose.mjs would look up and apply).
function screenRank(data) {
  // Same key the executor would look up: `qa.<normalize(labelOf(field))>` (lib/apply/choose.mjs), including
  // labelOf's own label → name → ref fallback for a field with no visible question.
  const exact = new Set(data.fields.map((field) => `qa.${normalize(field.label || field.name || field.ref || '')}`));
  const words = new Set(normalize(`${data.fields.map((field) => `${field.label} ${field.name}`).join(' ')} ${data.pageText ?? ''}`)
    .split(' ').filter((word) => word.length >= 4));
  return { exact, words };
}

// Rank the qa registry most-relevant-first: this screen's own question keys, then keys sharing 4+ letter words with
// it (more shared words first, shortest key on a tie). Deterministic: never insertion order alone.
function rankedQaKeys(data) {
  const { exact, words } = screenRank(data);
  const shared = (key) => normalize(key).split(' ').filter((word) => word.length >= 4 && words.has(word)).length;
  return Object.keys(data.answers).filter((key) => key.startsWith('qa.'))
    .map((key) => ({ key, exact: exact.has(key) ? 1 : 0, shared: shared(key) }))
    .sort((a, b) => (b.exact - a.exact) || (b.shared - a.shared) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.key);
}

// Drop the least relevant qa keys until the answers object fits `budget` bytes. answers is the biggest and the only
// monotonically growing part of every consult, so it is what gives way; facts/resume (identity and the applicant's
// own prose) are never dropped, and the surviving keys keep their order, so the DeepSeek cache prefix survives.
function fitAnswers(data, budget) {
  const order = rankedQaKeys(data);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (Buffer.byteLength(JSON.stringify(data.answers), 'utf8') <= budget) return;
    delete data.answers[order[i]];
  }
}

// The boolean word filter the shrink ladder used to apply: past a certain size only stored questions sharing a word
// with this screen stay (facts always stay).
function relevantAnswers(data) {
  const { words } = screenRank(data);
  return Object.fromEntries(Object.entries(data.answers).filter(([key]) => !key.startsWith('qa.')
    || normalize(key).split(' ').filter((word) => word.length >= 4).some((word) => words.has(word))));
}

// Per-class byte sizes, for a future over-limit failure to be diagnosable without a rerun. Sizes only, no page text.
function sizes(value) {
  return ['answers', 'fields', 'controls', 'history', 'pageText', 'pageMessages', 'goals', 'escalation', 'completed']
    .map((key) => `${key} ${Buffer.byteLength(JSON.stringify(value[key] ?? null), 'utf8')}`).join(', ');
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
    pageText: headTail(snapshot.pageText ?? '', 3000),
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
      // A per-field option list is context, not a decision: the planner picks by answer key, and 20 entries say what
      // the question offers as well as 254 do. optionRefs must stay exactly as long as options right here, because
      // parsePlan validates a `check` action against the refs the prompt actually carried.
      if (field.options !== undefined) {
        result.options = strings(field.options).slice(0, MAX_FIELD_OPTIONS).map((option) => option.slice(0, MAX_OPTION_CHARS));
      }
      if (Array.isArray(field.optionRefs)) result.optionRefs = field.optionRefs.slice(0, Math.min(MAX_FIELD_OPTIONS, result.options?.length ?? MAX_FIELD_OPTIONS));
      return result;
    }),
    credential: { host: url.hostname, status: context.credential.status },
    goals,
    history: strings(context.history ?? []).map((line) => line.slice(0, MAX_RECENT_CHARS)),
    completed,
    escalation,
  };
  const size = () => Buffer.byteLength(JSON.stringify(data), 'utf8');
  // Large forms (many open options, many sections, a registry of hundreds of remembered questions) can exceed the
  // limit: shed the bulkiest, least decision-relevant parts in steps, least decision-relevant first, and MEASURE
  // after each - a fixed single-pass ladder lands just under the cap on ordinary screens and tips over on the
  // fattest ones. Each step is applied only while the prompt is still over, so the parts that are the same on every
  // consult (the answer block first: it is the DeepSeek cache prefix) stay intact whenever a cheaper step suffices.
  const ladder = [
    () => {
      // Open option controls: 20 is more than a plan can use, and a 254-entry country list is not what the planner
      // picks by (it names the answer key; the executor resolves the ref against the live page).
      const options = data.controls.filter((control) => control.kind === 'option');
      if (options.length > MAX_FIELD_OPTIONS) {
        const keep = new Set(options.slice(0, MAX_FIELD_OPTIONS));
        data.controls = data.controls.filter((control) => control.kind !== 'option' || keep.has(control));
      }
    },
    () => {
      for (const field of data.fields) if (field.value) field.value = field.value.slice(0, MAX_FIELD_VALUE_CHARS);
      data.answers = clipValues(data.answers, MAX_ANSWER_CHARS);
    },
    () => { data.history = data.history.slice(-20); data.pageText = headTail(data.pageText, 1500); },
    () => { data.pageMessages = data.pageMessages.map((message) => message.slice(0, 300)); },
    () => { data.controls = data.controls.slice(0, 200); },
    () => { data.answers = relevantAnswers(data); },
    () => { data.controls = data.controls.slice(0, 100); data.fields = data.fields.slice(0, 100); data.pageText = headTail(data.pageText, 800); },
    () => { data.history = []; data.pageMessages = []; },
    () => { for (const goal of [data.goals[0], data.escalation?.goal].filter(Boolean)) goal.guidance = goal.guidance.slice(0, MAX_GUIDANCE_CHARS); },
    // Last resort among the decision-relevant parts: trim the registry down to what this screen asks, ranked, and
    // only by as much as the prompt is over (the registry is where a consult's size actually comes from).
    () => fitAnswers(data, Math.max(MIN_ANSWER_BYTES, Buffer.byteLength(JSON.stringify(data.answers), 'utf8') - (size() - MAX_PROMPT_BYTES))),
    () => { data.controls = []; data.fields = []; },
  ];
  let prompt = JSON.stringify(data);
  for (const step of ladder) {
    if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_BYTES) break;
    step();
    prompt = JSON.stringify(data);
  }
  // Guarantee a fit rather than stop the run: first the answers registry (least relevant keys first, down to the
  // screen's own questions and then to nothing: facts/resume identity stays), then the advisory page text.
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    fitAnswers(data, Math.max(0, Buffer.byteLength(JSON.stringify(data.answers), 'utf8') - (Buffer.byteLength(prompt, 'utf8') - MAX_PROMPT_BYTES)));
    prompt = JSON.stringify(data);
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    data.pageText = '';
    prompt = JSON.stringify(data);
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) invalidInput(`size ${Buffer.byteLength(prompt, 'utf8')} bytes (${sizes(data)})`);
  return { data, prompt };
}
