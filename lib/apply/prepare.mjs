// Pass step 2 (prepare): observe the screen, resolve the run context (identity, host, screen, values,
// learned answers, documents) and build the model view.

import * as act from '../act.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import * as email from '../email.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { localAnswers, resumeBullets, addAliases, learnAlias, loadLearned, saveLearned } from './values.mjs';

export async function prepare(ctx, shared) {
      ctx.identity = undefined;;
      try { ctx.identity = shared.accountIdentity(ctx.current); } catch (error) {
        if (!(error instanceof Stop)) throw error;
        ctx.identity = { host: credentials.hostFromUrl(ctx.current.url), username: null };
      }
      ctx.accountStatus = ctx.identity.username === null ? 'none' : await credentials.status(ctx.identity.host, ctx.identity.username);
      ctx.screen = screenFingerprint(ctx.current);
      ctx.host = credentials.hostFromUrl(ctx.current.url);
      // DeepSeek's queue belongs to the page it was planned on; in-page changes (a fill) keep it, stale refs are refused.
      if (ctx.current.url !== ctx.queuedUrl) ctx.queued = [];
      // A transient site error ("Something went wrong. Please refresh the page", a failed sign-in callback) with no
      // form on screen is reloaded, at most twice per URL; neither model has a reload action.
      if (!activeFields(ctx.current).length && (ctx.reloads.get(ctx.current.url) ?? 0) < 2
        && /something went wrong|refresh the page|an (unexpected )?error (has )?occurred|error code:|temporarily unavailable|operation is not available/i.test(String(ctx.current.pageText ?? ''))) {
        ctx.reloads.set(ctx.current.url, (ctx.reloads.get(ctx.current.url) ?? 0) + 1);
        shared.say(`RELOAD site error page (${ctx.reloads.get(ctx.current.url)}/2)`);
        runlog.trace('reload', { url: ctx.current.url });
        await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
        await shared.pause(3000);
        return 'again';
      }
      // A screen whose only way forward is a disabled Continue/Next while nothing on it is left to fill never enables
      // it by itself. Once it stays disabled for 8 s, the filled text boxes are retyped once (a value the browser
      // restored, as on iCIMS's email-only login, fires none of the input events that enable the button), then the
      // page is reloaded once (Workday's resume step after a stalled parse). The button may sit in a child frame.
      const ADVANCE = /^(continue|next|save (and|&) continue)$/i;
      if (!activeFields(ctx.current).some(field => fieldType(field) !== 'file' && isEmpty(field) && field.required)
        && !ctx.current.controls.some(control => ADVANCE.test(clean(control.label))) && (ctx.reloads.get(ctx.current.url) ?? 0) < 1) {
        const disabledAdvance = async () => {
          for (const frame of ctx.page.frames()) {
            if (await frame.evaluate(source => [...document.querySelectorAll('button,[role=button],input[type=submit]')]
              .some(button => (button.disabled || button.getAttribute('aria-disabled') === 'true') && button.getClientRects().length
                && new RegExp(source, 'i').test((button.innerText || button.value || '').trim())), ADVANCE.source).catch(() => false)) return true;
          }
          return false;
        };
        // A Continue the run just clicked that went disabled while the page's captcha has no token yet is a submit
        // waiting on that captcha (iCIMS greys "Next" while its invisible hCaptcha runs): retyping or reloading then
        // breaks the handoff. The run waits (the challenge, if one opens, is the user's gate) for up to 60 s.
        const clickedAdvance = /^clicked "(continue|next|save (and|&) continue)"$/i.test(ctx.history.at(-1) ?? '');
        if (clickedAdvance && (ctx.captchaPending.get(ctx.current.url) ?? Date.now()) > Date.now() - 60_000
            && await disabledAdvance() && await shared.captchaTokenEmpty()) {
          if (!ctx.captchaPending.has(ctx.current.url)) {
            ctx.captchaPending.set(ctx.current.url, Date.now());
            shared.say('WAIT Continue is pending on the page captcha; not retyping');
          }
          await shared.pause(3000);
          return 'again';
        }
        if (await disabledAdvance()) {
          await shared.pause(8000);
          if (await disabledAdvance()) {
            const retype = activeFields(ctx.current).filter(field => ['text', 'email', 'tel', 'search', 'url', ''].includes(fieldType(field))
              && !isChoiceField(field) && typeof field.value === 'string' && field.value.trim());
            if (retype.length && !ctx.retyped.has(ctx.current.url)) {
              ctx.retyped.add(ctx.current.url);
              for (const field of retype) await mutate('FILL', labelOf(field), () => act.type(ctx.page, field.ref, field.value));
              shared.say(`RETYPE ${retype.length} filled field(s): Continue stays disabled with nothing left to fill`);
              return 'again';
            }
            ctx.reloads.set(ctx.current.url, (ctx.reloads.get(ctx.current.url) ?? 0) + 1);
            shared.say('RELOAD Continue stays disabled with nothing left to fill');
            runlog.trace('reload', { url: ctx.current.url });
            await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
            await shared.pause(3000);
            return 'again';
          }
        }
      }
      let recoveredFill = false;
      for (const state of ctx.fillProgress.values()) {
        if (state.url !== ctx.current.url || !state.pending) continue;
        state.pending = false;
        const field = shared.findField(ctx.current, state.field);
        if (!field) continue;
        // An unchanged text box that holds a value the site does not reject is a refill of the same answer, not a failure.
        // A choice field showing exactly the intended answer took it, even while a stale "required" mark from an
        // earlier submit attempt still flags it invalid (many sites re-validate only on the next submit).
        const holds = isChoiceField(field) && !isEmpty(field) && answers.normalize(field.value) === answers.normalize(state.value);
        // A text box holding the typed value whose only complaint is the earlier "cannot be left blank"/"required" (or
        // none of its own) keeps a stale invalid mark: Phenom and others re-validate only on submit.
        const staleMark = !isChoiceField(field) && !isEmpty(field) && field.invalid
          && (!clean(field.message) || /\b(blank|required|empty)\b/i.test(field.message) && !/\b(invalid|only|must|format)\b/i.test(field.message));
        const failed = isEmpty(field) || (!holds && !staleMark && (field.invalid || (isChoiceField(field) && shared.fieldState(field) === state.before)));
        // A phone number is validated against its country-code picker: while that picker is empty the number's
        // rejection is the picker's, so it is not counted against the number.
        const codeEmpty = /\b(phone|mobile|telephone)\b/i.test(labelOf(field)) && activeFields(ctx.current).some(other => other.ref !== field.ref
          && isEmpty(other) && /\b(country|phone|dial(ing)?)\s*code\b/i.test(labelOf(other)));
        if (failed && codeEmpty) shared.say(`FILL "${labelOf(field)}" waits on its empty country-code picker`);
        if (failed && !codeEmpty) {
          state.failures++;
          const why = isEmpty(field) ? 'the site cleared the accepted fill' : field.invalid ? 'the site rejected the accepted fill' : 'the field did not change';
          shared.say(`FILL no progress "${labelOf(field)}" (${state.failures}): ${why}`);
          if (state.recovered) shared.needsField(field, `${why} after opening and picking an owned option`);
          if (state.failures >= 2 && !isChoiceField(field)) {
            // An optional box abandoned while still holding the value the site rejects blocks the step's save: it is
            // left blank, as abandoning means.
            if (!field.required && field.invalid && !isEmpty(field)) {
              await mutate('FILL', labelOf(field), () => act.type(ctx.page, field.ref, '', { secret: true })).catch(() => {});
              shared.say(`CLEARED rejected optional "${labelOf(field)}"`);
            }
            shared.needsField(field, `${why} twice`);
          }
          if (state.failures >= 2) {
            state.recovered = true;
            shared.say(`FILL recovering "${labelOf(field)}" through owned options`);
            await shared.pickField(ctx.current, field, state.key, state.value);
            Object.assign(state, { field, before: shared.fieldState(field), pending: true });
            recoveredFill = true;
            break;
          }
        }
      }
      if (recoveredFill) return 'again';
      // A rejected box already holding exactly a stored answer (entered on an earlier run, or by the site from the
      // profile) is that answer's fill: it gets the same replacement attempt as one filled on this run.
      for (const field of activeFields(ctx.current)) {
        if ((!field.invalid && !rejectionFor(ctx.current, labelOf(field))) || isEmpty(field) || field.autocomplete || labelOf(field) in ctx.filledKeys) continue;
        const shown = clean(field.value);
        const stored = [...ctx.values].find(([name, value]) => /^(facts|qa)\./.test(name) && !/\.(alt|alias)_\d+$/.test(name)
          && typeof value === 'string' && clean(value) === shown);
        if (stored) ctx.filledKeys[labelOf(field)] = stored[0];
      }
      for (const [label, key] of Object.entries(ctx.filledKeys)) {
        const message = rejectionFor(ctx.current, label);
        const field = ctx.current.fields.find(candidate => labelOf(candidate) === label);
        if (!field || isEmpty(field) || field.autocomplete) continue;
        if (!message && !field?.invalid) {
          if (/\.(alt|alias)_\d+$/.test(key) && ctx.rewritten.has(shared.baseKey(key))) {
            await learnAlias(shared.baseKey(key), ctx.values.get(shared.baseKey(key)), ctx.values.get(key));
            shared.say(`LEARNED accepted alternative for ${clean(label)}`);
            ctx.rewritten.delete(shared.baseKey(key));
          }
          // The site kept this answer: the same field label gets the same key on later applications.
          const as = ctx.learnAs[label];
          const keep = key.replace(/\.alt_\d+$/, '');
          if (as && isQuestionLabel(as) && !ctx.essayKeys.has(keep) && ctx.learned.fields[as] !== keep) {
            ctx.learned.fields[as] = keep;
            await saveLearned(ctx.learned);
            shared.say(`LEARNED field "${clean(as)}" → ${keep}`);
          }
          continue;
        }
        const base = shared.baseKey(key);
        if (ctx.rewritten.has(base) || !ctx.values.has(base)) continue;
        ctx.rewritten.add(base);
        ctx.phase = 'rewrite';
        const alternatives = await rewriteValue({ field: label, value: ctx.values.get(base), message: message ?? 'value rejected as invalid' });
        alternatives.forEach((alternative, i) => ctx.values.set(`${base}.alt_${i + 1}`, alternative));
        runlog.trace('rewrite', { label, key: base, message, count: alternatives.length });
        shared.say(`REWRITE ${clean(label)} → ${alternatives.length} alternatives (${base}.alt_*)`);
        ctx.history.push(`outcome: the site rejected "${label}" (${clean(message ?? 'invalid')}); replacement answers ${base}.alt_* are available`);
      }
      const unownedOptions = ctx.current.controls.some(c => c.kind === 'option' && !c.ownerRef);
      if (!unownedOptions) ctx.openedBy = null;
      // Only a popup trigger (a control reporting expanded state or a current selection) opens a choice list; a
      // section's "Submit & continue" whose next screen happens to show options is not their question.
      else if (ctx.attempt?.kind === 'click' && ctx.attempt.popup && ctx.attempt.screen !== ctx.screen) ctx.openedBy = ctx.attempt.label;
}
