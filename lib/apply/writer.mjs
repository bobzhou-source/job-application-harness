// Model-written answers: the tailored resume, free-text answers (writeFor), the applicant dossier, and
// mapping a stored answer onto one of a list's choices.

import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import { drive, pickOption, plan as jevPlan } from '../jev.mjs';
import { coverLetter, coverLetterText, instructedDocument, tailoredResume } from '../coverletter.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import * as runlog from '../trace.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf, isDateBox } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';
import { localAnswers, resumeBullets, addAliases, learnAlias, loadLearned, saveLearned } from './values.mjs';
import { RE_CREATE_ACCOUNT, USER_GATE, NEVER_WRITE, USER_MEDIA, LINK_FIELD, RESUME_PATH_KEY } from './runtime.mjs';
import { applicationExpectation, applicationOption } from '../work-authorization.mjs';
import { Stop } from './stop.mjs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export function installWriter(ctx, shared) {
    const tailorResume = pageText => tailoredResume({ url: ctx.runUrl, title: ctx.runInfo.title ?? '', pageText, basePdf: ctx.resume })
      .catch(error => {
        runlog.trace('tailored-resume-error', { message: clean(error?.message).slice(0, 200) });
        shared.say(`RESUME not tailored (${clean(error?.message).slice(0, 120)}); using ${basename(ctx.resume)}`);
        return null;
      });

    // A stored answer no dropdown choice spells out: reuse the choice past runs mapped it to, else let Jev pick
    // the listed choice stating the same fact once and keep it in learned.json (choices: answer → choice texts).
    // `preferences` is the answer then its aliases in preference order (Computer Science before Engineering for the
    // major). A new mapping is appended, so the first-established (preferred) choices keep priority over later fallbacks.
    async function chooseOption(question, value, listed, preferences = [value]) {
      const options = listed.filter(Boolean);
      const questionKey = `qa.${answers.normalize(question)}`;
      if (applicationExpectation(question, ctx.workAuthorization, questionKey, value)) {
        return applicationOption(question, options, ctx.workAuthorization, questionKey, value);
      }
      // A catch-all ("Other", "None of the above") learned on one site is re-judged on another: the site may list a
      // concrete match, and a catch-all can leave a dependent required field (a "Source" list under "Other") empty.
      const vague = choice => /^(other|others|none( of (the )?above)?|not listed|n\/?a)\b/i.test(clean(choice));
      const learnedChoices = (ctx.learned.choices?.[answers.normalize(value)] ?? []).filter(choice => options.includes(choice));
      const known = learnedChoices.find(choice => !vague(choice));
      if (known) { shared.say(`LEARNED choice "${clean(known)}" for ${clean(question)}`); return known; }
      let option = null;
      try { option = await pickOption(question, value, options, preferences); } catch { option = null; }
      if (!option && learnedChoices.length) { shared.say(`LEARNED choice "${clean(learnedChoices[0])}" for ${clean(question)}`); return learnedChoices[0]; }
      if (!option) return null;
      const key = answers.normalize(value);
      ctx.learned.choices = { ...ctx.learned.choices, [key]: [...(ctx.learned.choices?.[key] ?? []).filter(choice => choice !== option), option].slice(-12) };
      await saveLearned(ctx.learned);
      shared.say(`LEARNED choice "${clean(option)}" for stored answer (${clean(question)})`);
      return option;
    }

    // The writer's view of the applicant: stored facts/qa (no secrets, no alias variants) plus profile.md (gitignored:
    // the writer dossier of stories, character, and voice), re-read each call so edits apply immediately.
    async function writerApplicant() {
      const applicant = { facts: {}, qa: {}, resume: {} };
      for (const [key, value] of ctx.values) {
        const [group, ...rest] = key.split('.');
        if (key !== SECRET_KEY && key !== RESUME_PATH_KEY && applicant[group] && !/\.(alt|alias)_\d+$/.test(key)) applicant[group][rest.join('.')] = String(value);
      }
      // Configured logistics (config.applicant): the writer states a preference only for true/nonempty values, so an
      // unset field makes no claim (never a "No").
      applicant.preferences = {
        relocateAnywhere: shared.config.applicant.relocateAnywhere,
        workInPerson: shared.config.applicant.workInPerson,
        summerAvailability: shared.config.applicant.summerAvailability,
      };
      applicant.workAuthorization = ctx.workAuthorization;
      try { applicant.profile = await readFile(new URL('../../profile.md', import.meta.url), 'utf8'); } catch { applicant.profile = ''; }
      return applicant;
    }

    // Free-text questions no stored answer fits: the writer model composes the applicant's answers (within each
    // field's limit and validation message); each joins this site's written answers, then fills like any stored answer.
    // A date box (a Day/Month/Year segment under a date question) is never prose: it takes its part of a stored date.
    // A link or handle field ("Please provide your Facebook profile:") is a fact or nothing (runtime.mjs LINK_FIELD).
    async function writeFor(current, refs) {
      const candidates = refs.map(ref => activeFields(current).find(field => field.ref === ref))
        .filter(field => field && !field.autocomplete && !['password', 'file', 'radio', 'checkbox', 'select', 'date', 'month', 'number'].includes(fieldType(field))
          && !isDateBox(field) && !NEVER_WRITE.test(answers.normalize(labelOf(field))) && !LINK_FIELD.test(answers.normalize(labelOf(field))));
      // A recording only the applicant can make: the writer never fills it with a promise to send one later.
      const media = candidates.find(field => field.required && USER_MEDIA.test(answers.normalize(labelOf(field))));
      if (media) throw new Stop(`needs-user-media: "${clean(labelOf(media)).slice(0, 100)}" wants a recording the applicant has to make`);
      const fields = candidates.filter(field => !USER_MEDIA.test(answers.normalize(labelOf(field))));
      if (!fields.length) return [];
      const applicant = await writerApplicant();
      const questions = fields.map(field => ({
        ref: field.ref, question: labelOf(field), ...(field.prompt ? { prompt: field.prompt } : {}), kind: fieldType(field), limit: limitOf(field),
        message: field.message ?? messageFor(current, labelOf(field)) ?? null,
      }));
      ctx.phase = 'writer';
      // The posting (captured before the form opened) tells the writer which stories this role cares about.
      const job = {
        title: current.title, site: credentials.hostFromUrl(current.url), country: ctx.workAuthorization.country,
        posting: String(ctx.postingText ?? '').slice(0, 4000), page: String(current.pageText ?? '').slice(0, 3000),
      };
      // A "Cover Letter" text box gets this posting's full tailored letter (the same one a file slot would get), not
      // a short essay; the rest go to the answer writer.
      const COVER_BOX = /^\s*(cover letter|letter of interest|cover letter text)\s*\*?\s*$/i;
      const written = {};
      for (const field of fields.filter(field => fieldType(field) === 'textarea' && COVER_BOX.test(labelOf(field)))) {
        const text = await coverLetterText({ url: ctx.runUrl, title: clean(current.title), employer: null, pageText: `${ctx.postingText}\n${String(current.pageText ?? '')}`.slice(0, 6000), basePdf: ctx.resume })
          .catch(error => { shared.say(`COVER letter text failed (${clean(error?.message).slice(0, 120)})`); return null; });
        const limit = limitOf(field);
        if (text && (!limit || text.length <= limit)) written[field.ref] = text;
      }
      const rest = questions.filter(question => !written[question.ref]);
      if (rest.length) Object.assign(written, await writeAnswers({ job, applicant, questions: rest }));
      runlog.trace('writer', { refs, written: Object.keys(written),
        // The full texts, so an audit can read what was actually submitted (runs/ is gitignored); keyed by ref with
        // the question each answered. The written answers themselves are site-scoped (accounts.mjs rememberForSite).
        answers: Object.fromEntries(fields.filter(field => written[field.ref]).map(field => [field.ref, { question: labelOf(field), text: written[field.ref] }])) });
      const fills = [];
      for (const field of fields) {
        if (!written[field.ref]) continue;
        const key = `qa.${answers.normalize(labelOf(field))}`;
        if (fieldType(field) === 'textarea') {
          ctx.values.set(key, written[field.ref]);
          ctx.essayKeys.add(key);
        } else {
          // Saved for later runs of this site only (model-composed text is posting-specific); this run fills the
          // written answer either way (a bare "County" label is not stored, yet its answer must reach the fill).
          shared.rememberForSite(labelOf(field), written[field.ref]);
          ctx.values.set(key, written[field.ref]);
        }
        fills.push({ ref: field.ref, key });
      }
      shared.say(`WRITER ${fills.length}/${fields.length} answers (${clean(fields.map(labelOf).join('; ')).slice(0, 160)})`);
      return fills;
    }

  return { tailorResume, chooseOption, writerApplicant, writeFor };
}
