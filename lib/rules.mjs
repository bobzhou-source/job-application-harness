// Deterministic control classification used by the model-plan safety boundary.

// Handshake's external-apply dialog continues with "Step 2: External Application" (opens the employer's site);
// iCIMS career sites label theirs "Apply : <role title>".
// "I'm interested" is SmartRecruiters' apply entry on every posting it hosts.
const RE_APPLY_ENTRY = /apply now|apply for this job|apply externally|start application|^i['’]m interested$|^apply\s*[:–-]\s*\S|^(step \d+: )?external application$|apply on (the )?(company|employer)['’]?s? (site|website)/i;
const RE_BARE_APPLY = /^\s*apply\s*$/i;
const RE_STEP = /^(next|continue|save( (&|and) continue)?|save)$/i; // forward-only: NEVER Back/Previous
// Bare "confirm"/"finish" also label dialogs and self-reports, so they need an application/apply object.
const RE_FINAL_SUBMIT = /\bsubmit\b|send (my )?application|complete (my )?application|(confirm|finish) (and submit|my application|application)/i;
// Account controls, including password recovery ("Reset Password", "Send reset link", "Change Password") and the
// emailed-code confirmation ("Verify", "Verify code", "Confirm email").
const RE_LOGIN = /^(log ?(back )?in|sign ?(back )?in|register|create account|sign up|don['’]t have an account(?: yet)?\??|reset (my |your )?password|forgot (my |your )?password\??|send (password )?reset (link|email)|(set|change|update|save) (new )?password|verify( (my )?(code|e-?mail|account))?|confirm (my )?(code|e-?mail))[!.]?$/i;
// Page-level validation banners vary across ATSs; keep one predicate for both forward-step and recovery safety.
export const RE_PAGE_ISSUE = /\b(?:you have|there(?:['’]s| is| are)|\d+)\s+(?:\d+\s+)?(?:issues?|errors?|problems?)\b|\b(?:issues?|errors?)\b[^.\n]{0,40}\b(?:need|needs|must|attention|fixed|resolved|corrected|addressed)\b|\bplease\s+(?:fix|correct|review|address|complete)\b|\berrors?\s+found\b/i;
// A sign-in the site turned down for its password, as each ATS words it: Workday "You may have entered the wrong
// email address or password or your account might be locked", SuccessFactors "Invalid email address or password",
// Phenom "The username or password may be incorrect", BrassRing "Password is incorrect", Salesforce "Your login
// attempt has failed". A registration's "Passwords do not match" is not a rejected sign-in and stays out.
export const RE_PASSWORD_REJECTED = /\b(wrong|incorrect|invalid|unrecognized|not recognized)\b[^.\n]{0,60}\bpassword\b|\bpassword\b[^.\n]{0,40}\b(is |are |was |may be )?(incorrect|invalid|wrong|unrecognized|not recognized)\b|\blogin attempt has failed\b|\b(login|log-?in|sign-?in|authentication) (failed|unsuccessful|was unsuccessful)\b/i;
// A registration the site rejects because the email already has an account ("This email address is already in use.
// Please login", "An account already exists with this email"): a returning candidate.
export const RE_EXISTING_ACCOUNT = /\b(e-?mail|username|login)\b.{0,40}\balready (in use|registered|exists|taken|associated|used)\b|\balready (have|has) an account\b.{0,40}\b(this|that|the) e-?mail\b|\baccount already exists\b|\bexisting\b.{0,40}\b(record|account|profile)\b.{0,40}\b(e-?mail|address)\b/i;

// A text field may take a Keychain-generated secret when its form (the whole screen when it has no form) is an
// account-security form: it holds a password field or a security/challenge question.
export function secretForm(fields, field) {
  const peers = (fields ?? []).filter((f) => (f.formRef ?? '') === (field?.formRef ?? ''));
  return peers.some((f) => String(f.type ?? '').toLowerCase() === 'password'
    || /\b(security|secret|challenge|recovery) question\b/i.test(String(f.label ?? '')));
}

// Which applicant document a file input asks for, from its label/name and its section text: 'cover' (a cover or
// motivation letter), 'transcript', 'resume', or 'other' (writing sample, portfolio, unnamed extra attachment).
// A lone unnamed file input on a screen is the resume; one whose own label names an extra document ("Attach other
// required documents", "Writing sample", "Portfolio", "a brief research supplement") is 'other' even when alone,
// so the resume is never uploaded as the document the slot actually asks for. Among several kinds named in one
// source the first named wins: Workday's resume section ("attach your resume … you may also upload … cover letter,
// references, transcripts") lists the others as extras.
const DOCUMENT_KINDS = [
  ['cover', /cover\s*letter|letter of motivation|motivation letter/],
  ['transcript', /transcript/],
  ['resume', /\b(resume|résumé|cv)(?!\w)/],
];
const OTHER_DOCUMENT = /\bother\b.{0,30}\bdocuments?\b|\b(writing|work|code) sample|portfolio|supplement|essay|statement|proposal|summary|presentation|references?\b|recommendation|certificat|licen[cs]e|passport|identification|photo|headshot|video/;
export function documentKind(field, fileCount = 1) {
  const own = `${field?.label ?? ''} ${field?.name ?? ''}`;
  const text = `${own} ${field?.context ?? ''}`.toLowerCase();
  for (const source of [own.toLowerCase(), text]) {
    const named = DOCUMENT_KINDS.map(([kind, pattern]) => [kind, source.search(pattern)]).filter(([, at]) => at >= 0)
      .sort((a, b) => a[1] - b[1]);
    if (named.length) return named[0][0];
    if (source === own.toLowerCase() && OTHER_DOCUMENT.test(source)) return 'other';
  }
  return fileCount === 1 ? 'resume' : 'other';
}

export function classifyControl(control) {
  const label = String(control?.label ?? '').replace(/\s+/g, ' ').trim();
  if (!label) return 'other';
  // A question ("3. What happens after I submit my application?") is an FAQ heading or a prompt, never the action
  // its words name; only the account prompts RE_LOGIN spells out ("Don't have an account?") keep their class.
  if ((/\?\s*$/.test(label) || /^(\d+[.)]\s*)?(what|how|when|why|where|who|which)\b/i.test(label)) && !RE_LOGIN.test(label)) return 'other';
  const formFieldCount = Number(control?.formFieldCount ?? 0);
  // form ownership wins: any apply-like control inside a nonempty form submits that form, regardless of native type
  if (RE_APPLY_ENTRY.test(label) || RE_BARE_APPLY.test(label)) {
    return formFieldCount > 0 ? 'final-submit' : 'apply-entry';
  }
  // "Save and finish later" / "complete later" park the application; they are not a final submit.
  if (/\blater\b/i.test(label)) return 'other';
  // A form holding a password box with at most two other fields (its email or username, a consent or remember-me
  // box) is an account form — a sign-in, a registration, a password reset — and its submit-like button ("Submit",
  // "Continue", "Save password") is an account action: never the application's final submit (a reset page's "Submit"
  // would otherwise count as the application going out) nor one of its steps. An application page that also creates
  // a password carries many more fields; the form's other buttons (Cancel, Show password) keep their own class.
  const formPasswordCount = Number(control?.formPasswordCount ?? 0);
  if (formPasswordCount > 0 && formFieldCount <= formPasswordCount + 2
    && /^(submit|continue|proceed|confirm|save|update|set|done|ok|next)\b/i.test(label) && label.split(' ').length <= 4) return 'login';
  // A date picker's or carousel's "Next year (Control + right)" / "Next month" / "Next slide" pages a widget, not the form.
  if (/\b(next|previous|prev)\s+(year|month|week|day|decade|slide|image|photo|page of results)s?\b/i.test(label)) return 'other';
  // "Submit profile & continue" / "Submit and next" saves one section and moves on: a step, not the final submit.
  if (/\b(continue|next)\b/i.test(label) && !/\bapplication\b/i.test(label)) return 'step';
  if (RE_FINAL_SUBMIT.test(label)) return 'final-submit';
  if (RE_STEP.test(label)) return 'step';
  if (RE_LOGIN.test(label)) return 'login';
  return 'other';
}

