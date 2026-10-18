// Pass step 3 (choose): the deterministic rule plan first, then the model (planner/Jev) when the rules
// leave the screen stuck, and the plan validation that follows.

import * as act from '../act.mjs';
import { drive, pickOption, plan as jevPlan } from '../jev.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import * as rules from '../rules.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf, datePart, isTodayLabel, isDateBox, dateSegment, asksDate, dateFactKey } from './fields.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate, factlessSection, disclosureAnswer, disclosureQuestion, storedAnswerFor, ungroundedOption, isAddControl, sectionOf } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY, stalledRecommit } from './plan.mjs';
import { resolveApplicationAnswer } from '../work-authorization.mjs';
import { isControlledNameQuestion } from '../controlled-answers.mjs';
import { localAnswers, resumeBullets, addAliases, learnAlias, loadLearned, saveLearned } from './values.mjs';
import { RE_CREATE_ACCOUNT, USER_GATE, NEVER_WRITE, RESUME_PATH_KEY } from './runtime.mjs';
import { BASE_GOAL } from './state.mjs';

// Early-stop budgets in paid driver calls: p99 of calls per screen on the submitted Workday runs (21) plus margin,
// and the largest number of calls a submitted run spent on one step without an accepted answer (158) plus margin.
// See the replay numbers in the comment at the check in choose().
const FP_BUDGET = 23;
const STEP_BUDGET = 160;

// The consult budget, kept out of choose() so it is replayable. A consult that got something done must not burn the
// same budget as one that changed nothing: an action that altered the screen moves ctx.screen (resetting the count
// below), and an action whose effect the fingerprint cannot show (a fill typed, a box ticked, a document attached)
// sets ctx.consultProgress. Only a consult after nothing executed — every planned action refused, dropped, or with no
// visible effect — counts against the screen. The run-wide consultsTotal bounds the whole run, so progress-aware
// counting can never let a loop of executable-but-useless actions run forever (each consult is a paid planner call).
export function consultLimited(ctx) {
  if (ctx.consultScreen !== ctx.screen) { ctx.consultScreen = ctx.screen; ctx.screenConsults = 0; ctx.consultProgress = false; ctx.consultSig = null; }
  const progressed = ctx.consultProgress;
  ctx.consultProgress = false;
  if (!progressed) ctx.screenConsults += 1;
  // The plan signature of the consult before this one survives only while that consult got nothing done (see the
  // repeated-plan stop in choose): anything that progressed breaks the chain.
  if (progressed) ctx.consultSig = null;
  ctx.consults += 1;
  ctx.consultsTotal += 1;
  return ctx.screenConsults > 2 || ctx.consults > 6 || ctx.consultsTotal > 30;
}

// What the site did with an account form the run sent (execute's click bookkeeping): read from the next screen on the
// same host, so no model has to guess the account's state. A sign-in the site turned down for its password marks the
// host passwordRejected (the account exists with another password: the step rules take it through the site's reset,
// and registering again is refused); one that left the password boxes behind proves the account and records it. A
// registration answered with the site's own sign-in form and no message (Workday, for an email it already knows)
// lifts the registering brake so the stored password gets its one try.
export async function accountOutcome(ctx, shared, account) {
  const text = `${ctx.current.pageText ?? ''}\n${(ctx.current.messages ?? []).join('\n')}`;
  const passwords = passwordFields(ctx.current);
  const rejected = rules.RE_PASSWORD_REJECTED.test(text);
  if (account.mode === 'signin') {
    if (rejected) {
      ctx.passwordRejected.add(account.host);
      shared.say(`ACCOUNT ${clean(account.host)} rejected the stored password; resetting it through the site's password reset`);
      ctx.history.push(`outcome: the site rejected the stored password for ${account.username}: the account exists with another password; the harness resets it — open "Forgot your password?", fill the email, click the reset button once; never register again`);
    } else if (!passwords.length && !ctx.current.gates.includes('captcha')) {
      ctx.registering.delete(account.host);
      if (account.username && await credentials.status(account.host, account.username) === 'pending') {
        await credentials.markCreated(account.host, account.username);
        shared.say(`ACCOUNT created ${clean(account.host)} (signed in)`);
      }
    }
  } else if (account.mode === 'register' && passwords.length === 1 && !rejected && !rules.RE_EXISTING_ACCOUNT.test(text)) {
    ctx.registering.delete(account.host);
    shared.say(`ACCOUNT ${clean(account.host)} answered the registration with its sign-in form; trying the stored password`);
    ctx.history.push(`outcome: the registration was sent and the site came back to its sign-in form with no message: an account for ${account.username} may already exist; sign in with the stored password (credentials login, then the sign-in button), and if the site rejects it the harness resets it`);
  }
}

export async function choose(ctx, shared) {
      if (ctx.attempt) {
        if (ctx.attempt.kind === 'fill') {
          const cleared = ctx.attempt.fields.filter(item => {
            const field = ctx.current.fields.find(candidate => candidate.ref === item.ref);
            return field && isEmpty(field);
          });
          if (cleared.length) ctx.history.push(`outcome: the site cleared ${cleared.map(item => `"${item.label}"`).join(', ')} after typing`);
          // A list still open under a field that holds its pick (Workday's multi-select keeps listing after a choice)
          // needs no further pick.
          const open = ctx.attempt.fields.filter(item => item.autocomplete && ctx.current.controls.some(c => c.kind === 'option' && c.ownerRef === item.ref)
            && ctx.current.fields.some(field => field.ref === item.ref && isEmpty(field)));
          if (open.length) ctx.history.push(`outcome: suggestion list open for ${open.map(item => `"${item.label}"`).join(', ')}; pick the matching suggestion`);
        } else if (ctx.attempt.screen === ctx.screen) {
          ctx.history.push(`outcome: no visible change after clicking "${ctx.attempt.label}"`);
          // A forward step (Continue/Next/Save) that changed nothing marks the screen stalled: an occupied choice
          // field may then be re-committed once (plan.mjs stalledRecommit) so the site commits its dependents.
          if (rules.classifyControl({ label: ctx.attempt.label ?? '' }) === 'step') ctx.stepStalled = ctx.screen;
        } else if (ctx.attempt.account && ctx.attempt.account.host === credentials.hostFromUrl(ctx.current.url)) {
          await accountOutcome(ctx, shared, ctx.attempt.account);
        }
        ctx.attempt = null;
        if (ctx.history.length > 12) ctx.history.splice(0, ctx.history.length - 12);
      }
      // The deterministic policy answer takes the qa key for a work-right, age, or inverted boolean question (and
      // records it), else null. Unknown age truth stops instead of writing a guess.
      const policyKey = label => {
        const key = `qa.${answers.normalize(label)}`;
        const resolved = resolveApplicationAnswer(label, ctx.workAuthorization, key, ctx.values.get(key), ctx.values);
        if (!resolved) return null;
        if (resolved.answer === null) {
          // A name without that fact is left empty when optional (and refused by the writer when required); the
          // learned/template path must not substitute another fact for it.
          if (isControlledNameQuestion(label)) return null;
          throw new Stop(`unknown-answer ${resolved.family} ${questionOf(label)}`);
        }
        ctx.values.set(key, resolved.answer);
        return key;
      };
      // The stored answer that authorises a value for a field: the deterministic policy answer, the key a past run
      // learned for its label, a facts.<label> entry, or the qa registry key for its question. What the
      // learned/registry batch, the entry removal and the option grounding all resolve against.
      const storedFor = field => {
        if (!field) return null;
        // A value written for this field earlier in the run (the picker's committed item, the writer's composed
        // answer) is an answer the run itself holds: it authorises a later pick on the same field.
        if (typeof ctx.typed?.[field.ref] === 'string' && ctx.typed[field.ref]) return { key: null, value: ctx.typed[field.ref] };
        const policy = policyKey(labelOf(field));
        if (policy && ctx.values.has(policy)) return { key: policy, value: ctx.values.get(policy) };
        if (isControlledNameQuestion(labelOf(field))) return null;
        return storedAnswerFor(field, ctx.values, ctx.learned);
      };
      // Workday leaves some section "Add" buttons unnamed in the snapshot: the section is read from the live DOM once
      // per screen (the group-name walk the snapshot's own naming pass does) and reused by the passes that follow.
      const addSection = async ref => {
        if (ctx.addSections?.screen !== ctx.screen) ctx.addSections = { screen: ctx.screen, map: new Map() };
        if (!ctx.addSections.map.has(ref)) ctx.addSections.map.set(ref, await sectionOf(ctx.page, ref).catch(() => ''));
        return ctx.addSections.map.get(ref);
      };
      // The fact-less section an Add/Add Another control opens, with the DOM read cached per screen (a bare "Add"
      // names its section only in the live DOM); null when the control opens no entry or its section has facts.
      const factlessAdd = async control => {
        if (!isAddControl(control)) return null;
        return factlessSection(`${control.label ?? ''} ${control.context ?? ''}`, ctx.values)
          ?? factlessSection(await addSection(control.ref), ctx.values);
      };
      ctx.context = {
        // The resume's file path is executor-local (uploads read `values` directly) and is never offered to a model.
        availableKeys: [...ctx.values.keys()].filter(key => key !== RESUME_PATH_KEY),
        answerValues: Object.fromEntries([...ctx.values].filter(([key]) => key !== RESUME_PATH_KEY)),
        history: [...ctx.history],
        openedBy: ctx.openedBy,
        typed: { ...ctx.typed },
        resumeAvailable: ctx.resumeAvailable,
        transcriptAvailable: ctx.transcriptAvailable,
        credential: { host: ctx.identity.host, status: ctx.accountStatus },
      };
      if (ctx.refused.screen !== ctx.screen) ctx.refused = { screen: ctx.screen, actions: new Set() };
      ctx.phase = 'driver';
      ctx.outcome = undefined;;
      // Settles what the last action did on the family template before any plan is drawn (lib/apply/template.mjs).
      await shared.templateConfirm();
      // An open entry no stored answer can fill (Workday's "Certifications 1" panel after the section's "Add") is
      // removed before anything else is planned: no model may complete it from thin air, and its required field holds
      // every forward step back. The screen is re-observed straight after the removal.
      if (await shared.removeOpenEntry(ctx.current, storedFor)) return 'again';
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
        // Learned answers (including searchable choices) are tried once per field per run through the same executor.
        // A box the site prefilled (account profile, resume parse: the preferred name in "Legal First Name") that contradicts
        // the stored answer its label maps to is retyped with it, the same once-per-run. A choice field is only
        // re-decided while the page reports an issue (see plan.mjs currentField): re-picking the site's own widget is
        // what fixes a wrong prefilled choice, and an unflagged screen's choice is left alone.
        const flagged = (ctx.current.messages ?? []).length > 0 || activeFields(ctx.current).some(field => field.invalid);
        // A today's-date/signature-date field takes the run-time fact, never a stored or learned key: a qa answer
        // remembered under "today s date" is a past date by the next run and was submitted as one.
        const signatureNearby = activeFields(ctx.current)
          .some(field => /\bsignature\b|\bsigned\b|\bsign here\b|\btyped name\b|\btype your full name\b/.test(answers.normalize(labelOf(field))));
        // Beside a signature box a bare "Date" (or "Date (MM/DD/YYYY)") means the date of signing: today. A label
        // that names a different date ("Date of birth") does not match — that is a stored fact, not today.
        const bareDate = /^date(?: (?:mm|dd|yyyy|yy|m|d|y|month|day|year))+$/;
        const todayField = field => {
          const name = answers.normalize(labelOf(field));
          return isTodayLabel(labelOf(field)) || (signatureNearby && (name === 'date' || bareDate.test(name)));
        };
        // The key a today's-date field takes, always a run-time fact: a learned entry naming the ISO variant of that
        // fact is kept (the site's box takes that format), any other stored key — a qa answer remembered for the
        // label — is not.
        const todayKey = field => ctx.learned.fields[learnLabel(field)] === 'facts.today.iso' ? 'facts.today.iso' : 'facts.today';
        // A date box's segments share one question: the semantic facts first — a graduation question (never the
        // high-school one) is the stored graduation fact, an "Education End date"/degree-completion question is too,
        // and a Proposed Start Date is the internship start — then a mapping learned for the question without the
        // segment word (an Education Start date year keeps its learned `facts.college_start`).
        const dateKey = field => (isDateBox(field) || isChoiceField(field) || asksDate(field))
          ? dateFactKey(field, ctx.learned.fields) : undefined;
        const fieldKey = field => todayField(field) ? todayKey(field) : policyKey(labelOf(field)) ?? dateKey(field) ?? (isControlledNameQuestion(labelOf(field)) ? null : ctx.learned.fields[learnLabel(field)]);
        const prefilledWrong = field => {
          const key = fieldKey(field);
          const stored = /^(facts|qa)\./.test(key ?? '') && typeof ctx.values.get(key) === 'string' ? ctx.values.get(key) : '';
          // A date box holds one part of the stored date ("05" of "May 2029"), never the whole value.
          let expected = stored;
          if (stored && isDateBox(field)) { try { expected = String(dateSegment(field, stored)); } catch { expected = ''; } }
          const fact = answers.normalize(expected);
          const shown = answers.normalize(field.value);
          if (/^\d+$/.test(fact) && /^\d+$/.test(shown)) return Number(shown) !== Number(fact);
          return Boolean(fact) && !shown.includes(fact);
        };
        const known = activeFields(ctx.current).filter(field => (isEmpty(field) || (prefilledWrong(field) && (!isChoiceField(field) || flagged)))
          && !(field.autocomplete && shared.skippable(field)) && !ctx.learnedTried.has(`${ctx.current.url}|${field.ref}`)
          && !(labelOf(field) in ctx.filledKeys)
          && !['password', 'file', 'radio', 'checkbox'].includes(fieldType(field)) && ctx.values.has(fieldKey(field)));
        // Questions the qa registry already answers: empty radio groups (when an option states the answer) and native
        // selects are filled straight from it, with no model call.
        const registryKey = field => {
          if (todayField(field)) return 'facts.today';
          const policy = policyKey(labelOf(field));
          if (policy || isControlledNameQuestion(labelOf(field))) return policy;
          return `qa.${answers.normalize(labelOf(field))}`;
        };
        // A required native select that offers exactly one real option (the only region, the only program year)
        // has no decision in it: that option is its answer for this run.
        for (const field of activeFields(ctx.current)) {
          const real = (field.options ?? []).filter(option => !PLACEHOLDER_OPTION.test(String(option)));
          const key = registryKey(field);
          if (field.tag === 'select' && field.required && isEmpty(field) && real.length === 1 && key && !ctx.values.has(key)) {
            ctx.values.set(key, String(real[0]));
          }
        }
        const answered = activeFields(ctx.current).filter(field => isEmpty(field) && !ctx.learnedTried.has(`${ctx.current.url}|${field.ref}`)
          && !known.includes(field) && !(field.autocomplete && shared.skippable(field)) && ctx.values.has(registryKey(field))
          && (isChoiceField(field) || !['radio', 'checkbox', 'file', 'password', 'hidden'].includes(fieldType(field))
            || (fieldType(field) === 'radio' && (field.options ?? []).some(option => answers.normalize(option) === answers.normalize(ctx.values.get(registryKey(field)))))));
        // A custom dropdown still on its placeholder whose question the registry (or a fact learned for the same
        // question) already answers: choose that answer.
        const dropdownKey = control => {
          if (todayField(control)) return 'facts.today';
          const policy = policyKey(questionOf(control.label));
          if (policy || isControlledNameQuestion(questionOf(control.label))) return policy;
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
            const value = ctx.values.get(registryKey(field)) ?? ctx.values.get(fieldKey(field));
            if (typeof value !== 'string' || !value) return [];
            return field.optionRefs.filter((ref, index) => ref && !field.checkedRefs?.includes(ref)
              && !ctx.learnedTried.has(`${ctx.current.url}|${ref}`) && named(field.options?.[index] ?? '', value));
          })[0];
        // execute() commits at most one searchable widget before re-observing. Do not spend the once-per-field
        // replay guard on other widgets that would only be dropped from that batch.
        const batch = [];
        // A required name field whose fact does not exist has no correct answer: stop rather than let a model or a
        // learned template put another name fact in it.
        const missingName = activeFields(ctx.current).find(field => field.required && isEmpty(field)
          && isControlledNameQuestion(labelOf(field)) && !fieldKey(field));
        if (missingName) shared.needsField(missingName, 'no stored name fact');
        let autocompletePlanned = false;
        for (const field of [...known, ...answered]) {
          if (field.autocomplete && autocompletePlanned) continue;
          batch.push({ ref: field.ref, key: known.includes(field) ? fieldKey(field) : registryKey(field) });
          autocompletePlanned ||= Boolean(field.autocomplete);
          if (batch.length === 8) break;
        }
        // Cross-tenant question memory (lib/apply/questions.mjs): a question another tenant of this ATS family already
        // answered — same normalized text, same option set — is filled from that decision with no model call. A
        // policy-owned question never reaches here (the policy answers it), and a name question is never replayed.
        let memorised = 0;
        for (const field of activeFields(ctx.current)) {
          if (batch.length === 8) break;
          if (!isEmpty(field) || field.autocomplete || known.includes(field) || answered.includes(field)
            || ctx.learnedTried.has(`${ctx.current.url}|${field.ref}`)
            || ['password', 'file', 'hidden', 'textarea'].includes(fieldType(field))) continue;
          const answer = shared.questionAnswer(field, policyKey(labelOf(field)));
          if (!answer) continue;
          if (answer.value !== null && !ctx.values.has(answer.key)) ctx.values.set(answer.key, answer.value);
          if (!ctx.values.has(answer.key)) continue;
          ctx.learnedTried.add(`${ctx.current.url}|${field.ref}`);
          batch.push({ ref: field.ref, key: answer.key });
          memorised += 1;
        }
        // A family template replays what past tenants of this ATS taught it, ahead of the per-label batch.
        const templated = shared.templatePlan();
        if (templated) {
          ctx.outcome = { plan: templated, confidence: 1 };
          ctx.source = 'template';
        } else if (batch.length) {
          for (const item of batch) ctx.learnedTried.add(`${ctx.current.url}|${item.ref}`);
          ctx.outcome = { plan: { action: 'fill', fields: batch }, confidence: 1 };
          ctx.source = memorised && memorised === batch.length ? 'questions' : known.length ? 'learned' : 'registry';
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
          // A date part under a question ("…anticipated graduation date? Month") is no text question: it takes its
          // part of the stored date through the field mapping (fields.mjs isDateBox/asksDate).
          const dateBox = field => isDateBox(field) || asksDate(field);
          const asks = field => fieldType(field) === 'textarea'
            || /\?|^(tell|describe|explain|why|what|how|which|please (tell|describe|explain|share|list|provide))\b/i.test(labelOf(field));
          const questions = activeFields(ctx.current).filter(field => isEmpty(field) && !field.autocomplete && asks(field) && !dateBox(field)
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
        // Fields of a section the stored facts say nothing about are not offered to Jev at all (a Certification box
        // whose entry nothing can fill), nor are the section's own "Add" controls: the entry they open is removed. A
        // disclosure question in such a section ("Have you ever held a security clearance?") stays: the facts answer it.
        for (const field of activeFields(ctx.current)) {
          if (isEmpty(field) && !disclosureQuestion(field) && factlessSection(`${labelOf(field)} ${field.context ?? ''}`, ctx.values)) skipFields.add(field.ref);
        }
        for (const control of ctx.current.controls) {
          if (exclude.has(`click:${control.ref}`) || !isAddControl(control)) continue;
          const section = await factlessAdd(control);
          if (!section) continue;
          exclude.add(`click:${control.ref}`);
          // Said once per screen: the driver is never offered the control, and the log names the reason the way a
          // refused plan does, so a run that never opens such an entry says why.
          if (!ctx.refused.actions.has(`click:${control.ref}`)) {
            ctx.refused.actions.add(`click:${control.ref}`);
            // The trace carries the refusal the way a refused plan does, so an audit of the run finds the reason.
            runlog.trace('refused', { source: 'jev', action: `click:${control.ref}`, reason: `invalid-plan factless-section ${section}` });
            shared.say(`REFUSED click:${control.ref} (factless-section ${section}); not offering "${clean(control.label)}" to the driver`);
          }
        }
        try { ctx.outcome = await drive(modelView(ctx.current), { goal, ...ctx.context, exclude, skipFields }); }
        catch (error) {
          runlog.trace('error', { phase: 'drive', message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 600) });
          throw new Stop('driver-error', 1);
        }
        runlog.trace('jev', { goal, plan: ctx.outcome?.plan ?? null, confidence: ctx.outcome?.confidence ?? 0, ...ctx.outcome?.trace });
        if (ctx.outcome?.trace?.reused) shared.say('JEV reused the last verdicts: screen and questions unchanged (no request)');
        // Keep ref verdicts even for an unlabeled field or a dropdown trigger. Workday reuses URLs (and refs)
        // between steps, so these belong to the exact screen fingerprint, never just the URL or the last outcome.
        if (ctx.noAnswerScreen !== ctx.screen) {
          ctx.noAnswerScreen = ctx.screen;
          ctx.noAnswerRefs = new Set();
        }
        for (const [ref, answer] of Object.entries(ctx.outcome?.trace?.fieldAnswers ?? {})) {
          if (answer === 'none') ctx.noAnswerRefs.add(ref);
          else ctx.noAnswerRefs.delete(ref);
        }
        // Named optional empty fields also teach later runs; the ref verdict above needs no persistent label.
        const unanswerable = activeFields(ctx.current).filter(field => !field.required && isEmpty(field)
          && ctx.outcome?.trace?.fieldAnswers?.[field.ref] === 'none' && learnLabel(field) && !ctx.learned.noAnswer.includes(learnLabel(field)));
        if (unanswerable.length) {
          ctx.learned.noAnswer = [...ctx.learned.noAnswer, ...new Set(unanswerable.map(learnLabel))].slice(-500);
          await saveLearned(ctx.learned);
        }
        // The fresh verdict can remove the rule's last blocker. Use it now instead of paying for another driver
        // call or a planner consult to discover that the same Save and Continue is safe.
        if (!ctx.outcome?.plan) {
          const rule = shared.rulePlan(ctx.current, ctx.screen);
          if (rule) {
            ctx.outcome = { ...ctx.outcome, plan: rule.plan, confidence: 1 };
            ctx.source = 'rule';
            shared.say(`RULE ${clean(rule.why)}`);
            break;
          }
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
      // Stalls measure the driver repeating the same action on an unchanged screen; executing a queued/learned plan,
      // or moving on to a different action, is not a stall. The action is identified by what it is (verb and label or
      // answer keys), never by its ref: Workday re-renders a group after one answer and re-mints every ref, so a
      // ref-keyed mark never matches and the brake re-arms — a stuck screen then burned 30-50 model calls
      // (2026-10-17T22-25-22-061Z: 462 calls on one Application Questions screen). The mark also leaves refs out of
      // the plan for the same reason.
      const planKey = ctx.outcome?.plan ? shared.actionKeyOf(ctx.outcome.plan) ?? ctx.outcome.plan.action : null;
      const fingerprint = screenFingerprint(ctx.current);
      const mark = `${ctx.goals[0].goal}\u0000${fingerprint}\u0000${planKey}`;
      ctx.stalls = ctx.source !== 'jev' ? 0 : mark === ctx.lastMark ? ctx.stalls + 1 : 0;
      ctx.lastMark = ctx.source === 'jev' ? mark : null;
      // Alternating steps (open list A, open list B, A, B…) never repeat back to back, so they also count as a stall
      // once the same step comes up a third time on the same screen.
      const repeatKey = ctx.source === 'jev' && planKey ? `${ctx.screen}\u0000${planKey}` : null;
      const repeats = repeatKey ? (ctx.screenRepeats.get(repeatKey) ?? 0) + 1 : 0;
      if (repeatKey) ctx.screenRepeats.set(repeatKey, repeats);
      // Early stop, calibrated on the Workday traces of 2026-10-15..17 (replay over the 904 submitted runs stops
      // none): Workday re-renders its step rail around every click, so "Save and Continue" flickers in and out of
      // the fingerprint and the same plan re-appears on a screen that looks untouched while the run is genuinely
      // working (submitted runs repeated a label-identical plan up to 22 times and still finished). A repeat is
      // therefore only a signal once it has cost a budget of calls, and a long grind is bounded on its step:
      //  - FP_BUDGET 23: the p99 of calls per screen on submitted runs, plus margin. A plan repeated after that many
      //    calls on one unchanged fingerprint is going nowhere;
      //  - STEP_BUDGET 160: no submitted run ever spent more than 158 calls on one step without an accepted answer
      //    (2026-10-17T22-25-22-061Z burned 462 on Application Questions); the memory fix removes the stretches that
      //    reached 158 (work-authorization re-asks), so this bound only catches loops like that one.
      const calls = runlog.callsMade();
      if (ctx.outcome?.plan && planKey && ctx.screen !== null) {
        const seen = (ctx.actionRepeats.get(`${fingerprint}\u0000${planKey}`) ?? 0) + 1;
        ctx.actionRepeats.set(`${fingerprint}\u0000${planKey}`, seen);
        if (seen >= 2 && calls - ctx.loopMark >= FP_BUDGET) {
          throw new Stop(`unchanged-screen-repeat action=${clean(planKey).slice(0, 80)} calls=${calls - ctx.loopMark} screen=${ctx.screenConsults} run=${ctx.consultsTotal}`);
        }
      }
      if (calls - ctx.stepMark >= STEP_BUDGET) {
        throw new Stop(`screen-loop calls=${calls - ctx.stepMark} step="${clean(ctx.step || 'unnamed')}" run=${calls}`);
      }
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
        if (consultLimited(ctx)) throw new Stop(`consult-limit screen=${ctx.screenConsults} run=${ctx.consults} total=${ctx.consultsTotal}`);
        shared.say(`CONSULT ${clean(reason)} goal="${clean(ctx.goals[0].goal)}"`);
        await shared.replan(ctx, ctx.current, { goal: ctx.goals[0], reason, recent: [...ctx.recent] }, ctx.context);
        // Two consults that returned the identical plan with nothing done in between mean the planner has no new idea
        // for this screen (the same actions are refused again): stop on its own reason instead of re-asking until the
        // run-wide budget is gone. The signature is label-based: a re-rendered page re-mints refs, and a ref-keyed
        // signature made every repeated plan look new.
        const sig = ctx.queued.length
          ? JSON.stringify(ctx.queued.map(action => shared.actionKeyOf(action) ?? action.action))
          : null;
        if (sig && sig === ctx.consultSig) throw new Stop(`planner-refused-loop screen=${ctx.screenConsults} run=${ctx.consults} total=${ctx.consultsTotal}`);
        ctx.consultSig = sig;
        ctx.stalls = 0;
        ctx.lastMark = null;
        return 'again';
      }
      ctx.plan = ctx.outcome.plan;
      // The policy is the last word on a work-rights, age, or inverted-boolean field: template, learned,
      // remembered-site, writer, and model plans all pass here, so none can carry a stale generic fact or a site
      // answer over the deterministic answer.
      if (ctx.plan.action === 'fill' && Array.isArray(ctx.plan.fields)) {
        ctx.plan = { ...ctx.plan, fields: ctx.plan.fields.map(item => {
          const field = activeFields(ctx.current).find(candidate => candidate.ref === item.ref);
          const key = field && policyKey(labelOf(field));
          return key ? { ...item, key } : item;
        }) };
      } else if (ctx.plan.action === 'choose') {
        const target = ctx.current.controls.find(control => control.ref === ctx.plan.ref)
          ?? activeFields(ctx.current).find(field => field.ref === ctx.plan.ref);
        const key = target && policyKey(labelOf(target));
        if (key) ctx.plan = { ...ctx.plan, key };
      }
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
            // An "Add" that opens an entry in a section the stored facts say nothing about is refused outright: the
            // entry's required field has no answer, so it can only end in a fabrication or a deleted entry.
            const target = ctx.current.controls.find(control => control.ref === ctx.plan.ref)
              ?? activeFields(ctx.current).find(field => field.ref === ctx.plan.ref);
            const section = await factlessAdd(target);
            if (section) invalidPlan(`factless-section ${section}`);
            // A picked option no stored value names is a fabrication in any section (Jev suggesting "Six Sigma -
            // Black Belt" for an empty Certification box): the pick is refused and the field stays as the site has it.
            if (ctx.plan.action === 'click' && ungroundedOption(ctx.current, ctx.plan.ref, storedFor)) invalidPlan('ungrounded-option');
            if (!(ctx.plan.action === 'click' && isChoiceField(activeFields(ctx.current).find(field => field.ref === ctx.plan.ref)))) currentControl(ctx.current, ctx.plan.ref, { moreEntries: shared.moreEntries(ctx.current), allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting, values: ctx.values });
          }
          else if (ctx.plan.action === 'check') checkTarget(ctx.current, ctx.plan.ref, ctx.allowSubmit);
          else if (ctx.plan.action === 'upload_resume') {
            // Some sites clear the file input after taking the file, so it reads empty again; a field label gets at
            // most two uploads per page, then the upload counts as done and Jev must move on. A resume slot on a
            // screen that already lists the resume as attached (Workday's My Experience after "Autofill with Resume")
            // is filled too: its input is just the dropzone for more files.
            const { field, kind } = documentField(ctx.current, ctx.plan.ref, ctx.resumeAvailable, ctx.transcriptAvailable);
            if (kind === 'cover' && ctx.writerFailed.has(`${ctx.current.url}|${labelOf(field)}`)) invalidPlan('cover-letter-failed');
            if ((ctx.uploads.get(`${ctx.current.url}|${labelOf(field)}`) ?? 0) >= 2) invalidPlan('already-uploaded');
            const resumeName = ctx.resumeAvailable ? String(ctx.resume ?? '').split('/').pop() : '';
            if (kind === 'resume' && resumeName && ctx.current.controls.some(control => control.attached === resumeName)) invalidPlan('already-uploaded');
          }
          else if (ctx.plan.action === 'credentials') { if (!passwordFields(ctx.current).length) invalidPlan('password-fields'); }
          else {
            // A fill batch keeps its valid items; one occupied or unmatched field does not void the rest. On a
            // stalled screen an occupied choice field may be re-committed once with its own value.
            const recommit = stalledRecommit(ctx);
            const kept = ctx.plan.fields.filter(item => {
              try {
                // A value typed into a section field no stored answer covers (a Certification, a License) is a
                // fabrication whichever planner proposed it; the entry is removed instead (steprules.removeOpenEntry).
                // A stored answer for the field itself always stands, however the section reads: the veteran-status
                // fact is a "no" answer to a required disclosure question, not a military-service entry.
                const field = activeFields(ctx.current).find(candidate => candidate.ref === item.ref);
                const section = field && !storedFor(field) && !disclosureAnswer(field, ctx.values.get(item.key), item.key)
                  && factlessSection(`${labelOf(field)} ${field.context ?? ''}`, ctx.values);
                if (section) invalidPlan(`factless-section ${section}`);
                resolveFill(ctx.current, item, ctx.values, recommit, ctx.workAuthorization);
                return true;
              }
              catch (error) {
                if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ')) throw error;
                runlog.trace('refused', { source: ctx.source, action: `fill:${item.ref}`, reason: error.message });
                if (ctx.source === 'template') shared.templateRefused([item.ref], error.message);
                return false;
              }
            });
            if (!kept.length) resolveFill(ctx.current, ctx.plan.fields[0], ctx.values, recommit, ctx.workAuthorization);
            ctx.plan.fields = kept;
          }
        } catch (error) {
          if (!(error instanceof Stop) || !error.message.startsWith('invalid-plan ') || error.message.startsWith('invalid-plan final-submit')) throw error;
          runlog.trace('refused', { source: ctx.source, action: actionKey, reason: error.message });
          // A refused fill item was already counted above; the whole-plan refusal is for every other action.
          if (ctx.source === 'template' && ctx.plan.action !== 'fill') shared.templateRefused([ctx.plan.ref], error.message);
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
