// Reads the page and dispatches single page actions: fresh snapshots, captcha waits, guarded clicks
// (with their ref re-checks), and dialog watching.

import * as browser from '../browser.mjs';
import * as act from '../act.mjs';
import * as rules from '../rules.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY, stalledRecommit } from './plan.mjs';

export function installObserver(ctx, shared) {
    async function freshSnapshot(expected) {
      const fresh = await observe(ctx.page);
      // A lone verification-code gate is handled by the main loop (emailed codes are fetched): re-observe there.
      if (fresh.gates.length === 1 && fresh.gates[0] === 'mfa' && fresh.url !== ctx.emailCodeUrl) invalidPlan('stale-screen');
      // So is an open captcha puzzle (the main loop waits for the user to solve it).
      if (fresh.gates.includes('captcha-challenge')) invalidPlan('stale-screen');
      stopForGates(fresh, { emailCodeUrl: ctx.emailCodeUrl });
      if (fresh.url !== expected.url) invalidPlan('stale-screen');
      return fresh;
    }


    // A captcha only the user can solve (an open puzzle, or the unticked box before the final submit) is waited out
    // in place: the run alerts the user, re-checks every 3 s for up to 5 minutes, and resumes on the same page. A run
    // that exits instead leaves the site's post-captcha submit (iCIMS's spinning "Next") with nobody to drive it.
    const CAPTCHA_GATES = new Set(['captcha', 'captcha-challenge']);

    async function awaitCaptcha(current) {
      if (!current.gates.length || !current.gates.every(gate => CAPTCHA_GATES.has(gate))) return false;
      // A short wait for a user at the keyboard; otherwise the run stops and its tab stays open for them.
      shared.say(`GATE ${current.gates.join(' ')}: waiting up to 60 s for the user to solve it`);
      shared.notify(`Solve the captcha on ${new URL(current.url).host}`);
      for (const end = Date.now() + 60_000; Date.now() < end;) {
        await new Promise(done => setTimeout(done, 3000));
        const next = await observe(ctx.page);
        if (!next.gates.some(gate => CAPTCHA_GATES.has(gate))) {
          // A closed puzzle is not a solve: hCaptcha can close it yet issue no token (its risk check rejected the
          // solve), leaving the site's submit spinning forever. Solved means a token arrived or the page moved on.
          if (next.url === current.url && await shared.captchaTokenEmpty()) {
            await new Promise(done => setTimeout(done, 30_000));
            if (ctx.page.url() === current.url && await shared.captchaTokenEmpty()) {
              throw new Stop('captcha-rejected: the captcha closed without issuing a token, so the site cannot continue; its tab stays open to solve again (or apply in a normal browser)');
            }
          }
          shared.say('GATE captcha solved; resuming');
          ctx.history.push('the user solved the captcha');
          // The solve posts the form; a page that comes back with its file input empty (iCIMS) needs the file again.
          for (const url of [ctx.current.url, next.url]) for (const key of [...ctx.uploads.keys()]) if (key.startsWith(`${url}|`)) ctx.uploads.delete(key);
          return true;
        }
      }
      return false;
    }

    // True when the page holds a captcha response box (hCaptcha/reCAPTCHA) and every one of them is still empty.
    async function captchaTokenEmpty() {
      const values = [];
      for (const frame of ctx.page.frames()) {
        const found = await frame.evaluate(() => [...document.querySelectorAll('textarea[name=h-captcha-response], textarea[name=g-recaptcha-response]')]
          .map(box => box.value.length)).catch(() => []);
        values.push(...found);
      }
      return values.length > 0 && values.every(length => length === 0);
    }


    // Returns false (nothing dispatched) when the target is gone or changed on a fresh read: the page re-rendered or
    // is still loading, so the caller observes again instead of stopping the run.
    async function click(current, target, fill) {
      // A tab this click opens is picked up by `tabs` at the top of the next pass.
      const fresh = await freshSnapshot(current);
      let ref;
      try {
        if (fill) {
          const resolved = resolveFill(fresh, { ref: freshRef(fresh, target), key: fill.key }, ctx.values, stalledRecommit(ctx));
          ref = resolved.optionRef;
          if (!ref) invalidPlan('stale-option');
        } else {
          const control = currentControl(fresh, target.ref, { allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
          sameTarget(target, control);
          // Remember the account email before a step navigates away; an ambiguous
          // screen simply records nothing (only credentials actions require identity).
          if (rules.classifyControl(control) !== 'apply-entry') {
            try { shared.accountIdentity(fresh); } catch (error) { if (!(error instanceof Stop)) throw error; }
          }
          ref = control.ref;
        }
      } catch (error) {
        if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
        runlog.trace('refused', { source: 'executor', action: `click:${target.ref}`, reason: `stale ${error.message}` });
        return false;
      }
      await mutate('CLICK', labelOf(target), () => act.click(ctx.page, ref));
      return true;
    }


    const watchDialogs = target => {
      if (ctx.dialogWatched.has(target)) return;
      ctx.dialogWatched.add(target);
      target.on('dialog', async dialog => {
        const text = clean(dialog.message()).slice(0, 200);
        runlog.trace('dialog', { type: dialog.type(), message: text });
        shared.say(`DIALOG ${dialog.type()} "${text}"`);
        ctx.history.push(`the site showed a ${dialog.type()} dialog: "${text}"${dialog.type() === 'confirm' ? ' (dismissed)' : ''}`);
        await (dialog.type() === 'confirm' ? dialog.dismiss() : dialog.accept()).catch(() => undefined);
      });
    };

  return { freshSnapshot, awaitCaptcha, captchaTokenEmpty, click, watchDialogs };
}
