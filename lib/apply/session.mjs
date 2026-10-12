// Run lifecycle: argument intake, Chrome session and tab ownership, the observe/drive loop, and the
// stop/catch/finally report. Driving the page itself lives in the sibling modules.

import * as browser from '../browser.mjs';
import * as act from '../act.mjs';
import * as email from '../email.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';
import { localAnswers, resumeBullets, addAliases, learnAlias, loadLearned, saveLearned } from './values.mjs';
import { RE_CREATE_ACCOUNT, USER_GATE, NEVER_WRITE, RESUME_PATH_KEY } from './runtime.mjs';
import { basename } from 'node:path';
import { isConfirmed, APPLIED_TEXT, SUBMITTED_TEXT, SUBMITTED_URL } from './confirm.mjs';

export function installSession(ctx, shared) {
  async function startRun(ctx) {
      const { url, data, submit } = await shared.options(process.argv.slice(2));
      ctx.url = url;
      ctx.runUrl = url;
      shared.say(`TRACE ${runlog.start()}`);
      ctx.allowSubmit = submit;
      ctx.posting = { host: new URL(url).host, id: new URL(url).pathname.match(/\d{5,}/)?.[0] ?? '' };
      ctx.values = localAnswers(data);
      ctx.resume = data.facts?.resume;
      if (ctx.resume) ctx.runInfo.resume = basename(ctx.resume);
      ctx.resumeAvailable = await resumeIsReadable(ctx.resume);
      if (ctx.resumeAvailable) for (const [key, bullet] of await resumeBullets(ctx.resume)) ctx.values.set(key, bullet);
      ctx.phase = 'aliases';
      await addAliases(ctx.values);
      ctx.phase = 'browser-connect';
      ctx.connection = await browser.connect();
      ctx.phase = 'open-tab';
      // A tab whose CDP session times out while attaching (Chrome busy) gets one more attempt after a pause.
      ctx.page = await browser.openTab(ctx.connection, url).catch(async error => {
        if (!/timed out/i.test(String(error?.message))) throw error;
        shared.say('TAB attach timed out; retrying once');
        await delay(5000);
        return browser.openTab(ctx.connection, url);
      });
      // Tabs opened after this point (e.g. an "Apply externally" link) become the working tab on the next pass.
      ctx.tabs = browser.watchTabs(ctx.connection);
      // A submitted application is finished: every tab it used closes, the posting tab included, so tabs do not pile
      // up and slow Chrome. A stopped run keeps the page it ended on for the next attempt; a captcha or MFA step is
      // held open for the user to finish whenever they can.
      ctx.closeRunTabs = async () => {
        await ctx.tabs.closeOthers(ctx.submitted ? null : ctx.page);
        if (ctx.submitted && !ctx.page.isClosed()) await ctx.page.close().catch(() => undefined);
        if (!ctx.submitted && USER_GATE.test(ctx.stopReason ?? '')) {
          browser.holdTab(ctx.page, url, ctx.stopReason);
          shared.notify(`Left open for you: ${clean(ctx.stopReason).slice(0, 60)} on ${new URL(ctx.page.url()).host}`);
        }
      };
      // Some employers confirm the applicant's email only after submit ("[Action Required] verify your email to move to
      // the next step"). After a confirmed submit on an employer site, the inbox is checked for ~90 s for that site's
      // single verification link; it opens in a scratch tab that closes again. The link is never logged; assessments
      // or further steps it leads to are the user's.
      ctx.postSubmitEmail = async () => {
        // Email automation is optional: with it off, any post-submit verification link is the user's to open.
        if (!shared.config.email.enabled) { shared.say('EMAIL post-submit: email automation disabled; check the inbox manually for a verification link'); return; }
        const site = ctx.submitUrl ?? ctx.page.url();
        // An earlier submission (no submit click in this run) had its own inbox window.
        if (!ctx.submitAt || /(^|\.)joinhandshake\.com$/i.test(new URL(site).hostname)) return;
        ctx.phase = 'post-submit-email';
        // Some sites (Oracle Recruiting) confirm the applicant's identity with an emailed code right after submit
        // ("so that your job application is considered"): code boxes appear on the confirmation page a beat later.
        await delay(4000);
        const after = await observe(ctx.page).catch(() => null);
        if (after && shared.emailCodeFields(after).length) {
          await shared.enterEmailedCode(after);
          const typed = await observe(ctx.page);
          const verify = typed.controls.find(control => /^(verify|confirm|continue|submit|done)\b/i.test(clean(labelOf(control))));
          if (verify) {
            await mutate('CLICK', labelOf(verify), () => act.click(ctx.page, verify.ref));
            await delay(3000);
          }
          const text = clean((await observe(ctx.page)).pageText ?? '').slice(0, 200);
          shared.say(`EMAIL post-submit: identity code entered${verify ? ` and sent with ${clean(labelOf(verify))}` : ''}: "${text}"`);
          return;
        }
        // The full ~90 s window only when the confirmation page itself asks for an email step; otherwise one look after
        // 30 s (that wait found a link on 2 of ~270 submits, and cost every other submit 90 s).
        const asks = /\b(verify|confirm|activate)\b.{0,40}\b(e-?mail|account)\b|\bcheck your (e-?mail|inbox)\b|\bverification (e-?mail|link)\b/i
          .test(clean(after?.pageText ?? ''));
        const link = await email.waitForVerificationLink(shared.EMAIL_LABEL, ctx.submitAt - 30_000, site,
          wait => shared.say(`EMAIL post-submit: waiting ${wait / 1000}s for an email-verification link`), asks ? [30_000, 30_000, 30_000] : [30_000]);
        if (!link) { shared.say('EMAIL post-submit: no email-verification link arrived'); return; }
        const scratch = await browser.backgroundPage(ctx.page.browser());
        try {
          await scratch.goto(link, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
          const text = clean(await scratch.evaluate(() => document.body?.innerText ?? '').catch(() => '')).slice(0, 200);
          shared.say(`EMAIL post-submit: opened the email-verification link on ${clean(new URL(scratch.url()).hostname)}: "${text}"`);
        } finally {
          await scratch.close().catch(() => undefined);
        }
      };

      ctx.confirmSubmitted = async () => shared.isConfirmed(await observe(ctx.page));
      ctx.learned = await loadLearned();
  }

  async function runFlow(ctx) {
    try {
      await startRun(ctx);
      for (let iteration = 0; iteration < 300; iteration++) {
        try {
          ctx.iteration = iteration;
          const signal = await shared.drivePass(ctx);
          if (signal === 'done') return;
        } catch (error) {
          // A frame detached or a context destroyed mid-read (a tab navigated or closed under us): nothing was sent;
          // re-observe, on the last open web tab if this one is gone.
          if (!(error instanceof Stop) && /detached Frame|frame was detached|Execution context was destroyed|Target closed|Session closed/i.test(String(error?.message))
            && ++ctx.redrives <= 25) {
            runlog.trace('refused', { source: 'executor', action: 'pass', reason: `transient ${clean(error.message).slice(0, 120)}` });
            await delay(1000);
            if (ctx.page.isClosed()) ctx.page = (await ctx.connection.pages()).filter(open => /^https?:/.test(open.url())).pop() ?? ctx.page;
            ctx.lastMark = null;
            continue;
          }
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')
            || error.message.startsWith('invalid-plan final-submit') || ++ctx.redrives > 25) throw error;
          runlog.trace('refused', { source: 'executor', action: 'pass', reason: error.message });
          shared.say(`REFUSED ${error.message.replace('invalid-plan ', '')}; re-driving`);
          ctx.lastMark = null;
        }
      }
      throw new Stop('iteration-limit');
    } catch (error) {
      const reason = error instanceof Stop ? error.message : ctx.phase === 'browser-connect' ? clean(error?.message) : `implementation-error ${ctx.phase}`;
      if (!(error instanceof Stop)) runlog.trace('error', { phase: ctx.phase, message: clean(error?.message), stack: clean(error?.stack).slice(0, 1500) });
      if (ctx.submittedVia && ctx.confirmSubmitted && await ctx.confirmSubmitted().catch(() => false)) {
        shared.say(`SUBMITTED via "${clean(ctx.submittedVia)}" (confirmed after ${reason}: the page states the application was received)`);
        ctx.submitted = true;
        return;
      }
      shared.say(`STOP: ${reason}`);
      ctx.stopReason = reason;
      process.exitCode = error instanceof Stop ? error.code : 1;
    } finally {
      if (ctx.submitted && ctx.postSubmitEmail) await ctx.postSubmitEmail().catch(() => shared.say('EMAIL post-submit: inbox check failed'));
      let host = null;
      try { host = new URL(ctx.runUrl).host; } catch { /* no url */ }
      runlog.summary({ host, job: ctx.runUrl ? ctx.runUrl.replace(/[?#].*$/, '').slice(0, 200) : null, ...ctx.runInfo });
      if (ctx.closeRunTabs) await ctx.closeRunTabs().catch(() => undefined);
      if (ctx.connection) {
        try { await ctx.connection.disconnect(); }
        catch {
          shared.say('STOP: implementation-error disconnect');
          process.exitCode = 1;
        }
      }
    }
  }

  return { startRun, runFlow };
}
