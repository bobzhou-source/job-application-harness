// What the current screen offers: active application fields (newsletter/search forms excluded),
// results pagers, off-application links, the model-facing control view, and user-only gates that stop the run.
import * as answers from '../answers.mjs';
import * as rules from '../rules.mjs';
import { Stop } from './stop.mjs';
import { clean, fieldType, isEmpty } from './fields.mjs';

// A visible, unsolved captcha does not stop filling: the form is completed first, and the run stops for the user only
// when the final submit is next (see the final-submit click). Every other gate stops at once.
export function stopForGates(current, { submitting = false, emailCodeUrl = null } = {}) {
  const gates = current.gates.filter(gate => !(gate === 'mfa' && current.url === emailCodeUrl) && (gate !== 'captcha' || submitting));
  if (gates.length) throw new Stop(`gate ${gates.map(clean).join(' ')}`);
}

// A job-results pager ("181 - 200 of 330 jobs" with bare next/previous) pages a listing; it is no application step.
export function resultsPager(current, control) {
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
export const PLACEHOLDER_OPTION = /^\s*(|select|select one|choose|choose one|please select|please choose|please specify|[-–—]+.*[-–—]+|none selected)\s*\.{0,3}$/i;

export function activeFields(current) {
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
    && field.options.length > 0 && field.options.every(option => PLACEHOLDER_OPTION.test(String(option)));
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
  // An active form holding no fields at all (its inputs render outside the <form>: ADP's sign-in Email box beside a
  // form wrapping only Continue) owns the screen's formless fields. A formless box the site flags invalid (Workday's
  // optional "LinkedIn:" beside the Websites form) blocks the step's save, so it is the step's too.
  const fieldless = refs.size && !fields.some(field => refs.has(field.formRef));
  return refs.size ? fields.filter(field => refs.has(field.formRef) || (!field.formRef && (field.required || field.invalid || fieldless))) : fields;
}

// A control inside a newsletter/email-updates block (its "Submit"/"Sign up") subscribes the applicant; one owned by
// an application form (3+ active fields) is that form's own, even beside a "Sign up for job alerts" box. So is one in
// a block whose own choice already declines ("Join our Talent Network: No thanks, continue to apply" → Continue).
export function signupControl(current, control) {
  const declined = control.formRef && current.fields.some(field => field.formRef === control.formRef
    && ['radio', 'select'].includes(fieldType(field)) && /^(no\b|decline|not (now|interested)|skip)|continue to apply/i.test(clean(field.value)));
  return Boolean(control.signup) && !declined
    && !(control.formRef && activeFields(current).filter(field => field.formRef === control.formRef).length >= 3);
}

// Site chrome around an application: skip links, the header's own navigation (Workday's "Candidate Home", "Back to
// Job Posting", "Search for Jobs", "Job Alerts"), settings and language menus, sign-out, the footer's policy links,
// social and review-site links, and a date picker's "Calendar" trigger (dates are typed). None is ever an application
// step, yet each costs the driver one now/later/never question per screen read: on a Workday screen they were ten of
// the twenty asked, and over a day not one was picked. Delete/Back/Cancel are not chrome (entry removal, back-to-fix
// and account-escape rules allow them).
const SITE_CHROME = /^(?:skip to (?:main )?content(?: .*)?|home|candidate home|back to (?:job )?(?:posting|search|results|jobs?)|search for jobs|view all jobs|job alerts?|introduce yourself|(?:my )?settings\b.*|english(?: settings)?|sign out|log ?out|(?:[\w&.'-]+ ){0,3}privacy (?:policy|notice|statement|center)|privacy|terms(?: of (?:use|service)| and conditions| & conditions)?|accessibility(?: statement)?|cookies? (?:policy|settings|preferences|notice)|legal|site ?map|calendar)$/i;

// The screen as the models see it: unnamed controls (logo links, icons) are never clickable (`unlabeled-control`),
// so offering them only buys refused picks; so does site chrome, by label or by an off-application link target.
export function modelView(current) {
  const away = control => {
    if (!control.href) return false;
    try { return offApplication(new URL(control.href, current.url)); } catch { return false; }
  };
  return { ...current, controls: current.controls.filter(control => (answers.normalize(control.label) || control.current !== undefined)
    && (control.kind === 'option' || (!SITE_CHROME.test(clean(control.label)) && !away(control)))) };
}

// Social networks, share/intent links, and employer review/award sites are never part of an application (an
// employer's "Great Place to Work" badge leads to a share-to-X sign-in page).
const OFF_APPLICATION_HOST = /(^|\.)(x|twitter|facebook|fb|instagram|tiktok|youtube|youtu|pinterest|reddit|threads|glassdoor|greatplacetowork|comparably|fairygodboss)\.(com|net|be|org)$/i;

export function offApplication(url) {
  return OFF_APPLICATION_HOST.test(url.host) || (/(^|\.)linkedin\.com$/i.test(url.host) && !/\/jobs?\//i.test(url.pathname))
    || /\/(intent|share|sharer|sharing)(\/|\.php|$)|[?&](share|shareArticle)\b/i.test(`${url.pathname}${url.search}`);
}
