// Pass step 4 (execute): run the chosen plan's actions, then the field/answers pass and the advance
// click, recording what was typed so the next pass can re-check it.

import * as act from '../act.mjs';
import * as rules from '../rules.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
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
import { RE_CREATE_ACCOUNT, USER_GATE, NEVER_WRITE, RESUME_PATH_KEY } from './runtime.mjs';
import { basename } from 'node:path';

export async function execute(ctx, shared) {
      if (ctx.plan.action === 'choose') {
        const trigger = currentControl(ctx.current, ctx.plan.ref, { allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
        const question = questionOf(trigger.label);
        const value = ctx.values.get(ctx.plan.key);
        if (!trigger.expanded) await mutate('OPEN', question, () => act.click(ctx.page, trigger.ref));
        await shared.pause(600);
        let fresh = await shared.freshSnapshot(ctx.current);
        let shown = shared.choicesFor(fresh, trigger.ref);
        // The answer, then each stored alias in preference order ("United States" → "United States of America").
        const wanted = [value, ...shared.aliasesFor(ctx.plan.key, value)].map(answers.normalize).filter(Boolean);
        const listedMatch = () => {
          for (const text of wanted) {
            const hit = shown.find(choice => answers.normalize(choice.label) === text);
            if (hit) return hit.label;
          }
          return undefined;
        };
        let label = listedMatch();
        // A long or remote list (schools, employers) shows only some entries: its dropdown search box (one that appeared
        // on opening, or select2's bare "Search" box when the list was already open) narrows it to the answer.
        const searchBox = !label && fresh.fields.find(field => fieldType(field) === 'search' && field.autocomplete
          && (!ctx.current.fields.some(old => old.ref === field.ref) || /^search$/i.test(labelOf(field))));
        if (searchBox) {
          for (const text of [value, ...shared.aliasesFor(ctx.plan.key, value)]) {
            await mutate('FILL', labelOf(searchBox), () => act.type(ctx.page, searchBox.ref, text, { secret: true }));
            for (let wait = 0; wait < 6; wait++) {
              await shared.pause(wait ? 500 : 800);
              fresh = await shared.freshSnapshot(ctx.current);
              shown = shared.choicesFor(fresh, trigger.ref).filter(choice => !LIST_STATUS.test(clean(choice.label)));
              if (shown.length) break;
            }
            label = listedMatch();
            if (label) break;
          }
        }
        label ??= shown.length ? await shared.chooseOption(question, value, shown.map(choice => choice.label), shared.aliasesFor(ctx.plan.key, value)) : null;
        // An unlisted answer in a list that says to pick "Other" for it ("Select 'Other' if your employer name is not
        // listed"), or that comes with an "Other …" companion field, takes the "Other" entry; the companion field then
        // gets the real answer.
        let viaOther = false;
        if (!label && (/\bother\b/i.test(question) || activeFields(fresh).some(field => /^(other|if other)\b/i.test(labelOf(field))))) {
          if (searchBox) {
            await mutate('FILL', labelOf(searchBox), () => act.type(ctx.page, searchBox.ref, 'Other', { secret: true }));
            for (let wait = 0; wait < 6; wait++) {
              await shared.pause(wait ? 500 : 800);
              fresh = await shared.freshSnapshot(ctx.current);
              shown = shared.choicesFor(fresh, trigger.ref).filter(choice => !LIST_STATUS.test(clean(choice.label)));
              if (shown.length) break;
            }
          }
          label = shown.find(choice => /^other\b/i.test(clean(choice.label)))?.label ?? null;
          viaOther = Boolean(label);
        }
        const option = label && shown.find(choice => choice.label === label);
        if (!option) {
          ctx.history.push(`opened "${question}": no listed choice matched ${ctx.plan.key}`);
          shared.say(`CHOOSE ${clean(question)}: no match for ${ctx.plan.key}`);
          ctx.lastMark = null;
          return 'again';
        }
        await mutate('CLICK', option.label, () => act.click(ctx.page, option.ref));
        if (viaOther) ctx.history.push(`"${question}" does not list "${value}": chose "${option.label}"; put "${value}" in the matching "Other …" field`);
        else shared.remember(question, option.label);
        shared.say(`CHOOSE ${clean(question)} = "${clean(option.label)}"`);
        if (!viaOther) ctx.history.push(`chose "${option.label}" for "${question}"`);
        ctx.attempt = { kind: 'click', screen: ctx.screen, label: question };
        ctx.consults = 0;
        return 'again';
      }
      if (ctx.plan.action === 'click') {
        // An error-summary link ("Please select a City - This field is required") only scrolls to its field; clicking
        // it changes nothing. A click on one that names an empty dropdown goes to that dropdown.
        const linked = ctx.current.controls.find(control => control.ref === ctx.plan.ref);
        const linkText = linked ? answers.normalize(linked.label) : '';
        const errorLink = linked && /\b(required|invalid|must be|please (enter|select|choose))\b/.test(linkText)
          ? activeFields(ctx.current).filter(field => isChoiceField(field) && isEmpty(field) && answers.normalize(labelOf(field)).length >= 3
            && linkText.startsWith(answers.normalize(labelOf(field))) && linkText.length > answers.normalize(labelOf(field)).length)
            .sort((a, b) => labelOf(b).length - labelOf(a).length)[0]
          : undefined;
        const choiceField = errorLink ?? activeFields(ctx.current).find(field => field.ref === ctx.plan.ref && isChoiceField(field));
        if (choiceField) {
          // A native select shows its options without opening (no clickable option rows ever appear). When no stored
          // answer covers it and it asks a preference among several real options (business area, team, office), the
          // writer picks one from the posting and profile; the registry fill then sets it.
          const prefKey = `qa.${answers.normalize(labelOf(choiceField))}`;
          const real = (choiceField.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option))).map(String);
          if (choiceField.tag === 'select' && isEmpty(choiceField) && real.length >= 2 && !ctx.values.has(prefKey)
              && !ctx.writeTried.has(`${ctx.current.url}|pref|${labelOf(choiceField)}`)) {
            ctx.writeTried.add(`${ctx.current.url}|pref|${labelOf(choiceField)}`);
            ctx.phase = 'writer';
            const job = { title: ctx.current.title, site: credentials.hostFromUrl(ctx.current.url), page: String(ctx.postingText || ctx.current.pageText || '').slice(0, 3000) };
            const choice = await pickPreference({ job, applicant: await shared.writerApplicant(), question: labelOf(choiceField), options: real });
            shared.say(`WRITER preference "${clean(labelOf(choiceField))}" = ${choice ? `"${clean(choice)}"` : 'none'}`);
            if (choice) {
              ctx.values.set(prefKey, choice);
              ctx.lastMark = null;
              return 'again';
            }
          }
          const fresh = await shared.openField(ctx.current, choiceField);
          const target = shared.findField(fresh, choiceField);
          const listed = target ? shared.choicesFor(fresh, target.ref).filter(option => !LIST_STATUS.test(clean(option.label))) : [];
          const count = listed.length || target?.options?.length || 0;
          shared.say(`OPEN ${labelOf(choiceField)} (${count} choices)`);
          if (!count) shared.needsField(choiceField, 'opening the select/combobox exposed no owned options');
          // A short custom list (Yes/No, a few levels) no stored key answers: the writer picks the option the applicant
          // facts state, and the pick path commits it. Otherwise Jev opens one question after another.
          if (target && isEmpty(target) && !ctx.values.has(prefKey) && listed.length >= 2 && listed.length <= 40
              && !ctx.writeTried.has(`${ctx.current.url}|pref|${labelOf(choiceField)}`)) {
            ctx.writeTried.add(`${ctx.current.url}|pref|${labelOf(choiceField)}`);
            ctx.phase = 'writer';
            const job = { title: ctx.current.title, site: credentials.hostFromUrl(ctx.current.url), page: String(ctx.postingText || ctx.current.pageText || '').slice(0, 3000) };
            const choice = await pickPreference({ job, applicant: await shared.writerApplicant(), question: labelOf(choiceField), options: listed.map(option => option.label) });
            shared.say(`WRITER choice "${clean(labelOf(choiceField))}" = ${choice ? `"${clean(choice)}"` : 'none'}`);
            if (choice) {
              ctx.values.set(prefKey, choice);
              await shared.pickField(fresh, target, prefKey, choice);
              shared.remember(labelOf(choiceField), choice);
              ctx.lastMark = null;
            }
          }
          return 'again';
        }
        const control = currentControl(ctx.current, ctx.plan.ref, { moreEntries: shared.moreEntries(ctx.current), allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
        if (control.kind === 'option' && control.multi && control.selected) invalidPlan('multi-select-unchoose');
        // Advancing ("Save and Continue", "Next") while this screen still has required questions unanswered leaves
        // them behind: sites that save partial pages (tal.net) move on and the final submit later fails. The first
        // such advance per screen is refused with the open questions named; a repeat goes through (a site may mark
        // a question required that cannot be answered, and its own validation then reports it).
        if (/^(save (and|&) )?(continue|next)\b|^next( page| step)?$|^save (and|&) next\b/i.test(clean(control.label))) {
          const open = [
            ...activeFields(ctx.current).filter(field => field.required && isEmpty(field) && fieldType(field) !== 'file').map(labelOf),
            ...ctx.current.controls.filter(other => other.current !== undefined && other.formRef && /\*|\bfield is required\b/i.test(other.label ?? '')
              && (!clean(other.current) || /^(select|choose|please select|--)/i.test(clean(other.current)))).map(other => questionOf(other.label)),
          ];
          const mark = `${ctx.current.url}|advance|${open.join('|')}`;
          if (open.length && !ctx.advanceRefused.has(mark)) {
            ctx.advanceRefused.add(mark);
            ctx.history.push(`did not click "${clean(control.label)}": required questions on this screen are still empty: ${open.slice(0, 8).map(text => `"${clean(text).slice(0, 60)}"`).join(', ')}; answer them first`);
            invalidPlan('advance-with-required-empty');
          }
        }
        // A just-generated password belongs to an account still being created: signing in with it cannot work.
        if (ctx.registering.has(credentials.hostFromUrl(ctx.current.url)) && /^(log ?in|sign ?in)$/i.test(clean(control.label))
            && ctx.current.controls.some(other => RE_CREATE_ACCOUNT.test(clean(other.label)))) {
          invalidPlan('sign-in-before-account-exists');
        }
        if (rules.classifyControl(control) === 'final-submit') {
          if (ctx.current.gates.includes('captcha') && await shared.awaitCaptcha(ctx.current)) invalidPlan('stale-screen');
          stopForGates(ctx.current, { submitting: true });
        }
        const resetRequest = shared.isResetRequest(ctx.current, control);
        if (resetRequest && ctx.resetRequested.has(credentials.hostFromUrl(ctx.current.url))) {
          throw new Stop('needs-user-email-verification: the password reset was already requested in this run');
        }
        const clickedAt = Date.now();
        if (!await shared.click(ctx.current, control)) { ctx.lastMark = null; await shared.pause(1000); return 'again'; }
        shared.say(`JEV CLICK ${labelOf(control)} conf=${ctx.confidence.toFixed(2)}`);
        shared.noteRecent(`JEV CLICK ${labelOf(control)}`);
        ctx.attempt = { kind: 'click', screen: ctx.screen, label: labelOf(control), popup: control.expanded !== undefined || control.current !== undefined };
        ctx.history.push(`clicked "${labelOf(control)}"`);
        if (rules.classifyControl(control) === 'final-submit') {
          ctx.submittedVia = labelOf(control);
          ctx.submitFilled = new Set(activeFields(ctx.current).filter(field => !isEmpty(field)).map(field => field.ref));
          ctx.submitUrl = ctx.current.url;
          ctx.submitAt = Date.now();
          // The documents the site shows attached when the submit goes out: the one record of which resume it got.
          const attached = [...new Set(ctx.current.controls.filter(other => other.attached).map(other => other.attached))];
          if (attached.length) shared.say(`DOC submitted with ${attached.join(', ')}`);
          ctx.runInfo.submittedWith = attached;
          await shared.pause(2500);
        }
        if (resetRequest) { await shared.pause(1500); await shared.followEmailedReset(ctx.current, clickedAt); ctx.consults = 0; return 'again'; }
        if (control.kind === 'option') {
          const owner = control.ownerRef && (ctx.current.fields.find(field => field.ref === control.ownerRef)
            ?? ctx.current.controls.find(other => other.ref === control.ownerRef));
          const question = owner ? labelOf(owner) : ctx.openedBy;
          if (question && !/^no (matches|results)\b/i.test(control.label)) shared.remember(question, control.label);
        }
        ctx.consults = 0;
        return 'again';
      }
      if (ctx.plan.action === 'check') {
        const target = checkTarget(ctx.current, ctx.plan.ref, ctx.allowSubmit);
        const fresh = checkTarget(await shared.freshSnapshot(ctx.current), ctx.plan.ref, ctx.allowSubmit);
        sameTarget(target.field, fresh.field);
        if (fresh.field.checkedRefs?.includes(ctx.plan.ref) || (!Array.isArray(fresh.field.optionRefs) && fresh.field.value === 'checked')) invalidPlan('already-checked');
        const label = `${labelOf(target.field)}${target.option && target.option !== labelOf(target.field) ? ` = ${target.option}` : ''}`;
        await mutate('CHECK', label, () => act.click(ctx.page, ctx.plan.ref));
        shared.say(`JEV CHECK ${clean(label)} conf=${ctx.confidence.toFixed(2)}`);
        shared.noteRecent(`JEV CHECK ${clean(label)}`);
        ctx.attempt = { kind: 'click', screen: ctx.screen, label };
        ctx.history.push(`ticked "${label}"`);
        if (fieldType(target.field) === 'radio' && target.option) shared.remember(labelOf(target.field), target.option);
        ctx.consults = 0;
        return 'again';
      }
      if (ctx.plan.action === 'fill') {
        // Resolve and validate the entire batch before its first mutation.
        // At most one autocomplete per batch: picking it can re-render other widgets, which the next pass observes.
        const resolvedBatch = ctx.plan.fields.map(item => resolveFill(ctx.current, item, ctx.values));
        const autocompletes = resolvedBatch.filter(fill => fill.field.autocomplete);
        const fills = [...resolvedBatch.filter(fill => !fill.field.autocomplete), ...autocompletes.slice(0, 1)];
        // A field gone or changed on a fresh read (the page re-rendered or advanced) is skipped, not fatal: the next
        // observation decides what is left to do.
        const stillThere = (snap, fill) => {
          try { return resolveFill(snap, { ref: freshRef(snap, fill.field), key: fill.key }, ctx.values); }
          catch (error) {
            if (!(error instanceof Stop) || !/^invalid-plan stale-/.test(error.message)) throw error;
            runlog.trace('refused', { source: ctx.source, action: `fill:${fill.field.ref}`, reason: error.message });
            return null;
          }
        };
        const fresh = await shared.freshSnapshot(ctx.current);
        const live = fills.filter(fill => stillThere(fresh, fill));
        const applied = [];
        for (const fill of live) {
          if (fill.optionRef) {
            if (!await shared.click(ctx.current, fill.field, fill)) continue;
          } else {
            const before = await shared.freshSnapshot(ctx.current);
            const resolved = stillThere(before, fill);
            if (!resolved) continue;
            if (resolved.secretChoice) {
              // The Nth security-question picker on screen takes the Nth real question in its list, so no two match.
              const pickers = before.fields.filter(field => /\b(security|secret|challenge|recovery) question\b/i.test(labelOf(field)));
              const nth = Math.max(0, pickers.findIndex(field => field.ref === resolved.field.ref));
              const listed = (await act.selectOptions(ctx.page, resolved.field.ref, '', 500))
                .filter(option => option && !/^(select|choose|please)\b/i.test(option.trim()));
              const question = listed[nth % Math.max(listed.length, 1)];
              if (!question) invalidPlan('no-security-questions');
              await mutate('SELECT', labelOf(resolved.field), () => act.select(ctx.page, resolved.field.ref, question));
              shared.say(`SELECT ${labelOf(resolved.field)} = question ${nth + 1} of the list`);
              continue;
            }
            if (resolved.secret) {
              const account = shared.accountIdentity(before);
              if (account.username === null) throw new Stop('credential-identity-missing');
              // Repeated labels ("Answer" under each of three questions) get one secret each, by their order on screen.
              const same = before.fields.filter(field => answers.normalize(labelOf(field)) === answers.normalize(labelOf(resolved.field)));
              const nth = same.findIndex(field => field.ref === resolved.field.ref);
              const label = `${answers.normalize(labelOf(resolved.field))}${same.length > 1 ? `#${nth + 1}` : ''}`;
              const secret = await credentials.ensureSecret(account.host, account.username, label);
              await mutate('FILL', labelOf(resolved.field), () => act.type(ctx.page, resolved.field.ref, secret, { secret: true }));
              shared.say(`generated secret in Keychain for ${labelOf(resolved.field)}`);
              continue;
            }
            const progressId = shared.progressKey(before, resolved.field);
            const state = ctx.fillProgress.get(progressId) ?? { url: before.url, failures: 0, recovered: false };
            if (state.recovered) shared.needsField(resolved.field, 'the field still needs an answer after opening and picking');
            if (isChoiceField(resolved.field)) {
              // Linked choice widgets (a ZIP list filled only after the address pick) can be empty on the first try:
              // the first failed pick of a field is noted and the run moves on; the second one stops.
              try { await shared.pickField(before, resolved.field, resolved.key, resolved.value); }
              catch (error) {
                if (!(error instanceof Stop) || !error.message.startsWith('needs-user-field') || state.pickFailed) throw error;
                state.pickFailed = true;
                ctx.fillProgress.set(progressId, state);
                await act.press(ctx.page, 'Escape').catch(() => undefined);
                shared.say(`PICK deferred "${labelOf(resolved.field)}": ${error.message.replace(/^needs-user-field "[^"]*": /, '')}`);
                // A linked list (ZIP under City/State) offers only choices under the values already in its parent
                // fields: a field the site prefilled from a resume ("Waterville" in City) that contradicts a stored
                // fact is corrected now, so the deferred pick sees the right list when it is tried again.
                for (const field of before.fields.filter(other => other.ref !== resolved.field.ref && !isEmpty(other))) {
                  const key = `facts.${answers.normalize(labelOf(field)).replace(/ /g, '_')}`;
                  const stored = ctx.values.get(key);
                  const shown = answers.normalize(field.value);
                  if (typeof stored !== 'string' || !stored || shown.includes(answers.normalize(stored)) || answers.normalize(stored).includes(shown)) continue;
                  try {
                    const fresh = await shared.freshSnapshot(ctx.current);
                    const live = shared.findField(fresh, field);
                    if (!live) continue;
                    if (isChoiceField(live)) await shared.pickField(fresh, live, key, stored);
                    else {
                      await mutate('FILL', labelOf(live), () => act.type(ctx.page, live.ref, stored, { secret: true }));
                      await act.press(ctx.page, 'Tab');
                    }
                    shared.say(`CORRECTED prefilled "${labelOf(field)}" ("${clean(field.value)}") to the stored ${key}`);
                  } catch (correction) {
                    await act.press(ctx.page, 'Escape').catch(() => undefined);
                    ctx.history.push(`"${labelOf(field)}" shows "${clean(field.value)}" but the stored answer is "${stored}"; correct it before "${labelOf(resolved.field)}"`);
                  }
                }
                continue;
              }
            } else {
              await mutate('FILL', labelOf(resolved.field), () => act.type(ctx.page, resolved.field.ref, resolved.value, { secret: !isEmpty(resolved.field) }));
              await act.press(ctx.page, 'Tab');
            }
            Object.assign(state, { field: resolved.field, key: resolved.key, value: resolved.value, before: shared.fieldState(resolved.field), pending: true });
            ctx.fillProgress.set(progressId, state);
            applied.push(resolved);
            shared.rememberEmail(before, resolved.field, resolved.value);
          }
        }
        // A later keystroke can land in an earlier box of the same batch: a segmented date (Workday's Month/Year) moves
        // focus on its own, so the year's first digit overwrites the month. Each typed box is re-read once and retyped
        // (cleared first) if it no longer holds its value; numeric boxes may drop a leading zero ("06" shows "6").
        const typed = applied.filter(fill => !fill.optionRef && !fill.secret && !fill.secretChoice && !isChoiceField(fill.field));
        if (typed.length > 1) {
          const bare = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
          const holds = (shown, value) => bare(shown) === bare(value) || (/^\d+$/.test(bare(shown)) && /^\d+$/.test(bare(value)) && Number(bare(shown)) === Number(bare(value)));
          const after = await shared.freshSnapshot(ctx.current);
          for (const fill of typed) {
            const now = after.fields.find(field => field.ref === fill.field.ref);
            if (!now || now.value === undefined || holds(now.value, fill.value)) continue;
            await mutate('FILL', labelOf(fill.field), () => act.type(ctx.page, fill.field.ref, fill.value, { secret: true }));
            shared.say(`REFILL ${labelOf(fill.field)}: a later keystroke in the batch changed it`);
          }
        }
        shared.say(`JEV FILL ${fills.map(fill => labelOf(fill.field)).join('; ')} conf=${ctx.confidence.toFixed(2)}`);
        shared.noteRecent(`JEV FILL ${fills.map(fill => labelOf(fill.field)).join('; ')}`);
        ctx.attempt = { kind: 'fill', screen: ctx.screen, fields: applied.map(fill => ({ ref: fill.field.ref, label: labelOf(fill.field), autocomplete: !!fill.field.autocomplete })) };
        ctx.history.push(`filled ${applied.map(fill => `"${labelOf(fill.field)}"`).join(', ')}`);
        for (const fill of applied) {
          if (fill.secret || fill.optionRef || !labelOf(fill.field)) continue;
          ctx.filledKeys[labelOf(fill.field)] = fill.key;
          if (learnLabel(fill.field)) ctx.learnAs[labelOf(fill.field)] = learnLabel(fill.field);
        }
        ctx.consults = 0;
        return 'again';
      }
      if (ctx.plan.action === 'upload_resume') {
        const { field, kind } = documentField(ctx.current, ctx.plan.ref, ctx.resumeAvailable);
        let file = ctx.resume;
        if (kind === 'resume' && !await resumeIsReadable(ctx.resume)) throw new Stop('resume-not-readable', 1);
        if (kind === 'resume') {
          ctx.phase = 'tailored-resume';
          const tailored = await (ctx.tailoredPending ??= shared.tailorResume(`${ctx.postingText}\n${String(ctx.current.pageText ?? '')}`.slice(0, 6000)));
          ctx.phase = 'driver';
          if (tailored) {
            file = tailored;
            ctx.runInfo.tailored = true;
            shared.say(`RESUME tailored for this posting: ${tailored}`);
          }
        }
        if (kind === 'cover') {
          // A tailored letter for this posting, written and compiled once per job (cached across re-runs).
          ctx.phase = 'cover-letter';
          try {
            file = await coverLetter({ url: ctx.runUrl, title: clean(ctx.current.title), employer: null, pageText: `${ctx.postingText}\n${String(ctx.current.pageText ?? '')}`.slice(0, 6000) });
          } catch (error) {
            runlog.trace('cover-letter-error', { message: clean(error?.message).slice(0, 200) });
            ctx.refused.actions.add(`upload:${field.ref}`);
            ctx.lastMark = null;
            return 'again';
          }
          ctx.phase = 'driver';
        }
        const fresh = await shared.freshSnapshot(ctx.current);
        // The page re-rendered and the upload box is gone or changed: observe again rather than stop the run.
        let target;
        try { target = documentField(fresh, field.ref, true).field; sameTarget(field, target); }
        catch (error) {
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
          runlog.trace('refused', { source: ctx.source, action: `upload:${field.ref}`, reason: `stale ${error.message}` });
          ctx.lastMark = null;
          return 'again';
        }
        const what = kind === 'cover' ? 'COVER_LETTER' : 'RESUME';
        await mutate('UPLOAD', labelOf(target), () => act.upload(ctx.page, target.ref, file));
        if (!(ctx.runInfo.uploaded ??= []).includes(basename(file))) ctx.runInfo.uploaded.push(basename(file));
        // What the site did with the file (kept it, showed a chip, opened a dialog) once it has had time to react.
        const uploadResult = async () => {
          await shared.pause(2500);
          const after = await observe(ctx.page);
          const held = await ctx.page.evaluate(() => [...document.querySelectorAll('input[type=file]')].reduce((n, input) => n + input.files.length, 0)).catch(() => null);
          const result = { label: labelOf(target), held, messages: after.messages ?? [], gates: after.gates,
            attached: after.controls.filter(control => control.attached).map(control => clean(control.label)).slice(0, 5),
            context: clean(shared.findField(after, target)?.context ?? '').slice(0, 200), url: after.url !== ctx.current.url ? after.url : undefined };
          runlog.trace('upload-result', result);
          return { after, result };
        };
        const { after, result } = await uploadResult();
        // A widget that ignores a file set on its input (Phenom's resume box: input emptied, no chip, same text, no
        // dialog) gets it once more through its own upload button and the native file chooser.
        const dropped = result.held === 0 && !result.attached.length && !result.url && !result.gates.length
          && result.context === clean(target.context ?? '').slice(0, 200);
        const trigger = dropped && after.controls.find(control => control.kind === 'button' && !control.href
          && (control.formRef ?? '') === (target.formRef ?? '')
          && /\b(select|choose|browse|upload|attach)\b.*\b(file|resume|résumé|cv)\b/i.test(clean(control.label)));
        if (trigger) {
          await mutate('UPLOAD', labelOf(target), () => act.uploadViaChooser(ctx.page, trigger.ref, file)).catch(error => runlog.trace('upload-chooser-error', { message: clean(error?.message).slice(0, 200) }));
          shared.say(`UPLOAD retried through "${clean(trigger.label)}" (the site dropped the file set on its input)`);
          await uploadResult();
        }
        ctx.uploads.set(`${ctx.current.url}|${labelOf(target)}`, (ctx.uploads.get(`${ctx.current.url}|${labelOf(target)}`) ?? 0) + 1);
        uploadedLabels.add(answers.normalize(labelOf(target)));
        shared.say(`JEV UPLOAD_${what} ${labelOf(target)} conf=${ctx.confidence.toFixed(2)}`);
        shared.noteRecent(`JEV UPLOAD_${what} ${labelOf(target)}`);
        ctx.consults = 0;
        return 'again';
      }
      if (ctx.plan.action === 'credentials') {
        // Empty password fields are filled; when every one is already filled, Jev chose to re-enter them all
        // (the site rejected the pair), and the secret fill clears each field first.
        const all = passwordFields(ctx.current);
        const fields = all.some(isEmpty) ? all.filter(isEmpty) : all;
        if (!fields.length) invalidPlan('password-fields');
        if (!ctx.identity.username) throw new Stop('unknown-required-field email');
        const fresh = await shared.freshSnapshot(ctx.current);
        const freshAll = passwordFields(fresh);
        const freshFields = freshAll.some(isEmpty) ? freshAll.filter(isEmpty) : freshAll;
        if (freshFields.length !== fields.length) invalidPlan('stale-password-fields');
        for (const field of fields) {
          const target = freshFields.find(candidate => candidate.ref === field.ref);
          if (!target) invalidPlan('stale-password-field');
          sameTarget(field, target);
        }
        const freshIdentity = shared.accountIdentity(fresh);
        if (freshIdentity.host !== ctx.identity.host || freshIdentity.username !== ctx.identity.username) invalidPlan('stale-account');
        ctx.phase = 'credentials';
        const existing = await credentials.get(ctx.identity.host, ctx.identity.username);
        // No stored password and a lone password box: this is a sign-in form for an account that does not exist yet.
        // When the screen offers account creation, open it instead of inventing a password for a sign-in.
        const createControl = existing === null && freshAll.length === 1
          ? fresh.controls.find(control => RE_CREATE_ACCOUNT.test(clean(control.label))) : null;
        if (createControl) {
          await shared.click(fresh, createControl);
          shared.say(`HARNESS CLICK ${labelOf(createControl)} (no stored account for ${clean(ctx.identity.host)})`);
          shared.noteRecent(`HARNESS CLICK ${labelOf(createControl)}`);
          ctx.history.push(`no account exists for ${ctx.identity.username} on this site; opened "${labelOf(createControl)}" to register`);
          ctx.consults = 0;
          return 'again';
        }
        if (ctx.plan.mode === 'login' && existing === null) throw new Stop(`credential-missing ${clean(ctx.identity.host)}`);
        // On a reset page opened from the emailed link, the stored password is replaced once per run with a fresh
        // one, reused for every field of that form.
        const resetting = ctx.resetPasswords.has(ctx.identity.host) && (ctx.plan.mode === 'register' || all.length >= 2 || !!ctx.resetPasswords.get(ctx.identity.host));
        if (resetting && !ctx.resetPasswords.get(ctx.identity.host)) ctx.resetPasswords.set(ctx.identity.host, await credentials.rotate(ctx.identity.host, ctx.identity.username));
        // The longest password the site takes: the box's maxlength, else its stated rule ("8-18 characters",
        // "no more than 20 characters") in the field messages or page text.
        const ruleText = [...fields.map(field => field.message ?? ''), ...(fresh.messages ?? []), fresh.pageText ?? ''].join('\n');
        const stated = ruleText.match(/\b\d{1,2}\s*(?:-|–|to|and)\s*(\d{1,2})\s*(?:characters|chars)\b/i)?.[1]
          ?? ruleText.match(/\b(?:max(?:imum)?(?: of)?|at most|no more than|up to|not exceed|(?:not be|no) longer than)\s*(\d{1,2})\s*(?:characters|chars)\b/i)?.[1];
        const maxLength = Math.min(...fields.map(field => field.maxLength > 0 ? field.maxLength : Infinity), Number(stated) >= 8 ? Number(stated) : Infinity);
        const password = resetting ? ctx.resetPasswords.get(ctx.identity.host)
          : ctx.plan.mode === 'register' ? await credentials.ensure(ctx.identity.host, ctx.identity.username, Number.isFinite(maxLength) ? maxLength : 0) : existing;
        if (ctx.plan.mode === 'register' && existing === null) ctx.registering.add(ctx.identity.host);
        for (const field of fields) {
          const before = await shared.freshSnapshot(ctx.current);
          const target = passwordFields(before).find(candidate => candidate.ref === field.ref);
          if (!target || (fields !== all && !isEmpty(target))) invalidPlan('stale-password-field');
          sameTarget(field, target);
          const account = shared.accountIdentity(before);
          if (account.host !== ctx.identity.host || account.username !== ctx.identity.username) invalidPlan('stale-account');
          await mutate('FILL', 'password', () => act.type(ctx.page, target.ref, password, { secret: true }));
        }
        shared.say(`JEV CREDENTIALS ${ctx.plan.mode} conf=${ctx.confidence.toFixed(2)}`);
        if (ctx.plan.mode === 'login') ctx.registering.delete(ctx.identity.host);
        shared.noteRecent(`JEV CREDENTIALS ${ctx.plan.mode}`);
        shared.say(ctx.plan.mode === 'register' && existing === null ? 'generated password in Keychain' : 'filled password from Keychain');
        ctx.history.push(`filled the ${ctx.plan.mode === 'login' ? 'stored' : 'account'} password into ${fields.map(field => `"${labelOf(field)}"`).join(' and ')}`);
        ctx.consults = 0;
        return 'again';
      }
      invalidPlan('action');
}
