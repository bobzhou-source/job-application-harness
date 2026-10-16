// Account/sign-in bookkeeping: the stored-answer registry entry points, account identity and credential
// status reads, and the emailed password-reset follow-up.

import * as rules from '../rules.mjs';
import * as email from '../email.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, isTodayLabel, limitOf } from './fields.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';
import { withFileLockSync } from '../lockfile.mjs';

// Answers the writer composed on earlier runs of this host replay only here, for the same posting or title, as
// qa.<key> (the key space the template/learned mappings resolve in: LEARNED field "…" → qa.<key>); on another host
// or another role the key is absent and the writer is asked again. A user-authored qa entry of the same key wins.
// A site answer's entries: legacy entries are bare strings (composed for a posting no longer known), current ones
// { text, posting, title, t } (lib/answers.mjs schema).
export const siteAnswerEntries = stored => stored == null ? []
  : Array.isArray(stored) ? stored.map(entry => typeof entry === 'string' ? { text: entry, posting: null, title: null, t: null } : entry)
    : typeof stored === 'string' ? [{ text: stored, posting: null, title: null, t: null }] : [stored];

// The posting a URL names. postingId: the longest run of 5+ digits in the path, the last one on a tie (a slug may
// carry the location's ZIP code before the id), '' when there is none — link and page checks treat '' as unknown.
// postingOf: the id, else the path itself, so a site answer is always keyed to something.
export function postingId(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return ''; }
  const digitRuns = pathname.match(/\d{5,}/g) ?? [];
  return digitRuns.reduce((best, run) => (run.length >= best.length ? run : best), '');
}
export function postingOf(url) {
  if (postingId(url)) return postingId(url);
  try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
}

export const sameTitle = (a, b) => Boolean(a && b) && answers.normalize(a) === answers.normalize(b);

// Site answers were composed for one posting: they replay for that posting (a retry, a hand-off resumed) or for
// another posting with the same title (a repost, the same role in another city), never for a different role at the
// same employer (an "area of expertise" chosen for a toll-technology posting is wrong on a finance one). A legacy
// entry without a posting replays nowhere (`bun report.mjs --site-answers --annotate` pins those the traces know).
export function overlaySiteAnswers(values, data, host, match) {
  for (const [key, stored] of Object.entries(data?.written?.[host] ?? {})) {
    if (values.has(`qa.${key}`)) continue;
    const entry = siteAnswerEntries(stored).find(candidate => candidate.text
      && ((match.posting && candidate.posting === match.posting) || sameTitle(candidate.title, match.title)));
    if (entry) values.set(`qa.${key}`, String(entry.text));
  }
}

export function installAccounts(ctx, shared) {
    // Answer registry, global: an option pick derived from a stored answer (radio or dropdown) is saved to
    // answers.json qa under that question, so later applications answer it the same way; edit answers.json to
    // correct one. Model sources pass provenance 'model' and never land here: text composed for one posting
    // (writer answers, pickPreference picks) is posting-specific and takes rememberForSite. The text heuristic
    // (sentence-length, or naming this site's own host tokens) is the backstop for a caller that forgets to
    // declare provenance; it can only ever under-share an answer to one site, never corrupt the global registry.
    const ATS_HOST_TOKENS = new Set(['greenhouse', 'lever', 'workday', 'myworkdayjobs', 'oraclecloud', 'oracle', 'icims', 'taleo',
      'jobvite', 'ashby', 'ashbyhq', 'smartrecruiters', 'successfactors', 'sapsf', 'avature', 'eightfold', 'brassring', 'careerpuck',
      'applytojob', 'rippling', 'auth0', 'adp', 'cloud', 'jobs', 'job', 'careers', 'career', 'hire', 'apply', 'app',
      'secure', 'talent', 'recruiting', 'recruit', 'board', 'boards', 'portal', 'campus', 'www', 'com', 'net', 'org']);
    function looksSiteSpecific(answer) {
      const text = String(answer ?? '');
      if (text.length >= 80 || /\.\s+[A-Z]/.test(text)) return true;
      let host = '';
      try { host = credentials.hostFromUrl(ctx.runUrl ?? ctx.url ?? ''); } catch { return false; }
      const lower = text.toLowerCase();
      return host.split(/[.-]/).some(token => token.length >= 4 && !ATS_HOST_TOKENS.has(token) && lower.includes(token));
    }

    // Posting-specific answers: kept in answers.json under written[site][key] as { text, posting, title, t } entries
    // (answers.siteKey: the host, plus the employer segment on a multi-tenant ATS host), replayed by
    // overlaySiteAnswers for the same posting or title and composed fresh everywhere else. An entry for this
    // posting replaces the earlier one; other postings' entries stay. Re-read under the lock like remember():
    // parallel workers share answers.json.
    function rememberForSite(question, answer) {
      const key = answers.normalize(questionOf(question));
      if (!key || key.length > 300 || !answer || !isQuestionLabel(key) || isTodayLabel(key)) return;
      if (/^facts\./.test(ctx.learned?.fields?.[key] ?? '')) return;
      let host = '';
      try { host = answers.siteKey(ctx.runUrl); } catch { /* no run URL yet: fill this run, store nothing */ }
      const entry = { text: String(answer), posting: postingOf(ctx.runUrl), title: ctx.runInfo?.title ?? null, t: new Date().toISOString() };
      if (host) withFileLockSync(ctx.answerPath, () => {
        const stored = answers.load(ctx.answerPath);
        const others = siteAnswerEntries(stored.written?.[host]?.[key]).filter(candidate => candidate.posting !== entry.posting).slice(0, 11);
        stored.written = { ...(stored.written ?? {}), [host]: { ...(stored.written?.[host] ?? {}), [key]: [entry, ...others] } };
        answers.save(ctx.answerPath, stored);
      });
      ctx.values.set(`qa.${key}`, String(answer));
      shared.say(`REMEMBERED-SITE "${clean(question)}" = "${clean(answer)}" (${host || 'no host'}; posting ${entry.posting || '?'})`);
    }

    function remember(question, answer, replace = false, provenance = 'stored') {
      if (provenance === 'model' || looksSiteSpecific(answer)) return rememberForSite(question, answer);
      const key = answers.normalize(questionOf(question));
      if (!key || key.length > 300 || !answer || !isQuestionLabel(key) || isTodayLabel(key) || (!replace && ctx.values.has(`qa.${key}`))) return;
      // A field learned as a stored fact ("Zip Code" → facts.zip) takes the fact; a lookup widget's suggestion for it
      // ("91730, Rancho Cucamonga, San Bernardino, CA") is one site's rendering, not an answer for every site.
      if (/^facts\./.test(ctx.learned?.fields?.[key] ?? '')) return;
      // Re-read under the lock: parallel workers share answers.json and each must merge into the latest copy.
      withFileLockSync(ctx.answerPath, () => {
        const stored = answers.load(ctx.answerPath);
        stored.qa = { ...stored.qa, [key]: answer };
        answers.save(ctx.answerPath, stored);
      });
      ctx.values.set(`qa.${key}`, answer);
      shared.say(`REMEMBERED "${clean(question)}" = "${clean(answer)}"`);
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
        ctx.accountEmail = { page: ctx.page, host: credentials.hostFromUrl(current.url), formRef: field.formRef, value: String(value).trim() };
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
      if (ctx.accountEmail?.page === ctx.page && ctx.accountEmail.host === host && forms.has(ctx.accountEmail.formRef)) {
        return { host, username: ctx.accountEmail.value };
      }
      const email = ctx.values.get('facts.email');
      return { host, username: email?.trim() || null };
    }


    function isResetRequest(current, control) {
      // The request form's own button: "Send reset link", "Reset password", or a bare "Continue" (Auth0: "Forgot Your
      // Password? Enter your email address and we will send you instructions to reset your password.").
      return !passwordFields(current).length && /\b(reset|send)\b|^continue$/i.test(clean(control.label))
        && /\b(forgot|reset)\b[\s\S]{0,30}\bpassword\b/i.test(current.pageText ?? '');
    }

    async function followEmailedReset(current, requestedAt) {
      shared.requireEmail();
      const host = credentials.hostFromUrl(current.url);
      if (ctx.resetRequested.has(host)) throw new Stop('needs-user-email-verification: the password reset was already requested in this run');
      ctx.resetRequested.add(host);
      ctx.phase = 'email-password-reset';
      shared.say(`EMAIL requested a password reset on ${clean(host)}`);
      let link;
      try {
        link = await email.waitForVerificationLink(shared.EMAIL_LABEL, requestedAt - 15_000, current.url,
          wait => shared.say(`EMAIL waiting ${wait / 1000}s for a password-reset link`), [10_000, 30_000, 60_000], 'reset');
      } catch {
        throw new Stop(`needs-user-email-verification: Gmail account ${shared.EMAIL_LABEL} is unavailable; open the password-reset email`);
      }
      if (!link) throw new Stop('needs-user-email-verification: no fresh HTTPS password-reset link for this site was received');
      await mutate('VERIFY', 'emailed password-reset link', async () => {
        try { await ctx.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
        catch { throw new Error('password reset navigation failed'); }
      });
      ctx.resetPasswords.set(credentials.hostFromUrl(ctx.page.url()), null);
      shared.say('EMAIL opened the password-reset link in the application tab');
      ctx.history.push('opened the emailed password-reset link; fill the new password fields with credentials (the harness sets a fresh stored password), submit, then sign in');
    }


  return { remember, rememberForSite, accountForms, rememberEmail, accountIdentity, isResetRequest, followEmailedReset };
}
