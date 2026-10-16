// Deterministic steps tried before any model (rulePlan) and the DeepSeek escalation (replan).

import * as rules from '../rules.mjs';
import * as answers from '../answers.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { RE_CREATE_ACCOUNT, LINK_FIELD, linkFact } from './runtime.mjs';
import * as act from '../act.mjs';
import { mutate, factlessSection, sectionOf } from './controls.mjs';
import { reconcileWorkHistory } from './workhistory.mjs';

export function installSteprules(ctx, shared) {
    // This prepass runs in prepare, ahead of queued/learned/template plans as well as rulePlan:
    // no cached Save and Continue can bypass reconciliation of a resume import.
    async function workHistoryRule(current) {
      const manual = current.controls.find(control => /^apply manually$/i.test(clean(control.label)));
      if (manual && current.controls.some(control => /autofill with resume/i.test(control.label))) {
        const key = `${current.url}|work-history-manual`;
        if ((ctx.ruleRepeats.get(key) ?? 0) >= 2) throw new Stop('needs-user-work-history: Apply Manually did not open the application');
        ctx.ruleRepeats.set(key, (ctx.ruleRepeats.get(key) ?? 0) + 1);
        ctx.queued = [];
        await mutate('CLICK', 'Apply Manually', () => act.click(ctx.page, manual.ref));
        shared.say('WORK HISTORY chose Apply Manually instead of resume autofill');
        await shared.pause(600);
        return true;
      }
      return reconcileWorkHistory(ctx, shared, current);
    }

    // DeepSeek is consulted only when Jev stays stuck. Its answer is concrete actions on the current screen
    // (queued and run through the same executor checks), or a revised goal list, or a stop.
    async function replan(ctx, current, escalation, context) {
      ctx.phase = 'planner';
      // One failed consult (a timed-out subprocess, an unparseable plan) is retried once before it ends the run.
      let result;
      for (let attempt = 0; ; attempt++) {
        try { result = await planGoals(modelView(current), { goals: ctx.goals, completed: ctx.completed, escalation, ...context }); break; }
        catch (error) {
          runlog.trace('planner-error', { escalation, message: clean(error?.message), attempt });
          if (attempt >= 1) throw new Stop('planner-error', 1);
          shared.say(`CONSULT failed (${clean(error?.message)}); trying once more`);
          await delay(2000);
        }
      }
      runlog.trace('planner', { escalation, goals: ctx.goals, result });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Stop('planner-error', 1);
      if (typeof result.stop === 'string' && result.stop.trim()) {
        // A screen with no fields and almost no controls right after a step (a verify page between states, a
        // spinner) is usually still loading: it gets one longer wait per URL before a stop is believed.
        if (!activeFields(current).length && current.controls.length <= 4 && !ctx.blankWaits.has(current.url)) {
          ctx.blankWaits.add(current.url);
          shared.say(`WAIT the screen is nearly empty (${current.controls.length} controls); giving it 12s before stopping`);
          await delay(12000);
          return;
        }
        throw new Stop([clean(result.stop), ...(Array.isArray(result.questions) ? result.questions : []).map(clean)].filter(Boolean).join(' '));
      }
      if (Array.isArray(result.actions)) {
        ctx.queued = [];
        for (const action of result.actions) {
          const last = ctx.queued.at(-1);
          // Free-text answers are composed by the writer model when this item runs (writeFor), then filled.
          if (action.do === 'write' && last?.action === 'write') { last.refs.push(action.ref); continue; }
          if (action.do === 'write') { ctx.queued.push({ action: 'write', refs: [action.ref] }); continue; }
          const fill = action.do === 'fill' ? { ref: action.ref, key: action.key } : null;
          if (fill && last?.action === 'fill') last.fields.push(fill);
          else if (fill) ctx.queued.push({ action: 'fill', fields: [fill] });
          else if (action.do === 'credentials') ctx.queued.push({ action: 'credentials', mode: action.mode });
          else if (action.do === 'choose') ctx.queued.push({ action: 'choose', ref: action.ref, key: action.key });
          else {
            // A click keeps the label its ref had when planned: a re-rendered page reuses refs for other controls.
            const planned = current.controls.find(control => control.ref === action.ref);
            ctx.queued.push({ action: action.do, ref: action.ref, label: planned ? clean(planned.label) : undefined });
          }
        }
        ctx.queuedUrl = current.url;
        // A consult that ends in the final submit teaches nothing reusable: a submit that works ends the application,
        // and one the site rejects ("All steps complete, so submit") would steer later runs into the same loop.
        const submits = result.actions.some(action => action.do === 'click'
          && rules.classifyControl(current.controls.find(control => control.ref === action.ref) ?? {}) === 'final-submit');
        if (result.note && !submits) ctx.pendingLesson = { host: credentials.hostFromUrl(current.url), note: result.note };
        shared.say(`DEEPSEEK ${result.actions.map(a => a.do === 'fill' ? `fill ${a.ref}=${a.key}` : `${a.do} ${a.ref ?? a.mode}`).join(', ')}${result.note ? ` — ${clean(result.note)}` : ''}`);
        return;
      }
      if (!Array.isArray(result.goals) || !result.goals.length
        || result.goals.some(goal => !goal || typeof goal !== 'object' || Array.isArray(goal)
          || typeof goal.goal !== 'string' || !goal.goal.trim()
          || typeof goal.done_when !== 'string' || !goal.done_when.trim()
          || typeof goal.guidance !== 'string')) throw new Stop('planner-error', 1);
      ctx.goals = result.goals.map(goal => ({ goal: goal.goal.trim(), done_when: goal.done_when.trim(), guidance: `${goal.guidance.trim()}${ctx.targetNote}` }));
      ctx.recent.length = 0;
      shared.say(`PLAN ${ctx.goals.map(goal => clean(goal.goal)).join(' → ')}`);
    }


    // The last decline reason traced (once per screen and reason): a rule that declines silently cannot be told from
    // one that never ran, which is how the 2026-10-13 Kroll run ended with ten unnamed issues and no RULE line at all.
    let lastDecline = null;
    // The fields as the last rejected submit left them, and the submit clicks already re-sent after a rejection: the
    // final-submit branch earns exactly one re-submit per rejected submit, and only once a field changed since.
    let rejectedSubmit = null;
    const resubmitted = new Set();

    // Explicit "none" verdicts win over old learned mappings: a mapping can coexist with noAnswer even when its
    // answer cannot be used on this screen (notably a combobox). Ref verdicts belong only to this run's exact
    // screen; learned labels also cover later runs. Neither can excuse a required field.
    const skippable = (field, screen = ctx.screen) => {
      if (field.required) return false;
      const label = learnLabel(field);
      return (ctx.noAnswerScreen === screen && ctx.noAnswerRefs?.has(field.ref))
        || ctx.learned.noAnswer.includes(label)
        || (!ctx.learned.fields[label] && LINK_FIELD.test(label) && !linkFact(label, ctx.values));
    };

    // What the page shows of its fields, for telling whether anything was corrected since a rejected submit: labels
    // are stable across a re-render, and the values are compared in memory only (never traced).
    const fieldSignature = fields => JSON.stringify(fields.map(field =>
      [answers.normalize(clean(field.label ?? field.name ?? '')), field.occupied === true, Boolean(field.invalid), clean(field.value)]));

    function rulePlan(current, screen) {
      const fields = activeFields(current);
      // One try per screen, and at most three of the same action on one page while its fields stay the same: a
      // control whose click only changes a widget (a calendar page) yields a new screen each time and must not loop
      // the rule, while a step that moved on to other fields (Workday draws every step at one address) is a new page.
      const page = `${current.url}|${fields.map(field => clean(labelOf(field))).join('\u0001')}`;
      const fresh = key => !ctx.ruleTried.has(`${screen}|${key}`) && (ctx.ruleRepeats.get(`${page}|${key}`) ?? 0) < 3;
      const take = (key, plan, why) => {
        ctx.ruleTried.add(`${screen}|${key}`);
        ctx.ruleRepeats.set(`${page}|${key}`, (ctx.ruleRepeats.get(`${page}|${key}`) ?? 0) + 1);
        return { plan, why };
      };
      // A brake keys on what the action *is* — its verb, the subject's kind and label — never on its ref: a page that
      // re-renders mints new refs, and a ref-keyed brake re-arms on every pass (the 2026-10-13 DTCC 22-39 rule/step
      // oscillation). A label-less subject (a bare file input) is identified by its position among the same kind,
      // which a re-render does not move.
      const keyOf = (verb, subject, list) => {
        const kind = rules.classifyControl(subject);
        const label = answers.normalize(clean(subject.label ?? subject.name ?? ''));
        return label ? `${verb}:${kind}:${label}`
          : `${verb}:${kind}:#${list.filter(other => rules.classifyControl(other) === kind).indexOf(subject) + 1}`;
      };
      // Every decline is traced once per screen and reason, so the trace says which guard held the rule back.
      const decline = why => {
        const mark = `${screen}|${why}`;
        if (mark !== lastDecline) { lastDecline = mark; runlog.trace('rule-null', { why, url: current.url }); }
        return null;
      };
      const files = current.fields.filter(field => fieldType(field) === 'file');
      const resumeName = ctx.resumeAvailable ? String(ctx.resume ?? '').split('/').pop() : '';
      const resumeShown = current.controls.some(control => control.attached
        && (/\b(resume|résumé|cv)(?!\w)/i.test(control.context ?? '') || (resumeName && control.attached === resumeName)));
      if (ctx.resumeAvailable && !resumeShown) {
        const slot = fields.find(field => fieldType(field) === 'file' && isEmpty(field) && rules.documentKind(field, files.length) === 'resume'
          && !ctx.uploads.get(`${current.url}|${labelOf(field)}`) && !ctx.refused.actions.has(`upload:${field.ref}`));
        if (slot && fresh(keyOf('upload', slot, fields))) return take(keyOf('upload', slot, fields), { action: 'upload_resume', ref: slot.ref }, `resume slot "${labelOf(slot)}" is empty`);
      }
      // A transcript slot takes the configured transcript file (documents.transcript), as a resume slot takes the resume.
      if (ctx.transcriptAvailable) {
        const slot = fields.find(field => fieldType(field) === 'file' && isEmpty(field) && rules.documentKind(field, files.length) === 'transcript'
          && !ctx.uploads.get(`${current.url}|${labelOf(field)}`) && !ctx.refused.actions.has(`upload:${field.ref}`));
        if (slot && fresh(keyOf('upload', slot, fields))) return take(keyOf('upload', slot, fields), { action: 'upload_resume', ref: slot.ref }, `transcript slot "${labelOf(slot)}" is empty`);
      }
      const distinct = controls => new Set(controls.map(control => clean(control.label).toLowerCase())).size === 1;
      if (!fields.length) {
        // An entry the rule already used on this page (its dialog opened over the posting) is not clicked again: the
        // dialog's own next entry ("Step 2: External Application") is.
        const all = current.controls.filter(control => rules.classifyControl(control) === 'apply-entry');
        const entries = all.filter(control => !ctx.entriesUsed.has(`${current.url}|${clean(control.label).toLowerCase()}`));
        if (entries.length && distinct(entries) && fresh(keyOf('click', entries[0], current.controls))) {
          ctx.entriesUsed.add(`${current.url}|${clean(entries[0].label).toLowerCase()}`);
          return take(keyOf('click', entries[0], current.controls), { action: 'click', ref: entries[0].ref }, `the posting's only apply entry "${clean(entries[0].label)}"`);
        }
        // A fieldless screen that is not the posting (an intro, a review step) goes on to the step/submit rules below,
        // and so does a used entry's open application dialog whose only content is its submit (the resume preattached):
        // the posting's Apply button stays on the page behind it.
        const dialogSubmit = !entries.length && current.controls.some(control => control.formRef
          && rules.classifyControl(control) === 'final-submit');
        if (all.length && !dialogSubmit) return decline('apply-entry-used');
      }
      // With --submit, a required single acknowledgement box ("I certify the information is accurate", "I agree to
      // the terms") is ticked, as is an account form's terms/data-processing box (often not marked required);
      // marketing/SMS/alert opt-ins never match (the executor refuses them anyway).
      const password = fields.find(field => fieldType(field) === 'password');
      if (ctx.allowSubmit) {
        const attest = fields.find(field => fieldType(field) === 'checkbox' && isEmpty(field)
          && (field.required || (password && (field.formRef ?? '') === (password.formRef ?? '')))
          && (field.optionRefs?.length ?? 1) <= 1
          && /\b(agree|acknowledge|certify|attest|confirm|consent|i have read|i understand|accurate|true and complete)\b/i.test(labelOf(field))
          && !/\b(sms|text message|marketing|newsletter|alerts?|notifications?|promotional|offers|subscribe)\b/i.test(labelOf(field)));
        const ref = attest && (attest.optionRefs?.[0] ?? attest.ref);
        if (attest && fresh(keyOf('check', attest, fields))) return take(keyOf('check', attest, fields), { action: 'check', ref }, `required acknowledgement "${clean(labelOf(attest)).slice(0, 60)}"`);
      }
      // The account ladder, deterministic once the site has turned the stored password down (choose's accountOutcome
      // marks the host): the sign-in form's "Forgot your password?" opens the request; the request's own reset button
      // sends it once its email box is filled (the executor then follows the emailed link); the reset page's two
      // boxes take the fresh password; the sign-in form that follows takes it again, and the account button below
      // sends it. Each rung at most once per screen, like every rule.
      const host = credentials.hostFromUrl(current.url);
      const passwords = fields.filter(field => fieldType(field) === 'password');
      if (ctx.passwordRejected.has(host) && !ctx.resetRequested.has(host)) {
        if (passwords.length) {
          const forgot = current.controls.find(control => /\b(forgot|reset)\b.{0,24}\bpassword\b/i.test(clean(control.label))
            && !RE_CREATE_ACCOUNT.test(clean(control.label)));
          if (forgot && fresh(keyOf('click', forgot, current.controls))) {
            return take(keyOf('click', forgot, current.controls), { action: 'click', ref: forgot.ref }, `the stored password was rejected; "${clean(forgot.label)}"`);
          }
        } else {
          const request = current.controls.find(control => !control.href && shared.isResetRequest(current, control));
          const emailBox = request && fields.find(field => isEmailField(field) && (field.formRef ?? '') === (request.formRef ?? ''));
          if (request && emailBox && isEmpty(emailBox) && ctx.values.has('facts.email') && fresh(keyOf('fill', emailBox, fields))) {
            return take(keyOf('fill', emailBox, fields), { action: 'fill', fields: [{ ref: emailBox.ref, key: 'facts.email' }] }, `the password reset needs the account email in "${labelOf(emailBox)}"`);
          }
          if (request && emailBox && !isEmpty(emailBox) && fresh(keyOf('click', request, current.controls))) {
            return take(keyOf('click', request, current.controls), { action: 'click', ref: request.ref }, `requesting the password reset; "${clean(request.label)}"`);
          }
        }
      }
      if (ctx.resetPasswords.has(host) && passwords.length) {
        // The reset page's boxes, and the sign-in form after it (its password is the fresh one, so the executor's
        // generated-password guards do not apply): a credentials action, as Jev would choose.
        const empty = passwords.filter(isEmpty);
        const emailBox = fields.find(field => isEmailField(field) && fieldType(field) !== 'password' && (field.formRef ?? '') === (passwords[0].formRef ?? ''));
        if (empty.length && passwords.length >= 2 && fresh('credentials:reset')) {
          return take('credentials:reset', { action: 'credentials', mode: 'register' }, 'the emailed reset page takes the fresh password');
        }
        if (empty.length && passwords.length === 1 && ctx.resetPasswords.get(host) && (!emailBox || !isEmpty(emailBox)) && fresh('credentials:reset-login')) {
          return take('credentials:reset-login', { action: 'credentials', mode: 'login' }, 'signing in with the fresh password');
        }
        if (empty.length && passwords.length === 1 && ctx.resetPasswords.get(host) && emailBox && isEmpty(emailBox) && ctx.values.has('facts.email') && fresh(keyOf('fill', emailBox, fields))) {
          return take(keyOf('fill', emailBox, fields), { action: 'fill', fields: [{ ref: emailBox.ref, key: 'facts.email' }] }, `the sign-in needs the account email in "${labelOf(emailBox)}"`);
        }
      }
      // A file slot whose document the page already lists as attached (Workday keeps "Select files" empty after an
      // upload and shows the file beside a Delete button) asks for nothing more.
      const attachedKinds = new Set(current.controls.filter(control => control.attached).map(control =>
        resumeName && control.attached === resumeName ? 'resume' : rules.documentKind({ label: control.context ?? '' }, files.length)));
      const satisfied = field => fieldType(field) === 'file' && attachedKinds.has(rules.documentKind(field, files.length));
      const blocking = field => isEmpty(field) && (field.required || !['checkbox', 'file', 'hidden'].includes(fieldType(field))) && !skippable(field, screen) && !satisfied(field);
      // Optional fields hold back a forward step only until judged unanswerable; the final-submit branch below
      // keeps just the required ones blocking.
      const requiredEmpty = field => isEmpty(field) && field.required && !skippable(field) && !satisfied(field);
      // A dropdown trigger still showing its placeholder blocks when it is in a form, or (formless pages: Workday)
      // when its label marks it required ("Degree Select One Required").
      const placeholder = control => control.current !== undefined
        && (control.formRef || /\brequired\b|\*/i.test(clean(control.label)))
        && (!clean(control.current) || /^(select|choose|please select|--)/i.test(clean(control.current)));
      const placeholders = current.controls.filter(placeholder);
      const requiredPlaceholder = placeholders.filter(control => /\brequired\b|\*/i.test(clean(control.label)));
      // The page's own wording for "this application cannot be submitted yet" (the shared predicate: "You have 2
      // issues that need to be fixed", "There's 1 issue that needs your attention", "Errors found", "Please fix…").
      const pageIssue = (current.messages ?? []).some(message => rules.RE_PAGE_ISSUE.test(message));
      const pendingPlaceholders = placeholders.filter(control => requiredPlaceholder.includes(control) || !skippable(control, screen));
      const incomplete = fields.some(blocking) || fields.some(field => field.invalid) || pendingPlaceholders.length > 0 || pageIssue;
      // Only a forward step: a bare "Save" stores a section (or a profile) without moving on.
      const steps = current.controls.filter(control => rules.classifyControl(control) === 'step' && !control.href
        && /\b(next|continue)\b/i.test(clean(control.label)) && !resultsPager(current, control));
      if (steps.length) {
        if (incomplete) return decline('fields-incomplete');
        return distinct(steps) && fresh(keyOf('click', steps[0], current.controls))
          ? take(keyOf('click', steps[0], current.controls), { action: 'click', ref: steps[0].ref }, `every field is filled; "${clean(steps[0].label)}"`)
          : decline('step-taken');
      }
      // A step left unclicked holds the final submit back; a bare "Save" outside every form (Handshake's bookmark
      // button on the posting) saves no section of the application.
      if (current.controls.some(control => rules.classifyControl(control) === 'step' && !control.href
        && (control.formRef || /\b(next|continue)\b/i.test(clean(control.label))))) return decline('step-unclicked');
      if (incomplete) return decline('fields-incomplete');
      // A filled account form (sign-in or registration: its password fields hold the Keychain secret) is sent with
      // its own single account button. Not while the site has just turned that password down (the ladder above runs
      // the reset instead); a fresh password from the reset page is a new sign-in with its own brake.
      if (password) {
        if (ctx.passwordRejected.has(host)) return decline('password-rejected');
        const own = current.controls.filter(control => rules.classifyControl(control) === 'login' && !control.href
          && (control.formRef ?? '') === (password.formRef ?? ''));
        const key = own.length ? `${keyOf('click', own[0], current.controls)}${ctx.resetPasswords.get(host) ? '|reset' : ''}` : '';
        if (key && distinct(own) && fresh(key)) {
          return take(key, { action: 'click', ref: own[0].ref }, `account form filled; "${clean(own[0].label)}"`);
        }
        return decline('account-button');
      }
      const finals = ctx.allowSubmit ? current.controls.filter(control => rules.classifyControl(control) === 'final-submit'
        && !signupControl(current, control)) : [];
      if (!finals.length) return decline('no-final-submit');
      // A rejected submit leaves the site's issue banner standing while its own validation state stays stale, which
      // would freeze the final submit for the rest of the run (Kroll: ten issues it never named again). A banner on
      // the page the submit went out from, plus one field corrected since that submit, earns exactly one re-submit so
      // the site can re-validate.
      const rejected = Boolean(ctx.submitAt) && ctx.submitUrl === current.url && pageIssue;
      const signature = fieldSignature(fields);
      if (rejected && (!rejectedSubmit || rejectedSubmit.at !== ctx.submitAt)) rejectedSubmit = { at: ctx.submitAt, sig: signature };
      const resubmit = rejected && !resubmitted.has(ctx.submitAt) && rejectedSubmit.sig !== signature;
      // A required empty field, an invalid mark, a required placeholder dropdown and an uncorrected issue banner hold
      // the submit back; an optional empty field and an optional dropdown do not.
      const held = fields.some(requiredEmpty) || fields.some(field => field.invalid) || requiredPlaceholder.length > 0
        || (pageIssue && !resubmit);
      if (held) return decline(pageIssue ? 'page-issue' : 'required-empty');
      if (!distinct(finals)) return decline('final-ambiguous');
      if (resubmit) {
        resubmitted.add(ctx.submitAt);
        return take(keyOf('click', finals[0], current.controls), { action: 'click', ref: finals[0].ref }, `the page kept its issue banner after a corrected field; re-submitting "${clean(finals[0].label)}" once`);
      }
      return fresh(keyOf('click', finals[0], current.controls))
        ? take(keyOf('click', finals[0], current.controls), { action: 'click', ref: finals[0].ref }, `every field is filled; final "${clean(finals[0].label)}"`)
        : decline('final-taken');
    }

    // An entry no stored answer can fill — Workday's "Certifications 1" panel after the section's "Add" — is removed
    // rather than model-completed: its required field stays empty, so no forward step can ever commit, and a value
    // the model invents for it is a fact the applicant never stated. Only a section the stored facts say nothing
    // about (Certification, License, Award…) is touched: an Education or Languages entry holds answers the run fills
    // from, and a document slot ("Select files") reads empty again after an accepted upload while the file sits
    // beside its own Delete button. The panel is found in the live DOM by act.entryRemover (the probe execute.mjs's
    // pick-failure path uses: a group, region or fieldset holding its own Delete/Remove and no other field with a
    // value), which keeps the removal to an entry the run itself just opened. Work Experience panels belong to the
    // work-history reconciliation, and an entry whose fields the stored answers do answer (a Languages/Skills list
    // item still to enter) is never touched. One entry per call; the caller re-observes, and an entry whose removal
    // did not stick is not attempted again.
    const entryRemovals = new Map();
    const sectionReads = new Map();
    async function removeOpenEntry(current, storedFor) {
      const workEntry = /\b(job title|company|employer|role description|work experience|duties)\b/i;
      const documents = /\b(resume|cv|curriculum vitae|document|attachment|transcript|cover letter|select files?)\b/i;
      for (const field of activeFields(current)) {
        if (!field.required || storedFor(field) || workEntry.test(labelOf(field))) continue;
        const text = `${labelOf(field)} ${field.context ?? ''}`;
        if (fieldType(field) === 'file' || documents.test(text)) continue;
        // The section comes from the field's own words ("Certification", "Certification Number") or, for a bare
        // "Name" in a Certifications panel, from the live DOM the same way a section's own "Add" is read.
        const cacheKey = `${current.url}|${field.ref}`;
        if (!sectionReads.has(cacheKey)) sectionReads.set(cacheKey, await sectionOf(ctx.page, field.ref).catch(() => ''));
        if (!factlessSection(text, ctx.values) && !factlessSection(sectionReads.get(cacheKey), ctx.values)) continue;
        const mark = `${current.url}|${answers.normalize(labelOf(field))}`;
        if (entryRemovals.has(mark)) continue;
        const remover = await act.entryRemover(ctx.page, field.ref).catch(() => null);
        if (!remover || workEntry.test(remover.name) || documents.test(remover.name)) continue;
        entryRemovals.set(mark, current.url);
        await act.press(ctx.page, 'Escape').catch(() => undefined);
        await mutate('CLICK', `Delete ${remover.name}`, () => act.click(ctx.page, remover.ref));
        shared.say(`REMOVED entry "${remover.name}": "${labelOf(field)}" has no stored answer`);
        ctx.history.push(`removed the empty "${remover.name}" entry: "${labelOf(field)}" has no stored answer; do not open it again`);
        runlog.trace('rule-remove-entry', { entry: remover.name, field: labelOf(field) });
        return true;
      }
      return false;
    }

  return { replan, rulePlan, skippable, workHistoryRule, removeOpenEntry };
}
