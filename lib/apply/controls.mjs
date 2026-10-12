// Vetting model-proposed clicks and checks before they execute (word rules, target posting, opt-outs)
// and the action wrapper that classifies execution failures. The consecutive-Back walk counter lives here.
import * as answers from '../answers.mjs';
import * as rules from '../rules.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, isEmpty, fieldType } from './fields.mjs';
import { activeFields, signupControl, resultsPager, offApplication } from './screen.mjs';

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

export function currentControl(current, ref, { moreEntries = false, allowSubmit, targetRole, posting } = {}) {
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
  if (kind !== 'final-submit' && ((!popupTrigger && !removeEntry && !dismissPopup && !dismissDialog && !backToFix && kind !== 'login' && forbidden.test(answers.normalize(control.label))) || (kind !== 'login' && forbidden.test(answers.normalize(path))))
    || control.type === 'reset' || (control.type === 'submit' && kind === 'other' && !addEntry
      && !popupTrigger && control.kind !== 'option' && Number(control.formFieldCount) > 0 && !dismissDialog && !profileSection)) invalidPlan('unsafe-control');
  return control;
}

// Consecutive "Back" clicks (see currentControl's back-to-fix rule); any other action ends the walk back.
let backWalk = 0;

export async function mutate(operation, label, action) {
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
    // a dropdown was verified to hold no choice after the pick, or a box would not keep the typed text (a date
    // picker rejecting the format): the next observation shows it empty.
    if (/no longer resolves/.test(message)) invalidPlan(`stale-ref ${clean(label).slice(0, 60)}`);
    if (/the dropdown kept no choice/.test(message)) invalidPlan(`stale-choice ${clean(label).slice(0, 60)}`);
    if (/: value did not stick$/.test(message)) invalidPlan(`unheld-value ${clean(label).slice(0, 60)}`);
    // Do not expose the original error: libraries can include typed values or paths.
    throw new Stop(`action-outcome-unknown ${operation} ${clean(label)}`, 1);
  }
}
