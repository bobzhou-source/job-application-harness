// Account/sign-in bookkeeping: the stored-answer registry entry points, account identity and credential
// status reads, and the emailed password-reset follow-up.

import * as rules from '../rules.mjs';
import * as email from '../email.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';

export function installAccounts(ctx, shared) {
    // Answer registry: a choice Jev picks for a named question (radio or dropdown) is saved to answers.json qa
    // under that question, so later applications answer it the same way; edit answers.json to correct one.
    function remember(question, answer, replace = false) {
      const key = answers.normalize(questionOf(question));
      if (!key || key.length > 300 || !answer || !isQuestionLabel(key) || (!replace && ctx.values.has(`qa.${key}`))) return;
      const stored = answers.load(ctx.answerPath);
      stored.qa = { ...stored.qa, [key]: answer };
      answers.save(ctx.answerPath, stored);
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


  return { remember, accountForms, rememberEmail, accountIdentity, isResetRequest, followEmailedReset };
}
