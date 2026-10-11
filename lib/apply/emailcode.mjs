// Emailed-verification handling: locating code boxes, typing an emailed code, following a verification
// link, and the post-submit inbox check.

import * as browser from '../browser.mjs';
import { snapshot } from '../snapshot.mjs';
import * as act from '../act.mjs';
import * as rules from '../rules.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import * as email from '../email.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';

export function installEmailcode(ctx, shared) {
    // Labels name the code ("Verification code") or a one-character OTP box ("Please enter OTP character 1").
    function emailCodeFields(current) {
      return current.fields.filter(field => fieldType(field) !== 'password'
        && (/\b(verification|one.?time|security|confirmation|otp)\b.*\bcode\b|\bcode\b.*\bverif|\botp (character|digit)\b/i.test(`${labelOf(field)} ${field.name ?? ''}`)
          || /^(enter |the |your |\d+.digit )*pass ?code\W*(required)?$/i.test(clean(labelOf(field))) || /^pass ?code$/i.test(field.name ?? '')
          || (field.maxLength > 0 && field.maxLength <= 10 && /^(enter |the |your |\d+.digit )*code\W*(required)?$/i.test(clean(labelOf(field))))));
    }


    // A code sent to an inbox the user connected (multi-gmail) is fetched and typed by the run: the inbox is
    // polled on a fixed schedule and DeepSeek picks the code from the new mail. SMS/authenticator codes stop.
    async function enterEmailedCode(current) {
      shared.requireEmail();
      const text = current.pageText ?? '';
      // The address the code went to: named in the code boxes' own labels/messages first (Greenhouse's code row sits
      // below a posting that fills the clipped page text, which may also name a recruiter's address), else the page.
      const shown = [...current.fields.map(field => `${field.label ?? ''} ${field.message ?? ''}`), ...(current.messages ?? []), text].join('\n');
      // A code modal over a long form may be clipped out of the page text: the applicant's own address (the only one
      // the harness ever enters) is the inbox then.
      const address = [...shown.matchAll(/[\w.+*-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0])[0] ?? ctx.values.get('facts.email');
      const account = address ? await email.accountFor(address) : null;
      // A code box that still holds text while the page is gated holds a stale or mistyped code: it is replaced.
      const codeFields = emailCodeFields(current);
      // The page names the inbox the code went to (an address on screen): that inbox is read.
      // One box takes the whole code; a row of one-character boxes ("code 1" … "code 6") takes one character each.
      if (!account || !codeFields.length || (codeFields.length > 1 && codeFields.length < 4)) stopForGates(current, { emailCodeUrl: ctx.emailCodeUrl });
      ctx.phase = 'email-code';
      const pick = messages => pickCode({ site: credentials.hostFromUrl(current.url), page: text, messages });
      const poll = wait => shared.say(`EMAIL waiting ${wait / 1000}s for the code sent to ${clean(address)}`);
      // The site rejected the code in the boxes ("Invalid security code"): mail from before now is stale.
      const rejected = [...(current.messages ?? []), ...current.fields.map(field => field.message ?? '')]
        .some(message => /\b(invalid|incorrect|expired|wrong)\b.{0,30}\bcode\b|\bcode\b.{0,30}\b(invalid|incorrect|expired)\b/i.test(message));
      const submitControl = snapshot => ctx.allowSubmit ? snapshot.controls.find(control => rules.classifyControl(control) === 'final-submit') : undefined;
      // A code that has not arrived within ~1.5 min (or was rejected) is re-requested once through the page's own
      // resend control.
      let code = rejected ? null : await email.waitForCode(account, Date.now() - 10 * 60_000, pick, poll, [10_000, 30_000, 60_000]);
      const resend = !code && current.controls.find(control => /\b(resend|send (a )?new|send again)\b/i.test(control.label ?? ''));
      if (resend) {
        const requested = Date.now();
        await mutate('CLICK', labelOf(resend), () => act.click(ctx.page, resend.ref));
        shared.say(`EMAIL ${rejected ? 'code rejected' : 'no code yet'}; clicked ${clean(labelOf(resend))} for a new one`);
        code = await email.waitForCode(account, requested - 5_000, pick, poll);
      } else if (!code && !rejected) {
        // No resend control: the page still wants the code it sent when it first gated, possibly in an earlier run
        // that stopped here. The day's mail is read once for it.
        code = await email.waitForCode(account, Date.now() - 24 * 3_600_000, pick, poll, [0]);
        if (code) shared.say('EMAIL using the code sent earlier (the page offers no resend)');
      }
      // Still none (or the site rejected it), and no resend: a form that mails a code per submit (Greenhouse: "enter
      // the code, resubmit") is reloaded once under --submit; the run refills it, and its next submit mails a new code.
      if (!code && ctx.allowSubmit && !resend && (ctx.reloads.get(current.url) ?? 0) < 1) {
        ctx.reloads.set(current.url, (ctx.reloads.get(current.url) ?? 0) + 1);
        shared.say(`EMAIL ${rejected ? 'code rejected' : 'no usable code'}; reloading the form so its next submit mails a new code`);
        runlog.trace('reload', { url: current.url });
        await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await shared.pause(3000);
        ctx.emailCodeUrl = null;
        return;
      }
      if (!code) throw new Stop(`email-code-not-received ${clean(address)}`);
      const fresh = await observe(ctx.page);
      if (fresh.url !== current.url) invalidPlan('stale-screen');
      const boxes = codeFields.map(box => fresh.fields.find(candidate => candidate.ref === box.ref));
      if (boxes.some(box => !box)) invalidPlan('stale-screen');
      if (boxes.length > 1 && boxes.length !== code.length) throw new Stop(`email-code-shape ${boxes.length} boxes for a ${code.length}-character code`);
      const parts = boxes.length > 1 ? [...code] : [code];
      for (const [i, box] of boxes.entries()) {
        await mutate('FILL', labelOf(box), () => act.type(ctx.page, box.ref, parts[i], { secret: !isEmpty(box) }));
      }
      ctx.emailCodeUrl = current.url;
      // A code modal over the application form itself (three or more applicant fields besides the code boxes).
      if (!ctx.signInReturn && current.fields.filter(field => !codeFields.includes(field) && fieldType(field) !== 'hidden').length >= 3) {
        ctx.signInReturn = { url: current.url, used: 0 };
        browser.recordApplicationUrl(ctx.url, current.url);
      }
      // Signing in mid-form (Phenom asks for an account when a resume is attached) can drop the file taken before
      // it: the resume may go in again.
      for (const key of [...ctx.uploads.keys()]) if (key.startsWith(`${current.url}|`)) ctx.uploads.delete(key);
      shared.say(`EMAIL code entered into ${clean(labelOf(boxes[0]))}${boxes.length > 1 ? ` (+${boxes.length - 1} boxes)` : ''}`);
      // A code row on the application form itself (the gate appeared on submit) is sent with that same final submit:
      // under --submit the run resubmits at once, when nothing else required on the form is empty.
      const typed = await observe(ctx.page);
      const submit = submitControl(typed);
      const codeRefs = new Set(codeFields.map(field => field.ref));
      if (submit && !activeFields(typed).some(field => field.required && isEmpty(field) && !codeRefs.has(field.ref) && fieldType(field) !== 'file')) {
        await mutate('CLICK', labelOf(submit), () => act.click(ctx.page, submit.ref));
        ctx.submittedVia = labelOf(submit);
        ctx.submitFilled = new Set(activeFields(typed).filter(field => !isEmpty(field)).map(field => field.ref));
        ctx.submitUrl = typed.url;
        ctx.submitAt = Date.now();
        ctx.history.push(`typed the emailed verification code and clicked "${labelOf(submit)}"`);
        shared.say(`EMAIL code submitted with ${clean(labelOf(submit))}`);
        await shared.pause(2500);
        return;
      }
      ctx.history.push(`typed the emailed verification code into "${labelOf(boxes[0])}"; submit it with the page's verify/continue control`);
    }


    async function followEmailedVerification(current) {
      const resend = current.controls.find(control => /\bresend\b.*\b(account|email)\b.*\bverif/i.test(control.label ?? '')
        || /\bresend\b.*\bverif/i.test(control.label ?? '') && /\b(account|email)\b.{0,100}\bverif|\bverif\w*\b.{0,100}\b(account|email)\b/i.test(current.pageText ?? ''));
      if (!resend) return false;
      shared.requireEmail();
      const host = credentials.hostFromUrl(current.url);
      if (ctx.verificationRequested.has(host)) throw new Stop('needs-user-email-verification: the account still requires verification after the emailed link');
      if (current.gates.length) stopForGates(current, { submitting: true, emailCodeUrl: ctx.emailCodeUrl });
      ctx.verificationRequested.add(host);
      ctx.phase = 'email-verification-link';
      const inbox = async check => {
        try { return await check(); }
        catch { throw new Stop(`needs-user-email-verification: Gmail account ${shared.EMAIL_LABEL} is unavailable; open the account-verification email`); }
      };
      let link = await inbox(() => email.findVerificationLink(shared.EMAIL_LABEL, ctx.runStarted - 60 * 60_000, current.url));
      if (link) shared.say(`EMAIL found an existing account-verification link for ${clean(host)}; not resending`);
      else {
        // Resend sends to the address typed in the page's email box (Workday fails the resend when it is empty).
        const emailBox = activeFields(current).find(field => isEmpty(field) && fieldType(field) !== 'password'
          && (field.type === 'email' || /\be-?mail\b/i.test(labelOf(field))));
        if (emailBox && ctx.values.get('facts.email')) {
          await mutate('FILL', labelOf(emailBox), () => act.type(ctx.page, emailBox.ref, ctx.values.get('facts.email')));
        }
        if (!await shared.click(current, currentControl(current, resend.ref, { allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting }))) { ctx.verificationRequested.delete(host); return false; }
        shared.say(`EMAIL requested account verification on ${clean(host)}`);
        link = await inbox(() => email.waitForVerificationLink(shared.EMAIL_LABEL, Date.now() - 60_000, current.url,
          wait => shared.say(`EMAIL waiting ${wait / 1000}s for an account-verification link`)));
      }
      // The site may refuse to resend ("Failed to resend…", rate-limited); the newest earlier link for this host
      // (an unused sign-up email from a past run) still activates the account.
      if (!link) {
        link = await inbox(() => email.findVerificationLink(shared.EMAIL_LABEL, Date.now() - 14 * 24 * 60 * 60_000, current.url));
        if (link) shared.say(`EMAIL no fresh link; using the newest earlier account-verification link for ${clean(host)}`);
      }
      if (!link) throw new Stop('needs-user-email-verification: no fresh HTTPS account-verification link for this site was received');
      // Never log the token-bearing URL or pass it to a model.
      await mutate('VERIFY', 'emailed account link', async () => {
        try { await ctx.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
        catch { throw new Error('account verification navigation failed'); }
      });
      shared.say('EMAIL opened the account-verification link in the application tab');
      ctx.history.push('followed the fresh account-verification email; sign in with the existing stored account');
      return true;
    }


  return { emailCodeFields, enterEmailedCode, followEmailedVerification };
}
