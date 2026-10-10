import { access, stat, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const USAGE = 'usage: bun apply.mjs <https-job-url> [--resume <path>] [--answer "Question=Answer"]... [--submit]';
// `--help` prints usage and exits before configuration, answers, Chrome, or any harness module below is loaded, so a
// fresh clone with no config can still read it. No-argument behavior is unchanged (it reports the same usage with a
// nonzero exit).
if (process.argv.slice(2).includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

// The harness modules load config.json and build their own module constants at import time, so they are imported only
// after the help branch (a static import would evaluate them before `--help` could exit). Bindings match the former
// static imports.
const { loadConfig } = await import('./lib/config.mjs');
const browser = await import('./lib/browser.mjs');
const { snapshot } = await import('./lib/snapshot.mjs');
const act = await import('./lib/act.mjs');
const rules = await import('./lib/rules.mjs');
const { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } = await import('./lib/planner.mjs');
const email = await import('./lib/email.mjs');
const { drive, pickOption, plan: jevPlan } = await import('./lib/jev.mjs');
const { coverLetter, instructedDocument, tailoredResume } = await import('./lib/coverletter.mjs');
const answers = await import('./lib/answers.mjs');
const credentials = await import('./lib/credentials.mjs');
const runlog = await import('./lib/trace.mjs');

// Non-secret machine and user settings (config.json), read once at startup. A missing or invalid config fails here
// with the loader's actionable message, before any run state exists.
const config = loadConfig();

// Controls that open account creation on a sign-in screen.
const RE_CREATE_ACCOUNT = /^(create (an )?account|register|sign ?up|new user\??|don['’]t have an account(?: yet)?\??)$/i;

// Every user-visible line also goes to the run trace.
function say(line) {
  console.log(line);
  runlog.trace('log', { line });
}

// Alert the user about a condition only they can clear (an open captcha). The configured notification backend decides
// delivery: "console" prints the line, "macos-osascript" posts a desktop notification and fails clearly when selected
// off macOS. Both backends share config.notifications with the queue's own notify. Nothing runs merely by importing
// this module.
function notify(message) {
  const { backend, title, sound } = config.notifications;
  if (backend !== 'macos-osascript') { say(`[notification] ${message}`); return; }
  if (process.platform !== 'darwin') {
    throw new Stop(`notifications-unavailable: notifications.backend "${backend}" requires macOS; set notifications.backend to "console"`);
  }
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`], () => {});
}

// The connected Gmail label (config.email.accountLabel) and whether inbox automation is available at all. With email
// disabled, the run stops cleanly where it would need the inbox and the user completes emailed verification by hand.
const EMAIL_LABEL = config.email.accountLabel;
function requireEmail() {
  if (!config.email.enabled) throw new Stop('email automation disabled; complete verification manually');
}

const answerPath = fileURLToPath(new URL('./answers.json', import.meta.url));
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
const labelOf = field => clean(field.label || field.name || field.ref || 'unlabeled');
// A dropdown trigger's question without the widget's own announcement ("Country * The selected value is:Choose one...")
// or an attached validation message ("… Error: This field is required").
const questionOf = label => clean(String(label ?? '').replace(/\s*\*?\s*(the selected value is\b|error:\s).*$/is, '').replace(/\s*\*\s*$/, '')) || clean(label);
const isEmailField = field => field.type === 'email' || (field.tag === 'input' && ['text', ''].includes(field.type ?? '')
  && /\b(?:email|e mail)\b/.test(answers.normalize(`${field.label ?? ''} ${field.name ?? ''}`)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Stop extends Error {
  constructor(reason, code = 0) {
    super(reason);
    this.code = code;
  }
}

async function options(argv) {
  if (!argv.length) throw new Stop(USAGE, 1);
  let url;
  try { url = new URL(argv[0]); } catch { throw new Stop('invalid-url', 1); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Stop('invalid-url', 1);
  let resume;
  let submit = false;
  const qa = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--submit') { submit = true; continue; }
    if (!['--resume', '--answer'].includes(flag) || i + 1 >= argv.length) {
      throw new Stop('invalid-arguments', 1);
    }
    const value = argv[++i];
    if (flag === '--resume') {
      resume = resolve(value);
    } else {
      const separator = value.indexOf('=');
      const question = answers.normalize(value.slice(0, separator));
      if (separator < 1 || !question) throw new Stop('invalid-answer', 1);
      qa.push([question, value.slice(separator + 1)]);
    }
  }
  if (resume) {
    try {
      await access(resume, constants.R_OK);
      if (!(await stat(resume)).isFile()) throw new Error('not a file');
    } catch { throw new Stop('resume-not-readable', 1); }
  }
  const data = answers.load(answerPath);
  if (qa.length) {
    data.qa = { ...data.qa, ...Object.fromEntries(qa) };
    answers.save(answerPath, data);
  }
  // The explicit override is deliberately applied only after persistent Q&A storage.
  if (resume) data.facts = { ...data.facts, resume };
  return { url: url.href, data, submit };
}

// A dropdown's status row while a remote search runs or finds nothing; never a choice.
const LIST_STATUS = /^(searching|loading|no (results|matches|options)( found)?|please enter \d+ or more characters)\b/i;
// A filled field the site's own message names (e.g. "Responsibilities contains emojis") counts as rejected,
// so its value may be replaced like an aria-invalid one. A "required"/"enter a value" message is about emptiness:
// left over from an earlier validation pass (sites revalidate on blur or the next Continue), it never rejects a value.
const EMPTINESS = /\b(is|are) required\b|\brequired field\b|\bcannot be (blank|empty)\b|\bmust not be (blank|empty)\b/i;
function messageFor(current, label) {
  const name = answers.normalize(label);
  return name.length >= 3 ? (current.messages ?? []).find(message => answers.normalize(message).includes(name)) : undefined;
}
// The site's message rejecting a filled field's value: not an emptiness message, unless it also names a format.
function rejectionFor(current, label) {
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
const abandonedFields = new Set();
// Normalized labels of file fields this run uploaded to. A site that swaps the file input for the file name keeps
// its earlier "Resume/CV is required" message until the next submit; while no empty file field with that label is
// back, that emptiness message is stale and is hidden from the models (it otherwise drives re-upload loops).
const uploadedLabels = new Set();
function dropStaleUploadMessages(current) {
  if (!uploadedLabels.size || !current.messages?.length) return;
  const emptySlots = current.fields.filter(field => fieldType(field) === 'file' && isEmpty(field)).map(field => answers.normalize(labelOf(field)));
  current.messages = current.messages.filter(message => {
    const text = answers.normalize(message);
    return !(EMPTINESS.test(message) && [...uploadedLabels].some(label => label && text.includes(label) && !emptySlots.includes(label)));
  });
}
async function observe(page) {
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

// Set once the run has typed an emailed verification code on that URL; the remaining code field is then expected.
let emailCodeUrl = null;
// The application form an emailed-code sign-in was taken over (see the main loop's RETURN).
let signInReturn = null;
let codeRetried = false;
// The posting's role title ("Software Development Intern - Breakthrough"), from the posting page's title: an apply
// entry naming another role opens a different posting.
let targetRole = '';
// Per-run facts for the application report (runs/summary.jsonl): posting title, resume, documents at submit.
const runInfo = {};

// A visible, unsolved captcha does not stop filling: the form is completed first, and the run stops for the user only
// when the final submit is next (see the final-submit click). Every other gate stops at once.
function stopForGates(current, { submitting = false } = {}) {
  const gates = current.gates.filter(gate => !(gate === 'mfa' && current.url === emailCodeUrl) && (gate !== 'captcha' || submitting));
  if (gates.length) throw new Stop(`gate ${gates.map(clean).join(' ')}`);
}

const isEmpty = field => field.occupied !== true && (field.value == null || String(field.value) === '');
const fieldType = field => String(field.type ?? '').toLowerCase();
const invalidPlan = reason => { throw new Stop(`invalid-plan ${reason}`, 1); };
const isChoiceField = field => field && (field.autocomplete || fieldType(field) === 'select' || field.tag === 'select');

// A job-results pager ("181 - 200 of 330 jobs" with bare next/previous) pages a listing; it is no application step.
function resultsPager(current, control) {
  return /^(next|previous|prev)$/i.test(clean(control.label))
    && /\b\d+\s*[-–]\s*\d+\s+of\s+\d+\s*(jobs?|results?|positions?|openings?)?\b/i.test(String(current.pageText ?? ''))
    && !activeFields(current).length;
}

function activeFormRefs(current) {
  return new Set(current.controls
    .filter(control => control.formRef && ['login', 'step', 'final-submit'].includes(rules.classifyControl(control)))
    .map(control => control.formRef));
}

// A newsletter/subscription/job-alert signup is marketing, never part of an application: every field of its form
// (or the lone field, when formless or inside an application form) is excluded.
const SUBSCRIBE = /\b(subscribe|subscription|newsletter|mailing list|latest news|job alerts?|talent (community|network)|e-?mail updates|sign up for (our )?(e-?mails?|updates|news|insights)|stay (informed|connected|up to date|in touch))\b/i;
// A native select's placeholder row ("Select", "-- Choose --"), never an answer.
const PLACEHOLDER_OPTION = /^\s*(|select|select one|choose|choose one|please select|please choose|-+.*-+|none selected)\s*\.{0,3}$/i;
function activeFields(current) {
  // A newsletter/talent-community form is skipped whole; an opt-in checkbox inside an application form (3+ other
  // fields) is skipped alone, never the application around it. A field inside a signup block (snapshot `signup`:
  // "Sign up for Email Updates" over a lone Email address box) is one too, unless it sits in a form of 3+ other fields.
  const others = ref => current.fields.filter(field => field.formRef === ref && !SUBSCRIBE.test(field.label ?? '')).length;
  const signup = new Set();
  for (const field of current.fields) {
    if (SUBSCRIBE.test(field.label ?? '')) signup.add(field.formRef && others(field.formRef) < 3 ? field.formRef : field.ref);
    else if (field.signup && (!field.formRef || others(field.formRef) < 3)) signup.add(field.formRef ?? field.ref);
  }
  // A native select that offers nothing but its placeholder ("Select") waits on an earlier choice (a cascading
  // Region → Program → City chain fills it in client-side): it is not actionable until then.
  // A select fed by a type-to-search companion (snapshot `searchable`) loads its options as the applicant types.
  const unloaded = field => field.tag === 'select' && isEmpty(field) && !field.searchable && Array.isArray(field.options)
    && field.options.every(option => PLACEHOLDER_OPTION.test(String(option)));
  const fields = current.fields.filter(field => !signup.has(field.formRef ?? field.ref) && !signup.has(field.ref) && !unloaded(field));
  // Listing/apply-entry screens expose unrelated newsletter/search forms; no field is actionable until the application
  // entry control has been used. An application form open over the posting (a modal, whose Submit stays disabled until
  // required fields are filled, so it is not a listed control) is active even though the posting's Apply button is
  // still on the page behind it: a form of 3+ fields is an application, not a newsletter or search box, and so is a
  // short employer pre-screen (Handshake's questions before an external apply: Yes/No radios asking a question).
  const refs = activeFormRefs(current);
  if (!refs.size && current.controls.some(control => rules.classifyControl(control) === 'apply-entry')) {
    const sizes = new Map();
    const screens = new Set();
    for (const field of fields) {
      if (!field.formRef) continue;
      sizes.set(field.formRef, (sizes.get(field.formRef) ?? 0) + 1);
      if (['radio', 'select'].includes(fieldType(field)) && /\?\s*\*?$|^(are|do|did|have|will|would|can|is)\b/i.test(clean(field.label))) screens.add(field.formRef);
    }
    return fields.filter(field => (sizes.get(field.formRef) ?? 0) >= 3 || screens.has(field.formRef));
  }
  // A required field rendered outside the application's <form> (SuccessFactors' "Today's Date" sits in a sibling
  // block) still belongs to it.
  // So does an entry form beside the step's form (Oracle's "Add Experience" fields render as their own form, the
  // step's Next in another): a form of 3+ fields holding a required one is application content, not a search box.
  if (refs.size) {
    const sizes = new Map();
    for (const field of fields) if (field.formRef) sizes.set(field.formRef, (sizes.get(field.formRef) ?? 0) + 1);
    for (const [ref, size] of sizes) {
      if (size >= 3 && fields.some(field => field.formRef === ref && field.required)) refs.add(ref);
    }
  }
  return refs.size ? fields.filter(field => refs.has(field.formRef) || (!field.formRef && field.required)) : fields;
}
// A control inside a newsletter/email-updates block (its "Submit"/"Sign up") subscribes the applicant; one owned by
// an application form (3+ active fields) is that form's own, even beside a "Sign up for job alerts" box.
function signupControl(current, control) {
  return Boolean(control.signup)
    && !(control.formRef && activeFields(current).filter(field => field.formRef === control.formRef).length >= 3);
}

function localAnswers(data) {
  const values = new Map();
  for (const section of ['facts', 'qa']) {
    for (const [name, value] of Object.entries(data[section] ?? {})) {
      if ((section === 'facts' && name === 'resume') || /password|passwd|passphrase|secret|token|credential|api[_ -]?key/i.test(name)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value) === '') continue;
      const key = `${section}.${section === 'qa' ? answers.normalize(name) : name}`;
      if (key === `${section}.`) continue;
      if (values.has(key) && values.get(key) !== String(value)) throw new Stop('ambiguous-answer-keys', 1);
      values.set(key, String(value));
    }
  }
  return withVariants(values);
}

// Deterministic format variants of stored values, offered as extra answers so Jev can match a field's format
// (e.g. "Graduation year" or "Please enter a valid year" wants 2030, not "May 2030"). Code derives them; no model writes text.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function withVariants(values) {
  // Preferred display name; legal-name fields use facts.legal_* instead.
  const first = values.get('facts.first_name');
  const last = values.get('facts.last_name');
  if (first && last && !values.has('facts.preferred_full_name')) values.set('facts.preferred_full_name', `${first} ${last}`);
  // Today's date for signature-date fields, in the common US forms.
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  values.set('facts.today', `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`);
  values.set('facts.today.iso', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  for (const [key, value] of [...values]) {
    const date = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(value.trim());
    const month = date ? MONTHS.indexOf(date[1].slice(0, 3).toLowerCase()) + 1 : 0;
    if (date && month) {
      const mm = String(month).padStart(2, '0');
      values.set(`${key}.year`, date[2]);
      values.set(`${key}.mm_yyyy`, `${mm}/${date[2]}`);
      values.set(`${key}.yyyy_mm`, `${date[2]}-${mm}`);
    }
    const digits = value.replace(/\D/g, '');
    if (/^[+\d\s().-]+$/.test(value) && digits.length >= 7 && digits !== value) values.set(`${key}.digits`, digits);
  }
  return values;
}

// Resume bullets become stored answers keyed by their role ("resume.<employer>_<n>"), so free-text questions
// such as Responsibilities are answered by Jev choosing the applicant's own words, never generated text.
async function resumeBullets(path) {
  let text;
  try { ({ stdout: text } = await promisify(execFile)('pdftotext', ['-layout', path, '-'], { timeout: 10000 })); }
  catch { return []; }
  const bullets = [];
  let heading = '';
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { current = null; continue; }
    if (line.startsWith('•')) {
      current = { heading, text: line.slice(1).trim() };
      bullets.push(current);
    } else if (current && /^\s{2,}/.test(raw) && !/\s{4,}\S+\s*$/.test(raw.trimStart())) {
      current.text += ` ${line}`;
    } else {
      current = null;
      heading = line.replace(/\s{3,}.*$/, '');
    }
  }
  const counts = {};
  return bullets.slice(0, 16).map(b => {
    const slug = b.heading.split(/\s[—–-]\s/)[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'experience';
    counts[slug] = (counts[slug] ?? 0) + 1;
    return [`resume.${slug}_${counts[slug]}`, b.text.replace(/\s+/g, ' ').slice(0, 600)];
  });
}

function exactShape(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function validatePlan(plan, values) {
  if (!plan || typeof plan !== 'object') invalidPlan('shape');
  const shapes = {
    click: ['action', 'ref'],
    fill: ['action', 'fields'],
    upload_resume: ['action', 'ref'],
    check: ['action', 'ref'],
    credentials: ['action', 'mode'],
    choose: ['action', 'ref', 'key'],
  };
  if (!Object.hasOwn(shapes, plan.action) || !exactShape(plan, shapes[plan.action])) invalidPlan('shape');
  if (['click', 'upload_resume', 'check', 'choose'].includes(plan.action) && (typeof plan.ref !== 'string' || !plan.ref)) invalidPlan('ref');
  if (plan.action === 'choose' && !values.has(plan.key)) invalidPlan('choose-key');
  if (plan.action === 'credentials' && !['login', 'register'].includes(plan.mode)) invalidPlan('credential-mode');
  if (plan.action === 'fill') {
    if (!Array.isArray(plan.fields) || !plan.fields.length || plan.fields.length > 8) invalidPlan('fill-batch');
    const refs = new Set();
    for (const item of plan.fields) {
      if (!exactShape(item, ['ref', 'key']) || typeof item.ref !== 'string' || !item.ref || typeof item.key !== 'string'
        || !(values.has(item.key) || item.key === SECRET_KEY) || refs.has(item.ref)) invalidPlan('fill-field');
      refs.add(item.ref);
    }
  }
}

// Checkbox ticks and radio picks without a stored answer are Jev's choice, except applicant attestations,
// consents, and opt-ins: those stay with the user. A radio is picked only while its group has no selection.
const USER_DECISION = /\b(agree|consent|certif|attest|acknowledg|terms|privacy|policy|signature|sign|authori[sz]|marketing|newsletter|email me|text me|sms)/;
// Written (model-composed) answers never go into these: they are identity secrets, legal signatures, or an account's
// login name (the account's own address, entered with the credentials).
const NEVER_WRITE = /\b(password|passcode|ssn|social security|date of birth|birth ?date|dob|signature|sign here|initials|(verification|security|one time|access|sign in|login|enter( the| your)?) code)\b|^code\b|^(login|log in|login id|login name|user ?name|user id)$/;
// Marketing/notification opt-ins are never ticked. Applicant attestations (agree, acknowledge, certify) are ticked only
// under --submit, which authorizes completing the whole application unattended.
// "Yes, <employer> can contact me about future job opportunities" and talent-pool/retention offers are opt-ins too.
const OPT_IN = /\b(marketing|newsletter|email me|text me|sms|promotional|job alerts?|to contact you|contact me about|future (job |career |employment )?opportunities|talent (pool|community|network)|keep (me|my (information|details|data|resume|profile)) (informed|on file|updated))\b/;
function checkTarget(current, ref) {
  // A grouped choice (radio/checkbox group with optionRefs), or a lone checkbox addressed by its own ref; only in an
  // active (application) form, never a newsletter signup beside it.
  const fields = activeFields(current).filter(field => ['checkbox', 'radio'].includes(fieldType(field))
    && (Array.isArray(field.optionRefs) ? field.optionRefs.includes(ref) : field.ref === ref));
  if (fields.length !== 1) invalidPlan('check-target');
  const field = fields[0];
  if (fieldType(field) === 'radio' && field.checkedRefs?.length) invalidPlan('already-answered');
  if (field.checkedRefs?.includes(ref) || (!Array.isArray(field.optionRefs) && field.value === 'checked')) invalidPlan('already-checked');
  const option = Array.isArray(field.optionRefs) ? field.options[field.optionRefs.indexOf(ref)] : null;
  // A radio answer to a factual question (Yes/No about a non-compete agreement) is an answer, not a consent.
  const decides = answers.normalize(fieldType(field) === 'checkbox' ? `${field.label ?? ''} ${option ?? ''}` : option ?? '');
  if (OPT_IN.test(decides)) invalidPlan('opt-in');
  if (!allowSubmit && USER_DECISION.test(decides)) invalidPlan('user-decision');
  return { field, option };
}

// --submit lets the final submit control be clicked; it is then the run's last action.
let allowSubmit = false;
// The requested posting's host and id (the 5+ digit number in its URL path), when it has one.
let posting = { host: '', id: '' };

// The screen as the models see it: unnamed controls (logo links, icons) are never clickable (`unlabeled-control`),
// so offering them only buys refused picks.
function modelView(current) {
  return { ...current, controls: current.controls.filter(control => answers.normalize(control.label) || control.current !== undefined) };
}

// Social networks, share/intent links, and employer review/award sites are never part of an application (an
// employer's "Great Place to Work" badge leads to a share-to-X sign-in page).
const OFF_APPLICATION_HOST = /(^|\.)(x|twitter|facebook|fb|instagram|tiktok|youtube|youtu|pinterest|reddit|threads|glassdoor|greatplacetowork|comparably|fairygodboss)\.(com|net|be|org)$/i;
function offApplication(url) {
  return OFF_APPLICATION_HOST.test(url.host) || (/(^|\.)linkedin\.com$/i.test(url.host) && !/\/jobs?\//i.test(url.pathname))
    || /\/(intent|share|sharer|sharing)(\/|\.php|$)|[?&](share|shareArticle)\b/i.test(`${url.pathname}${url.search}`);
}

function currentControl(current, ref, { moreEntries = false } = {}) {
  const matches = current.controls.filter(control => control.ref === ref);
  if (matches.length !== 1) invalidPlan('control-ref');
  const control = matches[0];
  // An unnamed control (a logo link, an icon) cannot be vetted against the word rules below; it is never clicked.
  if (!answers.normalize(control.label) && control.current === undefined) invalidPlan('unlabeled-control');
  const kind = rules.classifyControl(control);
  if (kind === 'final-submit' && !allowSubmit) invalidPlan(`final-submit ${labelOf(control)}`);
  if (signupControl(current, control)) invalidPlan('opt-in');
  // An apply entry naming a role ("Apply Now Client Delivery Intern - Breakthrough") opens that posting: one naming
  // a role other than this run's posting is refused (a bare "Apply"/"Apply now" or one naming a requisition id passes).
  if (kind === 'apply-entry' && targetRole) {
    // Screen-reader notes ("Apply now (link opens in new tab)") are not role words.
    const words = text => answers.normalize(String(text).replace(/\(?\b(link )?opens? in (a )?new (tab|window)\b\)?/gi, ' ')).split(' ')
      .filter(word => word.length > 1 && !/^(apply|now|for|to|the|this|job|position|role|on|and|of|at|in|intern|interns|internship|internships|summer|fall|spring|winter|program|20\d\d|externally|external|company|companys|employer|employers|website|site|application|start|step|with|here|click|view|online|today|opening|our|your|career|careers)$/.test(word));
    // A popup-style apply button's label carries neighbouring text ("Create Alert Apply now"); its own text is `current`.
    const named = words(control.current !== undefined && /\bapply\b/i.test(control.current) ? control.current : control.label);
    const target = new Set(words(targetRole));
    const known = word => [...target].some(other => other === word || (word.length >= 5 && other.length >= 5 && other.slice(0, 5) === word.slice(0, 5)));
    if (named.length >= 2 && !named.some(word => /\d/.test(word)) && named.filter(word => !known(word)).length / named.length > 0.34) invalidPlan('other-posting');
  }
  // A birth date is the applicant's to enter: on a screen that asks for one, the date picker (its trigger, day cells,
  // month paging) is never clicked, so no model picks a date into it.
  if (current.fields.some(field => /\b(date of birth|birth ?date|dob)\b/i.test(labelOf(field)))
    && /\b(choose|pick|select|open)( a)? date\b|\bcalendar\b|date ?picker|^(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2},? \d{4}\b|\b\d{1,2} (january|february|march|april|may|june|july|august|september|october|november|december),? \d{4}\b|\b(previous|next|prev) (month|year|decade)\b/i.test(clean(control.label))) {
    invalidPlan('birth-date-picker');
  }
  if (resultsPager(current, control)) invalidPlan('results-paging');
  const forbidden = /\b(back|previous|submit|cancel|withdraw|remove|delete|unsubscribe|reset|discard|erase|destroy|pay|payments?|buy|purchases?|checkout|orders?|subscriptions?|subscribe|later)\b|\b(?:log|sign) out\b/;
  // A step whose page reports an error it shows no field for ("Errors Found: Enter at least 1 resume/CV" on a review
  // step) is fixed on an earlier step: a bare "Back" is allowed there, and keeps being allowed for a walk of up to
  // five steps back; the walk ends at the first other action.
  const backToFix = /^back$/.test(answers.normalize(control.label)) && !control.href && backWalk < 5
    && (backWalk > 0 || (/\b(errors? found|page error|please (fix|correct) the (following )?errors?)\b/i.test(current.pageText ?? '')
      && !activeFields(current).some(field => isEmpty(field) && fieldType(field) !== 'file')));
  let path = '';
  if (control.href) {
    let url;
    try { url = new URL(control.href, current.url); } catch { invalidPlan('control-url'); }
    // A javascript: href is a script-driven button, not navigation; other non-web schemes (mailto, tel, file) are refused.
    if (url.protocol !== 'javascript:') {
      if (!['http:', 'https:'].includes(url.protocol)) invalidPlan('control-url');
      path = url.pathname;
      if (offApplication(url)) invalidPlan('off-application-site');
      // On the posting's own site, a link to a path without the posting's id leaves the posting (another job's card,
      // the job search, the profile, the home feed): the run applies to this posting only.
      if (posting.id && url.host === posting.host && new URL(current.url).host === posting.host
        && !`${url.pathname}${url.search}`.includes(posting.id)) invalidPlan('off-posting-link');
      // With an application form open (3+ applicant fields), a link outside every form to another page (site
      // navigation, "Click here to visit home page", a footer privacy link) abandons the application half-filled. On
      // an application page itself (an apply/login/register path) a plain link to another site is leaving it too,
      // even before the form renders (iCIMS' login page footer links the employer's client portal).
      const here = new URL(current.url);
      const applicationPage = /\/(apply|application|login|log-in|signin|sign-in|register|candidate)\b/i.test(here.pathname);
      // iCIMS wraps its whole page, footer included, in one form: a link to another site leaves even from inside it.
      // A link naming the target role is the posting itself (a careers search list with a talent-community form on it).
      const opensTarget = targetRole && answers.normalize(labelOf(control)).includes(answers.normalize(targetRole));
      if (kind === 'other' && !opensTarget && (!control.formRef || url.host !== here.host) && (url.host !== here.host || url.pathname !== here.pathname)
        && (activeFields(current).length >= 3 || (applicationPage && url.host !== here.host))) invalidPlan('leaves-application');
    }
  }
  // A dropdown trigger (it shows a current selection) is a question, not navigation: its label is not word-filtered.
  const popupTrigger = control.current !== undefined;
  // An "Add …" control opens a new entry (education, work experience, website) in the form; buttons without a type
  // attribute default to submit, so that alone does not make it unsafe. "Add another" duplicates an entry: the stored
  // answers hold one entry per section, except a stored list with items still unentered (moreEntries).
  if (/^add (another|more)\b/.test(answers.normalize(control.label)) && !moreEntries) invalidPlan('duplicate-entry');
  // "Did you apply on the employer's site? Yes" records a submission the run never saw confirmed; a job board then
  // marks the posting applied and the real application is never finished. Only the employer's page confirms one.
  if (/\b(confirm|yes)\b.*\b(external(ly)?|employer'?s? (site|website))\b.*\bappl(y|ied)\b|\bconfirm external apply\b|\byes,? i (have )?applied\b|\bi('ve| have)? (already )?applied\b/
    .test(answers.normalize(control.label))) invalidPlan('self-reported-applied');
  // Cloud pickers ("Choose from Google Drive", Dropbox, OneDrive, a bare "Indeed"/"LinkedIn" resume-import button)
  // sign into a third-party account in a popup; the applicant's documents are always uploaded from local files.
  if (/\b(google drive|dropbox|one ?drive|box\.com|icloud|microsoft online)\b|^(indeed|linked ?in)$/.test(answers.normalize(control.label))) invalidPlan('cloud-picker');
  // Third-party sign-in ("Sign in with Google", Microsoft, LinkedIn, Apple) hands the run to an identity provider's
  // consent screens it cannot finish; employer accounts are made with the applicant's email and a stored password.
  if (/\b(sign ?in|log ?in|sign ?up|continue|register|apply|connect)\b.{0,12}\b(with|using|via|through)\s+(google|microsoft|linked ?in|apple|facebook|github|indeed|outlook|office 365)\b|^continue as\b/
    .test(answers.normalize(control.label))) invalidPlan('third-party-sign-in');
  // A passkey ("Continue with passkey", "Create a passkey") opens the OS WebAuthn sheet: a device credential the run
  // neither creates nor uses; the emailed-code or password path stays.
  if (/\bpass ?keys?\b/.test(answers.normalize(control.label))) invalidPlan('passkey');
  // A "Close"/"×" beside an attached document (Handshake's attachment chip) detaches that document; models read it
  // as closing a preview. Only the executor's own pre-attached-resume removal clicks it.
  if (control.attached) invalidPlan('detach-document');
  // A link to a policy document (privacy notice, arbitration agreement, terms) is reading matter. Inside an
  // application it often navigates the form's own frame away, discarding every filled answer; the attestation it
  // backs is the form's checkbox, never the link.
  if (control.href && !popupTrigger && /\b(privacy|arbitration|agreement|terms|policy|notice|disclosure|conditions)\b/.test(answers.normalize(control.label))
    && activeFields(current).length > 0) invalidPlan('policy-link');
  // "Add …"/"Edit" open an entry (education, work experience) in the form; neither submits the application.
  const addEntry = /^(add|edit)\b/.test(answers.normalize(control.label));
  // A bare "Delete"/"Remove" inside an applicant form removes one entry of a repeatable section (an empty
  // certification row the site added); it never touches an account, a saved application, or a stored document.
  const removeEntry = /^(delete|remove)$/.test(answers.normalize(control.label)) && !control.href && !control.attached
    && activeFields(current).length > 0 && !/\b(account|profile|application)\b/i.test(control.context ?? '');
  // Default-submit buttons outside applicant forms, and owned popup choices, do not submit an application. Account
  // controls ("Reset Password" requests a reset email) are exact labels, so the word filter skips them. A bare
  // "Cancel" inside a child frame holding no form fields (a third-party picker popup) only dismisses that popup.
  const frame = control.ref.includes(':') ? control.ref.slice(0, control.ref.indexOf(':') + 1) : null;
  const dismissPopup = frame && /^(cancel|close)$/.test(answers.normalize(control.label)) && Number(control.formFieldCount) === 0
    && !current.fields.some(field => field.ref.startsWith(frame) && fieldType(field) !== 'text');
  if (kind !== 'final-submit' && ((!popupTrigger && !removeEntry && !dismissPopup && !backToFix && kind !== 'login' && forbidden.test(answers.normalize(control.label))) || (kind !== 'login' && forbidden.test(answers.normalize(path))))
    || control.type === 'reset' || (control.type === 'submit' && kind === 'other' && !addEntry
      && !popupTrigger && control.kind !== 'option' && Number(control.formFieldCount) > 0)) invalidPlan('unsafe-control');
  return control;
}

// A free-text field's character limit: its maxlength, else the largest number in a length rule the site shows for it
// ("Text length should be between 0 and 200"), else a generous default by field kind.
function limitOf(field) {
  if (field.maxLength > 0) return field.maxLength;
  const rule = /\b(length|characters?|chars?)\b/i.test(field.message ?? '') ? (field.message.match(/\d{2,5}/g) ?? []).map(Number) : [];
  if (rule.length) return Math.max(...rule);
  return fieldType(field) === 'textarea' ? 1500 : 300;
}

function currentField(current, ref, correction = null) {
  const matches = activeFields(current).filter(field => field.ref === ref);
  if (matches.length !== 1) invalidPlan('field-ownership');
  const field = matches[0];
  // A value the site rejected (invalid, or longer than the site's stated limit) may be replaced. So may a value the
  // site prefilled (resume parsing) that contradicts a stored applicant fact ("Fairview" in City, "2020" as the
  // start year): the fact is the truth. Any other occupied field is left alone.
  // A choice field holds the site's display text ("NY" for New York): it contradicts only when neither text contains
  // the other.
  const shown = answers.normalize(field.value);
  const fact = correction && typeof correction.value === 'string' ? answers.normalize(correction.value) : '';
  const contradicts = correction && fact && ((/^facts\./.test(correction.key) && !shown.includes(fact)
    && (!isChoiceField(field) || !fact.includes(shown)))
    // A catch-all choice ("Other") an earlier run picked is replaced by a stored answer that names something concrete.
    || (isChoiceField(field) && /^(other|others)$/.test(shown) && !/^other\b/.test(fact)));
  if (!isEmpty(field) && !field.invalid && !contradicts && (field.valueLength ?? String(field.value ?? '').length) <= limitOf(field)) invalidPlan('occupied-field');
  return field;
}

// `secret.generated` fills an account-security field (e.g. a security-question
// answer) with a Keychain-generated value. Allowed only for a text input that
// shares its form with a password field; the value is resolved at execution.
const SECRET_KEY = 'secret.generated';

// The resume's file path is local-only: uploads read it directly from `values`, and it is never placed in a model
// payload (writer applicant, planner/Jev context keys or values). The `resume.<role>_<n>` bullet keys are the
// resume's text and do travel to the models.
const RESUME_PATH_KEY = 'facts.resume';

function resolveFill(current, item, values) {
  const field = currentField(current, item.ref, values.has(item.key) ? { key: item.key, value: values.get(item.key) } : null);
  const type = fieldType(field);
  if (item.key === SECRET_KEY) {
    // A security-question picker: any question will do; the executor picks a distinct one per picker.
    if ((type === 'select' || field.tag === 'select') && /\b(security|secret|challenge|recovery) question\b/i.test(labelOf(field))) {
      return { field, key: item.key, value: null, secretChoice: true };
    }
    if (field.tag !== 'input' || !['text', ''].includes(type) || !rules.secretForm(current.fields, field)) invalidPlan('secret-target');
    return { field, key: item.key, value: null, secret: true };
  }
  if (['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'].includes(type) || !values.has(item.key)) invalidPlan('fill-target');
  const value = values.get(item.key);
  let optionRef;
  if (type === 'radio' || type === 'checkbox') {
    if (!Array.isArray(field.options) || !Array.isArray(field.optionRefs)
      || field.options.length !== field.optionRefs.length) invalidPlan('option-group');
    // Exact text first; else the same words ignoring case and punctuation ("…employee." vs "…employee").
    let indexes = field.options.flatMap((option, index) => String(option).trim().toLowerCase() === value.trim().toLowerCase() ? [index] : []);
    if (!indexes.length) indexes = field.options.flatMap((option, index) => answers.normalize(option) === answers.normalize(value) ? [index] : []);
    // A checkbox group ("select all that apply") with a list answer ("English, Spanish"): the first unchecked
    // option the list names as whole words, parentheticals dropped; the remaining named options are ticked next.
    if (!indexes.length && type === 'checkbox' && field.options.length > 1) {
      const listed = ` ${answers.normalize(value)} `;
      indexes = field.options.flatMap((option, index) => {
        const text = answers.normalize(String(option).replace(/\([^)]*\)/g, ' '));
        return text && listed.includes(` ${text} `) && !field.checkedRefs?.includes(field.optionRefs[index]) ? [index] : [];
      }).slice(0, 1);
    }
    if (indexes.length !== 1) invalidPlan(`unmatched-option ${labelOf(field)}`);
    optionRef = field.optionRefs[indexes[0]];
    if (typeof optionRef !== 'string' || !optionRef
      || field.optionRefs.filter(ref => ref === optionRef).length !== 1) invalidPlan('option-ref');
  }
  return { field, key: item.key, value: dateSegment(field, value), optionRef };
}

// A segmented date box (its own label is Month, Year, or Day, or MM/YYYY/DD, alone or after a short qualifier such
// as "Start year" / "End month") takes only that part of a stored date ("June 2030", "06/2030", "2031-05-24");
// typing the whole date into a two-digit box is rejected by the site.
function dateSegment(field, value) {
  const words = answers.normalize(field.label || field.placeholder || '').split(' ').filter(Boolean);
  const segments = { month: 'month', mm: 'month', year: 'year', yyyy: 'year', yy: 'year', day: 'day', dd: 'day' };
  const part = words.length && words.length <= 3 ? segments[words.at(-1)] : undefined;
  if (!part || /^\d{1,4}$/.test(String(value).trim())) return value;
  const text = String(value).trim().toLowerCase();
  const year = text.match(/\b(19|20)\d{2}\b/)?.[0];
  const named = MONTHS.findIndex(name => new RegExp(`\\b${name}`).test(text)) + 1;
  const numbers = text.replace(/\b(19|20)\d{2}\b/, ' ').match(/\d{1,2}/g)?.map(Number) ?? [];
  // ISO (2031-05-24) and US (05/24/2031, 06/2030) both put the month before the day.
  const month = named || numbers[0];
  const day = named ? numbers[0] : numbers[1];
  const pick = { year, month: month >= 1 && month <= 12 ? String(month).padStart(2, '0') : undefined,
    day: day >= 1 && day <= 31 ? String(day).padStart(2, '0') : undefined }[part];
  if (!pick) invalidPlan(`date-segment ${part} of ${labelOf(field)}`);
  // A month list of names ("January" …) takes the name, not its number.
  if (part === 'month') {
    const name = MONTHS[Number(pick) - 1];
    const option = (field.options ?? []).find(option => answers.normalize(option).startsWith(name));
    if (option) return option;
  }
  return pick;
}

// The file input a planned upload targets and the document it asks for (rules.documentKind). Resumes and generated
// cover letters can be attached; a transcript, writing sample, or unnamed extra attachment has no stored file.
function documentField(current, ref, resumeAvailable) {
  // A file input may live outside any form (e.g. an upload dialog in its own frame); empty-field rules still apply.
  const files = current.fields.filter(candidate => fieldType(candidate) === 'file');
  const field = files.find(candidate => candidate.ref === ref);
  if (!field || fieldType(field) !== 'file') invalidPlan('resume-field');
  if (!isEmpty(field)) invalidPlan('occupied-field');
  const kind = rules.documentKind(field, files.length);
  if (kind === 'resume' && !resumeAvailable) invalidPlan('resume-unavailable');
  if (kind !== 'resume' && kind !== 'cover') invalidPlan(`no-stored-${kind}`);
  return { field, kind };
}

// The employer's instructions for an upload slot ("Instructions from employer: Include: …"), as the snapshot keeps
// them in full for file inputs; '' when the slot carries none.
function instructionsOf(field) {
  const text = String(field.instructions ?? '').replace(/\s+/g, ' ').trim();
  const match = text.match(/\binstructions?(?: from (?:the )?employer)?\s*:\s*(.+)/i) ?? text.match(/\b((?:include|attach|provide|submit)\s*:.+)/i);
  return match && match[1].trim().length >= 15 ? match[1].trim() : '';
}

function passwordFields(current) {
  const fields = activeFields(current).filter(field => fieldType(field) === 'password');
  if (new Set(fields.map(field => field.formRef ?? '')).size > 1) throw new Stop('credential-form-ambiguous');
  return fields;
}

function sameTarget(expected, actual) {
  const keys = ['ref', 'formRef', 'kind', 'tag', 'type', 'label', 'name', 'href', 'required', 'formFieldCount', 'options', 'optionRefs'];
  const changed = keys.find(key => JSON.stringify(expected[key]) !== JSON.stringify(actual?.[key]));
  if (changed) invalidPlan(`stale-target ${changed} of ${clean(labelOf(expected)).slice(0, 60)}`);
}

// The ref a planned field has on a fresh snapshot. Sites re-render a whole group after one answer (new nodes, new
// refs), so a field missing or changed at its ref is re-found as the one fresh field with the same identity (form,
// tag, type, label, name, options); none or several is stale.
function freshRef(fresh, field) {
  const atRef = fresh.fields.find(candidate => candidate.ref === field.ref);
  if (atRef) {
    try { sameTarget(field, atRef); return field.ref; } catch {}
  }
  const keys = ['tag', 'type', 'label', 'name', 'required', 'options'];
  const same = fresh.fields.filter(candidate => keys.every(key => JSON.stringify(field[key]) === JSON.stringify(candidate[key])));
  if (same.length !== 1) invalidPlan(`stale-target ${same.length} matches for ${clean(labelOf(field)).slice(0, 60)}`);
  return same[0].ref;
}

// Stable per-screen signature used only for stall detection: refs/labels/occupancy, never values.
const screenFingerprint = current => JSON.stringify([
  current.url,
  current.controls.map(control => [control.ref, clean(control.label)]),
  current.fields.map(field => [field.ref, field.occupied === true]),
]);

async function resumeIsReadable(path) {
  if (typeof path !== 'string' || !path) return false;
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}

// Consecutive "Back" clicks (see currentControl's back-to-fix rule); any other action ends the walk back.
let backWalk = 0;
async function mutate(operation, label, action) {
  backWalk = operation === 'CLICK' && /^back$/i.test(clean(label)) ? backWalk + 1 : 0;
  try {
    return await action();
  } catch (error) {
    const message = String(error?.message ?? '');
    // The cause, with quoted text (typed values, option text) and paths scrubbed: telemetry, never values.
    runlog.trace('action-error', { operation, label: clean(label).slice(0, 120),
      message: clean(message).replace(/"[^"]*"/g, '"…"').replace(/\/[\w./-]+/g, '<path>').slice(0, 300) });
    // act.select raises this only before dispatch, while resolving the option.
    if (operation === 'SELECT' && /^select failed on ref .+: no option matching /.test(message)) {
      throw new Stop(`unknown-required-field ${clean(label)}`);
    }
    // Known outcomes, so the run observes again instead of stopping: the target vanished before anything was sent,
    // or a dropdown was verified to hold no choice after the pick.
    if (/no longer resolves/.test(message)) invalidPlan(`stale-ref ${clean(label).slice(0, 60)}`);
    if (/the dropdown kept no choice/.test(message)) invalidPlan(`stale-choice ${clean(label).slice(0, 60)}`);
    // Do not expose the original error: libraries can include typed values or paths.
    throw new Stop(`action-outcome-unknown ${operation} ${clean(label)}`, 1);
  }
}

// Equivalent forms of stored answers live in aliases.json by key and value: planner-expanded aliases for short
// categorical facts, plus learned replacements the site accepted after rejecting a value. They become extra
// answers "<key>.alias_<n>". Contact and identity facts are never sent for expansion.
const aliasPath = fileURLToPath(new URL('./aliases.json', import.meta.url));
const NO_ALIAS = /email|phone|address|street|zip|postal|name|linkedin|website|url|resume|birth|ssn/;
async function addAliases(values) {
  let cache = {};
  try { cache = JSON.parse(await readFile(aliasPath, 'utf8')); } catch { /* first run */ }
  const wanted = Object.fromEntries([...values].filter(([key, value]) => key.startsWith('facts.') && key.split('.').length === 2
    && !NO_ALIAS.test(key) && value.length <= 40 && !/^(yes|no|true|false|[\d.\s/-]+)$/i.test(value.trim())));
  const missing = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => cache[key]?.value !== value));
  if (Object.keys(missing).length) {
    const fresh = await expandAliases(missing);
    for (const [key, list] of Object.entries(fresh)) cache[key] = { value: missing[key], aliases: list };
    await writeFile(aliasPath, `${JSON.stringify(cache, null, 2)}\n`);
  }
  for (const [key, entry] of Object.entries(cache)) {
    if (values.get(key) === entry.value) (entry.aliases ?? []).forEach((alias, i) => values.set(`${key}.alias_${i + 1}`, alias));
  }
}

async function learnAlias(key, original, accepted) {
  let cache = {};
  try { cache = JSON.parse(await readFile(aliasPath, 'utf8')); } catch { /* first save */ }
  if (cache[key]?.value !== original) cache[key] = { value: original, aliases: [] };
  if (!cache[key].aliases.includes(accepted)) cache[key].aliases.unshift(accepted);
  await writeFile(aliasPath, `${JSON.stringify(cache, null, 2)}\n`);
}

// learned.json — what past runs found to work, replayed without any model call:
//   fields:  normalized field label/name → answer key the site accepted for it (the executor fills these first);
//   choices: normalized stored answer → dropdown choice texts it was mapped to (no model call next time);
//   lessons: one-line notes from DeepSeek consults that got a stuck screen moving, per host (Jev reads them).
const learnedPath = fileURLToPath(new URL('./learned.json', import.meta.url));
async function loadLearned() {
  try {
    const data = JSON.parse(await readFile(learnedPath, 'utf8'));
    return { fields: data.fields ?? {}, choices: data.choices ?? {}, lessons: data.lessons ?? [] };
  } catch { return { fields: {}, choices: {}, lessons: [] }; }
}
async function saveLearned(learned) {
  await writeFile(learnedPath, `${JSON.stringify(learned, null, 2)}\n`);
}
// The label a field is learned under: its visible label, else its name attribute; never a ref.
const learnLabel = field => answers.normalize(field.label || field.name || '');

// A label that names a question (at least two words once placeholder/required-marker words are dropped). Bare
// "Month", "Year", or a placeholder like "Select One Required" recur on unrelated questions, so an answer or key
// remembered under them would be reused for the wrong question.
const PLACEHOLDER_WORDS = new Set(['select', 'choose', 'one', 'an', 'option', 'required', 'optional', 'please', 'enter']);
// A job-board search box ("Search for jobs or keywords") is not a question about the applicant.
const isQuestionLabel = label => !/\bsearch (for )?(jobs?|keywords?|positions?|roles?|openings?)\b|\bkeywords?\b/.test(answers.normalize(label))
  && answers.normalize(label).split(' ').filter(word => word && !PLACEHOLDER_WORDS.has(word)).length >= 2;

async function run() {
  let connection;
  // Closes the tabs this run opened, keeping the one it ended on (set once the tab watcher exists).
  let closeRunTabs = null;
  let phase = 'arguments';
  // Label of the final-submit control clicked; the run ends once a later screen confirms the submission. A stop
  // after that click re-checks the page, so a model error on the confirmation screen does not hide a submission.
  let submittedVia = null;
  // Answered fields at the last final-submit click, and how many submits came back as an emptied form.
  let submitFilled = null;
  let submitResets = 0;
  let submitUrl = null;
  let submitAt = null;
  let postSubmitEmail = null;
  let submitted = false;
  let confirmSubmitted = null;
  let runUrl = null;
  const runStarted = Date.now();
  try {
    const { url, data, submit } = await options(process.argv.slice(2));
    runUrl = url;
    say(`TRACE ${runlog.start()}`);
    allowSubmit = submit;
    posting = { host: new URL(url).host, id: new URL(url).pathname.match(/\d{5,}/)?.[0] ?? '' };
    const values = localAnswers(data);
    const resume = data.facts?.resume;
    if (resume) runInfo.resume = basename(resume);
    const resumeAvailable = await resumeIsReadable(resume);
    if (resumeAvailable) for (const [key, bullet] of await resumeBullets(resume)) values.set(key, bullet);
    phase = 'aliases';
    await addAliases(values);
    phase = 'browser-connect';
    connection = await browser.connect();
    phase = 'open-tab';
    // A tab whose CDP session times out while attaching (Chrome busy) gets one more attempt after a pause.
    let page = await browser.openTab(connection, url).catch(async error => {
      if (!/timed out/i.test(String(error?.message))) throw error;
      say('TAB attach timed out; retrying once');
      await delay(5000);
      return browser.openTab(connection, url);
    });
    // Tabs opened after this point (e.g. an "Apply externally" link) become the working tab on the next pass.
    const tabs = browser.watchTabs(connection);
    // A submitted application is finished: every tab it used closes, the posting tab included, so tabs do not pile
    // up and slow Chrome. A stopped run keeps the page it ended on for the next attempt.
    closeRunTabs = async () => {
      await tabs.closeOthers(submitted ? null : page);
      if (submitted && !page.isClosed()) await page.close().catch(() => undefined);
    };
    // Some employers confirm the applicant's email only after submit ("[Action Required] verify your email to move to
    // the next step"). After a confirmed submit on an employer site, the inbox is checked for ~90 s for that site's
    // single verification link; it opens in a scratch tab that closes again. The link is never logged; assessments
    // or further steps it leads to are the user's.
    postSubmitEmail = async () => {
      // Email automation is optional: with it off, any post-submit verification link is the user's to open.
      if (!config.email.enabled) { say('EMAIL post-submit: email automation disabled; check the inbox manually for a verification link'); return; }
      const site = submitUrl ?? page.url();
      // An earlier submission (no submit click in this run) had its own inbox window.
      if (!submitAt || /(^|\.)joinhandshake\.com$/i.test(new URL(site).hostname)) return;
      phase = 'post-submit-email';
      // Some sites (Oracle Recruiting) confirm the applicant's identity with an emailed code right after submit
      // ("so that your job application is considered"): code boxes appear on the confirmation page a beat later.
      await delay(4000);
      const after = await observe(page).catch(() => null);
      if (after && emailCodeFields(after).length) {
        await enterEmailedCode(after);
        const typed = await observe(page);
        const verify = typed.controls.find(control => /^(verify|confirm|continue|submit|done)\b/i.test(clean(labelOf(control))));
        if (verify) {
          await mutate('CLICK', labelOf(verify), () => act.click(page, verify.ref));
          await delay(3000);
        }
        const text = clean((await observe(page)).pageText ?? '').slice(0, 200);
        say(`EMAIL post-submit: identity code entered${verify ? ` and sent with ${clean(labelOf(verify))}` : ''}: "${text}"`);
        return;
      }
      const link = await email.waitForVerificationLink(EMAIL_LABEL, submitAt - 30_000, site,
        wait => say(`EMAIL post-submit: waiting ${wait / 1000}s for an email-verification link`), [30_000, 30_000, 30_000]);
      if (!link) { say('EMAIL post-submit: no email-verification link arrived'); return; }
      const scratch = await page.browser().newPage();
      try {
        await scratch.goto(link, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
        const text = clean(await scratch.evaluate(() => document.body?.innerText ?? '').catch(() => '')).slice(0, 200);
        say(`EMAIL post-submit: opened the email-verification link on ${clean(new URL(scratch.url()).hostname)}: "${text}"`);
      } finally {
        await scratch.close().catch(() => undefined);
      }
    };
    let accountEmail;
    // Answer registry: a choice Jev picks for a named question (radio or dropdown) is saved to answers.json qa
    // under that question, so later applications answer it the same way; edit answers.json to correct one.
    function remember(question, answer, replace = false) {
      const key = answers.normalize(questionOf(question));
      if (!key || key.length > 300 || !answer || !isQuestionLabel(key) || (!replace && values.has(`qa.${key}`))) return;
      const stored = answers.load(answerPath);
      stored.qa = { ...stored.qa, [key]: answer };
      answers.save(answerPath, stored);
      values.set(`qa.${key}`, answer);
      say(`REMEMBERED "${clean(question)}" = "${clean(answer)}"`);
    }

    function accountForms(current) {
      const passwords = passwordFields(current);
      if (passwords.length) return new Set(passwords.map(field => field.formRef).filter(Boolean));
      // Listing/apply-entry and unrelated newsletter/search forms never establish identity.
      if (current.controls.some(control => rules.classifyControl(control) === 'apply-entry')) return new Set();
      return new Set(current.controls
        .filter(control => control.formRef && ['login', 'step'].includes(rules.classifyControl(control)))
        .map(control => control.formRef));
    }

    function rememberEmail(current, field, value) {
      if (field.formRef && accountForms(current).has(field.formRef) && isEmailField(field) && String(value).trim()) {
        accountEmail = { page, host: credentials.hostFromUrl(current.url), formRef: field.formRef, value: String(value).trim() };
      }
    }

    function accountIdentity(current) {
      const host = credentials.hostFromUrl(current.url);
      const forms = accountForms(current);
      const fields = current.fields.filter(field => field.formRef && forms.has(field.formRef) && isEmailField(field)
        && fieldType(field) !== 'password' && fieldType(field) !== 'file' && String(field.value ?? '').trim());
      const emails = new Set(fields.map(field => String(field.value).trim()));
      if (emails.size > 1) throw new Stop('credential-email-ambiguous');
      if (emails.size === 1) {
        const value = emails.values().next().value;
        if (new Set(fields.map(field => field.formRef)).size === 1) rememberEmail(current, fields[0], value);
        return { host, username: value };
      }
      if (accountEmail?.page === page && accountEmail.host === host && forms.has(accountEmail.formRef)) {
        return { host, username: accountEmail.value };
      }
      const email = values.get('facts.email');
      return { host, username: email?.trim() || null };
    }

    async function freshSnapshot(expected) {
      const fresh = await observe(page);
      // A lone verification-code gate is handled by the main loop (emailed codes are fetched): re-observe there.
      if (fresh.gates.length === 1 && fresh.gates[0] === 'mfa' && fresh.url !== emailCodeUrl) invalidPlan('stale-screen');
      // So is an open captcha puzzle (the main loop waits for the user to solve it).
      if (fresh.gates.includes('captcha-challenge')) invalidPlan('stale-screen');
      stopForGates(fresh);
      if (fresh.url !== expected.url) invalidPlan('stale-screen');
      return fresh;
    }

    // A captcha only the user can solve (an open puzzle, or the unticked box before the final submit) is waited out
    // in place: the run alerts the user, re-checks every 3 s for up to 5 minutes, and resumes on the same page. A run
    // that exits instead leaves the site's post-captcha submit (iCIMS's spinning "Next") with nobody to drive it.
    const CAPTCHA_GATES = new Set(['captcha', 'captcha-challenge']);
    async function awaitCaptcha(current) {
      if (!current.gates.length || !current.gates.every(gate => CAPTCHA_GATES.has(gate))) return false;
      say(`GATE ${current.gates.join(' ')}: waiting up to 5 min for the user to solve it`);
      notify(`Solve the captcha on ${new URL(current.url).host}`);
      for (const end = Date.now() + 300_000; Date.now() < end;) {
        await new Promise(done => setTimeout(done, 3000));
        const next = await observe(page);
        if (!next.gates.some(gate => CAPTCHA_GATES.has(gate))) {
          // A closed puzzle is not a solve: hCaptcha can close it yet issue no token (its risk check rejected the
          // solve), leaving the site's submit spinning forever. Solved means a token arrived or the page moved on.
          if (next.url === current.url && await captchaTokenEmpty()) {
            await new Promise(done => setTimeout(done, 30_000));
            if (page.url() === current.url && await captchaTokenEmpty()) {
              throw new Stop('captcha-rejected: the captcha closed after solving but issued no token, so the site cannot continue; apply in a normal browser');
            }
          }
          say('GATE captcha solved; resuming');
          history.push('the user solved the captcha');
          // The solve posts the form; a page that comes back with its file input empty (iCIMS) needs the file again.
          for (const url of [current.url, next.url]) for (const key of [...uploads.keys()]) if (key.startsWith(`${url}|`)) uploads.delete(key);
          return true;
        }
      }
      return false;
    }
    // True when the page holds a captcha response box (hCaptcha/reCAPTCHA) and every one of them is still empty.
    async function captchaTokenEmpty() {
      const values = [];
      for (const frame of page.frames()) {
        const found = await frame.evaluate(() => [...document.querySelectorAll('textarea[name=h-captcha-response], textarea[name=g-recaptcha-response]')]
          .map(box => box.value.length)).catch(() => []);
        values.push(...found);
      }
      return values.length > 0 && values.every(length => length === 0);
    }

    // Labels name the code ("Verification code") or a one-character OTP box ("Please enter OTP character 1").
    function emailCodeFields(current) {
      return current.fields.filter(field => fieldType(field) !== 'password'
        && (/\b(verification|one.?time|security|confirmation|otp)\b.*\bcode\b|\bcode\b.*\bverif|\botp (character|digit)\b/i.test(`${labelOf(field)} ${field.name ?? ''}`)
          || (field.maxLength > 0 && field.maxLength <= 10 && (/^(enter |the |your |\d+.digit )*(pass ?code|code)\W*(required)?$/i.test(clean(labelOf(field))) || /^pass ?code$/i.test(field.name ?? '')))));
    }

    // A code sent to an inbox the user connected (multi-gmail) is fetched and typed by the run: the inbox is
    // polled on a fixed schedule and DeepSeek picks the code from the new mail. SMS/authenticator codes stop.
    async function enterEmailedCode(current) {
      requireEmail();
      const text = current.pageText ?? '';
      // The address the code went to: named in the code boxes' own labels/messages first (Greenhouse's code row sits
      // below a posting that fills the clipped page text, which may also name a recruiter's address), else the page.
      const shown = [...current.fields.map(field => `${field.label ?? ''} ${field.message ?? ''}`), ...(current.messages ?? []), text].join('\n');
      // A code modal over a long form may be clipped out of the page text: the applicant's own address (the only one
      // the harness ever enters) is the inbox then.
      const address = [...shown.matchAll(/[\w.+*-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0])[0] ?? values.get('facts.email');
      const account = address ? await email.accountFor(address) : null;
      // A code box that still holds text while the page is gated holds a stale or mistyped code: it is replaced.
      const codeFields = emailCodeFields(current);
      // The page names the inbox the code went to (an address on screen): that inbox is read.
      // One box takes the whole code; a row of one-character boxes ("code 1" … "code 6") takes one character each.
      if (!account || !codeFields.length || (codeFields.length > 1 && codeFields.length < 4)) stopForGates(current);
      phase = 'email-code';
      const pick = messages => pickCode({ site: credentials.hostFromUrl(current.url), page: text, messages });
      const poll = wait => say(`EMAIL waiting ${wait / 1000}s for the code sent to ${clean(address)}`);
      // The site rejected the code in the boxes ("Invalid security code"): mail from before now is stale.
      const rejected = [...(current.messages ?? []), ...current.fields.map(field => field.message ?? '')]
        .some(message => /\b(invalid|incorrect|expired|wrong)\b.{0,30}\bcode\b|\bcode\b.{0,30}\b(invalid|incorrect|expired)\b/i.test(message));
      const submitControl = snapshot => allowSubmit ? snapshot.controls.find(control => rules.classifyControl(control) === 'final-submit') : undefined;
      // A code that has not arrived within ~1.5 min (or was rejected) is re-requested once through the page's own
      // resend control.
      let code = rejected ? null : await email.waitForCode(account, Date.now() - 10 * 60_000, pick, poll, [10_000, 30_000, 60_000]);
      const resend = !code && current.controls.find(control => /\b(resend|send (a )?new|send again)\b/i.test(control.label ?? ''));
      if (resend) {
        const requested = Date.now();
        await mutate('CLICK', labelOf(resend), () => act.click(page, resend.ref));
        say(`EMAIL ${rejected ? 'code rejected' : 'no code yet'}; clicked ${clean(labelOf(resend))} for a new one`);
        code = await email.waitForCode(account, requested - 5_000, pick, poll);
      } else if (!code && !rejected) {
        // No resend control: the page still wants the code it sent when it first gated, possibly in an earlier run
        // that stopped here. The day's mail is read once for it.
        code = await email.waitForCode(account, Date.now() - 24 * 3_600_000, pick, poll, [0]);
        if (code) say('EMAIL using the code sent earlier (the page offers no resend)');
      }
      // Still none (or the site rejected it), and no resend: a form that mails a code per submit (Greenhouse: "enter
      // the code, resubmit") is reloaded once under --submit; the run refills it, and its next submit mails a new code.
      if (!code && allowSubmit && !resend && (reloads.get(current.url) ?? 0) < 1) {
        reloads.set(current.url, (reloads.get(current.url) ?? 0) + 1);
        say(`EMAIL ${rejected ? 'code rejected' : 'no usable code'}; reloading the form so its next submit mails a new code`);
        runlog.trace('reload', { url: current.url });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await pause(3000);
        emailCodeUrl = null;
        return;
      }
      if (!code) throw new Stop(`email-code-not-received ${clean(address)}`);
      const fresh = await observe(page);
      if (fresh.url !== current.url) invalidPlan('stale-screen');
      const boxes = codeFields.map(box => fresh.fields.find(candidate => candidate.ref === box.ref));
      if (boxes.some(box => !box)) invalidPlan('stale-screen');
      if (boxes.length > 1 && boxes.length !== code.length) throw new Stop(`email-code-shape ${boxes.length} boxes for a ${code.length}-character code`);
      const parts = boxes.length > 1 ? [...code] : [code];
      for (const [i, box] of boxes.entries()) {
        await mutate('FILL', labelOf(box), () => act.type(page, box.ref, parts[i], { secret: !isEmpty(box) }));
      }
      emailCodeUrl = current.url;
      // A code modal over the application form itself (three or more applicant fields besides the code boxes).
      if (!signInReturn && current.fields.filter(field => !codeFields.includes(field) && fieldType(field) !== 'hidden').length >= 3) {
        signInReturn = { url: current.url, used: 0 };
        browser.recordApplicationUrl(url, current.url);
      }
      // Signing in mid-form (Phenom asks for an account when a resume is attached) can drop the file taken before
      // it: the resume may go in again.
      for (const key of [...uploads.keys()]) if (key.startsWith(`${current.url}|`)) uploads.delete(key);
      say(`EMAIL code entered into ${clean(labelOf(boxes[0]))}${boxes.length > 1 ? ` (+${boxes.length - 1} boxes)` : ''}`);
      // A code row on the application form itself (the gate appeared on submit) is sent with that same final submit:
      // under --submit the run resubmits at once, when nothing else required on the form is empty.
      const typed = await observe(page);
      const submit = submitControl(typed);
      const codeRefs = new Set(codeFields.map(field => field.ref));
      if (submit && !activeFields(typed).some(field => field.required && isEmpty(field) && !codeRefs.has(field.ref) && fieldType(field) !== 'file')) {
        await mutate('CLICK', labelOf(submit), () => act.click(page, submit.ref));
        submittedVia = labelOf(submit);
        submitFilled = new Set(activeFields(typed).filter(field => !isEmpty(field)).map(field => field.ref));
        submitUrl = typed.url;
        submitAt = Date.now();
        history.push(`typed the emailed verification code and clicked "${labelOf(submit)}"`);
        say(`EMAIL code submitted with ${clean(labelOf(submit))}`);
        await pause(2500);
        return;
      }
      history.push(`typed the emailed verification code into "${labelOf(boxes[0])}"; submit it with the page's verify/continue control`);
    }

    // Follow only an account-verification link for this site in fresh mail. A link already in the inbox (sent at
    // sign-up, or by an earlier run's resend) is used first; Resend is clicked only when none is there, once per run.
    const verificationRequested = new Set();
    async function followEmailedVerification(current) {
      const resend = current.controls.find(control => /\bresend\b.*\b(account|email)\b.*\bverif/i.test(control.label ?? '')
        || /\bresend\b.*\bverif/i.test(control.label ?? '') && /\b(account|email)\b.{0,100}\bverif|\bverif\w*\b.{0,100}\b(account|email)\b/i.test(current.pageText ?? ''));
      if (!resend) return false;
      requireEmail();
      const host = credentials.hostFromUrl(current.url);
      if (verificationRequested.has(host)) throw new Stop('needs-user-email-verification: the account still requires verification after the emailed link');
      if (current.gates.length) stopForGates(current, { submitting: true });
      verificationRequested.add(host);
      phase = 'email-verification-link';
      const inbox = async check => {
        try { return await check(); }
        catch { throw new Stop(`needs-user-email-verification: Gmail account ${EMAIL_LABEL} is unavailable; open the account-verification email`); }
      };
      let link = await inbox(() => email.findVerificationLink(EMAIL_LABEL, runStarted - 60 * 60_000, current.url));
      if (link) say(`EMAIL found an existing account-verification link for ${clean(host)}; not resending`);
      else {
        // Resend sends to the address typed in the page's email box (Workday fails the resend when it is empty).
        const emailBox = activeFields(current).find(field => isEmpty(field) && fieldType(field) !== 'password'
          && (field.type === 'email' || /\be-?mail\b/i.test(labelOf(field))));
        if (emailBox && values.get('facts.email')) {
          await mutate('FILL', labelOf(emailBox), () => act.type(page, emailBox.ref, values.get('facts.email')));
        }
        if (!await click(current, currentControl(current, resend.ref))) { verificationRequested.delete(host); return false; }
        say(`EMAIL requested account verification on ${clean(host)}`);
        link = await inbox(() => email.waitForVerificationLink(EMAIL_LABEL, Date.now() - 60_000, current.url,
          wait => say(`EMAIL waiting ${wait / 1000}s for an account-verification link`)));
      }
      // The site may refuse to resend ("Failed to resend…", rate-limited); the newest earlier link for this host
      // (an unused sign-up email from a past run) still activates the account.
      if (!link) {
        link = await inbox(() => email.findVerificationLink(EMAIL_LABEL, Date.now() - 14 * 24 * 60 * 60_000, current.url));
        if (link) say(`EMAIL no fresh link; using the newest earlier account-verification link for ${clean(host)}`);
      }
      if (!link) throw new Stop('needs-user-email-verification: no fresh HTTPS account-verification link for this site was received');
      // Never log the token-bearing URL or pass it to a model.
      await mutate('VERIFY', 'emailed account link', async () => {
        try { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
        catch { throw new Error('account verification navigation failed'); }
      });
      say('EMAIL opened the account-verification link in the application tab');
      history.push('followed the fresh account-verification email; sign in with the existing stored account');
      return true;
    }

    // A site-required password reset ("you need to reset your password", or Jev chose Forgot Password for an account
    // whose stored password is rejected): after the reset request is clicked, the emailed reset link for this site is
    // opened in the application tab, and the next credentials fill there sets a fresh Keychain password (rotate).
    // One reset request per host per run, so a failing run cannot flood the inbox.
    const resetRequested = new Set();
    const resetPasswords = new Map();
    function isResetRequest(current, control) {
      // The request form's own button: "Send reset link", "Reset password", or a bare "Continue" (Auth0: "Forgot Your
      // Password? Enter your email address and we will send you instructions to reset your password.").
      return !passwordFields(current).length && /\b(reset|send)\b|^continue$/i.test(clean(control.label))
        && /\b(forgot|reset)\b[\s\S]{0,30}\bpassword\b/i.test(current.pageText ?? '');
    }
    async function followEmailedReset(current, requestedAt) {
      requireEmail();
      const host = credentials.hostFromUrl(current.url);
      if (resetRequested.has(host)) throw new Stop('needs-user-email-verification: the password reset was already requested in this run');
      resetRequested.add(host);
      phase = 'email-password-reset';
      say(`EMAIL requested a password reset on ${clean(host)}`);
      let link;
      try {
        link = await email.waitForVerificationLink(EMAIL_LABEL, requestedAt - 15_000, current.url,
          wait => say(`EMAIL waiting ${wait / 1000}s for a password-reset link`), [10_000, 30_000, 60_000], 'reset');
      } catch {
        throw new Stop(`needs-user-email-verification: Gmail account ${EMAIL_LABEL} is unavailable; open the password-reset email`);
      }
      if (!link) throw new Stop('needs-user-email-verification: no fresh HTTPS password-reset link for this site was received');
      await mutate('VERIFY', 'emailed password-reset link', async () => {
        try { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
        catch { throw new Error('password reset navigation failed'); }
      });
      resetPasswords.set(credentials.hostFromUrl(page.url()), null);
      say('EMAIL opened the password-reset link in the application tab');
      history.push('opened the emailed password-reset link; fill the new password fields with credentials (the harness sets a fresh stored password), submit, then sign in');
    }

    // Returns false (nothing dispatched) when the target is gone or changed on a fresh read: the page re-rendered or
    // is still loading, so the caller observes again instead of stopping the run.
    async function click(current, target, fill) {
      // A tab this click opens is picked up by `tabs` at the top of the next pass.
      const fresh = await freshSnapshot(current);
      let ref;
      try {
        if (fill) {
          const resolved = resolveFill(fresh, { ref: freshRef(fresh, target), key: fill.key }, values);
          ref = resolved.optionRef;
          if (!ref) invalidPlan('stale-option');
        } else {
          const control = currentControl(fresh, target.ref);
          sameTarget(target, control);
          // Remember the account email before a step navigates away; an ambiguous
          // screen simply records nothing (only credentials actions require identity).
          if (rules.classifyControl(control) !== 'apply-entry') {
            try { accountIdentity(fresh); } catch (error) { if (!(error instanceof Stop)) throw error; }
          }
          ref = control.ref;
        }
      } catch (error) {
        if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
        runlog.trace('refused', { source: 'executor', action: `click:${target.ref}`, reason: `stale ${error.message}` });
        return false;
      }
      await mutate('CLICK', labelOf(target), () => act.click(page, ref));
      return true;
    }

    // The run starts on one fixed goal; DeepSeek is consulted only when Jev stays stuck on a screen,
    // and its guidance (or goal list) refines that goal. Finished planner goals fall back to it.
    const BASE_GOAL = {
      goal: 'Complete this job application',
      done_when: 'The application has been submitted or the final review/submit step is reached',
      guidance: 'Open the application if it is not open yet, sign in or create the employer account when asked, fill every field and answer every question (required and optional) from the stored answers, add any required entries (education, work experience), upload the resume when asked, then continue to the next step. A repeatable section whose entry takes one choice (Skills, Languages) gets one entry per item of the stored list answer (fill the entry field from the list key; the executor enters the next unentered item), until every listed item the site offers is entered. Optional questions about the applicant, the role, or preferences are answered too (they help the application); only optional marketing/notification opt-ins and optional demographic fields without a stored answer stay empty.',
    };
    let goals = [{ ...BASE_GOAL }];
    const completed = [];
    let targetNote = '';
    // The first screen's text (the posting itself): the cover-letter writer's description of the role.
    let postingText = '';
    // The resume rewritten for this posting, started as soon as the posting text is read so the writer works while the
    // form is filled; null when it could not be built (the lane resume is uploaded instead).
    let tailoredPending = null;
    const tailorResume = pageText => tailoredResume({ url: runUrl, title: runInfo.title ?? '', pageText, basePdf: resume })
      .catch(error => {
        runlog.trace('tailored-resume-error', { message: clean(error?.message).slice(0, 200) });
        say(`RESUME not tailored (${clean(error?.message).slice(0, 120)}); using ${basename(resume)}`);
        return null;
      });
    // Resume uploads per page URL and file-field label (see the upload_resume check).
    const uploads = new Map();
    // Registry keys of essays the writer composed this run: they name this employer and posting, so they are never
    // saved to answers.json nor learned as the key for that label on later applications.
    const essayKeys = new Set();
    // Hosts whose password was generated this run for an account still being created (cleared by a later login).
    const registering = new Set();
    // URLs whose nearly empty screen already got one long wait before a planner stop.
    const blankWaits = new Set();

    // DeepSeek is consulted only when Jev stays stuck. Its answer is concrete actions on the current screen
    // (queued and run through the same executor checks), or a revised goal list, or a stop.
    async function replan(current, escalation, context) {
      phase = 'planner';
      let result;
      try { result = await planGoals(modelView(current), { goals, completed, escalation, ...context }); }
      catch (error) { runlog.trace('planner-error', { escalation, message: clean(error?.message) }); throw new Stop('planner-error', 1); }
      runlog.trace('planner', { escalation, goals, result });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Stop('planner-error', 1);
      if (typeof result.stop === 'string' && result.stop.trim()) {
        // A screen with no fields and almost no controls right after a step (a verify page between states, a
        // spinner) is usually still loading: it gets one longer wait per URL before a stop is believed.
        if (!activeFields(current).length && current.controls.length <= 4 && !blankWaits.has(current.url)) {
          blankWaits.add(current.url);
          say(`WAIT the screen is nearly empty (${current.controls.length} controls); giving it 12s before stopping`);
          await delay(12000);
          return;
        }
        throw new Stop([clean(result.stop), ...(Array.isArray(result.questions) ? result.questions : []).map(clean)].filter(Boolean).join(' '));
      }
      if (Array.isArray(result.actions)) {
        queued = [];
        for (const action of result.actions) {
          const last = queued.at(-1);
          // Free-text answers are composed by the writer model when this item runs (writeFor), then filled.
          if (action.do === 'write' && last?.action === 'write') { last.refs.push(action.ref); continue; }
          if (action.do === 'write') { queued.push({ action: 'write', refs: [action.ref] }); continue; }
          const fill = action.do === 'fill' ? { ref: action.ref, key: action.key } : null;
          if (fill && last?.action === 'fill') last.fields.push(fill);
          else if (fill) queued.push({ action: 'fill', fields: [fill] });
          else if (action.do === 'credentials') queued.push({ action: 'credentials', mode: action.mode });
          else if (action.do === 'choose') queued.push({ action: 'choose', ref: action.ref, key: action.key });
          else {
            // A click keeps the label its ref had when planned: a re-rendered page reuses refs for other controls.
            const planned = current.controls.find(control => control.ref === action.ref);
            queued.push({ action: action.do, ref: action.ref, label: planned ? clean(planned.label) : undefined });
          }
        }
        queuedUrl = current.url;
        // A consult that ends in the final submit teaches nothing reusable: a submit that works ends the application,
        // and one the site rejects ("All steps complete, so submit") would steer later runs into the same loop.
        const submits = result.actions.some(action => action.do === 'click'
          && rules.classifyControl(current.controls.find(control => control.ref === action.ref) ?? {}) === 'final-submit');
        if (result.note && !submits) pendingLesson = { host: credentials.hostFromUrl(current.url), note: result.note };
        say(`DEEPSEEK ${result.actions.map(a => a.do === 'fill' ? `fill ${a.ref}=${a.key}` : `${a.do} ${a.ref ?? a.mode}`).join(', ')}${result.note ? ` — ${clean(result.note)}` : ''}`);
        return;
      }
      if (!Array.isArray(result.goals) || !result.goals.length
        || result.goals.some(goal => !goal || typeof goal !== 'object' || Array.isArray(goal)
          || typeof goal.goal !== 'string' || !goal.goal.trim()
          || typeof goal.done_when !== 'string' || !goal.done_when.trim()
          || typeof goal.guidance !== 'string')) throw new Stop('planner-error', 1);
      goals = result.goals.map(goal => ({ goal: goal.goal.trim(), done_when: goal.done_when.trim(), guidance: `${goal.guidance.trim()}${targetNote}` }));
      recent.length = 0;
      say(`PLAN ${goals.map(goal => clean(goal.goal)).join(' → ')}`);
    }

    let consults = 0;
    const reloads = new Map();
    const retyped = new Set();
    // When a clicked Continue started waiting on the page captcha, per URL (see the disabled-Continue check).
    const captchaPending = new Map();
    // A submission counts only with positive evidence: the page states it was received (a thank-you, "application
    // submitted/received", "applied on <date>"), and no final-submit control or required empty field remains.
    // A closed modal or an emptied form alone is not a submission.
    // Only consulted after this run clicked a final submit (submittedVia), so post-submit phrasing ("You're all set")
    // counts too.
    // "succesfully"/"sucessfully" misspellings and "has successfully been submitted" word order are site wording too.
    const SUBMITTED_TEXT = /thank(s| you) for (your )?(application|applying|submitting|submission|your interest|(your )?registration|registering)|application (has |have )?(been |was |is )?(succ?ess?fully )?(been )?(submitted|received|complete|sent)|(we('ve| have)|has been) received your application|\bapplied on\b|you('ve| have)? (succ?ess?fully )?applied|submission (is )?(complete|received|successful)|succ?ess?fully submitted|you('| a)re all set\b/i;
    // Some sites confirm only by where they land after the submit (Workday: /jobTasks/completed/application).
    const SUBMITTED_URL = /\/(completed\/application|application-?(submitted|complete|confirmation)|thank-?you|confirmation)\b/i;
    const isConfirmed = current => (SUBMITTED_TEXT.test(String(current.pageText ?? '')) || SUBMITTED_URL.test(new URL(current.url).pathname))
      && !current.controls.some(control => rules.classifyControl(control) === 'final-submit')
      && !activeFields(current).some(field => field.required && isEmpty(field));
    confirmSubmitted = async () => isConfirmed(await observe(page));
    // A standing confirmation found without this run's submit must name a received application: account sign-up
    // pages say "Thank you for registering" too, and a talent-community "thank you for your interest" is no application.
    const APPLIED_TEXT = /application (has |have )?(been |was |is )?(succ?ess?fully )?(been )?(submitted|received|sent)|(we('ve| have)|has been) received your application|thank(s| you) for (your )?(application|applying)|you('ve| have)? (succ?ess?fully )?applied\b|\bapplied on\b/i;
    let lastMark = null;
    let stalls = 0;
    let lookedAgain = null;
    let consultScreen = null;
    let screenConsults = 0;
    // Jev's own planning pass (jevPlan) per screen: the actions it chose there, so a pick that made no progress is
    // never chosen again; DeepSeek is consulted only once Jev has planned twice on one screen, or has nothing left.
    let jevPlanScreen = null;
    let jevPlanTried = new Set();
    let jevPlans = 0;
    const actionKeyOf = plan => plan.action === 'click' ? `click:${plan.ref}` : plan.action === 'check' ? `check:${plan.ref}`
      : plan.action === 'upload_resume' ? `upload:${plan.ref}` : plan.action === 'fill' ? 'fill'
      : plan.action === 'credentials' ? `credentials:${plan.mode}` : null;
    // DeepSeek's actions for one screen, run in order before Jev is asked again; dropped once the screen changes.
    let queued = [];
    let queuedUrl = null;
    // A consult's note becomes a lesson for that host once its actions got Jev moving again.
    let pendingLesson = null;
    const learned = await loadLearned();
    // Fields the executor already filled from learned.json on this run (by ref), so a rejected one is not retried.
    const learnedTried = new Set();
    // Free-text fields the writer already answered on this run (url|label), so it writes each question once.
    const writeTried = new Set();
    // Screens whose advance click was refused once for unanswered required questions (url|advance|questions).
    const advanceRefused = new Set();
    // Learn label for each filled field label (fields are learned under label or name, never a ref).
    const learnAs = {};
    // A stored answer no dropdown choice spells out: reuse the choice past runs mapped it to, else let Jev pick
    // the listed choice stating the same fact once and keep it in learned.json (choices: answer → choice texts).
    // `preferences` is the answer then its aliases in preference order (Computer Science before Engineering for the
    // major). A new mapping is appended, so the first-established (preferred) choices keep priority over later fallbacks.
    async function chooseOption(question, value, listed, preferences = [value]) {
      const options = listed.filter(Boolean);
      // A catch-all ("Other", "None of the above") learned on one site is re-judged on another: the site may list a
      // concrete match, and a catch-all can leave a dependent required field (a "Source" list under "Other") empty.
      const vague = choice => /^(other|others|none( of (the )?above)?|not listed|n\/?a)\b/i.test(clean(choice));
      const learnedChoices = (learned.choices?.[answers.normalize(value)] ?? []).filter(choice => options.includes(choice));
      const known = learnedChoices.find(choice => !vague(choice));
      if (known) { say(`LEARNED choice "${clean(known)}" for ${clean(question)}`); return known; }
      let option = null;
      try { option = await pickOption(question, value, options, preferences); } catch { option = null; }
      if (!option && learnedChoices.length) { say(`LEARNED choice "${clean(learnedChoices[0])}" for ${clean(question)}`); return learnedChoices[0]; }
      if (!option) return null;
      const key = answers.normalize(value);
      learned.choices = { ...learned.choices, [key]: [...(learned.choices?.[key] ?? []).filter(choice => choice !== option), option].slice(-12) };
      await saveLearned(learned);
      say(`LEARNED choice "${clean(option)}" for stored answer (${clean(question)})`);
      return option;
    }
    // The writer's view of the applicant: stored facts/qa (no secrets, no alias variants) plus profile.md (gitignored:
    // the writer dossier of stories, character, and voice), re-read each call so edits apply immediately.
    async function writerApplicant() {
      const applicant = { facts: {}, qa: {}, resume: {} };
      for (const [key, value] of values) {
        const [group, ...rest] = key.split('.');
        if (key !== SECRET_KEY && key !== RESUME_PATH_KEY && applicant[group] && !/\.(alt|alias)_\d+$/.test(key)) applicant[group][rest.join('.')] = String(value);
      }
      // Configured logistics (config.applicant): the writer states a preference only for true/nonempty values, so an
      // unset field makes no claim (never a "No").
      applicant.preferences = {
        relocateAnywhere: config.applicant.relocateAnywhere,
        workInPerson: config.applicant.workInPerson,
        summerAvailability: config.applicant.summerAvailability,
      };
      try { applicant.profile = await readFile(new URL('./profile.md', import.meta.url), 'utf8'); } catch { applicant.profile = ''; }
      return applicant;
    }
    // Free-text questions no stored answer fits: the writer model composes the applicant's answers (within each
    // field's limit and validation message); each joins the answer registry, then fills like any stored answer.
    async function writeFor(current, refs) {
      const fields = refs.map(ref => activeFields(current).find(field => field.ref === ref))
        .filter(field => field && !field.autocomplete && !['password', 'file', 'radio', 'checkbox', 'select'].includes(fieldType(field))
          && !NEVER_WRITE.test(answers.normalize(labelOf(field))));
      if (!fields.length) return [];
      const applicant = await writerApplicant();
      const questions = fields.map(field => ({
        ref: field.ref, question: labelOf(field), ...(field.prompt ? { prompt: field.prompt } : {}), kind: fieldType(field), limit: limitOf(field),
        message: field.message ?? messageFor(current, labelOf(field)) ?? null,
      }));
      phase = 'writer';
      const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(current.pageText ?? '').slice(0, 3000) };
      const written = await writeAnswers({ job, applicant, questions });
      runlog.trace('writer', { refs, written: Object.keys(written) });
      const fills = [];
      for (const field of fields) {
        if (!written[field.ref]) continue;
        const key = `qa.${answers.normalize(labelOf(field))}`;
        if (fieldType(field) === 'textarea') {
          values.set(key, written[field.ref]);
          essayKeys.add(key);
        } else remember(labelOf(field), written[field.ref], true);
        fills.push({ ref: field.ref, key });
      }
      say(`WRITER ${fills.length}/${fields.length} answers (${clean(fields.map(labelOf).join('; ')).slice(0, 160)})`);
      return fills;
    }
    // Deterministic steps, tried before any model on a screen where the next move has no decision in it. Each rule
    // fires at most once per screen fingerprint: a screen that does not change after it goes to Jev as before.
    // Cheapest first: resume upload into an empty resume slot; the posting's single Apply entry when no application
    // fields are showing; then, on a screen with nothing left to fill (no empty field except optional ticks and
    // extra-document slots, no placeholder dropdown, no invalid field, no error message), its single forward step
    // (Next/Continue/Save and Continue), or with --submit and no step left, its single final submit.
    const ruleTried = new Set();
    const entriesUsed = new Set();
    const ruleRepeats = new Map();
    const ERROR_MESSAGE = /\b(required|invalid|error|must|please (enter|select|choose|provide|correct|complete|fix))\b/i;
    function rulePlan(current, screen) {
      const fields = activeFields(current);
      // One try per screen, and at most three of the same action on one page: a control whose click only changes
      // a widget (a calendar page) yields a new screen each time and must not loop the rule.
      const fresh = key => !ruleTried.has(`${screen}|${key}`) && (ruleRepeats.get(`${current.url}|${key}`) ?? 0) < 3;
      const take = (key, plan, why) => {
        ruleTried.add(`${screen}|${key}`);
        ruleRepeats.set(`${current.url}|${key}`, (ruleRepeats.get(`${current.url}|${key}`) ?? 0) + 1);
        return { plan, why };
      };
      const files = current.fields.filter(field => fieldType(field) === 'file');
      const resumeShown = current.controls.some(control => control.attached && /\b(resume|résumé|cv)\b/i.test(control.context ?? ''));
      if (resumeAvailable && !resumeShown) {
        const slot = fields.find(field => fieldType(field) === 'file' && isEmpty(field) && rules.documentKind(field, files.length) === 'resume'
          && !uploads.get(`${current.url}|${labelOf(field)}`) && !refused.actions.has(`upload:${field.ref}`));
        if (slot && fresh(`upload:${slot.ref}`)) return take(`upload:${slot.ref}`, { action: 'upload_resume', ref: slot.ref }, `resume slot "${labelOf(slot)}" is empty`);
      }
      const distinct = controls => new Set(controls.map(control => clean(control.label).toLowerCase())).size === 1;
      if (!fields.length) {
        // An entry the rule already used on this page (its dialog opened over the posting) is not clicked again: the
        // dialog's own next entry ("Step 2: External Application") is.
        const all = current.controls.filter(control => rules.classifyControl(control) === 'apply-entry');
        const entries = all.filter(control => !entriesUsed.has(`${current.url}|${clean(control.label).toLowerCase()}`));
        if (entries.length && distinct(entries) && fresh(`click:${entries[0].ref}`)) {
          entriesUsed.add(`${current.url}|${clean(entries[0].label).toLowerCase()}`);
          return take(`click:${entries[0].ref}`, { action: 'click', ref: entries[0].ref }, `the posting's only apply entry "${clean(entries[0].label)}"`);
        }
        // A fieldless screen that is not the posting (an intro, a review step) goes on to the step/submit rules below,
        // and so does a used entry's open application dialog whose only content is its submit (the resume preattached):
        // the posting's Apply button stays on the page behind it.
        const dialogSubmit = !entries.length && current.controls.some(control => control.formRef
          && rules.classifyControl(control) === 'final-submit');
        if (all.length && !dialogSubmit) return null;
      }
      // With --submit, a required single acknowledgement box ("I certify the information is accurate", "I agree to
      // the terms") is ticked, as is an account form's terms/data-processing box (often not marked required);
      // marketing/SMS/alert opt-ins never match (the executor refuses them anyway).
      const password = fields.find(field => fieldType(field) === 'password');
      if (allowSubmit) {
        const attest = fields.find(field => fieldType(field) === 'checkbox' && isEmpty(field)
          && (field.required || (password && (field.formRef ?? '') === (password.formRef ?? '')))
          && (field.optionRefs?.length ?? 1) <= 1
          && /\b(agree|acknowledge|certify|attest|confirm|consent|i have read|i understand|accurate|true and complete)\b/i.test(labelOf(field))
          && !/\b(sms|text message|marketing|newsletter|alerts?|notifications?|promotional|offers|subscribe)\b/i.test(labelOf(field)));
        const ref = attest && (attest.optionRefs?.[0] ?? attest.ref);
        if (attest && fresh(`check:${ref}`)) return take(`check:${ref}`, { action: 'check', ref }, `required acknowledgement "${clean(labelOf(attest)).slice(0, 60)}"`);
      }
      const blocking = field => isEmpty(field) && (field.required || !['checkbox', 'file', 'hidden'].includes(fieldType(field)));
      // A dropdown trigger still showing its placeholder blocks when it is in a form, or (formless pages: Workday)
      // when its label marks it required ("Degree Select One Required").
      const placeholder = current.controls.some(control => control.current !== undefined
        && (control.formRef || /\brequired\b|\*/i.test(clean(control.label)))
        && (!clean(control.current) || /^(select|choose|please select|--)/i.test(clean(control.current))));
      if (fields.some(blocking) || fields.some(field => field.invalid) || placeholder
        || (current.messages ?? []).some(message => ERROR_MESSAGE.test(message))) return null;
      // Only a forward step: a bare "Save" stores a section (or a profile) without moving on.
      const steps = current.controls.filter(control => rules.classifyControl(control) === 'step' && !control.href
        && /\b(next|continue)\b/i.test(clean(control.label)) && !resultsPager(current, control));
      if (steps.length) {
        return distinct(steps) && fresh(`click:${steps[0].ref}`)
          ? take(`click:${steps[0].ref}`, { action: 'click', ref: steps[0].ref }, `every field is filled; "${clean(steps[0].label)}"`)
          : null;
      }
      // A step left unclicked holds the final submit back; a bare "Save" outside every form (Handshake's bookmark
      // button on the posting) saves no section of the application.
      if (current.controls.some(control => rules.classifyControl(control) === 'step' && !control.href
        && (control.formRef || /\b(next|continue)\b/i.test(clean(control.label))))) return null;
      // A filled account form (sign-in or registration: its password fields hold the Keychain secret) is sent with
      // its own single account button.
      if (password) {
        const own = current.controls.filter(control => rules.classifyControl(control) === 'login' && !control.href
          && (control.formRef ?? '') === (password.formRef ?? ''));
        if (own.length && distinct(own) && fresh(`click:${own[0].ref}`)) {
          return take(`click:${own[0].ref}`, { action: 'click', ref: own[0].ref }, `account form filled; "${clean(own[0].label)}"`);
        }
        return null;
      }
      const finals = allowSubmit ? current.controls.filter(control => rules.classifyControl(control) === 'final-submit'
        && !signupControl(current, control)) : [];
      if (finals.length && distinct(finals) && fresh(`click:${finals[0].ref}`)) {
        return take(`click:${finals[0].ref}`, { action: 'click', ref: finals[0].ref }, `every field is filled; final "${clean(finals[0].label)}"`);
      }
      return null;
    }
    // Last <=6 executed action log lines for the active goal (labels only, no values).
    const recent = [];
    const noteRecent = line => { recent.push(line); if (recent.length > 6) recent.shift(); };
    // Executor safety refusals (pre-dispatch) exclude that action on the same screen; Jev then picks again.
    let refused = { screen: null, actions: new Set() };
    // Per screen fingerprint: actions Jev's ranking picked there (no leading verdict). Kept across revisits.
    const plannedTaken = new Map();
    // Per `${screen}\0${action}`: how many times Jev chose that step there (see the stall brake).
    const screenRepeats = new Map();
    // Attempt history for Jev: executed actions plus their observed outcome on the next screen.
    const history = [];
    // A site's alert/confirm blocks the page's JS thread: every later evaluate hangs to the protocol timeout and the
    // tab is later closed as frozen. Alerts (and beforeunload prompts) are accepted, confirms dismissed (they ask to
    // leave or discard); the text goes to the trace and to the driver's history.
    const dialogWatched = new WeakSet();
    const watchDialogs = target => {
      if (dialogWatched.has(target)) return;
      dialogWatched.add(target);
      target.on('dialog', async dialog => {
        const text = clean(dialog.message()).slice(0, 200);
        runlog.trace('dialog', { type: dialog.type(), message: text });
        say(`DIALOG ${dialog.type()} "${text}"`);
        history.push(`the site showed a ${dialog.type()} dialog: "${text}"${dialog.type() === 'confirm' ? ' (dismissed)' : ''}`);
        await (dialog.type() === 'confirm' ? dialog.dismiss() : dialog.accept()).catch(() => undefined);
      });
    };
    const removedFiles = new Set();
    // Back steps taken toward the resume a review step reported missing; set once that report is seen.
    let resumeWalk = 0;
    let resumeRejected = false;
    const pickerTried = new Set();
    const uploadRetries = new Map();
    let attempt = null;
    // Stored value last sent to each autocomplete box (by ref), so Jev can match its choices.
    const typed = {};
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    // List status rows ("No Items.", "No results found", "Loading…", "Searching") are not choices.
    const choicesFor = (snap, ref) => snap.controls.filter(c => c.kind === 'option' && c.ownerRef === ref
      && !/^(no (items|matches|results|options|records)\b|(loading|searching)\b)/i.test(clean(c.label)));
    // Answer key last typed into each field label; rejected values get planner-written alternatives once per key,
    // and an alternative the site then stops rejecting is saved to aliases.json for later runs.
    const filledKeys = {};
    const rewritten = new Set();
    const baseKey = key => key.replace(/\.(alt|alias)_\d+$/, '');
    // Ref churn must not reset failed fills. Only observed, accepted mutations count toward recovery.
    const fillProgress = new Map();
    const progressKey = (snap, field) => `${snap.url}|${learnLabel(field)}`;
    const fieldState = field => JSON.stringify([field.value ?? '', field.occupied === true, field.checkedRefs ?? []]);
    // A required field that cannot be committed needs the user; an optional one is abandoned and the run goes on.
    const needsField = (field, why) => {
      if (!field.required) {
        abandonedFields.add(`${page.url()}|${learnLabel(field)}`);
        say(`SKIP optional "${labelOf(field)}": ${why}`);
        invalidPlan(`abandoned-optional ${labelOf(field)}`);
      }
      throw new Stop(`needs-user-field "${labelOf(field)}": ${why}`);
    };
    const findField = (snap, field) => {
      // The same element (refs live as long as it does) wins; rows sharing one label ("Office" ×3) are told apart by it.
      const own = activeFields(snap).find(candidate => candidate.ref === field.ref && candidate.tag === field.tag);
      if (own) return own;
      const same = activeFields(snap).filter(candidate => ['tag', 'type', 'label', 'name'].every(key => candidate[key] === field[key]));
      return same.length === 1 ? same[0] : null;
    };
    const aliasesFor = (key, value) => [value, ...[...values].filter(([name]) => name.startsWith(`${baseKey(key)}.alias_`)).map(([, alias]) => alias)];

    async function openField(current, field) {
      const fresh = await freshSnapshot(current);
      const target = findField(fresh, field);
      if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
      await mutate('OPEN', labelOf(target), () => act.openList(page, target.ref));
      await pause(700);
      return freshSnapshot(current);
    }

    // A list answer ("Python, C#, SQL"; "English, Spanish") in a single-choice field takes one item per entry:
    // a repeatable section (Skills, Languages) has one such field per added entry. Items already entered this run (or
    // shown in a sibling entry) are skipped, an unlisted item gives way to the next, and the history tells the planner
    // which items still need their own entry. A multi-select list takes the whole answer as before.
    const listPicks = new Map();
    class MultiList extends Error {}
    // A repeatable section (Languages, Skills) already holds one item of a stored list answer and another item is in
    // no field yet ("English" entered, "Spanish" not): "Add another" opens the row that item needs.
    const moreEntries = current => {
      const entered = new Set(activeFields(current).filter(field => !isEmpty(field)).map(field => answers.normalize(String(field.value))));
      return [...values].some(([key, value]) => !/\.(alt|alias)_\d+$/.test(key) && (() => {
        const items = listItems(value)?.map(item => answers.normalize(item)) ?? [];
        return items.some(item => entered.has(item)) && items.some(item => ![...entered].some(text => text === item || text.startsWith(`${item} `) || item.startsWith(`${text} `)));
      })());
    };
    const listItems = value => {
      // Commas inside parentheses ("Handshake (career platform, campus engagement)") qualify one item, not separate it.
      const items = String(value ?? '').split(/\s*[,;]\s*(?![^()]*\))/).map(item => item.trim()).filter(Boolean);
      // A sentence ("Proficient - I have no difficulty in reading, writing, and speaking English.") is one answer.
      if (/[.!?]\s*$/.test(String(value ?? '').trim()) || items.some(item => /^(and|or|else|otherwise|if)\s/i.test(item))) return null;
      return items.length >= 2 && items.every(item => item.length <= 60) ? [...new Set(items)] : null;
    };
    async function pickField(current, field, key, value) {
      const items = listItems(value);
      if (!items) return pickOne(current, field, key, value);
      const id = `${new URL(page.url()).host}|${learnLabel(field)}`;
      const used = listPicks.get(id) ?? new Set();
      listPicks.set(id, used);
      for (const sibling of activeFields(current)) {
        if (sibling.ref !== field.ref && labelOf(sibling) === labelOf(field) && !isEmpty(sibling)) used.add(answers.normalize(sibling.value));
      }
      for (const item of items.filter(item => !used.has(answers.normalize(item)))) {
        used.add(answers.normalize(item));
        try { await pickOne(current, field, key, item, true); }
        catch (error) {
          if (error instanceof MultiList) { used.clear(); return pickOne(current, field, key, value); }
          const optional = error instanceof Stop && error.message.startsWith('invalid-plan abandoned-optional');
          if (!(error instanceof Stop) || !(optional || error.message.startsWith('needs-user-field'))) throw error;
          // An unlisted item is not the field's last chance: the next item may be listed.
          if (optional) abandonedFields.delete(`${page.url()}|${learnLabel(field)}`);
          await act.press(page, 'Escape').catch(() => undefined);
          say(`PICK "${labelOf(field)}": "${item}" is not listed; trying the next item of the stored list`);
          continue;
        }
        const rest = items.filter(other => !used.has(answers.normalize(other)));
        history.push(`"${labelOf(field)}" takes one item per entry: entered "${item}"${rest.length
          ? `; still to add, each as its own new entry (save this one, then use the section's Add control): ${rest.map(other => `"${other}"`).join(', ')}`
          : '; every listed item is now entered'}`);
        return;
      }
      needsField(field, `no listed choice matches any item of the stored list (${items.join(', ')}) not already entered`);
    }

    // A choice is committed only through this field's owned options, never a nearby unrelated popup.
    // Category rows can open another owned list: re-observe each level, bounded to four picks.
    async function pickOne(current, field, key, value, listItem = false) {
      let fresh = await openField(current, field);
      let target = findField(fresh, field);
      if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
      if (listItem && choicesFor(fresh, target.ref).some(option => option.multi)) throw new MultiList();
      typed[target.ref] = value;
      const equivalent = aliasesFor(key, value).map(answers.normalize);
      // A suggestion that extends the stored answer ("42 Oak Street" → "42 OAK STREET, FAIRVIEW, OREGON, 97000") is the
      // same answer with context; among several, the one naming the most other stored facts
      // (city, ZIP) wins.
      const facts = [...values].filter(([name, fact]) => name.startsWith('facts.') && typeof fact === 'string' && fact.length >= 3)
        .map(([, fact]) => answers.normalize(fact));
      // Aliases are in preference order ("Computer Engineering", "Computer Science", …, "Engineering"): each alias in turn
      // takes an option equal to it, else one extending it ("Computer Science …") or, for a multi-word alias, naming it
      // ("Applied Computer Science"), before the next alias is tried. The site's list order never decides.
      const exact = options => {
        for (const text of equivalent) {
          const equal = options.find(option => answers.normalize(option) === text);
          if (equal) return equal;
          const near = options.filter(option => {
            const shown = answers.normalize(option);
            // Containment only for multi-word aliases with a real word: an initialism ("B.A." → "b a") sits inside
            // others ("M.B.A." → "m b a").
            return (text.length >= 4 && shown.startsWith(`${text} `))
              || (text.includes(' ') && text.split(' ').some(word => word.length > 1) && ` ${shown} `.includes(` ${text} `));
          });
          if (near.length) return near.map(option => [option, facts.filter(fact => ` ${answers.normalize(option)} `.includes(` ${fact} `)).length])
            .sort((a, b) => b[1] - a[1])[0][0];
        }
        return undefined;
      };
      let shown = choicesFor(fresh, target.ref);
      // A choice the model matched in a filtered list, used by the pick loop below when no exact match exists.
      let preferred = null;
      // A select-only dropdown with its own search box (select2: "Search Discipline") renders long lists in pages,
      // so an absent answer may simply not be loaded: search for the answer and each alias there.
      if (!(target.tag === 'input' && fieldType(target) !== 'select') && shown.length && !exact(shown.map(option => option.label))) {
        const compact = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        // The dropdown (and its search box) is often appended to <body>, outside the form: look in all fields.
        const searchBox = fresh.fields.find(other => other.ref !== target.ref
          && compact(labelOf(other)).startsWith(`search${compact(labelOf(target)).slice(0, 12)}`));
        if (searchBox) {
          // Remote lists show a status row ("Searching…", "No results found") until results arrive; that row is no choice.
          const settled = async () => {
            for (let wait = 0; ; wait++) {
              await pause(wait ? 500 : 800);
              fresh = await freshSnapshot(current);
              target = findField(fresh, field);
              if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
              const listed = choicesFor(fresh, target.ref).filter(option => !LIST_STATUS.test(clean(option.label)));
              if (listed.length || wait >= 6) return listed;
            }
          };
          for (const search of [...new Set([...aliasesFor(key, value), value.trim().split(/\s+/)[0]])]) {
            await mutate('FILL', labelOf(searchBox), () => act.type(page, searchBox.ref, search, { secret: true }));
            const filtered = await settled();
            if (exact(filtered.map(option => option.label))) { shown = filtered; break; }
          }
          // Nothing matched: the model chooses from the unfiltered list.
          if (!exact(shown.map(option => option.label))) {
            await mutate('FILL', labelOf(searchBox), () => act.type(page, searchBox.ref, '', { secret: true }));
            const full = await settled();
            if (full.length) shown = full;
          }
        }
      }
      if (target.tag === 'input' && fieldType(target) !== 'select' && !exact(shown.map(option => option.label))) {
        // The answer, then each stored alias, then its first word: a list without "Computer Engineering" may list
        // "Engineering". Search-on-Enter widgets (prompt fields) show nothing new until Enter (an open prompt keeps its
        // unfiltered list on screen), and remote lookups lag.
        for (const search of [...new Set([...aliasesFor(key, value), value.trim().split(/\s+/)[0]])]) {
          const unfiltered = JSON.stringify(shown.map(option => option.label));
          await mutate('FILL', labelOf(target), () => act.type(page, target.ref, search, { secret: true }));
          let entered = false;
          for (let wait = 0; wait < 5; wait++) {
            await pause(1000);
            fresh = await freshSnapshot(current);
            target = findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            shown = choicesFor(fresh, target.ref);
            const unchanged = shown.length && JSON.stringify(shown.map(option => option.label)) === unfiltered;
            if (shown.length && (!unchanged || entered)) break;
            if (wait >= 1 && !entered) { await act.press(page, 'Enter'); entered = true; }
          }
          if (exact(shown.map(option => option.label))) break;
          // A list the search actually narrowed (aliases run in preference order) is offered to the choice step right
          // away: "Computer Science" narrowing to "Computer and Information Science" beats a later alias's list.
          const real = shown.filter(option => !LIST_STATUS.test(clean(option.label)));
          if (real.length && JSON.stringify(shown.map(option => option.label)) !== unfiltered) {
            preferred = await chooseOption(labelOf(field), value, real.map(option => option.label), aliasesFor(key, value));
            if (preferred) break;
          }
        }
        // No listed match for any search: a filtered list ("Currently" leaves only "I'm not currently enrolled…") can
        // hide the right choice. The filtered list is offered to the choice step first; only when nothing there fits
        // is the search cleared and the full list offered instead (long lists render just their first entries, so
        // the filtered one is preferred).
        if (!preferred && shown.length && !exact(shown.map(option => option.label))) {
          preferred = await chooseOption(labelOf(field), value, shown.map(option => option.label), aliasesFor(key, value));
        }
        if (!preferred && (!shown.length || !exact(shown.map(option => option.label)))) {
          await mutate('FILL', labelOf(target), () => act.type(page, target.ref, '', { secret: true }));
          fresh = await openField(current, target);
          target = findField(fresh, field);
          if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
          const full = choicesFor(fresh, target.ref);
          if (full.length) shown = full;
        }
        // A curated list without the answer (a school list missing the applicant's school) that comes with an
        // "Other …" companion field takes its "Other" entry; the companion field then gets the real answer.
        const companion = activeFields(fresh).some(other => other.ref !== target.ref && /^other\b/i.test(labelOf(other)));
        if (companion && !exact(shown.map(option => option.label))) {
          await mutate('FILL', labelOf(target), () => act.type(page, target.ref, 'Other', { secret: true }));
          // Remote lookups answer a few hundred ms to seconds after typing.
          let other = null;
          for (let wait = 0; wait < 4 && !other; wait++) {
            await pause(800);
            fresh = await freshSnapshot(current);
            target = findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            other = choicesFor(fresh, target.ref).find(option => /^other\b/.test(answers.normalize(option.label)));
          }
          if (other) {
            currentControl(fresh, other.ref);
            await mutate('CLICK', labelOf(field), () => act.click(page, other.ref));
            say(`CHOOSE ${labelOf(field)} = "${clean(other.label)}" (not listed; the "Other" field takes it)`);
            history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(other.label)}"; put "${value}" in the matching "Other …" field`);
            return;
          }
          shown = choicesFor(fresh, target.ref);
        }
      }
      if (!shown.length && (target.tag === 'select' || fieldType(target) === 'select')) {
        // Exact matches are checked against every option (an alias like "BA" shares no word with the answer, so a
        // long list trimmed by the answer's words drops it); the model chooses from the trimmed list only.
        const all = await act.selectOptions(page, target.ref, value, Infinity);
        const listed = all.length > 40 ? await act.selectOptions(page, target.ref, [value, ...aliasesFor(key, value)].join(' ')) : all;
        let option = exact(all) ?? (listed.length ? await chooseOption(labelOf(field), value, listed, aliasesFor(key, value)) : null);
        // The key's value names no option (a follow-up "Source" listing campuses under "How did you hear: Campus"):
        // the writer picks the one option the applicant facts support, with the field's own context, once per field.
        const real = all.filter(choice => !PLACEHOLDER_OPTION.test(String(choice))).map(String);
        if (!option && real.length >= 2 && real.length <= 60 && !writeTried.has(`${current.url}|pref|${labelOf(field)}`)) {
          writeTried.add(`${current.url}|pref|${labelOf(field)}`);
          const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(postingText || current.pageText || '').slice(0, 3000) };
          const question = [labelOf(field), clean(field.context ?? '')].filter(Boolean).join(' — ').slice(0, 300);
          option = await pickPreference({ job, applicant: await writerApplicant(), question, options: real });
          say(`WRITER choice "${clean(labelOf(field))}" = ${option ? `"${clean(option)}"` : 'none'} (no option matched ${key})`);
          if (option) remember(labelOf(field), option);
        }
        if (!option) needsField(field, listed.length ? 'no option matches the stored answer or its aliases' : 'opening the widget exposed no owned options');
        await mutate('SELECT', labelOf(target), () => act.select(page, target.ref, option));
        return;
      }
      const visited = new Set();
      for (let depth = 0; depth < 4; depth++) {
        const signature = JSON.stringify(shown.map(option => [option.label, !!option.selected]));
        if (!shown.length || visited.has(signature)) needsField(field, 'opening and picking did not commit a choice');
        visited.add(signature);
        // A child list under the chosen parent ("Other" → "Source Not Listed") with one entry is the only completion.
        const label = exact(shown.map(option => option.label))
          ?? (preferred && shown.some(option => option.label === preferred) ? preferred : null)
          ?? (depth > 0 && shown.length === 1 ? shown[0].label : null)
          ?? await chooseOption(labelOf(field), value, shown.map(option => option.label), aliasesFor(key, value));
        preferred = null;
        const option = shown.find(candidate => candidate.label === label);
        if (!option) needsField(field, `no owned option matches the stored answer or its aliases (shown: ${shown.slice(0, 6).map(candidate => `"${clean(candidate.label).slice(0, 40)}"`).join(', ')})`);
        // An empty field's "selected" option is only the keyboard highlight (Workday marks the first entry of a
        // freshly opened child list aria-selected): it still needs the click.
        if (option.selected && !isEmpty(target)) return;
        // A multi-select's chips (its value before this pick lists them) already hold this choice: clicking it again
        // in a list that keeps chosen options toggles it off. (After a typed search the live value is the search text.)
        if (depth === 0 && String(field.value ?? '').split(/\s*,\s*/).some(chip => answers.normalize(chip) === answers.normalize(option.label))) return;
        const checked = await freshSnapshot(current);
        const owner = findField(checked, field);
        const live = owner && choicesFor(checked, owner.ref).find(candidate => candidate.ref === option.ref);
        if (!live) invalidPlan(`stale-target ${labelOf(field)}`);
        sameTarget(option, live);
        currentControl(checked, live.ref);
        await mutate('CLICK', labelOf(field), () => act.click(page, live.ref));
        say(`CHOOSE ${labelOf(field)} = "${clean(live.label)}"`);
        await pause(600);
        fresh = await freshSnapshot(current);
        target = findField(fresh, field);
        if (!target) return;
        shown = choicesFor(fresh, target.ref);
        // Some widgets close their list on blur, a tick after the choice handler updates the input.
        // Do not blur a newly opened child list: it still needs the next hierarchical pick.
        if (JSON.stringify(shown.map(option => [option.label, !!option.selected])) === signature && !isEmpty(target)) {
          await act.press(page, 'Tab');
          await pause(400);
          fresh = await freshSnapshot(current);
          target = findField(fresh, field);
          if (!target) return;
          shown = choicesFor(fresh, target.ref);
        }
        // A hierarchical list ("Other" → its sources) may fetch the child list a second or two after the click.
        for (let wait = 0; wait < 4 && shown.length && isEmpty(target)
          && JSON.stringify(shown.map(option => [option.label, !!option.selected])) === signature; wait++) {
          await pause(600);
          fresh = await freshSnapshot(current);
          target = findField(fresh, field);
          if (!target) return;
          shown = choicesFor(fresh, target.ref);
        }
        // A closed list whose choice has not shown yet: some widgets render the committed value a beat later.
        for (let wait = 0; wait < 3 && !shown.length && isEmpty(target); wait++) {
          await pause(500);
          fresh = await freshSnapshot(current);
          target = findField(fresh, field);
          if (!target) return;
          shown = choicesFor(fresh, target.ref);
        }
        // The field showing exactly the chosen option committed it, even while a stale "required" error from an earlier
        // Continue still marks it invalid (many sites re-validate only on the next submit).
        if (target.occupied === true || shown.some(candidate => candidate.selected && candidate.label === live.label)
          || (!shown.length && answers.normalize(target.value) === answers.normalize(live.label))
          || (!target.invalid && !isEmpty(target)
            && (!shown.length || answers.normalize(target.value) === answers.normalize(live.label)))) return;
      }
      needsField(field, 'the owned choice hierarchy did not commit an answer after four picks');
    }
    // Required comboboxes the executor opened to reveal their choices (once per field).
    const opened = new Set();
    // Label of the control whose click opened the current unowned option list.
    let openedBy = null;
    // Each Jev plan is one semantic action; fill batches and password pairs stay together. Long applications run
    // dozens of questions per section; stalls and consult limits bound unproductive loops, this caps the whole run.
    // Any pre-dispatch refusal (invalid-plan: nothing was sent) anywhere in a pass re-observes instead of ending the
    // run; a run with this many refusals is not progressing and stops.
    let redrives = 0;
    // Times the run landed on a social/review site (a badge or share link) and went back; a few at most.
    let offsite = 0;
    // Reloads of a Chrome error page (the page failed to load).
    let errorReloads = 0;
    for (let iteration = 0; iteration < 300; iteration++) { try {
      phase = 'snapshot';
      const previousPage = page;
      const newTab = await tabs.take();
      if (newTab) {
        page = newTab;
        history.push(`a new tab opened (${new URL(page.url()).host}); continuing there`);
        say(`TAB ${clean(new URL(page.url()).host)}`);
      }
      // A page Chrome could not load (DNS, redirect loop, refused: chrome-error://chromewebdata) is retried once; one
      // that still fails ends the run instead of letting a model click the error page's help links.
      if (/^chrome-error:/.test(page.url())) {
        if (errorReloads++ >= 1) throw new Stop('external-site-failed-to-load (Chrome showed its error page twice)');
        say('PAGE failed to load (Chrome error page); reloading once');
        await delay(3000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        continue;
      }
      watchDialogs(page);
      if (/^https?:/.test(page.url()) && offApplication(new URL(page.url()))) {
        if (++offsite > 3) throw new Stop(`off-application-site (kept landing on ${new URL(page.url()).host})`);
        const host = new URL(page.url()).host;
        say(`OFFSITE ${clean(host)} is not part of the application; going back`);
        history.push(`a click left the application for ${host} (social/review site); went back: do not click that link again`);
        if (newTab && previousPage !== newTab && !previousPage.isClosed()) {
          await newTab.close().catch(() => undefined);
          page = previousPage;
        } else {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
          // A share popup has no history to go back to: start again from the posting.
          if (!/^https?:/.test(page.url()) || offApplication(new URL(page.url()))) {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
          }
        }
        await pause(1500);
        continue;
      }
      await browser.markTab(page, url);
      const current = await observe(page);
      // A posting URL carrying its own id (/jobs/11392334) that opens on the same site without that id was taken down
      // and redirected (often to a search list of other jobs): stop instead of applying to whatever is listed there.
      // (A recorded tab may already be on the employer's own site, which legitimately lacks the id.)
      if (iteration === 0 && posting.id && new URL(page.url()).host === posting.host) {
        if (!page.url().includes(posting.id) && !String(current.pageText ?? '').includes(posting.id)) {
          throw new Stop(`posting-unavailable (opened ${new URL(page.url()).host}${new URL(page.url()).pathname})`);
        }
      }
      {
        // A posting the applicant already applied to, or one the site will not show or accept, ends the run here
        // instead of after a consult. (After this run's own submit, the confirmation is judged elsewhere.)
        const text = String(current.pageText ?? '');
        if (!submittedVia && /\b(applied on (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d|you(['’]ve| have) already applied|already applied (to|for) this)\b/i.test(text)) {
          throw new Stop(`already applied (page shows "${clean(text.match(/applied on [^\n]{0,24}|[^\n]{0,30}already applied[^\n]{0,20}/i)?.[0] ?? '')}")`);
        }
        const GONE = /you (don['’]t|do not) have permission to view this job|no longer accepting applications|this (job|posting|position|requisition) (is no longer available|is closed|has expired|has been filled)|(registration|applications?) (is |are )?closed for this (job|posting|position)|(the )?requested (job|position|posting) could not be found|(job|position|posting) (could not be|was not) found|the page you are looking for (doesn['’]t|does not) exist/i;
        if (GONE.test(text)) throw new Stop(`posting-unavailable (page shows "${clean(text.match(GONE)[0])}")`);
        // Two listings (an employer's own and a partner's re-post) can lead to one employer requisition. The first
        // employer page whose path carries an id is this run's employer posting; one already submitted from another
        // listing ends the run instead of sending a duplicate application.
        const here = new URL(current.url);
        if (!submittedVia && !runInfo.employerPosting && here.host !== posting.host && /\d{4,}/.test(here.pathname)) {
          runInfo.employerPosting = `${here.host}${here.pathname.replace(/\/+$/, '')}`;
          const rows = await readFile(new URL('./runs/summary.jsonl', import.meta.url), 'utf8').catch(() => '');
          const prior = rows.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
            .find(row => row?.outcome === 'submitted' && row.employerPosting === runInfo.employerPosting && row.job !== url.replace(/[?#].*$/, ''));
          if (prior) throw new Stop(`already applied (the same employer posting was submitted from ${prior.job})`);
        }
      }
      // A sign-in taken over the application form (an emailed-code modal on a page of applicant fields) that lands on
      // another path (a "Welcome"/profile page) left the application unsent: go back to it (twice at most: a driver
      // that signs in again from the form lands there again). The code modal's own "Submit" was no application
      // submit. A run resuming a tab parked there by an earlier run returns the same way.
      if (iteration === 0 && !signInReturn) {
        const application = browser.applicationUrl(url);
        if (application && new URL(application).host === new URL(current.url).host) signInReturn = { url: application, used: 0 };
      }
      if (signInReturn && signInReturn.used < 2 && !current.gates.length
        && new URL(current.url).pathname !== new URL(signInReturn.url).pathname
        && !SUBMITTED_TEXT.test(String(current.pageText ?? '')) && !SUBMITTED_URL.test(current.url)) {
        signInReturn.used++;
        submittedVia = null;
        submitFilled = null;
        submitUrl = null;
        say(`RETURN sign-in landed on ${clean(new URL(current.url).pathname)}; reopening the application`);
        history.push(`the sign-in redirected to ${new URL(current.url).pathname}; reopened the application form`);
        await page.goto(signInReturn.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await pause(3000);
        continue;
      }
      // The posting this run applies to is named by the posting page's title; every goal carries it, so a listing of
      // several roles (an employer's open-roles page behind an "Apply externally" link) opens only this one. A run
      // that resumes its tab on the employer's site (a sign-in or password page) uses the title recorded when the
      // posting itself was open; with none recorded the note is left out rather than naming the wrong page.
      if (iteration === 0) {
        const onPosting = new URL(page.url()).host === new URL(url).host;
        // A single-app page names itself only by the site ("Handshake") until the posting renders; a title is the
        // posting's once it has more than two words.
        const named = title => title.split(/\s+/).filter(Boolean).length > 2;
        const readTitle = async tab => {
          let title = '';
          for (let tries = 0; tries < 10 && !named(title); tries += 1) {
            if (tries) await pause(1000);
            title = clean(await tab.title().catch(() => ''));
          }
          return named(title) ? title : '';
        };
        let title = onPosting ? await readTitle(page) : clean(browser.postingTitle(url) ?? '');
        if (!named(title)) title = '';
        // Resumed on the employer's site with no title recorded: read it from the posting in a scratch tab.
        if (!onPosting && !title) {
          const scratch = await page.browser().newPage();
          try {
            await scratch.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            title = await readTitle(scratch);
          } finally { await scratch.close().catch(() => {}); }
          if (title) await browser.markTab(page, url, title);
        }
        if (onPosting && title) await browser.markTab(page, url, title);
        if (title) {
          targetRole = clean(title.split(/\s+\|\s+/)[0]);
          runInfo.title = clean(title).slice(0, 160);
          if (onPosting) postingText = String(current.pageText ?? '').slice(0, 4000);
          if (postingText && resumeAvailable) tailoredPending = tailorResume(postingText);
          targetNote = ` The target posting is "${title.slice(0, 160)}": on any page that lists several roles, open only the role matching it (same title); if none matches, stop rather than apply to a different role.`;
          BASE_GOAL.guidance += targetNote;
          for (const goal of goals) goal.guidance += targetNote;
        }
      }
      // A final-submit click is confirmed only when a later screen states the submission and has no final-submit
      // control or required empty field left (a post-submit modal or a validation error keeps the run going).
      if (submittedVia && isConfirmed(current)) {
        const evidence = String(current.pageText ?? '').match(SUBMITTED_TEXT)?.[0] ?? new URL(current.url).pathname;
        say(`SUBMITTED via "${clean(submittedVia)}" (confirmed: the page states the application was received: "${clean(evidence).slice(0, 80)}")`);
        submitted = true;
        return;
      }
      // A rerun that lands on the employer's own confirmation of an earlier run's submit with no form left has
      // nothing to do: it reports the standing confirmation, not a stop.
      if (!submittedVia && new URL(current.url).host !== posting.host && !activeFields(current).length && isConfirmed(current)
        && APPLIED_TEXT.test(String(current.pageText ?? ''))) {
        say('SUBMITTED earlier (confirmed: the employer page already states the application was received)');
        submitted = true;
        return;
      }
      // A submit that brings back the same form with most of its filled answers emptied and no error or confirmation
      // was silently rejected (typically an invisible captcha scoring the session as a bot). Refilling resubmits the
      // same rejected attempt, so the second such reset stops for the user.
      if (submitFilled && submitFilled.size >= 4 && current.url === submitUrl) {
        const fresh = activeFields(current);
        const emptied = [...submitFilled].filter(ref => { const field = fresh.find(f => f.ref === ref); return !field || isEmpty(field); });
        const reset = emptied.length >= submitFilled.size / 2;
        submitFilled = null;
        if (reset) {
          runlog.trace('submit-reset', { emptied: emptied.length, filled: emptied.length + fresh.length });
          if (++submitResets >= 2) throw new Stop('submit-rejected: the site cleared the form after Submit without an error or confirmation (likely an invisible captcha); submit it once by hand');
          say(`SUBMIT reset the form (${emptied.length} answers cleared); refilling once`);
          // The emptied form is a fresh screen: stored answers and the resume go in again.
          const prefix = `${current.url}|`;
          for (const key of [...learnedTried]) if (key.startsWith(prefix)) learnedTried.delete(key);
          for (const key of [...uploads.keys()]) if (key.startsWith(prefix)) uploads.delete(key);
          screenConsults = 0;
        }
      }
      // A required document the harness has no file for (a transcript, writing sample) needs the user: stop with it
      // named instead of looping until the consult limit.
      {
        const files = activeFields(current).filter(field => fieldType(field) === 'file');
        // Upload widgets often mark only their question with "*" ("…transcript* Attach"), not the hidden input.
        const required = field => field.required || /\*\s*(\(required\)\s*)?(attach|upload|choose|browse|drop)\b/i.test(field.context ?? '');
        const missing = files.find(field => required(field) && isEmpty(field) && !['resume', 'cover'].includes(rules.documentKind(field, files.length)));
        if (missing) throw new Stop(`needs-user-document ${rules.documentKind(missing, files.length)} "${clean(missing.context || labelOf(missing)).slice(0, 80)}"`);
      }
      // A review step whose error list says the resume is missing while every step looked complete (Workday: "Errors
      // Found — Enter at least 1 resume/CV" after the file went in through "Autofill with Resume") is fixed on the
      // step that shows the resume: the run walks Back (≤5 steps) until a resume slot or file is on screen; that file
      // is then re-attached below.
      if (resumeAvailable && resumeWalk < 5 && !current.fields.some(field => fieldType(field) === 'file')
          && !current.controls.some(control => control.attached)) {
        const resumeReported = text => /\berrors? found\b|\bpage error\b/i.test(text ?? '')
          && /\b(enter|upload|attach|add) at least (1|one) (resume|résumé|cv)\b|\b(resume|résumé)(\/cv)? is required\b/i.test(text ?? '');
        let reported = resumeWalk > 0 || resumeReported(current.pageText);
        // The error list renders a moment after the submit click, often after this pass's snapshot.
        for (let wait = 0; !reported && submitAt && Date.now() - submitAt < 15_000 && wait < 4; wait++) {
          await pause(1000);
          reported = resumeReported((await observe(page)).pageText);
        }
        const back = reported && current.controls.find(control => /^back$/i.test(clean(control.label)) && !control.href);
        if (back) {
          resumeWalk++;
          resumeRejected = true;
          await mutate('CLICK', 'Back', () => act.click(page, back.ref));
          say(`DOC review reports the resume missing; Back to its step (${resumeWalk})`);
          await pause(1500);
          continue;
        }
      }
      if (resumeWalk && (current.fields.some(field => fieldType(field) === 'file') || current.controls.some(control => control.attached))) resumeWalk = 5;
      // A site that pre-attaches a stored document (Handshake attaches the profile's default resume) gets it removed
      // when it is not this run's resume, so the slot's upload/picker appears and the run's own file goes in. So does
      // a shown file the site's own slot message still calls missing ("Resume/CV is required." under the chip: the
      // page lost the upload, e.g. after a reload) or a review step reported missing, once per file per run.
      {
        const MISSING = /\b(is required|required field|can't be blank|cannot be blank|please (upload|attach)|upload failed|failed to upload)\b/i;
        const wrong = resumeAvailable && current.controls.find(control => control.attached && !removedFiles.has(control.attached)
          && /\b(resume|résumé|cv)\b/i.test(control.context ?? '') && !/cover\s*letter|transcript/i.test(control.context ?? '')
          && (control.attached !== basename(resume) || resumeRejected || MISSING.test(control.context ?? '')));
        if (wrong) {
          removedFiles.add(wrong.attached);
          await mutate('CLICK', `remove ${wrong.attached}`, () => act.click(page, wrong.ref));
          const why = wrong.attached === basename(resume) ? 'the site still reports the resume missing' : 'not this application\'s resume';
          history.push(`removed the attached "${wrong.attached}" (${why}); attach ${basename(resume)} again`);
          say(`DOC removed attached ${clean(wrong.attached)} (${why}); attaching ${basename(resume)}`);
          continue;
        }
      }
      // A resume slot that offers the site's stored documents (a "Search your resumes" picker) gets this run's resume
      // picked from that list when a copy is already stored, instead of uploading another duplicate copy.
      {
        const stem = resumeAvailable ? basename(resume).replace(/\.[^.]+$/, '').toLowerCase() : '';
        const picker = stem && activeFields(current).find(field => field.autocomplete && isEmpty(field) && !pickerTried.has(field.ref)
          && /\b(resume|résumé|cv)s?\b/i.test(`${labelOf(field)} ${field.context ?? ''}`) && !/cover\s*letter|transcript/i.test(labelOf(field)));
        if (picker) {
          pickerTried.add(picker.ref);
          await mutate('FILL', labelOf(picker), () => act.type(page, picker.ref, stem));
          await delay(1500);
          const after = await observe(page);
          const option = after.controls.find(control => control.kind === 'option' && control.ownerRef === picker.ref
            && clean(control.label).toLowerCase().startsWith(stem));
          if (option) {
            await mutate('CLICK', option.label, () => act.click(page, option.ref));
            history.push(`picked the stored copy "${clean(option.label)}" in "${labelOf(picker)}"; the resume is attached`);
            say(`DOC picked stored ${clean(option.label)}`);
          } else {
            await mutate('FILL', labelOf(picker), () => act.type(page, picker.ref, '', { secret: true }));
            say(`DOC no stored copy of ${basename(resume)}; uploading it`);
          }
          continue;
        }
      }
      // A transcript slot with a stored-documents picker ("Search your transcripts") gets the applicant's own stored
      // transcript when the site holds exactly one: the harness has no transcript file, and the user put that one there
      // for applications. Several stored transcripts are ambiguous and are left alone.
      {
        const picker = activeFields(current).find(field => field.autocomplete && isEmpty(field) && !pickerTried.has(field.ref)
          && /\btranscripts?\b/i.test(`${labelOf(field)} ${field.context ?? ''}`) && /\bsearch your\b/i.test(labelOf(field)));
        if (picker) {
          pickerTried.add(picker.ref);
          await mutate('CLICK', labelOf(picker), () => act.click(page, picker.ref));
          await delay(1200);
          const options = (await observe(page)).controls.filter(control => control.kind === 'option' && control.ownerRef === picker.ref
            && /\.(pdf|docx?)\b|transcript/i.test(control.label ?? ''));
          if (options.length === 1) {
            await mutate('CLICK', options[0].label, () => act.click(page, options[0].ref));
            history.push(`picked the stored transcript "${clean(options[0].label)}" in "${labelOf(picker)}"`);
            say(`DOC picked stored transcript ${clean(options[0].label)}`);
          } else {
            await act.press(page, 'Escape').catch(() => undefined);
            say(`DOC transcript picker has ${options.length} stored transcripts; not choosing`);
          }
          continue;
        }
      }
      // An extra-document slot whose employer instructions say what to attach ("Include: internships, major & plans,
      // where you get news, a writing sample PDF") gets a document the writer composes for exactly those items, once
      // per slot. Without instructions an extra slot has no known content and is left to the user.
      {
        const files = current.fields.filter(field => fieldType(field) === 'file');
        const slot = activeFields(current).find(field => fieldType(field) === 'file' && isEmpty(field)
          && rules.documentKind(field, files.length) === 'other' && instructionsOf(field)
          && !uploads.has(`${current.url}|${labelOf(field)}`) && !refused.actions.has(`upload:${field.ref}`));
        if (slot) {
          const instructions = instructionsOf(slot);
          phase = 'document';
          let file;
          try {
            file = await instructedDocument({ url: runUrl, title: clean(current.title), instructions,
              pageText: `${postingText}\n${String(current.pageText ?? '')}`, applicant: await writerApplicant() });
          } catch (error) {
            runlog.trace('document-error', { message: clean(error?.message).slice(0, 200) });
            refused.actions.add(`upload:${slot.ref}`);
            say(`DOC could not compose the document for "${clean(labelOf(slot)).slice(0, 60)}"`);
            phase = 'driver';
            continue;
          }
          phase = 'driver';
          await mutate('UPLOAD', labelOf(slot), () => act.upload(page, slot.ref, file));
          (runInfo.uploaded ??= []).push(basename(file));
          uploads.set(`${current.url}|${labelOf(slot)}`, 1);
          uploadedLabels.add(answers.normalize(labelOf(slot)));
          history.push(`attached "${basename(file)}" in "${labelOf(slot)}": it answers every item the employer's instructions list`);
          say(`DOC UPLOAD ${basename(file)} → ${clean(labelOf(slot)).slice(0, 60)}`);
          continue;
        }
      }
      // A document slot that shows an upload failure ("Whoops, something went wrong... Please try uploading again")
      // is reset with its own dismiss control so the upload can run again; each slot is retried at most twice.
      {
        const failed = current.controls.find(control => control.uploadError && (uploadRetries.get(control.context) ?? 0) < 2);
        if (failed) {
          uploadRetries.set(failed.context, (uploadRetries.get(failed.context) ?? 0) + 1);
          await mutate('CLICK', `dismiss upload error (${clean(failed.context).slice(0, 40)})`, () => act.click(page, failed.ref));
          history.push(`the upload in "${clean(failed.context).slice(0, 60)}" failed; dismissed the error, upload the document again`);
          say(`DOC upload failed in ${clean(failed.context).slice(0, 50)}; retrying`);
          continue;
        }
      }
      // A typed code the site rejected ("Invalid security code") is replaced once with the newest mailed code (the
      // rejected submit usually mails a fresh one).
      if (current.url === emailCodeUrl && !codeRetried && (current.messages ?? []).some(message => /\b(invalid|incorrect|expired|wrong)\b.{0,30}\bcode\b|\bcode\b.{0,30}\b(invalid|incorrect|expired)\b/i.test(message))) {
        codeRetried = true;
        emailCodeUrl = null;
      }
      if (current.gates.length === 1 && current.gates[0] === 'mfa' && current.url !== emailCodeUrl) {
        await enterEmailedCode(current);
        continue;
      }
      if (current.gates.includes('captcha-challenge') && await awaitCaptcha(current)) continue;
      stopForGates(current);
      // Once the emailed code is typed, the code boxes are form fields like any other: the models see no gate there
      // (they stop on any listed gate) and submit the form.
      if (current.url === emailCodeUrl) current.gates = current.gates.filter(gate => gate !== 'mfa');
      if (await followEmailedVerification(current)) continue;
      const resetHint = 'the site requires a password reset: click Forgot Password, fill the account email, and click the reset button once; the harness opens the emailed reset link and stores the new password';
      if (/\b(need|must|required) to (reset|change) your password\b|\bpassword (has )?expired\b/i.test(current.pageText ?? '')
        && !history.includes(resetHint)) history.push(resetHint);
      // A registration the site rejects because the email already has an account ("This email address is already in
      // use. Please login") is a returning candidate: the account's password is the one stored in Keychain.
      const loginHint = 'an account with this email already exists on this site: open its login/sign-in link and sign in with the stored password (credentials login); do not register again';
      if (/\b(e-?mail|username|login)\b.{0,40}\balready (in use|registered|exists|taken|associated)\b|\balready (have|has) an account\b.{0,40}\b(this|that|the) e-?mail\b/i.test(`${current.pageText ?? ''} ${(current.messages ?? []).join(' ')}`)
        && !history.includes(loginHint)) history.push(loginHint);
      phase = 'credential-availability';
      // Ambiguous account forms only block a credentials action (which re-derives
      // identity and stops); observing/planning/clicking on such a screen is fine.
      let identity;
      try { identity = accountIdentity(current); } catch (error) {
        if (!(error instanceof Stop)) throw error;
        identity = { host: credentials.hostFromUrl(current.url), username: null };
      }
      const accountStatus = identity.username === null ? 'none' : await credentials.status(identity.host, identity.username);
      const screen = screenFingerprint(current);
      const host = credentials.hostFromUrl(current.url);
      // DeepSeek's queue belongs to the page it was planned on; in-page changes (a fill) keep it, stale refs are refused.
      if (current.url !== queuedUrl) queued = [];
      // A transient site error ("Something went wrong. Please refresh the page", a failed sign-in callback) with no
      // form on screen is reloaded, at most twice per URL; neither model has a reload action.
      if (!activeFields(current).length && (reloads.get(current.url) ?? 0) < 2
        && /something went wrong|refresh the page|an (unexpected )?error (has )?occurred|error code:|temporarily unavailable|operation is not available/i.test(String(current.pageText ?? ''))) {
        reloads.set(current.url, (reloads.get(current.url) ?? 0) + 1);
        say(`RELOAD site error page (${reloads.get(current.url)}/2)`);
        runlog.trace('reload', { url: current.url });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await pause(3000);
        continue;
      }
      // A screen whose only way forward is a disabled Continue/Next while nothing on it is left to fill never enables
      // it by itself. Once it stays disabled for 8 s, the filled text boxes are retyped once (a value the browser
      // restored, as on iCIMS's email-only login, fires none of the input events that enable the button), then the
      // page is reloaded once (Workday's resume step after a stalled parse). The button may sit in a child frame.
      const ADVANCE = /^(continue|next|save (and|&) continue)$/i;
      if (!activeFields(current).some(field => fieldType(field) !== 'file' && isEmpty(field) && field.required)
        && !current.controls.some(control => ADVANCE.test(clean(control.label))) && (reloads.get(current.url) ?? 0) < 1) {
        const disabledAdvance = async () => {
          for (const frame of page.frames()) {
            if (await frame.evaluate(source => [...document.querySelectorAll('button,[role=button],input[type=submit]')]
              .some(button => (button.disabled || button.getAttribute('aria-disabled') === 'true') && button.getClientRects().length
                && new RegExp(source, 'i').test((button.innerText || button.value || '').trim())), ADVANCE.source).catch(() => false)) return true;
          }
          return false;
        };
        // A Continue the run just clicked that went disabled while the page's captcha has no token yet is a submit
        // waiting on that captcha (iCIMS greys "Next" while its invisible hCaptcha runs): retyping or reloading then
        // breaks the handoff. The run waits (the challenge, if one opens, is the user's gate) for up to 60 s.
        const clickedAdvance = /^clicked "(continue|next|save (and|&) continue)"$/i.test(history.at(-1) ?? '');
        if (clickedAdvance && (captchaPending.get(current.url) ?? Date.now()) > Date.now() - 60_000
            && await disabledAdvance() && await captchaTokenEmpty()) {
          if (!captchaPending.has(current.url)) {
            captchaPending.set(current.url, Date.now());
            say('WAIT Continue is pending on the page captcha; not retyping');
          }
          await pause(3000);
          continue;
        }
        if (await disabledAdvance()) {
          await pause(8000);
          if (await disabledAdvance()) {
            const retype = activeFields(current).filter(field => ['text', 'email', 'tel', 'search', 'url', ''].includes(fieldType(field))
              && !isChoiceField(field) && typeof field.value === 'string' && field.value.trim());
            if (retype.length && !retyped.has(current.url)) {
              retyped.add(current.url);
              for (const field of retype) await mutate('FILL', labelOf(field), () => act.type(page, field.ref, field.value));
              say(`RETYPE ${retype.length} filled field(s): Continue stays disabled with nothing left to fill`);
              continue;
            }
            reloads.set(current.url, (reloads.get(current.url) ?? 0) + 1);
            say('RELOAD Continue stays disabled with nothing left to fill');
            runlog.trace('reload', { url: current.url });
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
            await pause(3000);
            continue;
          }
        }
      }
      let recoveredFill = false;
      for (const state of fillProgress.values()) {
        if (state.url !== current.url || !state.pending) continue;
        state.pending = false;
        const field = findField(current, state.field);
        if (!field) continue;
        // An unchanged text box that holds a value the site does not reject is a refill of the same answer, not a failure.
        // A choice field showing exactly the intended answer took it, even while a stale "required" mark from an
        // earlier submit attempt still flags it invalid (many sites re-validate only on the next submit).
        const holds = isChoiceField(field) && !isEmpty(field) && answers.normalize(field.value) === answers.normalize(state.value);
        // A text box holding the typed value whose only complaint is the earlier "cannot be left blank"/"required" (or
        // none of its own) keeps a stale invalid mark: Phenom and others re-validate only on submit.
        const staleMark = !isChoiceField(field) && !isEmpty(field) && field.invalid
          && (!clean(field.message) || /\b(blank|required|empty)\b/i.test(field.message) && !/\b(invalid|only|must|format)\b/i.test(field.message));
        const failed = isEmpty(field) || (!holds && !staleMark && (field.invalid || (isChoiceField(field) && fieldState(field) === state.before)));
        // A phone number is validated against its country-code picker: while that picker is empty the number's
        // rejection is the picker's, so it is not counted against the number.
        const codeEmpty = /\b(phone|mobile|telephone)\b/i.test(labelOf(field)) && activeFields(current).some(other => other.ref !== field.ref
          && isEmpty(other) && /\b(country|phone|dial(ing)?)\s*code\b/i.test(labelOf(other)));
        if (failed && codeEmpty) say(`FILL "${labelOf(field)}" waits on its empty country-code picker`);
        if (failed && !codeEmpty) {
          state.failures++;
          const why = isEmpty(field) ? 'the site cleared the accepted fill' : field.invalid ? 'the site rejected the accepted fill' : 'the field did not change';
          say(`FILL no progress "${labelOf(field)}" (${state.failures}): ${why}`);
          if (state.recovered) needsField(field, `${why} after opening and picking an owned option`);
          if (state.failures >= 2 && !isChoiceField(field)) needsField(field, `${why} twice`);
          if (state.failures >= 2) {
            state.recovered = true;
            say(`FILL recovering "${labelOf(field)}" through owned options`);
            await pickField(current, field, state.key, state.value);
            Object.assign(state, { field, before: fieldState(field), pending: true });
            recoveredFill = true;
            break;
          }
        }
      }
      if (recoveredFill) continue;
      for (const [label, key] of Object.entries(filledKeys)) {
        const message = rejectionFor(current, label);
        const field = current.fields.find(candidate => labelOf(candidate) === label);
        if (!field || isEmpty(field) || field.autocomplete) continue;
        if (!message && !field?.invalid) {
          if (/\.(alt|alias)_\d+$/.test(key) && rewritten.has(baseKey(key))) {
            await learnAlias(baseKey(key), values.get(baseKey(key)), values.get(key));
            say(`LEARNED accepted alternative for ${clean(label)}`);
            rewritten.delete(baseKey(key));
          }
          // The site kept this answer: the same field label gets the same key on later applications.
          const as = learnAs[label];
          const keep = key.replace(/\.alt_\d+$/, '');
          if (as && isQuestionLabel(as) && !essayKeys.has(keep) && learned.fields[as] !== keep) {
            learned.fields[as] = keep;
            await saveLearned(learned);
            say(`LEARNED field "${clean(as)}" → ${keep}`);
          }
          continue;
        }
        const base = baseKey(key);
        if (rewritten.has(base) || !values.has(base)) continue;
        rewritten.add(base);
        phase = 'rewrite';
        const alternatives = await rewriteValue({ field: label, value: values.get(base), message: message ?? 'value rejected as invalid' });
        alternatives.forEach((alternative, i) => values.set(`${base}.alt_${i + 1}`, alternative));
        runlog.trace('rewrite', { label, key: base, message, count: alternatives.length });
        say(`REWRITE ${clean(label)} → ${alternatives.length} alternatives (${base}.alt_*)`);
        history.push(`outcome: the site rejected "${label}" (${clean(message ?? 'invalid')}); replacement answers ${base}.alt_* are available`);
      }
      const unownedOptions = current.controls.some(c => c.kind === 'option' && !c.ownerRef);
      if (!unownedOptions) openedBy = null;
      // Only a popup trigger (a control reporting expanded state or a current selection) opens a choice list; a
      // section's "Submit & continue" whose next screen happens to show options is not their question.
      else if (attempt?.kind === 'click' && attempt.popup && attempt.screen !== screen) openedBy = attempt.label;
      if (attempt) {
        if (attempt.kind === 'fill') {
          const cleared = attempt.fields.filter(item => {
            const field = current.fields.find(candidate => candidate.ref === item.ref);
            return field && isEmpty(field);
          });
          if (cleared.length) history.push(`outcome: the site cleared ${cleared.map(item => `"${item.label}"`).join(', ')} after typing`);
          const open = attempt.fields.filter(item => item.autocomplete && current.controls.some(c => c.kind === 'option' && c.ownerRef === item.ref));
          if (open.length) history.push(`outcome: suggestion list open for ${open.map(item => `"${item.label}"`).join(', ')}; pick the matching suggestion`);
        } else if (attempt.screen === screen) {
          history.push(`outcome: no visible change after clicking "${attempt.label}"`);
        }
        attempt = null;
        if (history.length > 12) history.splice(0, history.length - 12);
      }
      const context = {
        // The resume's file path is executor-local (uploads read `values` directly) and is never offered to a model.
        availableKeys: [...values.keys()].filter(key => key !== RESUME_PATH_KEY),
        answerValues: Object.fromEntries([...values].filter(([key]) => key !== RESUME_PATH_KEY)),
        history: [...history],
        openedBy,
        typed: { ...typed },
        resumeAvailable,
        credential: { host: identity.host, status: accountStatus },
      };
      if (refused.screen !== screen) refused = { screen, actions: new Set() };
      phase = 'driver';
      let outcome;
      // Plan source, cheapest first: DeepSeek's queued actions for this screen, then fields past runs learned
      // the answer for, then Jev. Lessons from past consults on this host ride along in Jev's guidance.
      const lessons = learned.lessons.filter(lesson => lesson.host === host).slice(-6).map(lesson => lesson.note);
      const goal = lessons.length ? { ...goals[0], guidance: `${goals[0].guidance} Lessons from earlier applications on this site: ${lessons.join(' ')}` } : goals[0];
      let source = 'jev';
      // A queued action whose ref is gone means the screen moved on (a list closed, a section advanced): the rest of
      // DeepSeek's queue was planned for a screen that no longer exists, so drop it and let Jev read the new one.
      if (queued.length) {
        const live = new Set([...current.controls.map(control => control.ref), ...current.fields.flatMap(field => [field.ref, ...(field.optionRefs ?? [])])]);
        const item = queued[0];
        const refs = [item.ref, ...(item.refs ?? []), ...(item.fields ?? []).map(field => field.ref)].filter(Boolean);
        const relabeled = item.label !== undefined && clean(current.controls.find(control => control.ref === item.ref)?.label ?? '') !== item.label;
        if (refs.some(ref => !live.has(ref)) || relabeled) {
          say(`DEEPSEEK queue dropped (${queued.length} actions): screen changed`);
          queued = [];
        }
      }
      if (queued.length) {
        const { label: _planned, ...plan } = queued.shift();
        outcome = { plan, confidence: 1 };
        source = 'deepseek';
        if (outcome.plan.action === 'write') {
          const fields = await writeFor(current, outcome.plan.refs);
          if (!fields.length) continue;
          outcome.plan = { action: 'fill', fields };
        }
      } else {
        // Learned answers fill plain fields only once per field per run; autocomplete search boxes stay Jev's.
        const known = activeFields(current).filter(field => isEmpty(field) && !field.autocomplete && !learnedTried.has(`${current.url}|${field.ref}`)
          && !(labelOf(field) in filledKeys)
          && !['password', 'file', 'radio', 'checkbox'].includes(fieldType(field)) && values.has(learned.fields[learnLabel(field)]));
        // Questions the qa registry already answers: empty radio groups (when an option states the answer) and native
        // selects are filled straight from it, with no model call.
        const registryKey = field => `qa.${answers.normalize(labelOf(field))}`;
        // A required native select that offers exactly one real option (the only region, the only program year)
        // has no decision in it: that option is its answer for this run.
        for (const field of activeFields(current)) {
          const real = (field.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option)));
          if (field.tag === 'select' && field.required && isEmpty(field) && real.length === 1 && !values.has(registryKey(field))) {
            values.set(registryKey(field), String(real[0]));
          }
        }
        const answered = activeFields(current).filter(field => isEmpty(field) && !learnedTried.has(`${current.url}|${field.ref}`)
          && !known.includes(field) && values.has(registryKey(field))
          && (fieldType(field) === 'select' || (!field.autocomplete && !['radio', 'checkbox', 'file', 'password', 'hidden'].includes(fieldType(field)))
            || (fieldType(field) === 'radio' && (field.options ?? []).some(option => answers.normalize(option) === answers.normalize(values.get(registryKey(field)))))));
        // A custom dropdown still on its placeholder whose question the registry (or a fact learned for the same
        // question) already answers: choose that answer.
        const dropdownKey = control => {
          const qa = `qa.${answers.normalize(questionOf(control.label))}`;
          if (values.has(qa)) return qa;
          const fact = learned.fields[answers.normalize(questionOf(control.label))];
          return fact && values.has(fact) ? fact : null;
        };
        const unset = current.controls.find(control => control.current !== undefined && control.formRef
          && (!clean(control.current) || /^(select|choose|please select|--)/i.test(clean(control.current)))
          && dropdownKey(control) && !learnedTried.has(`${current.url}|${control.ref}`));
        // A "check all that apply" group whose stored answer (qa for its question, or the fact learned for its label)
        // names more options than are ticked: tick the next named option. Option text is matched as whole words with
        // any parenthetical code dropped ("Spanish (SPA)" ⊂ "English, Spanish").
        const named = (option, value) => {
          const text = answers.normalize(String(option).replace(/\([^)]*\)/g, ' '));
          return Boolean(text) && ` ${answers.normalize(value)} `.includes(` ${text} `);
        };
        const tick = activeFields(current).filter(field => fieldType(field) === 'checkbox' && (field.optionRefs?.length ?? 0) > 1)
          .flatMap(field => {
            const value = values.get(registryKey(field)) ?? values.get(learned.fields[learnLabel(field)]);
            if (typeof value !== 'string' || !value) return [];
            return field.optionRefs.filter((ref, index) => ref && !field.checkedRefs?.includes(ref)
              && !learnedTried.has(`${current.url}|${ref}`) && named(field.options?.[index] ?? '', value));
          })[0];
        const batch = [
          ...known.map(field => ({ ref: field.ref, key: learned.fields[learnLabel(field)] })),
          ...answered.map(field => ({ ref: field.ref, key: registryKey(field) })),
        ].slice(0, 8);
        if (batch.length) {
          for (const item of batch) learnedTried.add(`${current.url}|${item.ref}`);
          outcome = { plan: { action: 'fill', fields: batch }, confidence: 1 };
          source = known.length ? 'learned' : 'registry';
        } else if (unset) {
          learnedTried.add(`${current.url}|${unset.ref}`);
          outcome = { plan: { action: 'choose', ref: unset.ref, key: dropdownKey(unset) }, confidence: 1 };
          source = 'registry';
        } else if (tick) {
          learnedTried.add(`${current.url}|${tick}`);
          outcome = { plan: { action: 'check', ref: tick }, confidence: 1 };
          source = 'registry';
        } else {
          // Empty free-text questions, required or optional (an essay box, or a text field whose label asks a
          // question), go to the writer up front: optional questions help an application and Jev never writes text.
          const asks = field => fieldType(field) === 'textarea'
            || /\?|^(tell|describe|explain|why|what|how|which|please (tell|describe|explain|share|list|provide))\b/i.test(labelOf(field));
          const questions = activeFields(current).filter(field => isEmpty(field) && !field.autocomplete && asks(field)
            && !['radio', 'checkbox', 'file', 'password', 'select', 'hidden'].includes(fieldType(field))
            && !writeTried.has(`${current.url}|${labelOf(field)}`));
          if (questions.length) {
            for (const field of questions) writeTried.add(`${current.url}|${labelOf(field)}`);
            const fields = await writeFor(current, questions.map(field => field.ref));
            if (fields.length) {
              queued = [{ action: 'fill', fields: fields.slice(0, 8) }];
              queuedUrl = current.url;
              continue;
            }
          }
          const rule = rulePlan(current, screen);
          if (rule) {
            outcome = { plan: rule.plan, confidence: 1 };
            source = 'rule';
            say(`RULE ${clean(rule.why)}`);
          }
        }
      }
      for (let redrives = 0; source === 'jev';) {
        // A step Jev already took on this exact screen through its ranking (no leading verdict) is not offered again
        // when the screen comes back: weak picks alternating between two screens otherwise loop without a stall.
        const exclude = new Set([...refused.actions, ...(plannedTaken.get(screen) ?? [])]);
        try { outcome = await drive(modelView(current), { goal, ...context, exclude }); }
        catch (error) {
          runlog.trace('error', { phase: 'drive', message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) });
          throw new Stop('driver-error', 1);
        }
        runlog.trace('jev', { goal, plan: outcome?.plan ?? null, confidence: outcome?.confidence ?? 0, ...outcome?.trace });
        if (Number(outcome?.goalDone ?? 0) < 0.7 || goals[0].goal === BASE_GOAL.goal) break;
        completed.push(goals.shift());
        recent.length = 0;
        if (!goals.length) goals = [{ ...BASE_GOAL }];
        if (++redrives > 8) { outcome = { plan: null, confidence: 0 }; break; }
      }
      // DeepSeek's note becomes a lesson for this host only when its actions unstuck Jev: once the queue is
      // done, Jev's very next decision has a plan of its own. Otherwise the note is dropped.
      if (source === 'jev' && pendingLesson?.armed && !queued.length) {
        const { host: lessonHost, note } = pendingLesson;
        pendingLesson = null;
        if (outcome?.plan && !learned.lessons.some(lesson => lesson.host === lessonHost && lesson.note === note)) {
          learned.lessons = [...learned.lessons, { host: lessonHost, note }].slice(-60);
          await saveLearned(learned);
          say(`LEARNED lesson for ${clean(lessonHost)}: ${clean(note)}`);
        }
      }
      if (source !== 'jev') {
        runlog.trace('plan', { source, plan: outcome.plan });
        say(`${source.toUpperCase()} ${outcome.plan.action}`);
      }
      // Jev judges whether an unconfirmed registration now exists; code records it in Keychain.
      if (accountStatus === 'pending' && Number(outcome?.accountCreated ?? 0) >= 0.8) {
        await credentials.markCreated(identity.host, identity.username);
        context.credential.status = 'created';
        say(`ACCOUNT created ${clean(identity.host)}`);
      }
      const confidence = Number(outcome?.confidence ?? 0);
      // Step chosen by Jev's "which ONE action" ranking rather than a leading verdict: noted so runs can measure it.
      if (source === 'jev' && outcome?.planned) {
        say(`JEV PLANNED ${actionKeyOf(outcome.plan) ?? outcome.plan?.action} p=${confidence.toFixed(2)}`);
        const taken = plannedTaken.get(screen) ?? new Set();
        taken.add(actionKeyOf(outcome.plan));
        plannedTaken.set(screen, taken);
      }
      // Stalls measure Jev repeating the same action on an unchanged screen; executing a queued/learned plan, or Jev
      // moving on to a different action, is not a stall.
      const mark = `${goals[0].goal}\u0000${screenFingerprint(current)}\u0000${JSON.stringify(outcome?.plan ?? null)}`;
      stalls = source !== 'jev' ? 0 : mark === lastMark ? stalls + 1 : 0;
      lastMark = source === 'jev' ? mark : null;
      // Alternating steps (open list A, open list B, A, B…) never repeat back to back, so they also count as a stall
      // once the same step comes up a third time on the same screen.
      const repeatKey = source === 'jev' && outcome?.plan ? `${screen}\u0000${actionKeyOf(outcome.plan) ?? outcome.plan.action}` : null;
      const repeats = repeatKey ? (screenRepeats.get(repeatKey) ?? 0) + 1 : 0;
      if (repeatKey) screenRepeats.set(repeatKey, repeats);
      let reason = null;
      if (!outcome?.plan) reason = 'no plan';
      else if (stalls >= 2 || repeats >= 3) reason = 'goal not progressing';
      // A Jev step repeated on an unchanged screen: Jev re-plans without that step (and any other it already chose
      // there), at most twice per screen, before DeepSeek is consulted.
      if (reason === 'goal not progressing' && source === 'jev' && outcome?.trace?.steps?.length) {
        if (jevPlanScreen !== screen) { jevPlanScreen = screen; jevPlanTried = new Set(); jevPlans = 0; }
        if (outcome.plan && (stalls >= 2 || repeats >= 3)) jevPlanTried.add(actionKeyOf(outcome.plan));
        if (jevPlans < 2) {
          jevPlans += 1;
          const planned = await jevPlan(modelView(current), { goal: goals[0], ...context, exclude: refused.actions }, outcome, jevPlanTried);
          if (planned.plan) {
            jevPlanTried.add(planned.choice);
            say(`JEV PLAN ${planned.choice} p=${planned.confidence.toFixed(2)} (${clean(reason)})`);
            runlog.trace('jev-plan', { reason, choice: planned.choice, confidence: planned.confidence });
            outcome = { ...outcome, plan: planned.plan, confidence: planned.confidence };
            reason = null;
            stalls = 0;
            lastMark = null;
          } else jevPlans = 2;
        }
      }
      if (reason) {
        // An empty required combobox with no stored answer has hidden choices: open it once so Jev can
        // match a listed choice to the stored facts instead of the planner guessing it is free text.
        const closed = activeFields(current).find(field => field.required && field.autocomplete && isEmpty(field)
          && !opened.has(field.ref) && !choicesFor(current, field.ref).length);
        if (closed) {
          opened.add(closed.ref);
          await mutate('OPEN', labelOf(closed), () => act.openList(page, closed.ref));
          await pause(700);
          const shown = choicesFor(await freshSnapshot(current), closed.ref);
          history.push(shown.length
            ? `opened "${labelOf(closed)}": a fixed choice list (${shown.map(c => `"${clean(c.label)}"`).slice(0, 12).join(', ')}); pick the choice matching a stored fact`
            : `opened "${labelOf(closed)}": no choices appeared`);
          say(`OPEN ${clean(labelOf(closed))} (${shown.length} choices)`);
          lastMark = null;
          continue;
        }
        // Jev never writes text: free-text fields no stored answer fits (empty, or longer than the site's limit) go
        // straight to the writer model, once per question per run, with no consult.
        const fieldAnswers = outcome?.trace?.fieldAnswers ?? {};
        const gaps = activeFields(current).filter(field => !field.autocomplete && !writeTried.has(`${current.url}|${labelOf(field)}`)
          && !['radio', 'checkbox', 'file', 'password', 'select'].includes(fieldType(field))
          && ((field.required && isEmpty(field) && fieldAnswers[field.ref] === 'none')
            || (!isEmpty(field) && (field.valueLength ?? String(field.value ?? '').length) > limitOf(field))));
        if (gaps.length) {
          for (const field of gaps) writeTried.add(`${current.url}|${labelOf(field)}`);
          const fields = await writeFor(current, gaps.map(field => field.ref));
          if (fields.length) {
            queued = [{ action: 'fill', fields }];
            queuedUrl = current.url;
            continue;
          }
        }
        // Second look: re-snapshot and re-ask once per screen before paying for a consult.
        if (lookedAgain !== screen) {
          lookedAgain = screen;
          await pause(800);
          continue;
        }
        if (consultScreen !== screen) { consultScreen = screen; screenConsults = 0; }
        screenConsults += 1;
        consults += 1;
        if (screenConsults > 2 || consults > 6) throw new Stop('consult-limit');
        say(`CONSULT ${clean(reason)} goal="${clean(goals[0].goal)}"`);
        await replan(current, { goal: goals[0], reason, recent: [...recent] }, context);
        stalls = 0;
        lastMark = null;
        continue;
      }
      const plan = outcome.plan;
      validatePlan(plan, values);
      phase = 'action';
      // Pre-dispatch executor checks: a refusal (nothing was sent to the page) excludes that action on this
      // screen and Jev picks again. Reaching final submit is the run's end, so it stays terminal.
      const actionKey = plan.action === 'click' ? `click:${plan.ref}` : plan.action === 'check' ? `check:${plan.ref}`
        : plan.action === 'upload_resume' ? `upload:${plan.ref}` : plan.action === 'fill' ? 'fill'
        : plan.action === 'choose' ? `choose:${plan.ref}`
        : plan.action === 'credentials' ? `credentials:${plan.mode}` : null;
      if (actionKey) {
        try {
          if (plan.action === 'click' || plan.action === 'choose') {
            if (!(plan.action === 'click' && isChoiceField(activeFields(current).find(field => field.ref === plan.ref)))) currentControl(current, plan.ref, { moreEntries: moreEntries(current) });
          }
          else if (plan.action === 'check') checkTarget(current, plan.ref);
          else if (plan.action === 'upload_resume') {
            // Some sites clear the file input after taking the file, so it reads empty again; a field label gets at
            // most two uploads per page, then the upload counts as done and Jev must move on.
            const { field } = documentField(current, plan.ref, resumeAvailable);
            if ((uploads.get(`${current.url}|${labelOf(field)}`) ?? 0) >= 2) invalidPlan('already-uploaded');
          }
          else if (plan.action === 'credentials') { if (!passwordFields(current).length) invalidPlan('password-fields'); }
          else {
            // A fill batch keeps its valid items; one occupied or unmatched field does not void the rest.
            const kept = plan.fields.filter(item => {
              try { resolveFill(current, item, values); return true; }
              catch (error) {
                if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
                runlog.trace('refused', { source, action: `fill:${item.ref}`, reason: error.message });
                return false;
              }
            });
            if (!kept.length) resolveFill(current, plan.fields[0], values);
            plan.fields = kept;
          }
        } catch (error) {
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ') || error.message.startsWith('invalid-plan final-submit')) throw error;
          runlog.trace('refused', { source, action: actionKey, reason: error.message });
          say(`REFUSED ${source === 'jev' ? '' : `${source} `}${clean(actionKey)} (${error.message.replace('invalid-plan ', '')}); re-driving`);
          // The planners see the refusal, so a consult does not re-propose it ("upload the resume" six times).
          const note = `refused ${clean(actionKey)} (${error.message.replace('invalid-plan ', '')}): do not plan it again; act on another control`;
          if (!history.includes(note)) history.push(note);
          // A refused DeepSeek/learned action is dropped without excluding Jev's own choices on this screen.
          if (source === 'jev') refused.actions.add(actionKey);
          // A refused DeepSeek action is skipped; the rest of its queue still runs.
          lastMark = null;
          continue;
        }
      }
      if (source === 'deepseek' && pendingLesson) pendingLesson.armed = true;
      // A custom dropdown: open its trigger, then click the listed option stating the key's value (exact text first,
      // else the choice learned or picked by Jev for that answer). The pick joins the answer registry.
      if (plan.action === 'choose') {
        const trigger = currentControl(current, plan.ref);
        const question = questionOf(trigger.label);
        const value = values.get(plan.key);
        if (!trigger.expanded) await mutate('OPEN', question, () => act.click(page, trigger.ref));
        await pause(600);
        let fresh = await freshSnapshot(current);
        let shown = choicesFor(fresh, trigger.ref);
        // The answer, then each stored alias in preference order ("United States" → "United States of America").
        const wanted = [value, ...aliasesFor(plan.key, value)].map(answers.normalize).filter(Boolean);
        const listedMatch = () => {
          for (const text of wanted) {
            const hit = shown.find(choice => answers.normalize(choice.label) === text);
            if (hit) return hit.label;
          }
          return undefined;
        };
        let label = listedMatch();
        // A long or remote list (schools, employers) shows only some entries: its dropdown search box (one that appeared
        // on opening, or select2's bare "Search" box when the list was already open) narrows it to the answer.
        const searchBox = !label && fresh.fields.find(field => fieldType(field) === 'search' && field.autocomplete
          && (!current.fields.some(old => old.ref === field.ref) || /^search$/i.test(labelOf(field))));
        if (searchBox) {
          for (const text of [value, ...aliasesFor(plan.key, value)]) {
            await mutate('FILL', labelOf(searchBox), () => act.type(page, searchBox.ref, text, { secret: true }));
            for (let wait = 0; wait < 6; wait++) {
              await pause(wait ? 500 : 800);
              fresh = await freshSnapshot(current);
              shown = choicesFor(fresh, trigger.ref).filter(choice => !LIST_STATUS.test(clean(choice.label)));
              if (shown.length) break;
            }
            label = listedMatch();
            if (label) break;
          }
        }
        label ??= shown.length ? await chooseOption(question, value, shown.map(choice => choice.label), aliasesFor(plan.key, value)) : null;
        // An unlisted answer in a list that says to pick "Other" for it ("Select 'Other' if your employer name is not
        // listed"), or that comes with an "Other …" companion field, takes the "Other" entry; the companion field then
        // gets the real answer.
        let viaOther = false;
        if (!label && (/\bother\b/i.test(question) || activeFields(fresh).some(field => /^(other|if other)\b/i.test(labelOf(field))))) {
          if (searchBox) {
            await mutate('FILL', labelOf(searchBox), () => act.type(page, searchBox.ref, 'Other', { secret: true }));
            for (let wait = 0; wait < 6; wait++) {
              await pause(wait ? 500 : 800);
              fresh = await freshSnapshot(current);
              shown = choicesFor(fresh, trigger.ref).filter(choice => !LIST_STATUS.test(clean(choice.label)));
              if (shown.length) break;
            }
          }
          label = shown.find(choice => /^other\b/i.test(clean(choice.label)))?.label ?? null;
          viaOther = Boolean(label);
        }
        const option = label && shown.find(choice => choice.label === label);
        if (!option) {
          history.push(`opened "${question}": no listed choice matched ${plan.key}`);
          say(`CHOOSE ${clean(question)}: no match for ${plan.key}`);
          lastMark = null;
          continue;
        }
        await mutate('CLICK', option.label, () => act.click(page, option.ref));
        if (viaOther) history.push(`"${question}" does not list "${value}": chose "${option.label}"; put "${value}" in the matching "Other …" field`);
        else remember(question, option.label);
        say(`CHOOSE ${clean(question)} = "${clean(option.label)}"`);
        if (!viaOther) history.push(`chose "${option.label}" for "${question}"`);
        attempt = { kind: 'click', screen, label: question };
        consults = 0;
        continue;
      }
      if (plan.action === 'click') {
        // An error-summary link ("Please select a City - This field is required") only scrolls to its field; clicking
        // it changes nothing. A click on one that names an empty dropdown goes to that dropdown.
        const linked = current.controls.find(control => control.ref === plan.ref);
        const linkText = linked ? answers.normalize(linked.label) : '';
        const errorLink = linked && /\b(required|invalid|must be|please (enter|select|choose))\b/.test(linkText)
          ? activeFields(current).filter(field => isChoiceField(field) && isEmpty(field) && answers.normalize(labelOf(field)).length >= 3
            && linkText.startsWith(answers.normalize(labelOf(field))) && linkText.length > answers.normalize(labelOf(field)).length)
            .sort((a, b) => labelOf(b).length - labelOf(a).length)[0]
          : undefined;
        const choiceField = errorLink ?? activeFields(current).find(field => field.ref === plan.ref && isChoiceField(field));
        if (choiceField) {
          // A native select shows its options without opening (no clickable option rows ever appear). When no stored
          // answer covers it and it asks a preference among several real options (business area, team, office), the
          // writer picks one from the posting and profile; the registry fill then sets it.
          const prefKey = `qa.${answers.normalize(labelOf(choiceField))}`;
          const real = (choiceField.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option))).map(String);
          if (choiceField.tag === 'select' && isEmpty(choiceField) && real.length >= 2 && !values.has(prefKey)
              && !writeTried.has(`${current.url}|pref|${labelOf(choiceField)}`)) {
            writeTried.add(`${current.url}|pref|${labelOf(choiceField)}`);
            phase = 'writer';
            const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(postingText || current.pageText || '').slice(0, 3000) };
            const choice = await pickPreference({ job, applicant: await writerApplicant(), question: labelOf(choiceField), options: real });
            say(`WRITER preference "${clean(labelOf(choiceField))}" = ${choice ? `"${clean(choice)}"` : 'none'}`);
            if (choice) {
              values.set(prefKey, choice);
              lastMark = null;
              continue;
            }
          }
          const fresh = await openField(current, choiceField);
          const target = findField(fresh, choiceField);
          const listed = target ? choicesFor(fresh, target.ref).filter(option => !LIST_STATUS.test(clean(option.label))) : [];
          const count = listed.length || target?.options?.length || 0;
          say(`OPEN ${labelOf(choiceField)} (${count} choices)`);
          if (!count) needsField(choiceField, 'opening the select/combobox exposed no owned options');
          // A short custom list (Yes/No, a few levels) no stored key answers: the writer picks the option the applicant
          // facts state, and the pick path commits it. Otherwise Jev opens one question after another.
          if (target && isEmpty(target) && !values.has(prefKey) && listed.length >= 2 && listed.length <= 40
              && !writeTried.has(`${current.url}|pref|${labelOf(choiceField)}`)) {
            writeTried.add(`${current.url}|pref|${labelOf(choiceField)}`);
            phase = 'writer';
            const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(postingText || current.pageText || '').slice(0, 3000) };
            const choice = await pickPreference({ job, applicant: await writerApplicant(), question: labelOf(choiceField), options: listed.map(option => option.label) });
            say(`WRITER choice "${clean(labelOf(choiceField))}" = ${choice ? `"${clean(choice)}"` : 'none'}`);
            if (choice) {
              values.set(prefKey, choice);
              await pickField(fresh, target, prefKey, choice);
              remember(labelOf(choiceField), choice);
              lastMark = null;
            }
          }
          continue;
        }
        const control = currentControl(current, plan.ref, { moreEntries: moreEntries(current) });
        if (control.kind === 'option' && control.multi && control.selected) invalidPlan('multi-select-unchoose');
        // Advancing ("Save and Continue", "Next") while this screen still has required questions unanswered leaves
        // them behind: sites that save partial pages (tal.net) move on and the final submit later fails. The first
        // such advance per screen is refused with the open questions named; a repeat goes through (a site may mark
        // a question required that cannot be answered, and its own validation then reports it).
        if (/^(save (and|&) )?(continue|next)\b|^next( page| step)?$|^save (and|&) next\b/i.test(clean(control.label))) {
          const open = [
            ...activeFields(current).filter(field => field.required && isEmpty(field) && fieldType(field) !== 'file').map(labelOf),
            ...current.controls.filter(other => other.current !== undefined && other.formRef && /\*|\bfield is required\b/i.test(other.label ?? '')
              && (!clean(other.current) || /^(select|choose|please select|--)/i.test(clean(other.current)))).map(other => questionOf(other.label)),
          ];
          const mark = `${current.url}|advance|${open.join('|')}`;
          if (open.length && !advanceRefused.has(mark)) {
            advanceRefused.add(mark);
            history.push(`did not click "${clean(control.label)}": required questions on this screen are still empty: ${open.slice(0, 8).map(text => `"${clean(text).slice(0, 60)}"`).join(', ')}; answer them first`);
            invalidPlan('advance-with-required-empty');
          }
        }
        // A just-generated password belongs to an account still being created: signing in with it cannot work.
        if (registering.has(credentials.hostFromUrl(current.url)) && /^(log ?in|sign ?in)$/i.test(clean(control.label))
            && current.controls.some(other => RE_CREATE_ACCOUNT.test(clean(other.label)))) {
          invalidPlan('sign-in-before-account-exists');
        }
        if (rules.classifyControl(control) === 'final-submit') {
          if (current.gates.includes('captcha') && await awaitCaptcha(current)) invalidPlan('stale-screen');
          stopForGates(current, { submitting: true });
        }
        const resetRequest = isResetRequest(current, control);
        if (resetRequest && resetRequested.has(credentials.hostFromUrl(current.url))) {
          throw new Stop('needs-user-email-verification: the password reset was already requested in this run');
        }
        const clickedAt = Date.now();
        if (!await click(current, control)) { lastMark = null; await pause(1000); continue; }
        say(`JEV CLICK ${labelOf(control)} conf=${confidence.toFixed(2)}`);
        noteRecent(`JEV CLICK ${labelOf(control)}`);
        attempt = { kind: 'click', screen, label: labelOf(control), popup: control.expanded !== undefined || control.current !== undefined };
        history.push(`clicked "${labelOf(control)}"`);
        if (rules.classifyControl(control) === 'final-submit') {
          submittedVia = labelOf(control);
          submitFilled = new Set(activeFields(current).filter(field => !isEmpty(field)).map(field => field.ref));
          submitUrl = current.url;
          submitAt = Date.now();
          // The documents the site shows attached when the submit goes out: the one record of which resume it got.
          const attached = [...new Set(current.controls.filter(other => other.attached).map(other => other.attached))];
          if (attached.length) say(`DOC submitted with ${attached.join(', ')}`);
          runInfo.submittedWith = attached;
          await pause(2500);
        }
        if (resetRequest) { await pause(1500); await followEmailedReset(current, clickedAt); consults = 0; continue; }
        if (control.kind === 'option') {
          const owner = control.ownerRef && (current.fields.find(field => field.ref === control.ownerRef)
            ?? current.controls.find(other => other.ref === control.ownerRef));
          const question = owner ? labelOf(owner) : openedBy;
          if (question && !/^no (matches|results)\b/i.test(control.label)) remember(question, control.label);
        }
        consults = 0;
        continue;
      }
      if (plan.action === 'check') {
        const target = checkTarget(current, plan.ref);
        const fresh = checkTarget(await freshSnapshot(current), plan.ref);
        sameTarget(target.field, fresh.field);
        if (fresh.field.checkedRefs?.includes(plan.ref) || (!Array.isArray(fresh.field.optionRefs) && fresh.field.value === 'checked')) invalidPlan('already-checked');
        const label = `${labelOf(target.field)}${target.option && target.option !== labelOf(target.field) ? ` = ${target.option}` : ''}`;
        await mutate('CHECK', label, () => act.click(page, plan.ref));
        say(`JEV CHECK ${clean(label)} conf=${confidence.toFixed(2)}`);
        noteRecent(`JEV CHECK ${clean(label)}`);
        attempt = { kind: 'click', screen, label };
        history.push(`ticked "${label}"`);
        if (fieldType(target.field) === 'radio' && target.option) remember(labelOf(target.field), target.option);
        consults = 0;
        continue;
      }
      if (plan.action === 'fill') {
        // Resolve and validate the entire batch before its first mutation.
        // At most one autocomplete per batch: picking it can re-render other widgets, which the next pass observes.
        const resolvedBatch = plan.fields.map(item => resolveFill(current, item, values));
        const autocompletes = resolvedBatch.filter(fill => fill.field.autocomplete);
        const fills = [...resolvedBatch.filter(fill => !fill.field.autocomplete), ...autocompletes.slice(0, 1)];
        // A field gone or changed on a fresh read (the page re-rendered or advanced) is skipped, not fatal: the next
        // observation decides what is left to do.
        const stillThere = (snap, fill) => {
          try { return resolveFill(snap, { ref: freshRef(snap, fill.field), key: fill.key }, values); }
          catch (error) {
            if (!(error instanceof Stop) || !/^invalid-plan stale-/.test(error.message)) throw error;
            runlog.trace('refused', { source, action: `fill:${fill.field.ref}`, reason: error.message });
            return null;
          }
        };
        const fresh = await freshSnapshot(current);
        const live = fills.filter(fill => stillThere(fresh, fill));
        const applied = [];
        for (const fill of live) {
          if (fill.optionRef) {
            if (!await click(current, fill.field, fill)) continue;
          } else {
            const before = await freshSnapshot(current);
            const resolved = stillThere(before, fill);
            if (!resolved) continue;
            if (resolved.secretChoice) {
              // The Nth security-question picker on screen takes the Nth real question in its list, so no two match.
              const pickers = before.fields.filter(field => /\b(security|secret|challenge|recovery) question\b/i.test(labelOf(field)));
              const nth = Math.max(0, pickers.findIndex(field => field.ref === resolved.field.ref));
              const listed = (await act.selectOptions(page, resolved.field.ref, '', 500))
                .filter(option => option && !/^(select|choose|please)\b/i.test(option.trim()));
              const question = listed[nth % Math.max(listed.length, 1)];
              if (!question) invalidPlan('no-security-questions');
              await mutate('SELECT', labelOf(resolved.field), () => act.select(page, resolved.field.ref, question));
              say(`SELECT ${labelOf(resolved.field)} = question ${nth + 1} of the list`);
              continue;
            }
            if (resolved.secret) {
              const account = accountIdentity(before);
              if (account.username === null) throw new Stop('credential-identity-missing');
              // Repeated labels ("Answer" under each of three questions) get one secret each, by their order on screen.
              const same = before.fields.filter(field => answers.normalize(labelOf(field)) === answers.normalize(labelOf(resolved.field)));
              const nth = same.findIndex(field => field.ref === resolved.field.ref);
              const label = `${answers.normalize(labelOf(resolved.field))}${same.length > 1 ? `#${nth + 1}` : ''}`;
              const secret = await credentials.ensureSecret(account.host, account.username, label);
              await mutate('FILL', labelOf(resolved.field), () => act.type(page, resolved.field.ref, secret, { secret: true }));
              say(`generated secret in Keychain for ${labelOf(resolved.field)}`);
              continue;
            }
            const progressId = progressKey(before, resolved.field);
            const state = fillProgress.get(progressId) ?? { url: before.url, failures: 0, recovered: false };
            if (state.recovered) needsField(resolved.field, 'the field still needs an answer after opening and picking');
            if (isChoiceField(resolved.field)) {
              // Linked choice widgets (a ZIP list filled only after the address pick) can be empty on the first try:
              // the first failed pick of a field is noted and the run moves on; the second one stops.
              try { await pickField(before, resolved.field, resolved.key, resolved.value); }
              catch (error) {
                if (!(error instanceof Stop) || !error.message.startsWith('needs-user-field') || state.pickFailed) throw error;
                state.pickFailed = true;
                fillProgress.set(progressId, state);
                await act.press(page, 'Escape').catch(() => undefined);
                say(`PICK deferred "${labelOf(resolved.field)}": ${error.message.replace(/^needs-user-field "[^"]*": /, '')}`);
                // A linked list (ZIP under City/State) offers only choices under the values already in its parent
                // fields: a field the site prefilled from a resume ("Waterville" in City) that contradicts a stored
                // fact is corrected now, so the deferred pick sees the right list when it is tried again.
                for (const field of before.fields.filter(other => other.ref !== resolved.field.ref && !isEmpty(other))) {
                  const key = `facts.${answers.normalize(labelOf(field)).replace(/ /g, '_')}`;
                  const stored = values.get(key);
                  const shown = answers.normalize(field.value);
                  if (typeof stored !== 'string' || !stored || shown.includes(answers.normalize(stored)) || answers.normalize(stored).includes(shown)) continue;
                  try {
                    const fresh = await freshSnapshot(current);
                    const live = findField(fresh, field);
                    if (!live) continue;
                    if (isChoiceField(live)) await pickField(fresh, live, key, stored);
                    else {
                      await mutate('FILL', labelOf(live), () => act.type(page, live.ref, stored, { secret: true }));
                      await act.press(page, 'Tab');
                    }
                    say(`CORRECTED prefilled "${labelOf(field)}" ("${clean(field.value)}") to the stored ${key}`);
                  } catch (correction) {
                    await act.press(page, 'Escape').catch(() => undefined);
                    history.push(`"${labelOf(field)}" shows "${clean(field.value)}" but the stored answer is "${stored}"; correct it before "${labelOf(resolved.field)}"`);
                  }
                }
                continue;
              }
            } else {
              await mutate('FILL', labelOf(resolved.field), () => act.type(page, resolved.field.ref, resolved.value, { secret: !isEmpty(resolved.field) }));
              await act.press(page, 'Tab');
            }
            Object.assign(state, { field: resolved.field, key: resolved.key, value: resolved.value, before: fieldState(resolved.field), pending: true });
            fillProgress.set(progressId, state);
            applied.push(resolved);
            rememberEmail(before, resolved.field, resolved.value);
          }
        }
        // A later keystroke can land in an earlier box of the same batch: a segmented date (Workday's Month/Year) moves
        // focus on its own, so the year's first digit overwrites the month. Each typed box is re-read once and retyped
        // (cleared first) if it no longer holds its value; numeric boxes may drop a leading zero ("06" shows "6").
        const typed = applied.filter(fill => !fill.optionRef && !fill.secret && !fill.secretChoice && !isChoiceField(fill.field));
        if (typed.length > 1) {
          const bare = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
          const holds = (shown, value) => bare(shown) === bare(value) || (/^\d+$/.test(bare(shown)) && /^\d+$/.test(bare(value)) && Number(bare(shown)) === Number(bare(value)));
          const after = await freshSnapshot(current);
          for (const fill of typed) {
            const now = after.fields.find(field => field.ref === fill.field.ref);
            if (!now || now.value === undefined || holds(now.value, fill.value)) continue;
            await mutate('FILL', labelOf(fill.field), () => act.type(page, fill.field.ref, fill.value, { secret: true }));
            say(`REFILL ${labelOf(fill.field)}: a later keystroke in the batch changed it`);
          }
        }
        say(`JEV FILL ${fills.map(fill => labelOf(fill.field)).join('; ')} conf=${confidence.toFixed(2)}`);
        noteRecent(`JEV FILL ${fills.map(fill => labelOf(fill.field)).join('; ')}`);
        attempt = { kind: 'fill', screen, fields: applied.map(fill => ({ ref: fill.field.ref, label: labelOf(fill.field), autocomplete: !!fill.field.autocomplete })) };
        history.push(`filled ${applied.map(fill => `"${labelOf(fill.field)}"`).join(', ')}`);
        for (const fill of applied) {
          if (fill.secret || fill.optionRef || !labelOf(fill.field)) continue;
          filledKeys[labelOf(fill.field)] = fill.key;
          if (learnLabel(fill.field)) learnAs[labelOf(fill.field)] = learnLabel(fill.field);
        }
        consults = 0;
        continue;
      }
      if (plan.action === 'upload_resume') {
        const { field, kind } = documentField(current, plan.ref, resumeAvailable);
        let file = resume;
        if (kind === 'resume' && !await resumeIsReadable(resume)) throw new Stop('resume-not-readable', 1);
        if (kind === 'resume') {
          phase = 'tailored-resume';
          const tailored = await (tailoredPending ??= tailorResume(`${postingText}\n${String(current.pageText ?? '')}`.slice(0, 6000)));
          phase = 'driver';
          if (tailored) {
            file = tailored;
            runInfo.tailored = true;
            say(`RESUME tailored for this posting: ${tailored}`);
          }
        }
        if (kind === 'cover') {
          // A tailored letter for this posting, written and compiled once per job (cached across re-runs).
          phase = 'cover-letter';
          try {
            file = await coverLetter({ url: runUrl, title: clean(current.title), employer: null, pageText: `${postingText}\n${String(current.pageText ?? '')}`.slice(0, 6000) });
          } catch (error) {
            runlog.trace('cover-letter-error', { message: clean(error?.message).slice(0, 200) });
            refused.actions.add(`upload:${field.ref}`);
            lastMark = null;
            continue;
          }
          phase = 'driver';
        }
        const fresh = await freshSnapshot(current);
        // The page re-rendered and the upload box is gone or changed: observe again rather than stop the run.
        let target;
        try { target = documentField(fresh, field.ref, true).field; sameTarget(field, target); }
        catch (error) {
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
          runlog.trace('refused', { source, action: `upload:${field.ref}`, reason: `stale ${error.message}` });
          lastMark = null;
          continue;
        }
        const what = kind === 'cover' ? 'COVER_LETTER' : 'RESUME';
        await mutate('UPLOAD', labelOf(target), () => act.upload(page, target.ref, file));
        if (!(runInfo.uploaded ??= []).includes(basename(file))) runInfo.uploaded.push(basename(file));
        // What the site did with the file (kept it, showed a chip, opened a dialog) once it has had time to react.
        const uploadResult = async () => {
          await pause(2500);
          const after = await observe(page);
          const held = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')].reduce((n, input) => n + input.files.length, 0)).catch(() => null);
          const result = { label: labelOf(target), held, messages: after.messages ?? [], gates: after.gates,
            attached: after.controls.filter(control => control.attached).map(control => clean(control.label)).slice(0, 5),
            context: clean(findField(after, target)?.context ?? '').slice(0, 200), url: after.url !== current.url ? after.url : undefined };
          runlog.trace('upload-result', result);
          return { after, result };
        };
        const { after, result } = await uploadResult();
        // A widget that ignores a file set on its input (Phenom's resume box: input emptied, no chip, same text, no
        // dialog) gets it once more through its own upload button and the native file chooser.
        const dropped = result.held === 0 && !result.attached.length && !result.url && !result.gates.length
          && result.context === clean(target.context ?? '').slice(0, 200);
        const trigger = dropped && after.controls.find(control => control.kind === 'button' && !control.href
          && (control.formRef ?? '') === (target.formRef ?? '')
          && /\b(select|choose|browse|upload|attach)\b.*\b(file|resume|résumé|cv)\b/i.test(clean(control.label)));
        if (trigger) {
          await mutate('UPLOAD', labelOf(target), () => act.uploadViaChooser(page, trigger.ref, file)).catch(error => runlog.trace('upload-chooser-error', { message: clean(error?.message).slice(0, 200) }));
          say(`UPLOAD retried through "${clean(trigger.label)}" (the site dropped the file set on its input)`);
          await uploadResult();
        }
        uploads.set(`${current.url}|${labelOf(target)}`, (uploads.get(`${current.url}|${labelOf(target)}`) ?? 0) + 1);
        uploadedLabels.add(answers.normalize(labelOf(target)));
        say(`JEV UPLOAD_${what} ${labelOf(target)} conf=${confidence.toFixed(2)}`);
        noteRecent(`JEV UPLOAD_${what} ${labelOf(target)}`);
        consults = 0;
        continue;
      }
      if (plan.action === 'credentials') {
        // Empty password fields are filled; when every one is already filled, Jev chose to re-enter them all
        // (the site rejected the pair), and the secret fill clears each field first.
        const all = passwordFields(current);
        const fields = all.some(isEmpty) ? all.filter(isEmpty) : all;
        if (!fields.length) invalidPlan('password-fields');
        if (!identity.username) throw new Stop('unknown-required-field email');
        const fresh = await freshSnapshot(current);
        const freshAll = passwordFields(fresh);
        const freshFields = freshAll.some(isEmpty) ? freshAll.filter(isEmpty) : freshAll;
        if (freshFields.length !== fields.length) invalidPlan('stale-password-fields');
        for (const field of fields) {
          const target = freshFields.find(candidate => candidate.ref === field.ref);
          if (!target) invalidPlan('stale-password-field');
          sameTarget(field, target);
        }
        const freshIdentity = accountIdentity(fresh);
        if (freshIdentity.host !== identity.host || freshIdentity.username !== identity.username) invalidPlan('stale-account');
        phase = 'credentials';
        const existing = await credentials.get(identity.host, identity.username);
        // No stored password and a lone password box: this is a sign-in form for an account that does not exist yet.
        // When the screen offers account creation, open it instead of inventing a password for a sign-in.
        const createControl = existing === null && freshAll.length === 1
          ? fresh.controls.find(control => RE_CREATE_ACCOUNT.test(clean(control.label))) : null;
        if (createControl) {
          await click(fresh, createControl);
          say(`HARNESS CLICK ${labelOf(createControl)} (no stored account for ${clean(identity.host)})`);
          noteRecent(`HARNESS CLICK ${labelOf(createControl)}`);
          history.push(`no account exists for ${identity.username} on this site; opened "${labelOf(createControl)}" to register`);
          consults = 0;
          continue;
        }
        if (plan.mode === 'login' && existing === null) throw new Stop(`credential-missing ${clean(identity.host)}`);
        // On a reset page opened from the emailed link, the stored password is replaced once per run with a fresh
        // one, reused for every field of that form.
        const resetting = resetPasswords.has(identity.host) && (plan.mode === 'register' || all.length >= 2 || !!resetPasswords.get(identity.host));
        if (resetting && !resetPasswords.get(identity.host)) resetPasswords.set(identity.host, await credentials.rotate(identity.host, identity.username));
        // The longest password the site takes: the box's maxlength, else its stated rule ("8-18 characters",
        // "no more than 20 characters") in the field messages or page text.
        const ruleText = [...fields.map(field => field.message ?? ''), ...(fresh.messages ?? []), fresh.pageText ?? ''].join('\n');
        const stated = ruleText.match(/\b\d{1,2}\s*(?:-|–|to|and)\s*(\d{1,2})\s*(?:characters|chars)\b/i)?.[1]
          ?? ruleText.match(/\b(?:max(?:imum)?(?: of)?|at most|no more than|up to|not exceed|(?:not be|no) longer than)\s*(\d{1,2})\s*(?:characters|chars)\b/i)?.[1];
        const maxLength = Math.min(...fields.map(field => field.maxLength > 0 ? field.maxLength : Infinity), Number(stated) >= 8 ? Number(stated) : Infinity);
        const password = resetting ? resetPasswords.get(identity.host)
          : plan.mode === 'register' ? await credentials.ensure(identity.host, identity.username, Number.isFinite(maxLength) ? maxLength : 0) : existing;
        if (plan.mode === 'register' && existing === null) registering.add(identity.host);
        for (const field of fields) {
          const before = await freshSnapshot(current);
          const target = passwordFields(before).find(candidate => candidate.ref === field.ref);
          if (!target || (fields !== all && !isEmpty(target))) invalidPlan('stale-password-field');
          sameTarget(field, target);
          const account = accountIdentity(before);
          if (account.host !== identity.host || account.username !== identity.username) invalidPlan('stale-account');
          await mutate('FILL', 'password', () => act.type(page, target.ref, password, { secret: true }));
        }
        say(`JEV CREDENTIALS ${plan.mode} conf=${confidence.toFixed(2)}`);
        if (plan.mode === 'login') registering.delete(identity.host);
        noteRecent(`JEV CREDENTIALS ${plan.mode}`);
        say(plan.mode === 'register' && existing === null ? 'generated password in Keychain' : 'filled password from Keychain');
        history.push(`filled the ${plan.mode === 'login' ? 'stored' : 'account'} password into ${fields.map(field => `"${labelOf(field)}"`).join(' and ')}`);
        consults = 0;
        continue;
      }
      invalidPlan('action');
    } catch (error) {
      // A frame detached or a context destroyed mid-read (a tab navigated or closed under us): nothing was sent;
      // re-observe, on the last open web tab if this one is gone.
      if (!(error instanceof Stop) && /detached Frame|frame was detached|Execution context was destroyed|Target closed|Session closed/i.test(String(error?.message))
        && ++redrives <= 25) {
        runlog.trace('refused', { source: 'executor', action: 'pass', reason: `transient ${clean(error.message).slice(0, 120)}` });
        await delay(1000);
        if (page.isClosed()) page = (await connection.pages()).filter(open => /^https?:/.test(open.url())).pop() ?? page;
        lastMark = null;
        continue;
      }
      if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')
        || error.message.startsWith('invalid-plan final-submit') || ++redrives > 25) throw error;
      runlog.trace('refused', { source: 'executor', action: 'pass', reason: error.message });
      say(`REFUSED ${error.message.replace('invalid-plan ', '')}; re-driving`);
      lastMark = null;
    } }
    throw new Stop('iteration-limit');
  } catch (error) {
    const reason = error instanceof Stop ? error.message : phase === 'browser-connect' ? clean(error?.message) : `implementation-error ${phase}`;
    if (!(error instanceof Stop)) runlog.trace('error', { phase, message: clean(error?.message), stack: clean(error?.stack).slice(0, 1500) });
    if (submittedVia && confirmSubmitted && await confirmSubmitted().catch(() => false)) {
      say(`SUBMITTED via "${clean(submittedVia)}" (confirmed after ${reason}: the page states the application was received)`);
      submitted = true;
      return;
    }
    say(`STOP: ${reason}`);
    process.exitCode = error instanceof Stop ? error.code : 1;
  } finally {
    if (submitted && postSubmitEmail) await postSubmitEmail().catch(() => say('EMAIL post-submit: inbox check failed'));
    let host = null;
    try { host = new URL(runUrl).host; } catch { /* no url */ }
    runlog.summary({ host, job: runUrl ? runUrl.replace(/[?#].*$/, '').slice(0, 200) : null, ...runInfo });
    if (closeRunTabs) await closeRunTabs().catch(() => undefined);
    if (connection) {
      try { await connection.disconnect(); }
      catch {
        say('STOP: implementation-error disconnect');
        process.exitCode = 1;
      }
    }
  }
}

await run();
