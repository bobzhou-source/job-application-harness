// Pass step 1 (preflight): page sanity before anything is dispatched - tab adoption, load errors, off-site
// landings, posting/account state, sign-in and reset hand-offs, submission confirmation and gates.

import * as browser from '../browser.mjs';
import { snapshot } from '../snapshot.mjs';
import * as act from '../act.mjs';
import * as rules from '../rules.mjs';
import * as email from '../email.mjs';
import { coverLetter, coverLetterText, instructedDocument, tailoredResume } from '../coverletter.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getDomain } from 'tldts';
import { isConfirmed, APPLIED_TEXT, SUBMITTED_TEXT, SUBMITTED_URL } from './confirm.mjs';
import { BASE_GOAL } from './state.mjs';

export async function preflight(ctx, shared) {
      ctx.phase = 'snapshot';
      const previousPage = ctx.page;
      const newTab = await ctx.tabs.take();
      if (newTab) {
        ctx.page = newTab;
        ctx.history.push(`a new tab opened (${new URL(ctx.page.url()).host}); continuing there`);
        shared.say(`TAB ${clean(new URL(ctx.page.url()).host)}`);
      }
      // A page Chrome could not load (DNS, redirect loop, refused: chrome-error://chromewebdata) is retried once; one
      // that still fails ends the run instead of letting a model click the error page's help links. A redirect loop
      // is usually a stale cookie: the failed URL's cookies are cleared before the retry (Chrome's own remedy).
      if (/^chrome-error:/.test(ctx.page.url())) {
        const code = (await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).match(/\bERR_[A-Z_]+\b/)?.[0] ?? 'unknown error';
        if (ctx.errorReloads++ >= 1) throw new Stop(`external-site-failed-to-load (Chrome showed its error page twice: ${code})`);
        const cdp = await ctx.page.createCDPSession().catch(() => null);
        const entry = (await cdp?.send('Page.getNavigationHistory').catch(() => null))?.entries?.at(-1);
        const failed = [entry?.url, entry?.userTypedURL].find(url => /^https?:/.test(url ?? ''));
        let cleared = 0;
        if (cdp && failed && code === 'ERR_TOO_MANY_REDIRECTS') {
          // A loop often bounces between sibling hosts (careers.x.com ↔ x.com): every cookie of the registrable domain.
          const domain = getDomain(new URL(failed).hostname, { allowPrivateDomains: true }) ?? new URL(failed).hostname;
          const { cookies = [] } = await cdp.send('Network.getAllCookies').catch(() => ({}));
          for (const cookie of cookies.filter(cookie => `.${cookie.domain.replace(/^\./, '')}`.endsWith(`.${domain}`))) {
            await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path }).catch(() => undefined);
            cleared += 1;
          }
        }
        await cdp?.detach().catch(() => undefined);
        shared.say(`PAGE ${failed ? new URL(failed).host : 'page'} failed to load (${code}${cleared ? `; cleared ${cleared} cookies of its domain` : ''}); reloading once`);
        await delay(3000);
        if (/^https?:/.test(failed ?? '')) await ctx.page.goto(failed, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        else await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        return 'again';
      }
      shared.watchDialogs(ctx.page);
      if (/^https?:/.test(ctx.page.url()) && offApplication(new URL(ctx.page.url()))) {
        if (++ctx.offsite > 3) throw new Stop(`off-application-site (kept landing on ${new URL(ctx.page.url()).host})`);
        const host = new URL(ctx.page.url()).host;
        shared.say(`OFFSITE ${clean(host)} is not part of the application; going back`);
        ctx.history.push(`a click left the application for ${host} (social/review site); went back: do not click that link again`);
        if (newTab && previousPage !== newTab && !previousPage.isClosed()) {
          await newTab.close().catch(() => undefined);
          ctx.page = previousPage;
        } else {
          await ctx.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
          // A share popup has no history to go back to: start again from the posting.
          if (!/^https?:/.test(ctx.page.url()) || offApplication(new URL(ctx.page.url()))) {
            await ctx.page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
          }
        }
        await shared.pause(1500);
        return 'again';
      }
      await browser.markTab(ctx.page, ctx.url);
      ctx.current = await observe(ctx.page);
      // The job board itself refusing the applicant's account (Handshake's /deactivated "Account Blocked" after an
      // "Interaction limit hit") ends every application on it, not just this posting.
      if (new URL(ctx.page.url()).host === ctx.posting.host && (/\/(deactivated|suspended|blocked)\/?$/i.test(new URL(ctx.page.url()).pathname)
        || /\b(your )?account (is|has been) (temporarily |permanently )?(blocked|suspended|deactivated|locked)\b/i.test(String(ctx.current.pageText ?? '').slice(0, 1500)))) {
        throw new Stop(`account-blocked (opened ${new URL(ctx.page.url()).host}${new URL(ctx.page.url()).pathname}): the job board blocked the account`);
      }
      // A posting URL carrying its own id (/jobs/11392334) that opens on the same site without that id was taken down
      // and redirected (often to a search list of other jobs): stop instead of applying to whatever is listed there.
      // (A recorded tab may already be on the employer's own site, which legitimately lacks the id.)
      if (ctx.iteration === 0 && ctx.posting.id && new URL(ctx.page.url()).host === ctx.posting.host) {
        if (!ctx.page.url().includes(ctx.posting.id) && !String(ctx.current.pageText ?? '').includes(ctx.posting.id)) {
          throw new Stop(`posting-unavailable (opened ${new URL(ctx.page.url()).host}${new URL(ctx.page.url()).pathname})`);
        }
      }
      {
        // A posting the applicant already applied to, or one the site will not show or accept, ends the run here
        // instead of after a consult. (After this run's own submit, the confirmation is judged elsewhere.)
        const text = String(ctx.current.pageText ?? '');
        if (!ctx.submittedVia && /\b(applied on (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d|you(['’]ve| have) already applied|already applied (to|for) this)\b/i.test(text)) {
          throw new Stop(`already applied (page shows "${clean(text.match(/applied on [^\n]{0,24}|[^\n]{0,30}already applied[^\n]{0,20}/i)?.[0] ?? '')}")`);
        }
        const GONE = /you (don['’]t|do not) have permission to view this job|no longer accepting applications|this (job|posting|position|requisition) (is no longer available|is closed|has expired|has been filled)|(registration|applications?) (is |are )?closed for this (job|posting|position)|(the )?requested (job|position|posting) could not be found|(job|position|posting) (could not be|was not) found|the page you are looking for (doesn['’]t|does not) exist/i;
        if (GONE.test(text)) throw new Stop(`posting-unavailable (page shows "${clean(text.match(GONE)[0])}")`);
        // A site-wide outage (maintenance notice, service unavailable) with no form: the queue retries it later.
        const DOWN = /(down for|scheduled|undergoing|under|currently in) maintenance|maintenance (is )?in progress|service (interruption|(is )?(temporarily )?unavailable)|(site|service|system) is (currently |temporarily )?unavailable/i;
        if (!activeFields(ctx.current).length && (DOWN.test(text) || /maintenance/i.test(new URL(ctx.current.url).pathname))) {
          throw new Stop(`site-down (page shows "${clean(text.match(DOWN)?.[0] ?? 'a maintenance page')}")`);
        }
        // Two listings (an employer's own and a partner's re-post) can lead to one employer requisition. The first
        // employer page whose path carries an id is this run's employer posting; one already submitted from another
        // listing ends the run instead of sending a duplicate application.
        const here = new URL(ctx.current.url);
        if (!ctx.submittedVia && !ctx.runInfo.employerPosting && here.host !== ctx.posting.host && /\d{4,}/.test(here.pathname)) {
          ctx.runInfo.employerPosting = `${here.host}${here.pathname.replace(/\/+$/, '')}`;
          const rows = await readFile(new URL('../../runs/summary.jsonl', import.meta.url), 'utf8').catch(() => '');
          const prior = rows.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
            .find(row => row?.outcome === 'submitted' && row.employerPosting === ctx.runInfo.employerPosting && row.job !== ctx.url.replace(/[?#].*$/, ''));
          if (prior) throw new Stop(`already applied (the same employer posting was submitted from ${prior.job})`);
        }
      }
      // A sign-in taken over the application form (an emailed-code modal on a page of applicant fields) that lands on
      // another path (a "Welcome"/profile page) left the application unsent: go back to it (twice at most: a driver
      // that signs in again from the form lands there again). The code modal's own "Submit" was no application
      // submit. A run resuming a tab parked there by an earlier run returns the same way.
      if (ctx.iteration === 0 && !ctx.signInReturn) {
        const application = browser.applicationUrl(ctx.url);
        if (application && new URL(application).host === new URL(ctx.current.url).host) ctx.signInReturn = { url: application, used: 0 };
      }
      if (ctx.signInReturn && ctx.signInReturn.used < 2 && !ctx.current.gates.length
        && new URL(ctx.current.url).pathname !== new URL(ctx.signInReturn.url).pathname
        && !SUBMITTED_TEXT.test(String(ctx.current.pageText ?? '')) && !SUBMITTED_URL.test(ctx.current.url)) {
        ctx.signInReturn.used++;
        ctx.submittedVia = null;
        ctx.submitFilled = null;
        ctx.submitUrl = null;
        shared.say(`RETURN sign-in landed on ${clean(new URL(ctx.current.url).pathname)}; reopening the application`);
        ctx.history.push(`the sign-in redirected to ${new URL(ctx.current.url).pathname}; reopened the application form`);
        await ctx.page.goto(ctx.signInReturn.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await shared.pause(3000);
        return 'again';
      }
      // The posting this run applies to is named by the posting page's title; every goal carries it, so a listing of
      // several roles (an employer's open-roles page behind an "Apply externally" link) opens only this one. A run
      // that resumes its tab on the employer's site (a sign-in or password page) uses the title recorded when the
      // posting itself was open; with none recorded the note is left out rather than naming the wrong page.
      if (ctx.iteration === 0) {
        const onPosting = new URL(ctx.page.url()).host === new URL(ctx.url).host;
        // A single-app page names itself only by the site ("Handshake") until the posting renders; a title is the
        // posting's once it has more than two words.
        const named = title => title.split(/\s+/).filter(Boolean).length > 2;
        const readTitle = async tab => {
          let title = '';
          for (let tries = 0; tries < 10 && !named(title); tries += 1) {
            if (tries) await shared.pause(1000);
            title = clean(await tab.title().catch(() => ''));
          }
          return named(title) ? title : '';
        };
        let title = onPosting ? await readTitle(ctx.page) : clean(browser.postingTitle(ctx.url) ?? '');
        if (!named(title)) title = '';
        // Resumed on the employer's site with no title recorded: read it from the posting in a scratch tab.
        if (!onPosting && !title) {
          const scratch = await browser.backgroundPage(ctx.page.browser());
          try {
            await scratch.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            title = await readTitle(scratch);
          } finally { await scratch.close().catch(() => {}); }
          if (title) await browser.markTab(ctx.page, ctx.url, title);
        }
        if (onPosting && title) await browser.markTab(ctx.page, ctx.url, title);
        if (title) {
          ctx.targetRole = clean(title.split(/\s+\|\s+/)[0]);
          ctx.runInfo.title = clean(title).slice(0, 160);
          if (onPosting) ctx.postingText = String(ctx.current.pageText ?? '').slice(0, 4000);
          if (ctx.postingText && ctx.resumeAvailable) ctx.tailoredPending = shared.tailorResume(ctx.postingText);
          ctx.targetNote = ` The target posting is "${title.slice(0, 160)}": on any page that lists several roles, open only the role matching it (same title); if none matches, stop rather than apply to a different role.`;
          BASE_GOAL.guidance += ctx.targetNote;
          for (const goal of ctx.goals) goal.guidance += ctx.targetNote;
        }
      }
      // A final-submit click is confirmed only when a later screen states the submission and has no final-submit
      // control or required empty field left (a post-submit modal or a validation error keeps the run going).
      if (ctx.submittedVia && shared.isConfirmed(ctx.current)) {
        const evidence = String(ctx.current.pageText ?? '').match(SUBMITTED_TEXT)?.[0] ?? new URL(ctx.current.url).pathname;
        shared.say(`SUBMITTED via "${clean(ctx.submittedVia)}" (confirmed: the page states the application was received: "${clean(evidence).slice(0, 80)}")`);
        ctx.submitted = true;
        return 'done';
      }
      // A rerun that lands on the employer's own confirmation of an earlier run's submit with no form left has
      // nothing to do: it reports the standing confirmation, not a stop.
      if (!ctx.submittedVia && new URL(ctx.current.url).host !== ctx.posting.host && !activeFields(ctx.current).length && shared.isConfirmed(ctx.current)
        && APPLIED_TEXT.test(String(ctx.current.pageText ?? ''))) {
        const evidence = String(ctx.current.pageText ?? '').match(APPLIED_TEXT)?.[0] ?? '';
        shared.say(`SUBMITTED earlier (confirmed: the employer page already states the application was received: "${clean(evidence).slice(0, 80)}")`);
        ctx.submitted = true;
        return 'done';
      }
      // A submit that brings back the same form with most of its filled answers emptied and no error or confirmation
      // was silently rejected (typically an invisible captcha scoring the session as a bot). Refilling resubmits the
      // same rejected attempt, so the second such reset stops for the user.
      if (ctx.submitFilled && ctx.submitFilled.size >= 4 && ctx.current.url === ctx.submitUrl) {
        const fresh = activeFields(ctx.current);
        const emptied = [...ctx.submitFilled].filter(ref => { const field = fresh.find(f => f.ref === ref); return !field || isEmpty(field); });
        const reset = emptied.length >= ctx.submitFilled.size / 2;
        ctx.submitFilled = null;
        if (reset) {
          runlog.trace('submit-reset', { emptied: emptied.length, filled: emptied.length + fresh.length });
          if (++ctx.submitResets >= 2) throw new Stop('submit-rejected: the site cleared the form after Submit without an error or confirmation (likely an invisible captcha); submit it once by hand');
          shared.say(`SUBMIT reset the form (${emptied.length} answers cleared); refilling once`);
          // The emptied form is a fresh screen: stored answers and the resume go in again.
          const prefix = `${ctx.current.url}|`;
          for (const key of [...ctx.learnedTried]) if (key.startsWith(prefix)) ctx.learnedTried.delete(key);
          for (const key of [...ctx.uploads.keys()]) if (key.startsWith(prefix)) ctx.uploads.delete(key);
          ctx.screenConsults = 0;
        }
      }
      // A required document the harness has no file for (a transcript, writing sample) needs the user: stop with it
      // named instead of looping until the consult limit.
      {
        const files = activeFields(ctx.current).filter(field => fieldType(field) === 'file');
        // Upload widgets often mark only their question with "*" ("…transcript* Attach"), not the hidden input.
        const required = field => field.required || /\*\s*(\(required\)\s*)?(attach|upload|choose|browse|drop)\b/i.test(field.context ?? '');
        // A slot this run already uploaded to on this screen is filled even when the widget empties its input (Workday).
        const missing = files.find(field => required(field) && isEmpty(field) && !ctx.uploads.has(`${ctx.current.url}|${labelOf(field)}`)
          && !['resume', 'cover'].includes(rules.documentKind(field, files.length)));
        if (missing) throw new Stop(`needs-user-document ${rules.documentKind(missing, files.length)} "${clean(missing.context || labelOf(missing)).slice(0, 80)}"`);
      }
      // A review step whose error list says the resume is missing while every step looked complete (Workday: "Errors
      // Found — Enter at least 1 resume/CV" after the file went in through "Autofill with Resume") is fixed on the
      // step that shows the resume: the run walks Back (≤5 steps) until a resume slot or file is on screen; that file
      // is then re-attached below.
      if (ctx.resumeAvailable && ctx.resumeWalk < 5 && !ctx.current.fields.some(field => fieldType(field) === 'file')
          && !ctx.current.controls.some(control => control.attached)) {
        const resumeReported = text => /\berrors? found\b|\bpage error\b/i.test(text ?? '')
          && /\b(enter|upload|attach|add) at least (1|one) (resume|résumé|cv)\b|\b(resume|résumé)(\/cv)? is required\b/i.test(text ?? '');
        let reported = ctx.resumeWalk > 0 || resumeReported(ctx.current.pageText);
        // The error list renders a moment after the submit click, often after this pass's snapshot.
        for (let wait = 0; !reported && ctx.submitAt && Date.now() - ctx.submitAt < 15_000 && wait < 4; wait++) {
          await shared.pause(1000);
          reported = resumeReported((await observe(ctx.page)).pageText);
        }
        const back = reported && ctx.current.controls.find(control => /^back$/i.test(clean(control.label)) && !control.href);
        if (back) {
          ctx.resumeWalk++;
          ctx.resumeRejected = true;
          await mutate('CLICK', 'Back', () => act.click(ctx.page, back.ref));
          shared.say(`DOC review reports the resume missing; Back to its step (${ctx.resumeWalk})`);
          await shared.pause(1500);
          return 'again';
        }
      }
      if (ctx.resumeWalk && (ctx.current.fields.some(field => fieldType(field) === 'file') || ctx.current.controls.some(control => control.attached))) ctx.resumeWalk = 5;
      // A site that pre-attaches a stored document (Handshake attaches the profile's default resume) gets it removed
      // when it is not this run's resume, so the slot's upload/picker appears and the run's own file goes in. So does
      // a shown file the site's own slot message still calls missing ("Resume/CV is required." under the chip: the
      // page lost the upload, e.g. after a reload) or a review step reported missing, once per file per run.
      {
        const MISSING = /\b(is required|required field|can't be blank|cannot be blank|please (upload|attach)|upload failed|failed to upload)\b/i;
        const wrong = ctx.resumeAvailable && ctx.current.controls.find(control => control.attached && !ctx.removedFiles.has(control.attached)
          && /\b(resume|résumé|cv)\b/i.test(control.context ?? '') && !/cover\s*letter|transcript/i.test(control.context ?? '')
          && (control.attached !== basename(ctx.resume) || ctx.resumeRejected || MISSING.test(control.context ?? '')));
        if (wrong) {
          ctx.removedFiles.add(wrong.attached);
          await mutate('CLICK', `remove ${wrong.attached}`, () => act.click(ctx.page, wrong.ref));
          const why = wrong.attached === basename(ctx.resume) ? 'the site still reports the resume missing' : 'not this application\'s resume';
          ctx.history.push(`removed the attached "${wrong.attached}" (${why}); attach ${basename(ctx.resume)} again`);
          shared.say(`DOC removed attached ${clean(wrong.attached)} (${why}); attaching ${basename(ctx.resume)}`);
          return 'again';
        }
      }
      // A resume slot that offers the site's stored documents (a "Search your resumes" picker) gets this run's resume
      // picked from that list when a copy is already stored, instead of uploading another duplicate copy.
      {
        const stem = ctx.resumeAvailable ? basename(ctx.resume).replace(/\.[^.]+$/, '').toLowerCase() : '';
        const picker = stem && activeFields(ctx.current).find(field => field.autocomplete && isEmpty(field) && !ctx.pickerTried.has(field.ref)
          && /\b(resume|résumé|cv)s?\b/i.test(`${labelOf(field)} ${field.context ?? ''}`) && !/cover\s*letter|transcript/i.test(labelOf(field)));
        if (picker) {
          ctx.pickerTried.add(picker.ref);
          await mutate('FILL', labelOf(picker), () => act.type(ctx.page, picker.ref, stem));
          await delay(1500);
          const after = await observe(ctx.page);
          const option = after.controls.find(control => control.kind === 'option' && control.ownerRef === picker.ref
            && clean(control.label).toLowerCase().startsWith(stem));
          if (option) {
            await mutate('CLICK', option.label, () => act.click(ctx.page, option.ref));
            ctx.history.push(`picked the stored copy "${clean(option.label)}" in "${labelOf(picker)}"; the resume is attached`);
            shared.say(`DOC picked stored ${clean(option.label)}`);
          } else {
            await mutate('FILL', labelOf(picker), () => act.type(ctx.page, picker.ref, '', { secret: true }));
            shared.say(`DOC no stored copy of ${basename(ctx.resume)}; uploading it`);
          }
          return 'again';
        }
      }
      // A transcript slot with a stored-documents picker ("Search your transcripts") gets the applicant's own stored
      // transcript when the site holds exactly one: the harness has no transcript file, and the user put that one there
      // for applications. Several stored transcripts are ambiguous and are left alone.
      {
        const picker = activeFields(ctx.current).find(field => field.autocomplete && isEmpty(field) && !ctx.pickerTried.has(field.ref)
          && /\btranscripts?\b/i.test(`${labelOf(field)} ${field.context ?? ''}`) && /\bsearch your\b/i.test(labelOf(field)));
        if (picker) {
          ctx.pickerTried.add(picker.ref);
          await mutate('CLICK', labelOf(picker), () => act.click(ctx.page, picker.ref));
          await delay(1200);
          const options = (await observe(ctx.page)).controls.filter(control => control.kind === 'option' && control.ownerRef === picker.ref
            && /\.(pdf|docx?)\b|transcript/i.test(control.label ?? ''));
          if (options.length === 1) {
            await mutate('CLICK', options[0].label, () => act.click(ctx.page, options[0].ref));
            ctx.history.push(`picked the stored transcript "${clean(options[0].label)}" in "${labelOf(picker)}"`);
            shared.say(`DOC picked stored transcript ${clean(options[0].label)}`);
          } else {
            await act.press(ctx.page, 'Escape').catch(() => undefined);
            shared.say(`DOC transcript picker has ${options.length} stored transcripts; not choosing`);
          }
          return 'again';
        }
      }
      // An extra-document slot whose employer instructions say what to attach ("Include: internships, major & plans,
      // where you get news, a writing sample PDF") gets a document the writer composes for exactly those items, once
      // per slot. Without instructions an extra slot has no known content and is left to the user.
      {
        const files = ctx.current.fields.filter(field => fieldType(field) === 'file');
        const slot = activeFields(ctx.current).find(field => fieldType(field) === 'file' && isEmpty(field)
          && rules.documentKind(field, files.length) === 'other' && instructionsOf(field)
          && !ctx.uploads.has(`${ctx.current.url}|${labelOf(field)}`) && !ctx.refused.actions.has(`upload:${field.ref}`));
        if (slot) {
          const instructions = instructionsOf(slot);
          ctx.phase = 'document';
          let file;
          try {
            file = await instructedDocument({ url: ctx.runUrl, title: clean(ctx.current.title), instructions,
              pageText: `${ctx.postingText}\n${String(ctx.current.pageText ?? '')}`, applicant: await shared.writerApplicant() });
          } catch (error) {
            runlog.trace('document-error', { message: clean(error?.message).slice(0, 200) });
            ctx.refused.actions.add(`upload:${slot.ref}`);
            shared.say(`DOC could not compose the document for "${clean(labelOf(slot)).slice(0, 60)}"`);
            ctx.phase = 'driver';
            return 'again';
          }
          ctx.phase = 'driver';
          await mutate('UPLOAD', labelOf(slot), () => act.upload(ctx.page, slot.ref, file));
          (ctx.runInfo.uploaded ??= []).push(basename(file));
          ctx.uploads.set(`${ctx.current.url}|${labelOf(slot)}`, 1);
          uploadedLabels.add(answers.normalize(labelOf(slot)));
          ctx.history.push(`attached "${basename(file)}" in "${labelOf(slot)}": it answers every item the employer's instructions list`);
          shared.say(`DOC UPLOAD ${basename(file)} → ${clean(labelOf(slot)).slice(0, 60)}`);
          return 'again';
        }
      }
      // A document slot that shows an upload failure ("Whoops, something went wrong... Please try uploading again")
      // is reset with its own dismiss control so the upload can run again; each slot is retried at most twice.
      {
        const failed = ctx.current.controls.find(control => control.uploadError && (ctx.uploadRetries.get(control.context) ?? 0) < 2);
        if (failed) {
          ctx.uploadRetries.set(failed.context, (ctx.uploadRetries.get(failed.context) ?? 0) + 1);
          await mutate('CLICK', `dismiss upload error (${clean(failed.context).slice(0, 40)})`, () => act.click(ctx.page, failed.ref));
          ctx.history.push(`the upload in "${clean(failed.context).slice(0, 60)}" failed; dismissed the error, upload the document again`);
          shared.say(`DOC upload failed in ${clean(failed.context).slice(0, 50)}; retrying`);
          return 'again';
        }
      }
      // A typed code the site rejected ("Invalid security code") is replaced once with the newest mailed code (the
      // rejected submit usually mails a fresh one).
      if (ctx.current.url === ctx.emailCodeUrl && !ctx.codeRetried && (ctx.current.messages ?? []).some(message => /\b(invalid|incorrect|expired|wrong)\b.{0,30}\bcode\b|\bcode\b.{0,30}\b(invalid|incorrect|expired)\b/i.test(message))) {
        ctx.codeRetried = true;
        ctx.emailCodeUrl = null;
      }
      if (ctx.current.gates.length === 1 && ctx.current.gates[0] === 'mfa' && ctx.current.url !== ctx.emailCodeUrl) {
        await shared.enterEmailedCode(ctx.current);
        return 'again';
      }
      if (ctx.current.gates.includes('captcha-challenge') && await shared.awaitCaptcha(ctx.current)) return 'again';
      stopForGates(ctx.current, { emailCodeUrl: ctx.emailCodeUrl });
      // Once the emailed code is typed, the code boxes are form fields like any other: the models see no gate there
      // (they stop on any listed gate) and submit the form.
      if (ctx.current.url === ctx.emailCodeUrl) ctx.current.gates = ctx.current.gates.filter(gate => gate !== 'mfa');
      if (await shared.followEmailedVerification(ctx.current)) return 'again';
      ctx.resetHint = 'the site requires a password reset: click Forgot Password, fill the account email, and click the reset button once; the harness opens the emailed reset link and stores the new password';
      if (/\b(need|must|required) to (reset|change) your password\b|\bpassword (has )?expired\b/i.test(ctx.current.pageText ?? '')
        && !ctx.history.includes(ctx.resetHint)) ctx.history.push(ctx.resetHint);
      // A registration the site rejects because the email already has an account ("This email address is already in
      // use. Please login") is a returning candidate: the account's password is the one stored in Keychain.
      ctx.loginHint = 'an account with this email already exists on this site: open its login/sign-in link and sign in with the stored password (credentials login); do not register again';
      if (/\b(e-?mail|username|login)\b.{0,40}\balready (in use|registered|exists|taken|associated)\b|\balready (have|has) an account\b.{0,40}\b(this|that|the) e-?mail\b/i.test(`${ctx.current.pageText ?? ''} ${(ctx.current.messages ?? []).join(' ')}`)
        && !ctx.history.includes(ctx.loginHint)) ctx.history.push(ctx.loginHint);
      ctx.phase = 'credential-availability';
      // Ambiguous account forms only block a credentials action (which re-derives
      // identity and stops); observing/planning/clicking on such a screen is fine.
}
