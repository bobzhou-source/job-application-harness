// Deterministic control classification used by the model-plan safety boundary.

// Handshake's external-apply dialog continues with "Step 2: External Application" (opens the employer's site);
// iCIMS career sites label theirs "Apply : <role title>".
const RE_APPLY_ENTRY = /apply now|apply for this job|apply externally|start application|^apply\s*[:–-]\s*\S|^(step \d+: )?external application$|apply on (the )?(company|employer)['’]?s? (site|website)/i;
const RE_BARE_APPLY = /^\s*apply\s*$/i;
const RE_STEP = /^(next|continue|save( (&|and) continue)?|save)$/i; // forward-only: NEVER Back/Previous
// Bare "confirm"/"finish" also label dialogs and self-reports, so they need an application/apply object.
const RE_FINAL_SUBMIT = /\bsubmit\b|send (my )?application|complete (my )?application|(confirm|finish) (and submit|my application|application)/i;
// Account controls, including password recovery ("Reset Password", "Send reset link", "Change Password") and the
// emailed-code confirmation ("Verify", "Verify code", "Confirm email").
const RE_LOGIN = /^(log ?(back )?in|sign ?(back )?in|register|create account|sign up|don['’]t have an account(?: yet)?\??|reset (my |your )?password|forgot (my |your )?password\??|send (password )?reset (link|email)|(set|change|update|save) (new )?password|verify( (my )?(code|e-?mail|account))?|confirm (my )?(code|e-?mail))[!.]?$/i;

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
// required documents", "Writing sample", "Portfolio") is 'other' even when alone.
export function documentKind(field, fileCount = 1) {
  const own = `${field?.label ?? ''} ${field?.name ?? ''}`;
  const text = `${own} ${field?.context ?? ''}`.toLowerCase();
  for (const source of [own.toLowerCase(), text]) {
    if (/cover\s*letter|letter of motivation|motivation letter/.test(source)) return 'cover';
    if (/transcript/.test(source)) return 'transcript';
    if (/\b(resume|résumé|cv)\b/.test(source)) return 'resume';
    if (source === own.toLowerCase() && /\bother\b.{0,30}\bdocuments?\b|writing sample|portfolio/.test(source)) return 'other';
  }
  return fileCount === 1 ? 'resume' : 'other';
}

export function classifyControl(control) {
  const label = String(control?.label ?? '').replace(/\s+/g, ' ').trim();
  if (!label) return 'other';
  const formFieldCount = Number(control?.formFieldCount ?? 0);
  // form ownership wins: any apply-like control inside a nonempty form submits that form, regardless of native type
  if (RE_APPLY_ENTRY.test(label) || RE_BARE_APPLY.test(label)) {
    return formFieldCount > 0 ? 'final-submit' : 'apply-entry';
  }
  // "Save and finish later" / "complete later" park the application; they are not a final submit.
  if (/\blater\b/i.test(label)) return 'other';
  // A date picker's or carousel's "Next year (Control + right)" / "Next month" / "Next slide" pages a widget, not the form.
  if (/\b(next|previous|prev)\s+(year|month|week|day|decade|slide|image|photo|page of results)s?\b/i.test(label)) return 'other';
  // "Submit profile & continue" / "Submit and next" saves one section and moves on: a step, not the final submit.
  if (/\b(continue|next)\b/i.test(label) && !/\bapplication\b/i.test(label)) return 'step';
  if (RE_FINAL_SUBMIT.test(label)) return 'final-submit';
  if (RE_STEP.test(label)) return 'step';
  if (RE_LOGIN.test(label)) return 'login';
  return 'other';
}

