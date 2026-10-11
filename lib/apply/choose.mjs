// Pass step 3 (choose): the deterministic rule plan first, then the model (planner/Jev) when the rules
// leave the screen stuck, and the plan validation that follows.

import * as act from '../act.mjs';
import { drive, pickOption, plan as jevPlan } from '../jev.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';
import { localAnswers, resumeBullets, addAliases, learnAlias, loadLearned, saveLearned } from './values.mjs';
import { RE_CREATE_ACCOUNT, USER_GATE, NEVER_WRITE, RESUME_PATH_KEY } from './runtime.mjs';
import { BASE_GOAL } from './state.mjs';

export async function choose(ctx, shared) {
      if (ctx.attempt) {
        if (ctx.attempt.kind === 'fill') {
          const cleared = ctx.attempt.fields.filter(item => {
            const field = ctx.current.fields.find(candidate => candidate.ref === item.ref);
            return field && isEmpty(field);
          });
          if (cleared.length) ctx.history.push(`outcome: the site cleared ${cleared.map(item => `"${item.label}"`).join(', ')} after typing`);
          const open = ctx.attempt.fields.filter(item => item.autocomplete && ctx.current.controls.some(c => c.kind === 'option' && c.ownerRef === item.ref));
          if (open.length) ctx.history.push(`outcome: suggestion list open for ${open.map(item => `"${item.label}"`).join(', ')}; pick the matching suggestion`);
        } else if (ctx.attempt.screen === ctx.screen) {
          ctx.history.push(`outcome: no visible change after clicking "${ctx.attempt.label}"`);
        }
        ctx.attempt = null;
        if (ctx.history.length > 12) ctx.history.splice(0, ctx.history.length - 12);
      }
      ctx.context = {
        // The resume's file path is executor-local (uploads read `values` directly) and is never offered to a model.
        availableKeys: [...ctx.values.keys()].filter(key => key !== RESUME_PATH_KEY),
        answerValues: Object.fromEntries([...ctx.values].filter(([key]) => key !== RESUME_PATH_KEY)),
        history: [...ctx.history],
        openedBy: ctx.openedBy,
        typed: { ...ctx.typed },
        resumeAvailable: ctx.resumeAvailable,
        credential: { host: ctx.identity.host, status: ctx.accountStatus },
      };
      if (ctx.refused.screen !== ctx.screen) ctx.refused = { screen: ctx.screen, actions: new Set() };
      ctx.phase = 'driver';
      ctx.outcome = undefined;;
      // Plan source, cheapest first: DeepSeek's queued actions for this screen, then fields past runs learned
      // the answer for, then Jev. Lessons from past consults on this host ride along in Jev's guidance.
      const lessons = ctx.learned.lessons.filter(lesson => lesson.host === ctx.host).slice(-6).map(lesson => lesson.note);
      const goal = lessons.length ? { ...ctx.goals[0], guidance: `${ctx.goals[0].guidance} Lessons from earlier applications on this site: ${lessons.join(' ')}` } : ctx.goals[0];
      ctx.source = 'jev';
      // A queued action whose ref is gone means the screen moved on (a list closed, a section advanced): the rest of
      // DeepSeek's queue was planned for a screen that no longer exists, so drop it and let Jev read the new one.
      if (ctx.queued.length) {
        const live = new Set([...ctx.current.controls.map(control => control.ref), ...ctx.current.fields.flatMap(field => [field.ref, ...(field.optionRefs ?? [])])]);
        const item = ctx.queued[0];
        const refs = [item.ref, ...(item.refs ?? []), ...(item.fields ?? []).map(field => field.ref)].filter(Boolean);
        const relabeled = item.label !== undefined && clean(ctx.current.controls.find(control => control.ref === item.ref)?.label ?? '') !== item.label;
        if (refs.some(ref => !live.has(ref)) || relabeled) {
          shared.say(`DEEPSEEK queue dropped (${ctx.queued.length} actions): screen changed`);
          ctx.queued = [];
        }
      }
      if (ctx.queued.length) {
        const { label: _planned, ...plan } = ctx.queued.shift();
        ctx.outcome = { plan, confidence: 1 };
        ctx.source = 'deepseek';
        if (ctx.outcome.plan.action === 'write') {
          const fields = await shared.writeFor(ctx.current, ctx.outcome.plan.refs);
          // Identity/credential boxes (username, codes, signatures) are never composed: say so, or the planner re-plans
          // the same write forever.
          if (!fields.length) {
            shared.say(`REFUSED write ${ctx.outcome.plan.refs.join(',')} (identity/credential box); re-driving`);
            ctx.history.push(`refused write ${ctx.outcome.plan.refs.join(',')}: usernames, codes and signatures are never composed; fill them from a stored answer, or the applicant must choose one`);
            ctx.queued = [];
            return 'again';
          }
          ctx.outcome.plan = { action: 'fill', fields };
        }
      } else {
        // Learned answers fill plain fields only once per field per run; autocomplete search boxes stay Jev's. A box
        // the site prefilled (account profile, resume parse: the preferred name in "Legal First Name") that contradicts
        // the stored fact its label maps to is retyped with the fact, the same once-per-run.
        const prefilledWrong = field => {
          const key = ctx.learned.fields[learnLabel(field)];
          const fact = /^facts\./.test(key ?? '') && typeof ctx.values.get(key) === 'string' ? answers.normalize(ctx.values.get(key)) : '';
          return Boolean(fact) && !answers.normalize(field.value).includes(fact);
        };
        const known = activeFields(ctx.current).filter(field => (isEmpty(field) || (!isChoiceField(field) && prefilledWrong(field)))
          && !field.autocomplete && !ctx.learnedTried.has(`${ctx.current.url}|${field.ref}`)
          && !(labelOf(field) in ctx.filledKeys)
          && !['password', 'file', 'radio', 'checkbox'].includes(fieldType(field)) && ctx.values.has(ctx.learned.fields[learnLabel(field)]));
        // Questions the qa registry already answers: empty radio groups (when an option states the answer) and native
        // selects are filled straight from it, with no model call.
        const registryKey = field => `qa.${answers.normalize(labelOf(field))}`;
        // A required native select that offers exactly one real option (the only region, the only program year)
        // has no decision in it: that option is its answer for this run.
        for (const field of activeFields(ctx.current)) {
          const real = (field.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option)));
          if (field.tag === 'select' && field.required && isEmpty(field) && real.length === 1 && !ctx.values.has(registryKey(field))) {
            ctx.values.set(registryKey(field), String(real[0]));
          }
        }
        const answered = activeFields(ctx.current).filter(field => isEmpty(field) && !ctx.learnedTried.has(`${ctx.current.url}|${field.ref}`)
          && !known.includes(field) && ctx.values.has(registryKey(field))
          && (fieldType(field) === 'select' || (!field.autocomplete && !['radio', 'checkbox', 'file', 'password', 'hidden'].includes(fieldType(field)))
            || (fieldType(field) === 'radio' && (field.options ?? []).some(option => answers.normalize(option) === answers.normalize(ctx.values.get(registryKey(field)))))));
        // A custom dropdown still on its placeholder whose question the registry (or a fact learned for the same
        // question) already answers: choose that answer.
        const dropdownKey = control => {
          const qa = `qa.${answers.normalize(questionOf(control.label))}`;
          if (ctx.values.has(qa)) return qa;
          const fact = ctx.learned.fields[answers.normalize(questionOf(control.label))];
          return fact && ctx.values.has(fact) ? fact : null;
        };
        const unset = ctx.current.controls.find(control => control.current !== undefined && control.formRef
          && (!clean(control.current) || /^(select|choose|please select|--)/i.test(clean(control.current)))
          && dropdownKey(control) && !ctx.learnedTried.has(`${ctx.current.url}|${control.ref}`));
        // A "check all that apply" group whose stored answer (qa for its question, or the fact learned for its label)
        // names more options than are ticked: tick the next named option. Option text is matched as whole words with
        // any parenthetical code dropped ("Spanish (SPA)" ⊂ "English, Spanish").
        const named = (option, value) => {
          const text = answers.normalize(String(option).replace(/\([^)]*\)/g, ' '));
          return Boolean(text) && ` ${answers.normalize(value)} `.includes(` ${text} `);
        };
        const tick = activeFields(ctx.current).filter(field => fieldType(field) === 'checkbox' && (field.optionRefs?.length ?? 0) > 1)
          .flatMap(field => {
            const value = ctx.values.get(registryKey(field)) ?? ctx.values.get(ctx.learned.fields[learnLabel(field)]);
            if (typeof value !== 'string' || !value) return [];
            return field.optionRefs.filter((ref, index) => ref && !field.checkedRefs?.includes(ref)
              && !ctx.learnedTried.has(`${ctx.current.url}|${ref}`) && named(field.options?.[index] ?? '', value));
          })[0];
        const batch = [
          ...known.map(field => ({ ref: field.ref, key: ctx.learned.fields[learnLabel(field)] })),
          ...answered.map(field => ({ ref: field.ref, key: registryKey(field) })),
        ].slice(0, 8);
        if (batch.length) {
          for (const item of batch) ctx.learnedTried.add(`${ctx.current.url}|${item.ref}`);
          ctx.outcome = { plan: { action: 'fill', fields: batch }, confidence: 1 };
          ctx.source = known.length ? 'learned' : 'registry';
        } else if (unset) {
          ctx.learnedTried.add(`${ctx.current.url}|${unset.ref}`);
          ctx.outcome = { plan: { action: 'choose', ref: unset.ref, key: dropdownKey(unset) }, confidence: 1 };
          ctx.source = 'registry';
        } else if (tick) {
          ctx.learnedTried.add(`${ctx.current.url}|${tick}`);
          ctx.outcome = { plan: { action: 'check', ref: tick }, confidence: 1 };
          ctx.source = 'registry';
        } else {
          // Empty free-text questions, required or optional (an essay box, or a text field whose label asks a
          // question), go to the writer up front: optional questions help an application and Jev never writes text.
          const asks = field => fieldType(field) === 'textarea'
            || /\?|^(tell|describe|explain|why|what|how|which|please (tell|describe|explain|share|list|provide))\b/i.test(labelOf(field));
          const questions = activeFields(ctx.current).filter(field => isEmpty(field) && !field.autocomplete && asks(field)
            && !['radio', 'checkbox', 'file', 'password', 'select', 'hidden'].includes(fieldType(field))
            && !ctx.writeTried.has(`${ctx.current.url}|${labelOf(field)}`));
          if (questions.length) {
            for (const field of questions) ctx.writeTried.add(`${ctx.current.url}|${labelOf(field)}`);
            const fields = await shared.writeFor(ctx.current, questions.map(field => field.ref));
            if (fields.length) {
              ctx.queued = [{ action: 'fill', fields: fields.slice(0, 8) }];
              ctx.queuedUrl = ctx.current.url;
              return 'again';
            }
          }
          const rule = shared.rulePlan(ctx.current, ctx.screen);
          if (rule) {
            ctx.outcome = { plan: rule.plan, confidence: 1 };
            ctx.source = 'rule';
            shared.say(`RULE ${clean(rule.why)}`);
          }
        }
      }
      for (let redrives = 0; ctx.source === 'jev';) {
        // A step Jev already took on this exact screen through its ranking (no leading verdict) is not offered again
        // when the screen comes back: weak picks alternating between two screens otherwise loop without a stall.
        const exclude = new Set([...ctx.refused.actions, ...(ctx.plannedTaken.get(ctx.screen) ?? [])]);
        const skipFields = new Set(activeFields(ctx.current).filter(field => isEmpty(field) && shared.skippable(field)).map(field => field.ref));
        try { ctx.outcome = await drive(modelView(ctx.current), { goal, ...ctx.context, exclude, skipFields }); }
        catch (error) {
          runlog.trace('error', { phase: 'drive', message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) });
          throw new Stop('driver-error', 1);
        }
        runlog.trace('jev', { goal, plan: ctx.outcome?.plan ?? null, confidence: ctx.outcome?.confidence ?? 0, ...ctx.outcome?.trace });
        // Optional fields Jev judged no stored answer fits are remembered by label for the forward rule.
        const unanswerable = activeFields(ctx.current).filter(field => !field.required && isEmpty(field)
          && ctx.outcome?.trace?.fieldAnswers?.[field.ref] === 'none' && learnLabel(field) && !ctx.learned.noAnswer.includes(learnLabel(field)));
        if (unanswerable.length) {
          ctx.learned.noAnswer = [...ctx.learned.noAnswer, ...new Set(unanswerable.map(learnLabel))].slice(-500);
          await saveLearned(ctx.learned);
        }
        if (Number(ctx.outcome?.goalDone ?? 0) < 0.7 || ctx.goals[0].goal === BASE_GOAL.goal) break;
        ctx.completed.push(ctx.goals.shift());
        ctx.recent.length = 0;
        if (!ctx.goals.length) ctx.goals = [{ ...BASE_GOAL }];
        if (++redrives > 8) { ctx.outcome = { plan: null, confidence: 0 }; break; }
      }
      // DeepSeek's note becomes a lesson for this host only when its actions unstuck Jev: once the queue is
      // done, Jev's very next decision has a plan of its own. Otherwise the note is dropped.
      if (ctx.source === 'jev' && ctx.pendingLesson?.armed && !ctx.queued.length) {
        const { host: lessonHost, note } = ctx.pendingLesson;
        ctx.pendingLesson = null;
        if (ctx.outcome?.plan && !ctx.learned.lessons.some(lesson => lesson.host === lessonHost && lesson.note === note)) {
          ctx.learned.lessons = [...ctx.learned.lessons, { host: lessonHost, note }].slice(-60);
          await saveLearned(ctx.learned);
          shared.say(`LEARNED lesson for ${clean(lessonHost)}: ${clean(note)}`);
        }
      }
      if (ctx.source !== 'jev') {
        runlog.trace('plan', { source: ctx.source, plan: ctx.outcome.plan });
        shared.say(`${ctx.source.toUpperCase()} ${ctx.outcome.plan.action}`);
      }
      // Jev judges whether an unconfirmed registration now exists; code records it in Keychain.
      if (ctx.accountStatus === 'pending' && Number(ctx.outcome?.accountCreated ?? 0) >= 0.8) {
        await credentials.markCreated(ctx.identity.host, ctx.identity.username);
        ctx.context.credential.status = 'created';
        shared.say(`ACCOUNT created ${clean(ctx.identity.host)}`);
      }
      ctx.confidence = Number(ctx.outcome?.confidence ?? 0);
      // Step chosen by Jev's "which ONE action" ranking rather than a leading verdict: noted so runs can measure it.
      if (ctx.source === 'jev' && ctx.outcome?.planned) {
        shared.say(`JEV PLANNED ${shared.actionKeyOf(ctx.outcome.plan) ?? ctx.outcome.plan?.action} p=${ctx.confidence.toFixed(2)}`);
        const taken = ctx.plannedTaken.get(ctx.screen) ?? new Set();
        taken.add(shared.actionKeyOf(ctx.outcome.plan));
        ctx.plannedTaken.set(ctx.screen, taken);
      }
      // Stalls measure Jev repeating the same action on an unchanged screen; executing a queued/learned plan, or Jev
      // moving on to a different action, is not a stall.
      const mark = `${ctx.goals[0].goal}\u0000${screenFingerprint(ctx.current)}\u0000${JSON.stringify(ctx.outcome?.plan ?? null)}`;
      ctx.stalls = ctx.source !== 'jev' ? 0 : mark === ctx.lastMark ? ctx.stalls + 1 : 0;
      ctx.lastMark = ctx.source === 'jev' ? mark : null;
      // Alternating steps (open list A, open list B, A, B…) never repeat back to back, so they also count as a stall
      // once the same step comes up a third time on the same screen.
      const repeatKey = ctx.source === 'jev' && ctx.outcome?.plan ? `${ctx.screen}\u0000${shared.actionKeyOf(ctx.outcome.plan) ?? ctx.outcome.plan.action}` : null;
      const repeats = repeatKey ? (ctx.screenRepeats.get(repeatKey) ?? 0) + 1 : 0;
      if (repeatKey) ctx.screenRepeats.set(repeatKey, repeats);
      let reason = null;
      if (!ctx.outcome?.plan) reason = 'no plan';
      else if (ctx.stalls >= 2 || repeats >= 3) reason = 'goal not progressing';
      // A Jev step repeated on an unchanged screen: Jev re-plans without that step (and any other it already chose
      // there), at most twice per screen, before DeepSeek is consulted.
      if (reason === 'goal not progressing' && ctx.source === 'jev' && ctx.outcome?.trace?.steps?.length) {
        if (ctx.jevPlanScreen !== ctx.screen) { ctx.jevPlanScreen = ctx.screen; ctx.jevPlanTried = new Set(); ctx.jevPlans = 0; }
        if (ctx.outcome.plan && (ctx.stalls >= 2 || repeats >= 3)) ctx.jevPlanTried.add(shared.actionKeyOf(ctx.outcome.plan));
        if (ctx.jevPlans < 2) {
          ctx.jevPlans += 1;
          const planned = await jevPlan(modelView(ctx.current), { goal: ctx.goals[0], ...ctx.context, exclude: ctx.refused.actions }, ctx.outcome, ctx.jevPlanTried);
          if (planned.plan) {
            ctx.jevPlanTried.add(planned.choice);
            shared.say(`JEV PLAN ${planned.choice} p=${planned.confidence.toFixed(2)} (${clean(reason)})`);
            runlog.trace('jev-plan', { reason, choice: planned.choice, confidence: planned.confidence });
            ctx.outcome = { ...ctx.outcome, plan: planned.plan, confidence: planned.confidence };
            reason = null;
            ctx.stalls = 0;
            ctx.lastMark = null;
          } else ctx.jevPlans = 2;
        }
      }
      if (reason) {
        // An empty required combobox with no stored answer has hidden choices: open it once so Jev can
        // match a listed choice to the stored facts instead of the planner guessing it is free text.
        const closed = activeFields(ctx.current).find(field => field.required && field.autocomplete && isEmpty(field)
          && !ctx.opened.has(field.ref) && !shared.choicesFor(ctx.current, field.ref).length);
        if (closed) {
          ctx.opened.add(closed.ref);
          await mutate('OPEN', labelOf(closed), () => act.openList(ctx.page, closed.ref));
          await shared.pause(700);
          const shown = shared.choicesFor(await shared.freshSnapshot(ctx.current), closed.ref);
          ctx.history.push(shown.length
            ? `opened "${labelOf(closed)}": a fixed choice list (${shown.map(c => `"${clean(c.label)}"`).slice(0, 12).join(', ')}); pick the choice matching a stored fact`
            : `opened "${labelOf(closed)}": no choices appeared`);
          shared.say(`OPEN ${clean(labelOf(closed))} (${shown.length} choices)`);
          ctx.lastMark = null;
          return 'again';
        }
        // Jev never writes text: free-text fields no stored answer fits (empty, or longer than the site's limit) go
        // straight to the writer model, once per question per run, with no consult.
        const fieldAnswers = ctx.outcome?.trace?.fieldAnswers ?? {};
        const gaps = activeFields(ctx.current).filter(field => !field.autocomplete && !ctx.writeTried.has(`${ctx.current.url}|${labelOf(field)}`)
          && !['radio', 'checkbox', 'file', 'password', 'select'].includes(fieldType(field))
          && ((field.required && isEmpty(field) && fieldAnswers[field.ref] === 'none')
            || (!isEmpty(field) && (field.valueLength ?? String(field.value ?? '').length) > limitOf(field))));
        if (gaps.length) {
          for (const field of gaps) ctx.writeTried.add(`${ctx.current.url}|${labelOf(field)}`);
          const fields = await shared.writeFor(ctx.current, gaps.map(field => field.ref));
          if (fields.length) {
            ctx.queued = [{ action: 'fill', fields }];
            ctx.queuedUrl = ctx.current.url;
            return 'again';
          }
        }
        // Second look: re-snapshot and re-ask once per screen before paying for a consult.
        if (ctx.lookedAgain !== ctx.screen) {
          ctx.lookedAgain = ctx.screen;
          await shared.pause(800);
          return 'again';
        }
        if (ctx.consultScreen !== ctx.screen) { ctx.consultScreen = ctx.screen; ctx.screenConsults = 0; }
        ctx.screenConsults += 1;
        ctx.consults += 1;
        if (ctx.screenConsults > 2 || ctx.consults > 6) throw new Stop('consult-limit');
        shared.say(`CONSULT ${clean(reason)} goal="${clean(ctx.goals[0].goal)}"`);
        await shared.replan(ctx, ctx.current, { goal: ctx.goals[0], reason, recent: [...ctx.recent] }, ctx.context);
        ctx.stalls = 0;
        ctx.lastMark = null;
        return 'again';
      }
      ctx.plan = ctx.outcome.plan;
      validatePlan(ctx.plan, ctx.values);
      ctx.phase = 'action';
      // Pre-dispatch executor checks: a refusal (nothing was sent to the page) excludes that action on this
      // screen and Jev picks again. Reaching final submit is the run's end, so it stays terminal.
      const actionKey = ctx.plan.action === 'click' ? `click:${ctx.plan.ref}` : ctx.plan.action === 'check' ? `check:${ctx.plan.ref}`
        : ctx.plan.action === 'upload_resume' ? `upload:${ctx.plan.ref}` : ctx.plan.action === 'fill' ? 'fill'
        : ctx.plan.action === 'choose' ? `choose:${ctx.plan.ref}`
        : ctx.plan.action === 'credentials' ? `credentials:${ctx.plan.mode}` : null;
      if (actionKey) {
        try {
          if (ctx.plan.action === 'click' || ctx.plan.action === 'choose') {
            if (!(ctx.plan.action === 'click' && isChoiceField(activeFields(ctx.current).find(field => field.ref === ctx.plan.ref)))) currentControl(ctx.current, ctx.plan.ref, { moreEntries: shared.moreEntries(ctx.current), allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
          }
          else if (ctx.plan.action === 'check') checkTarget(ctx.current, ctx.plan.ref, ctx.allowSubmit);
          else if (ctx.plan.action === 'upload_resume') {
            // Some sites clear the file input after taking the file, so it reads empty again; a field label gets at
            // most two uploads per page, then the upload counts as done and Jev must move on.
            const { field } = documentField(ctx.current, ctx.plan.ref, ctx.resumeAvailable);
            if ((ctx.uploads.get(`${ctx.current.url}|${labelOf(field)}`) ?? 0) >= 2) invalidPlan('already-uploaded');
          }
          else if (ctx.plan.action === 'credentials') { if (!passwordFields(ctx.current).length) invalidPlan('password-fields'); }
          else {
            // A fill batch keeps its valid items; one occupied or unmatched field does not void the rest.
            const kept = ctx.plan.fields.filter(item => {
              try { resolveFill(ctx.current, item, ctx.values); return true; }
              catch (error) {
                if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
                runlog.trace('refused', { source: ctx.source, action: `fill:${item.ref}`, reason: error.message });
                return false;
              }
            });
            if (!kept.length) resolveFill(ctx.current, ctx.plan.fields[0], ctx.values);
            ctx.plan.fields = kept;
          }
        } catch (error) {
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ') || error.message.startsWith('invalid-plan final-submit')) throw error;
          runlog.trace('refused', { source: ctx.source, action: actionKey, reason: error.message });
          shared.say(`REFUSED ${ctx.source === 'jev' ? '' : `${ctx.source} `}${clean(actionKey)} (${error.message.replace('invalid-plan ', '')}); re-driving`);
          // The planners see the refusal, so a consult does not re-propose it ("upload the resume" six times).
          const note = `refused ${clean(actionKey)} (${error.message.replace('invalid-plan ', '')}): do not plan it again; act on another control`;
          if (!ctx.history.includes(note)) ctx.history.push(note);
          // A refused DeepSeek/learned action is dropped without excluding Jev's own choices on this screen.
          if (ctx.source === 'jev') ctx.refused.actions.add(actionKey);
          // A refused DeepSeek action is skipped; the rest of its queue still runs.
          ctx.lastMark = null;
          return 'again';
        }
      }
      if (ctx.source === 'deepseek' && ctx.pendingLesson) ctx.pendingLesson.armed = true;
      // A custom dropdown: open its trigger, then click the listed option stating the key's value (exact text first,
      // else the choice learned or picked by Jev for that answer). The pick joins the answer registry.
}
