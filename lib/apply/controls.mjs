// Vetting model-proposed clicks and checks before they execute (word rules, target posting, opt-outs)
// and the action wrapper that classifies execution failures. The consecutive-Back walk counter lives here.
import * as answers from '../answers.mjs';
import * as rules from '../rules.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmpty, fieldType, learnLabel } from './fields.mjs';
import { activeFields, signupControl, resultsPager, offApplication } from './screen.mjs';
import { resolveHandle } from '../act/resolve.mjs';

// Sections the harness only ever writes from stored facts. Education, Work Experience, Languages and Skills are not
// here: their facts (and their stored list answers) answer them.
export const FACTLESS_SECTIONS = [
  { name: 'certification', re: /\bcertificat(e|es|ion|ions)\b/ },
  { name: 'license', re: /\blicen[cs]es?\b|\blicensure\b/ },
  { name: 'award', re: /\bawards?\b|\bhonou?rs?\b/ },
  { name: 'patent', re: /\bpatents?\b/ },
  { name: 'publication', re: /\bpublications?\b/ },
  { name: 'military service', re: /\bmilitary\b|\barmed forces\b|\bveteran\b/ },
  { name: 'security clearance', re: /\bsecurity clearance\b|\bclearance\b/ },
  { name: 'professional membership', re: /\bmemberships?\b|\baffiliations?\b|\bprofessional (association|affiliation|membership)s?\b/ },
  { name: 'volunteer', re: /\bvolunteer(ing|s)?\b/ },
];

// Does a stored fact exist for a section? Both registries are flat (facts.* and qa.*): a facts key whose own name
// names the section, or a qa key whose question does. Alias variants belong to the fact they extend. A value stating
// the applicant holds none of it ("None", "No", "I have never served in the military") authorises nothing, and
// neither does a key that states the absence in its own words ("... have never held a security clearance"). A qa key
// phrased as a question ("do you currently or have you previously held any license or professional certification",
// "please provide further information e g name of publication or job board") is an answer to a question about the
// section, not a value of it, so it does not authorise the section's entries either.
const STATES_NONE = /\b(no|none|never|not|n a|n\/?a|false|nil|null|without)\b/;
const QUESTION_KEY = /^(do|does|did|have|has|had|are|is|was|were|will|would|should|shall|can|could|may|might|must|please|provide|share|select|enter|describe|tell|when|where|which|what|who|how|why|if|or|and|any|for)\b/;
export function hasSectionFacts(values, hint) {
  if (!values) return true;
  for (const key of values.keys()) {
    if (!/^(facts|qa)\./.test(key) || /\.(alt|alias)_\d+$/.test(key)) continue;
    const value = values.get(key);
    if (value === false || value === null || value === undefined || String(value).trim() === '') continue;
    if (STATES_NONE.test(answers.normalize(String(value)))) continue;
    const name = answers.normalize(String(key).replace(/^(facts|qa)\./, '').replace(/_/g, ' '));
    if (!name || !hint.re.test(name)) continue;
    if (STATES_NONE.test(name) || (key.startsWith('qa.') && QUESTION_KEY.test(name))) continue;
    return true;
  }
  return false;
}

// The fact-less section a label names (a field's label, a control's label or its context caption), or null: the
// section's own words with no stored fact under them. A fast path only — the generic rules are provenance-based.
export function factlessSection(text, values) {
  const name = answers.normalize(text);
  if (!name) return null;
  for (const hint of FACTLESS_SECTIONS) if (hint.re.test(name) && !hasSectionFacts(values, hint)) return hint.name;
  return null;
}

// The stored answer that authorises a value for a field: the key a past run learned for its label, an entry under
// facts.<label>, or the qa registry key for its question or its label. Null when nothing answers it.
export function storedAnswerFor(field, values, learned) {
  if (!field || !values) return null;
  const label = labelOf(field);
  const keys = [learned?.fields?.[learnLabel(field)], `facts.${answers.normalize(label).replace(/ /g, '_')}`,
    `qa.${answers.normalize(questionOf(label))}`, `qa.${answers.normalize(label)}`];
  for (const key of keys) if (key && values.has(key)) return { key, value: values.get(key) };
  return null;
}

// A generic answer ("Yes", "No", "I confirm", "Not applicable") names no entity: the driver derives it from the facts
// it was shown (a May 2029 graduation answers "Do you expect to graduate by June 2028?" with No).
const GENERIC_ANSWER = /^(yes|no|i (confirm|agree|do not agree|accept|decline|understand|acknowledge)|confirm|agree|decline|not applicable|n a|none|prefer not to (say|answer|disclose|respond))$/;

// A disclosure question in a section ("Have you ever held an active security clearance?", "Are you able to provide
// proof of U.S. Citizenship?") asks for an answer, not an entry: a section with no facts under it still asks such
// questions, and the stored facts answer them.
const DISCLOSURE_QUESTION = /^(do|does|did|have|has|had|are|is|was|were|will|would|can|could|if|to your knowledge|please (select|indicate|confirm))\b/;
export function disclosureQuestion(field) {
  const label = clean(labelOf(field ?? {}));
  return label.includes('?') || DISCLOSURE_QUESTION.test(answers.normalize(questionOf(label)));
}

// True when a fill answers a disclosure question with a plain answer rather than filing a named credential in the
// section: a none answer (No/None/N/A/"Never held a clearance") files nothing; an affirmative (Yes/I confirm) stands
// only when its stored key is about something else (facts.us_citizen answering "are you able to provide proof of
// U.S. Citizenship?" in a clearance section), since a key that itself names the section is as unverified as the section.
export function disclosureAnswer(field, value, key = '') {
  if (!field || value === undefined || value === null || !disclosureQuestion(field)) return false;
  const shown = answers.normalize(String(value));
  if (STATES_NONE.test(shown)) return true;
  if (!GENERIC_ANSWER.test(shown)) return false;
  const name = answers.normalize(String(key).replace(/^(facts|qa)\./, '').replace(/_/g, ' '));
  return !FACTLESS_SECTIONS.some(hint => hint.re.test(name));
}

// True when a model-planned click on one listed option is not grounded: the option belongs to a field (its ownerRef,
// or the field listing it as an optionRef) and neither that field's stored answer nor the value it already shows
// names the option's words. Jev picking a suggestion nothing stored states ("Six Sigma - Black Belt") is a
// fabrication in any section; the option a picker resolved from a stored value's list never reaches this. A generic
// answer (GENERIC_ANSWER) is never refused here.
export function ungroundedOption(current, ref, storedFor) {
  const option = current.controls.find(control => control.ref === ref);
  if (GENERIC_ANSWER.test(answers.normalize(clean(option?.label ?? '')))) return false;
  // The pick's owner is the field the option belongs to (its ownerRef), the field listing it as an optionRef, or the
  // control that owns it (a button-style listbox names its trigger, not a field).
  const ownerRef = option?.ownerRef ?? current.fields.find(field => (field.optionRefs ?? []).includes(ref))?.ref;
  const owner = ownerRef && ownerRef !== ref
    ? current.fields.find(candidate => candidate.ref === ownerRef) ?? current.controls.find(candidate => candidate.ref === ownerRef)
    : null;
  if (!owner) return false;
  // Either direction counts: the stored value may carry a qualifier the option drops ("English" ⊂ "English (EN)",
  // "United States of America" ⊂ "United States of America (+1)") and the option may name a part of a longer value.
  const names = (value, option) => {
    const shown = answers.normalize(clean(option));
    if (!value || shown.length < 2) return false;
    const text = ` ${answers.normalize(String(value))} `;
    return text.includes(` ${shown} `) || ` ${shown} `.includes(text);
  };
  const stored = storedFor(owner);
  const shownValue = owner.value !== undefined ? owner.value : owner.current;
  return !((stored && names(stored.value, option?.label)) || names(shownValue, option?.label));
}

// The section a generic control acts in, read from the live DOM: the nearest ancestor group/region/fieldset with an
// accessible name (the walk the snapshot's own naming pass does), else the nearest ancestor whose id names a section
// ("Certifications-section", "Languages-1-panel"). Workday leaves some section "Add" buttons unnamed in the snapshot;
// the DOM still carries the section.
export async function sectionOf(page, ref) {
  const el = await resolveHandle(page, ref);
  return el.evaluate(node => {
    const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    for (let parent = node.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth += 1) {
      const role = parent.getAttribute('role') || '';
      if (role !== 'group' && role !== 'region' && parent.tagName !== 'FIELDSET') continue;
      const ids = (parent.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const name = text(ids.map(id => document.getElementById(id)?.textContent ?? '').join(' '))
        || text(parent.getAttribute('aria-label')) || text(parent.querySelector('legend,h1,h2,h3,h4,h5,h6')?.textContent);
      if (name && name.length <= 60) return name;
    }
    for (let parent = node.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth += 1) {
      const match = String(parent.id || '').match(/^([A-Za-z][\w/-]*?)(?:-\d+)?-(?:section|panel)$/);
      if (match) return match[1].replace(/[-_/]+/g, ' ');
    }
    return '';
  }).catch(() => '');
}

// The fact-less section an Add/Add Another control opens: the control's own words ("Add Another Certifications"),
// else the section the live DOM gives a bare "Add". Null when the control opens no entry, or its section has facts.
export async function factlessEntrySection(page, control, values) {
  if (!isAddControl(control)) return null;
  return factlessSection(`${control.label ?? ''} ${control.context ?? ''}`, values)
    ?? factlessSection(await sectionOf(page, control.ref), values);
}

// An "Add"/"Add Another"/"+" control opens a new entry in the section it sits in. A "+" has no words to normalize.
export function isAddControl(control) {
  return /^\s*\+/.test(String(control?.label ?? '')) || /^(add|add another|add more|add new)\b/.test(answers.normalize(control?.label));
}

// Checkbox ticks and radio picks without a stored answer are Jev's choice, except applicant attestations,
// consents, and opt-ins: those stay with the user. A radio is picked only while its group has no selection.
const USER_DECISION = /\b(agree|consent|certif|attest|acknowledg|terms|privacy|policy|signature|sign|authori[sz]|marketing|newsletter|email me|text me|sms)/;

// Marketing/notification opt-ins are never ticked. Applicant attestations (agree, acknowledge, certify) are ticked only
// under --submit, which authorizes completing the whole application unattended.
// "Yes, <employer> can contact me about future job opportunities" and talent-pool/retention offers are opt-ins too.
const OPT_IN = /\b(marketing|newsletter|email me|text me|sms|promotional|job alerts?|to contact you|contact me about|future (job |career |employment )?opportunities|talent (pool|community|network)|keep (me|my (information|details|data|resume|profile)) (informed|on file|updated))\b/;

export function checkTarget(current, ref, allowSubmit) {
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

export function currentControl(current, ref, { moreEntries = false, allowSubmit, targetRole, posting, values } = {}) {
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
  // five steps back; the walk ends at the first other action. The page's own wording is read through the shared
  // RE_PAGE_ISSUE predicate, so every ATS banner ("You have 2 issues that need to be fixed", "There's 1 issue that
  // needs your attention") is understood the same way here and in the step rules.
  const backToFix = /^back$/.test(answers.normalize(control.label)) && !control.href && backWalk < 5
    && (backWalk > 0 || (rules.RE_PAGE_ISSUE.test(current.pageText ?? '')
      && !activeFields(current).some(field => isEmpty(field) && fieldType(field) !== 'file')));
  // An account/registration step the run cannot finish (the site says this email already has a record) has no other way
  // out than the site's own Back/Cancel/Close: that escape is allowed, bounded like the back-to-fix walk, and the
  // site's own sign-in control is preferred over it (it stays clickable and may leave the register page for the login
  // page). Two password boxes are a register/sign-up form even on a URL that does not name one.
  const accountStep = /\/(register|registration|sign-?up|create-?account|new-?account|join)(\/|$|\?)/i.test(String(current.url))
    || activeFields(current).filter(field => fieldType(field) === 'password').length >= 2;
  const accountEscape = accountStep && !control.href && accountWalk < 3
    && /^(back|cancel|close)$/.test(answers.normalize(control.label));
  const accountSignIn = accountStep && !/\b(register|sign ?up|create (an )?account|new user)\b/i.test(answers.normalize(control.label))
    && /\b(log ?in|sign ?in)\b|\balready have an account\b/i.test(answers.normalize(control.label));
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
      // the job search, the profile, the home feed): the run applies to this posting only. The posting page's own
      // apply entry is the exception: it opens this posting's application wherever the site keeps it (SmartRecruiters'
      // /oneclick-ui/…/publication/<uuid>, SuccessFactors' /talentcommunity/apply/<id>), and it is the posting's own
      // when the page is the posting (its URL carries the id) and every apply entry on it reads alike (no other job's
      // card with its own Apply); one naming another role is refused above.
      const here0 = new URL(current.url);
      const postingsOwnEntry = kind === 'apply-entry' && `${here0.pathname}${here0.search}`.includes(posting.id)
        && new Set(current.controls.filter(other => rules.classifyControl(other) === 'apply-entry').map(other => answers.normalize(other.label))).size === 1;
      if (posting.id && url.host === posting.host && here0.host === posting.host && !postingsOwnEntry
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
      if (kind === 'other' && !opensTarget && !accountSignIn && (!control.formRef || url.host !== here.host) && (url.host !== here.host || url.pathname !== here.pathname)
        && (activeFields(current).length >= 3 || (applicationPage && url.host !== here.host))) invalidPlan('leaves-application');
    }
  }
  // A dropdown trigger (it shows a current selection) is a question, not navigation: its label is not word-filtered.
  const popupTrigger = control.current !== undefined;
  // An "Add …" control opens a new entry (education, work experience, website) in the form; buttons without a type
  // attribute default to submit, so that alone does not make it unsafe. "Add another" duplicates an entry: the stored
  // answers hold one entry per section, except a stored list with items still unentered (moreEntries).
  // An entry in a section the stored facts say nothing about (Certifications, Licenses, Awards…) is refused first: it
  // opens a required field no stored answer can fill, so it can only sit empty and block the step, or be filled with
  // a fabrication. The section comes from the control's own words ("Add Another Certifications") or the caption it
  // carries; a bare "Add" is resolved from the live DOM at the call sites (factlessEntrySection) before this is reached.
  if (values && isAddControl(control)) {
    const section = factlessSection(`${control.label ?? ''} ${control.context ?? ''}`, values);
    if (section) invalidPlan(`factless-section ${section}`);
  }
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
  // A bare "Delete"/"Remove" inside an applicant form, or one the snapshot named by its entry ("Delete Certifications
  // 1"), removes one entry of a repeatable section (an empty certification row the site added); it never touches an
  // account, a saved application, or a stored document.
  const removeEntry = /^(delete|remove)( [a-z0-9 /&-]{1,40})?$/.test(answers.normalize(control.label)) && !control.href && !control.attached
    && activeFields(current).length > 0 && !/\b(account|profile|application|resume|cv|document|file|attachment)s?\b/i.test(`${control.label} ${control.context ?? ''}`);
  // Three widgets that live inside the applicant form and default to type=submit, so the word rules read them as
  // submitting the application: a collapsed section's own disclosure ("Show more", "View all" - it reveals the
  // fields the site hid, including the attestation the run must tick), a widget's own value clear ("Remove value for
  // the Month field." - it empties one control, never an account or an entry), and a profile re-import ("Import
  // profile again", "Refresh profile" - it refills the form from the candidate's own profile).
  const disclosure = !control.href
    && /^(show|view|read|see|expand)\b.{0,24}\b(more|all|details|less|options|fields|section)\b/i.test(answers.normalize(control.label));
  const widgetClear = !control.href && /^(remove|clear|delete)\s+(the\s+)?value\s+for\b/i.test(answers.normalize(control.label));
  const profileImport = !control.href
    && (/\b(import|refresh|re-?run|reload|use|update|sync)\b.{0,24}\bprofile\b|\bprofile\b.{0,24}\b(again|import|refresh|update|reload)\b/i.test(answers.normalize(control.label)));
  // Default-submit buttons outside applicant forms, and owned popup choices, do not submit an application. Account
  // controls ("Reset Password" requests a reset email) are exact labels, so the word filter skips them. A bare
  // "Cancel" inside a child frame holding no form fields (a third-party picker popup) only dismisses that popup.
  const frame = control.ref.includes(':') ? control.ref.slice(0, control.ref.indexOf(':') + 1) : null;
  const dismissPopup = frame && /^(cancel|close)$/.test(answers.normalize(control.label)) && Number(control.formFieldCount) === 0
    && !current.fields.some(field => field.ref.startsWith(frame) && fieldType(field) !== 'text');
  // A modal dialog's own Cancel/Close (the snapshot tags a control/field inside a visible role=dialog/alertdialog,
  // aria-modal, or open <dialog> with the dialog's index) only dismisses that overlay, whatever the button's native
  // type. Refused when the dialog is itself a form (3+ fields: cancelling discards entered answers, as the
  // application form's own Cancel would), when a sibling button in the same dialog confirms a withdrawal or an
  // account deletion, or when the control is a link (the href rules above already vetted its destination).
  const inDialog = control.dialog !== undefined;
  const dialogPeers = inDialog ? current.controls.filter(other => other.dialog === control.dialog) : [];
  const dialogFields = inDialog ? current.fields.filter(field => field.dialog === control.dialog && fieldType(field) !== 'hidden') : [];
  const destructiveDialog = dialogPeers.some(other => other.ref !== control.ref
    && /\b(withdraw|delet|deactivate|close (my |your |the )?account|remove (my |your |the )?(account|profile|application)|discard (my |your |the )?(application|changes|progress))\b/i.test(answers.normalize(other.label)));
  const dismissDialog = inDialog && /^(cancel|close|x)$/.test(answers.normalize(control.label)) && !control.href
    && dialogFields.length < 3 && !destructiveDialog;
  // A section of the candidate's own profile or documents on the employer's site ("My Documents", "Profile
  // Information") is where the resume and profile data live; opening it navigates within the profile, never off the
  // application (a cross-host href was already refused above). Inside the one big profile form such a button
  // defaults to type=submit, which alone does not submit an application — the word rules above still apply to it.
  const profileSection = /\b(my (documents?|profile|information|details|attachments?|files?)|profile (information|details|sections?)|personal (information|details|data))\b/i.test(answers.normalize(control.label))
    && (!control.href || new URL(control.href, current.url).host === new URL(current.url).host);
  // The command words vet buttons and links. A dropdown option is an answer value, not a command: "January 2029
  // or later", "Remove from consideration: No" are picked, never acted on, so the word rules skip options.
  if (kind !== 'final-submit' && ((control.kind !== 'option' && !popupTrigger && !removeEntry && !widgetClear && !dismissPopup && !dismissDialog && !backToFix
    && !accountEscape && !accountSignIn && kind !== 'login' && forbidden.test(answers.normalize(control.label)))
    || (kind !== 'login' && forbidden.test(answers.normalize(path))))
    || (control.type === 'reset' && !accountEscape) || (control.type === 'submit' && kind === 'other' && !addEntry
      && !popupTrigger && control.kind !== 'option' && Number(control.formFieldCount) > 0 && !dismissDialog && !profileSection
      && !disclosure && !widgetClear && !profileImport && !accountEscape && !accountSignIn)) invalidPlan('unsafe-control');
  return control;
}

// Consecutive "Back" clicks (see currentControl's back-to-fix rule); any other action ends the walk back. The
// account-step escape (Back/Cancel/Close on a register page) has its own counter so neither walk extends the other.
let backWalk = 0;
let accountWalk = 0;

export async function mutate(operation, label, action) {
  backWalk = operation === 'CLICK' && /^back$/i.test(clean(label)) ? backWalk + 1 : 0;
  accountWalk = operation === 'CLICK' && /^(back|cancel|close)$/i.test(clean(label)) ? accountWalk + 1 : 0;
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
    // a dropdown was verified to hold no choice after the pick, or a box would not keep the typed text (a date
    // picker rejecting the format): the next observation shows it empty.
    if (/no longer resolves/.test(message)) invalidPlan(`stale-ref ${clean(label).slice(0, 60)}`);
    // A node the page re-rendered between the snapshot and the click (an SPA re-render, a collapsed section closing)
    // throws from the protocol with the ref the caller still holds: nothing was sent, and the next observation mints
    // the refs again, so this is a stale target like the one above, not an unknown outcome.
    if (/detached from (the )?document|not attached to the (document|dom)|cannot find context with specified id|no node with given id/i.test(message)) {
      invalidPlan(`stale-ref ${clean(label).slice(0, 60)}`);
    }
    if (/the dropdown kept no choice/.test(message)) invalidPlan(`stale-choice ${clean(label).slice(0, 60)}`);
    if (/: value did not stick$/.test(message)) invalidPlan(`unheld-value ${clean(label).slice(0, 60)}`);
    // Do not expose the original error: libraries can include typed values or paths.
    throw new Stop(`action-outcome-unknown ${operation} ${clean(label)}`, 1);
  }
}
