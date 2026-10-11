// Deterministic steps tried before any model (rulePlan) and the DeepSeek escalation (replan).

import * as rules from '../rules.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';

export function installSteprules(ctx, shared) {
    // DeepSeek is consulted only when Jev stays stuck. Its answer is concrete actions on the current screen
    // (queued and run through the same executor checks), or a revised goal list, or a stop.
    async function replan(ctx, current, escalation, context) {
      ctx.phase = 'planner';
      let result;
      try { result = await planGoals(modelView(current), { goals: ctx.goals, completed: ctx.completed, escalation, ...context }); }
      catch (error) { runlog.trace('planner-error', { escalation, message: clean(error?.message) }); throw new Stop('planner-error', 1); }
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


    const ERROR_MESSAGE = /\b(required|invalid|error|must|please (enter|select|choose|provide|correct|complete|fix))\b/i;

    // An optional field Jev already judged unanswerable from the stored answers (learned.noAnswer) stays empty: it
    // holds back no forward step and is not asked about again.
    const skippable = field => !field.required && ctx.learned.noAnswer.includes(learnLabel(field)) && !ctx.learned.fields[learnLabel(field)];

    function rulePlan(current, screen) {
      const fields = activeFields(current);
      // One try per screen, and at most three of the same action on one page: a control whose click only changes
      // a widget (a calendar page) yields a new screen each time and must not loop the rule.
      const fresh = key => !ctx.ruleTried.has(`${screen}|${key}`) && (ctx.ruleRepeats.get(`${current.url}|${key}`) ?? 0) < 3;
      const take = (key, plan, why) => {
        ctx.ruleTried.add(`${screen}|${key}`);
        ctx.ruleRepeats.set(`${current.url}|${key}`, (ctx.ruleRepeats.get(`${current.url}|${key}`) ?? 0) + 1);
        return { plan, why };
      };
      const files = current.fields.filter(field => fieldType(field) === 'file');
      const resumeShown = current.controls.some(control => control.attached && /\b(resume|résumé|cv)\b/i.test(control.context ?? ''));
      if (ctx.resumeAvailable && !resumeShown) {
        const slot = fields.find(field => fieldType(field) === 'file' && isEmpty(field) && rules.documentKind(field, files.length) === 'resume'
          && !ctx.uploads.get(`${current.url}|${labelOf(field)}`) && !ctx.refused.actions.has(`upload:${field.ref}`));
        if (slot && fresh(`upload:${slot.ref}`)) return take(`upload:${slot.ref}`, { action: 'upload_resume', ref: slot.ref }, `resume slot "${labelOf(slot)}" is empty`);
      }
      const distinct = controls => new Set(controls.map(control => clean(control.label).toLowerCase())).size === 1;
      if (!fields.length) {
        // An entry the rule already used on this page (its dialog opened over the posting) is not clicked again: the
        // dialog's own next entry ("Step 2: External Application") is.
        const all = current.controls.filter(control => rules.classifyControl(control) === 'apply-entry');
        const entries = all.filter(control => !ctx.entriesUsed.has(`${current.url}|${clean(control.label).toLowerCase()}`));
        if (entries.length && distinct(entries) && fresh(`click:${entries[0].ref}`)) {
          ctx.entriesUsed.add(`${current.url}|${clean(entries[0].label).toLowerCase()}`);
          return take(`click:${entries[0].ref}`, { action: 'click', ref: entries[0].ref }, `the posting's only apply entry "${clean(entries[0].label)}"`);
        }
        // A fieldless screen that is not the posting (an intro, a review step) goes on to the step/submit rules below,
        // and so does a used entry's open application dialog whose only content is its submit (the resume preattached):
        // the posting's Apply button stays on the page behind it.
        const dialogSubmit = !entries.length && current.controls.some(control => control.formRef
          && rules.classifyControl(control) === 'final-submit');
        if (all.length && !dialogSubmit) return null;
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
        if (attest && fresh(`check:${ref}`)) return take(`check:${ref}`, { action: 'check', ref }, `required acknowledgement "${clean(labelOf(attest)).slice(0, 60)}"`);
      }
      const blocking = field => isEmpty(field) && (field.required || !['checkbox', 'file', 'hidden'].includes(fieldType(field))) && !skippable(field);
      // A dropdown trigger still showing its placeholder blocks when it is in a form, or (formless pages: Workday)
      // when its label marks it required ("Degree Select One Required").
      const placeholder = current.controls.some(control => control.current !== undefined
        && (control.formRef || /\brequired\b|\*/i.test(clean(control.label)))
        && (!clean(control.current) || /^(select|choose|please select|--)/i.test(clean(control.current))));
      if (fields.some(blocking) || fields.some(field => field.invalid) || placeholder
        || (current.messages ?? []).some(message => ERROR_MESSAGE.test(message))) return null;
      // Only a forward step: a bare "Save" stores a section (or a profile) without moving on.
      const steps = current.controls.filter(control => rules.classifyControl(control) === 'step' && !control.href
        && /\b(next|continue)\b/i.test(clean(control.label)) && !resultsPager(current, control));
      if (steps.length) {
        return distinct(steps) && fresh(`click:${steps[0].ref}`)
          ? take(`click:${steps[0].ref}`, { action: 'click', ref: steps[0].ref }, `every field is filled; "${clean(steps[0].label)}"`)
          : null;
      }
      // A step left unclicked holds the final submit back; a bare "Save" outside every form (Handshake's bookmark
      // button on the posting) saves no section of the application.
      if (current.controls.some(control => rules.classifyControl(control) === 'step' && !control.href
        && (control.formRef || /\b(next|continue)\b/i.test(clean(control.label))))) return null;
      // A filled account form (sign-in or registration: its password fields hold the Keychain secret) is sent with
      // its own single account button.
      if (password) {
        const own = current.controls.filter(control => rules.classifyControl(control) === 'login' && !control.href
          && (control.formRef ?? '') === (password.formRef ?? ''));
        if (own.length && distinct(own) && fresh(`click:${own[0].ref}`)) {
          return take(`click:${own[0].ref}`, { action: 'click', ref: own[0].ref }, `account form filled; "${clean(own[0].label)}"`);
        }
        return null;
      }
      const finals = ctx.allowSubmit ? current.controls.filter(control => rules.classifyControl(control) === 'final-submit'
        && !signupControl(current, control)) : [];
      if (finals.length && distinct(finals) && fresh(`click:${finals[0].ref}`)) {
        return take(`click:${finals[0].ref}`, { action: 'click', ref: finals[0].ref }, `every field is filled; final "${clean(finals[0].label)}"`);
      }
      return null;
    }

  return { replan, rulePlan, skippable };
}
