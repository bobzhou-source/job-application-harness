// The model-guided list picker (pickOne): opening one choice widget step by step and committing the pick.

import * as act from '../act.mjs';
import { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } from '../planner.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';
import { validatePlan, resolveFill, documentField, instructionsOf, passwordFields, sameTarget, freshRef, resumeIsReadable, SECRET_KEY } from './plan.mjs';

// "Other" / "Other (please specify)" list entries, and the free-text field that takes the unlisted answer.
const OTHER_OPTION = /^other\b(?!\s+than\b)/;
const OTHER_FIELD = /^(if\s+)?other\b|\bplease specify\b/i;

export function installPicker(ctx, shared) {
    // A choice is committed only through this field's owned options, never a nearby unrelated popup.
    // Category rows can open another owned list: re-observe each level, bounded to four picks.
    async function pickOne(current, field, key, value, listItem = false) {
      // This run already settled the field on "Other" (the answer is not listed): picking again only repeats that.
      if (ctx.otherChosen.has(labelOf(field)) && OTHER_OPTION.test(answers.normalize(field.value))) return;
      let fresh = await shared.openField(current, field);
      let target = shared.findField(fresh, field);
      if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
      if (listItem && shared.choicesFor(fresh, target.ref).some(option => option.multi)) throw new shared.MultiList();
      ctx.typed[target.ref] = value;
      // The registry's answer to exactly this question ("Nationality" → "American") is the last equivalent of the
      // planned value (facts.country "United States"), for lists that phrase the answer that way.
      const asked = ctx.values.get(`qa.${answers.normalize(labelOf(field))}`);
      const candidates = [...new Set([...shared.aliasesFor(key, value), ...(typeof asked === 'string' && asked.trim() ? [asked] : [])])];
      const equivalent = candidates.map(answers.normalize);
      // A suggestion that extends the stored answer ("42 Oak Street" → "42 OAK STREET, FAIRVIEW, OREGON, 97000") is the
      // same answer with context; among several, the one naming the most other stored facts
      // (city, ZIP) wins.
      const facts = [...ctx.values].filter(([name, fact]) => name.startsWith('facts.') && typeof fact === 'string' && fact.length >= 3)
        .map(([, fact]) => answers.normalize(fact));
      // Aliases are in preference order ("Computer Engineering", "Computer Science", …, "Engineering"): each alias in turn
      // takes an option equal to it, else one extending it ("Computer Science …") or, for a multi-word alias, naming it
      // ("Applied Computer Science"), before the next alias is tried. The site's list order never decides.
      const exact = options => {
        for (const text of equivalent) {
          const equal = options.find(option => answers.normalize(option) === text);
          if (equal) return equal;
          const near = options.filter(option => {
            const shown = answers.normalize(option);
            // Containment only for multi-word aliases with a real word: an initialism ("B.A." → "b a") sits inside
            // others ("M.B.A." → "m b a").
            return (text.length >= 4 && shown.startsWith(`${text} `))
              || (text.includes(' ') && text.split(' ').some(word => word.length > 1) && ` ${shown} `.includes(` ${text} `));
          });
          if (near.length) return near.map(option => [option, facts.filter(fact => ` ${answers.normalize(option)} `.includes(` ${fact} `)).length])
            .sort((a, b) => b[1] - a[1])[0][0];
        }
        return undefined;
      };
      let shown = shared.choicesFor(fresh, target.ref);
      // A choice the model matched in a filtered list, used by the pick loop below when no exact match exists.
      let preferred = null;
      // The dropdown's own search box (select2: "Search Discipline") is often appended to <body>, outside the form:
      // look in all fields.
      const compact = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const searchBoxOf = (snap, owner) => snap.fields.find(other => other.ref !== owner.ref
        && compact(labelOf(other)).startsWith(`search${compact(labelOf(owner)).slice(0, 12)}`));
      // A select-only dropdown with its own search box renders long lists in pages, so an absent answer may simply
      // not be loaded: search for the answer and each alias there.
      if (!(target.tag === 'input' && fieldType(target) !== 'select') && shown.length && !exact(shown.map(option => option.label))) {
        const searchBox = searchBoxOf(fresh, target);
        if (searchBox) {
          // Remote lists show a status row ("Searching…", "No results found") until results arrive; that row is no choice.
          const settled = async () => {
            for (let wait = 0; ; wait++) {
              await shared.pause(wait ? 500 : 800);
              fresh = await shared.freshSnapshot(current);
              target = shared.findField(fresh, field);
              if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
              const listed = shared.choicesFor(fresh, target.ref).filter(option => !LIST_STATUS.test(clean(option.label)));
              if (listed.length || wait >= 6) return listed;
            }
          };
          for (const search of [...new Set([...candidates, value.trim().split(/\s+/)[0]])]) {
            await mutate('FILL', labelOf(searchBox), () => act.type(ctx.page, searchBox.ref, search, { secret: true }));
            const filtered = await settled();
            if (exact(filtered.map(option => option.label))) { shown = filtered; break; }
          }
          // Nothing matched: the model chooses from the unfiltered list.
          if (!exact(shown.map(option => option.label))) {
            await mutate('FILL', labelOf(searchBox), () => act.type(ctx.page, searchBox.ref, '', { secret: true }));
            const full = await settled();
            if (full.length) shown = full;
          }
        }
      }
      if (target.tag === 'input' && fieldType(target) !== 'select' && !exact(shown.map(option => option.label))) {
        // The answer, then each stored alias, then its first word: a list without "Computer Engineering" may list
        // "Engineering". Search-on-Enter widgets (prompt fields) show nothing new until Enter (an open prompt keeps its
        // unfiltered list on screen), and remote lookups lag.
        for (const search of [...new Set([...candidates, value.trim().split(/\s+/)[0]])]) {
          const unfiltered = JSON.stringify(shown.map(option => option.label));
          await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, search, { secret: true }));
          let entered = false;
          for (let wait = 0; wait < 5; wait++) {
            await shared.pause(1000);
            fresh = await shared.freshSnapshot(current);
            target = shared.findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            shown = shared.choicesFor(fresh, target.ref);
            const unchanged = shown.length && JSON.stringify(shown.map(option => option.label)) === unfiltered;
            if (shown.length && (!unchanged || entered)) break;
            if (wait >= 1 && !entered) { await act.searchEnter(ctx.page, target.ref); entered = true; }
          }
          if (exact(shown.map(option => option.label))) break;
          // A list the search actually narrowed (aliases run in preference order) is offered to the choice step right
          // away: "Computer Science" narrowing to "Computer and Information Science" beats a later alias's list.
          const real = shown.filter(option => !LIST_STATUS.test(clean(option.label)));
          if (real.length && JSON.stringify(shown.map(option => option.label)) !== unfiltered) {
            preferred = await shared.chooseOption(labelOf(field), value, real.map(option => option.label), candidates);
            if (preferred) break;
          }
        }
        // No listed match for any search: a filtered list ("Currently" leaves only "I'm not currently enrolled…") can
        // hide the right choice. The filtered list is offered to the choice step first; only when nothing there fits
        // is the search cleared and the full list offered instead (long lists render just their first entries, so
        // the filtered one is preferred).
        if (!preferred && shown.length && !exact(shown.map(option => option.label))) {
          preferred = await shared.chooseOption(labelOf(field), value, shown.map(option => option.label), candidates);
        }
        if (!preferred && (!shown.length || !exact(shown.map(option => option.label)))) {
          await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, '', { secret: true }));
          fresh = await shared.openField(current, target);
          target = shared.findField(fresh, field);
          if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
          const full = shared.choicesFor(fresh, target.ref);
          if (full.length) shown = full;
        }
        // A curated list without the answer (a school list missing the applicant's school) that comes with an
        // "Other …" companion field takes its "Other" entry; the companion field then gets the real answer.
        const companion = activeFields(fresh).some(other => other.ref !== target.ref && OTHER_FIELD.test(labelOf(other)));
        if (companion && !exact(shown.map(option => option.label))) {
          await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, 'Other', { secret: true }));
          // Remote lookups answer a few hundred ms to seconds after typing.
          let other = null;
          for (let wait = 0; wait < 4 && !other; wait++) {
            await shared.pause(800);
            fresh = await shared.freshSnapshot(current);
            target = shared.findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            other = shared.choicesFor(fresh, target.ref).find(option => /^other\b/.test(answers.normalize(option.label)));
          }
          if (other) {
            currentControl(fresh, other.ref, { allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
            await mutate('CLICK', labelOf(field), () => act.click(ctx.page, other.ref));
            shared.say(`CHOOSE ${labelOf(field)} = "${clean(other.label)}" (not listed; the "Other" field takes it)`);
            ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(other.label)}"; put "${value}" in the matching "Other …" field`);
            ctx.otherChosen.add(labelOf(field));
            return;
          }
          shown = shared.choicesFor(fresh, target.ref);
        }
      }
      if (!shown.length && (target.tag === 'select' || fieldType(target) === 'select')) {
        // Exact matches are checked against every option (an alias like "BA" shares no word with the answer, so a
        // long list trimmed by the answer's words drops it); the model chooses from the trimmed list only.
        const all = await act.selectOptions(ctx.page, target.ref, value, Infinity);
        const listed = all.length > 40 ? await act.selectOptions(ctx.page, target.ref, candidates.join(' ')) : all;
        let option = exact(all) ?? (listed.length ? await shared.chooseOption(labelOf(field), value, listed, candidates) : null);
        // The key's value names no option (a follow-up "Source" listing campuses under "How did you hear: Campus"):
        // the writer picks the one option the applicant facts support, with the field's own context, once per field.
        const real = all.filter(choice => !PLACEHOLDER_OPTION.test(String(choice))).map(String);
        if (!option && real.length >= 2 && real.length <= 60 && !ctx.writeTried.has(`${current.url}|pref|${labelOf(field)}`)) {
          ctx.writeTried.add(`${current.url}|pref|${labelOf(field)}`);
          const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(ctx.postingText || current.pageText || '').slice(0, 3000) };
          const question = [labelOf(field), clean(field.context ?? '')].filter(Boolean).join(' — ').slice(0, 300);
          option = await pickPreference({ job, applicant: await shared.writerApplicant(), question, options: real });
          shared.say(`WRITER choice "${clean(labelOf(field))}" = ${option ? `"${clean(option)}"` : 'none'} (no option matched ${key})`);
          if (option) shared.remember(labelOf(field), option);
        }
        // A long curated list without the answer (a school list missing the applicant's school) takes its "Other"
        // entry; the "If other, please specify" field it reveals then gets the real answer.
        const otherChoice = !option && all.map(String).find(choice => OTHER_OPTION.test(answers.normalize(choice)));
        if (otherChoice) {
          option = otherChoice;
          ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(otherChoice)}"; put "${value}" in the "If other, please specify" field it reveals`);
          ctx.otherChosen.add(labelOf(field));
          shared.say(`CHOOSE ${labelOf(field)} = "${clean(otherChoice)}" (not listed; the "Other" field takes it)`);
        }
        if (!option) shared.needsField(field, listed.length ? 'no option matches the stored answer or its aliases' : 'opening the widget exposed no owned options');
        await mutate('SELECT', labelOf(target), () => act.select(ctx.page, target.ref, option));
        return;
      }
      const visited = new Set();
      for (let depth = 0; depth < 4; depth++) {
        const signature = JSON.stringify(shown.map(option => [option.label, !!option.selected]));
        if (!shown.length || visited.has(signature)) shared.needsField(field, 'opening and picking did not commit a choice');
        visited.add(signature);
        // A child list under the chosen parent ("Other" → "Source Not Listed") with one entry is the only completion.
        let label = exact(shown.map(option => option.label))
          ?? (preferred && shown.some(option => option.label === preferred) ? preferred : null)
          ?? (depth > 0 && shown.length === 1 ? shown[0].label : null)
          ?? await shared.chooseOption(labelOf(field), value, shown.map(option => option.label), candidates);
        preferred = null;
        // The key's value names no listed option (a yes/no answer under "Undergraduate"/"Graduate"): the writer picks
        // the one option the applicant facts support, once per field, as for native selects above.
        const real = shown.map(option => option.label).filter(choice => !PLACEHOLDER_OPTION.test(String(choice)));
        if (!shown.some(candidate => candidate.label === label) && real.length >= 2 && real.length <= 60
            && !ctx.writeTried.has(`${current.url}|pref|${labelOf(field)}`)) {
          ctx.writeTried.add(`${current.url}|pref|${labelOf(field)}`);
          const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(ctx.postingText || current.pageText || '').slice(0, 3000) };
          const question = [labelOf(field), clean(field.context ?? '')].filter(Boolean).join(' — ').slice(0, 300);
          label = await pickPreference({ job, applicant: await shared.writerApplicant(), question, options: real });
          shared.say(`WRITER choice "${clean(labelOf(field))}" = ${label ? `"${clean(label)}"` : 'none'} (no option matched ${key})`);
          if (label) shared.remember(labelOf(field), label);
        }
        let option = shown.find(candidate => candidate.label === label);
        // Nothing listed fits: the list's "Other" entry (searched for when the list pages or filters) takes the pick,
        // and the "If other, please specify" field it reveals gets the real answer.
        if (!option && depth === 0) {
          option = shown.find(candidate => OTHER_OPTION.test(answers.normalize(candidate.label)));
          const typeable = owner => owner.tag === 'input' && fieldType(owner) !== 'select' ? owner : null;
          let box = !option && (searchBoxOf(fresh, target) ?? typeable(target));
          // A list that closed while it was read (select2 drops its search box with the popup) is opened again.
          if (!option && !box) {
            fresh = await shared.openField(current, target);
            target = shared.findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            box = searchBoxOf(fresh, target) ?? typeable(target);
          }
          if (box) {
            await mutate('FILL', labelOf(box), () => act.type(ctx.page, box.ref, 'Other', { secret: true }));
            for (let wait = 0; wait < 5 && !option; wait++) {
              await shared.pause(800);
              fresh = await shared.freshSnapshot(current);
              target = shared.findField(fresh, field);
              if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
              shown = shared.choicesFor(fresh, target.ref);
              option = shown.find(candidate => OTHER_OPTION.test(answers.normalize(candidate.label)));
            }
          }
          if (option) {
            ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(option.label)}"; put "${value}" in the "If other, please specify" field it reveals`);
            ctx.otherChosen.add(labelOf(field));
            shared.say(`PICK ${labelOf(field)}: "${clean(value)}" not listed; choosing "${clean(option.label)}"`);
          }
        }
        if (!option) shared.needsField(field, `no owned option matches the stored answer or its aliases (shown: ${shown.slice(0, 6).map(candidate => `"${clean(candidate.label).slice(0, 40)}"`).join(', ')})`);
        // An empty field's "selected" option is only the keyboard highlight (Workday marks the first entry of a
        // freshly opened child list aria-selected): it still needs the click.
        if (option.selected && !isEmpty(target)) return;
        // A multi-select's chips (its value before this pick lists them) already hold this choice: clicking it again
        // in a list that keeps chosen options toggles it off. (After a typed search the live value is the search text.)
        if (depth === 0 && String(field.value ?? '').split(/\s*,\s*/).some(chip => answers.normalize(chip) === answers.normalize(option.label))) return;
        const checked = await shared.freshSnapshot(current);
        const owner = shared.findField(checked, field);
        const live = owner && shared.choicesFor(checked, owner.ref).find(candidate => candidate.ref === option.ref);
        if (!live) invalidPlan(`stale-target ${labelOf(field)}`);
        sameTarget(option, live);
        currentControl(checked, live.ref, { allowSubmit: ctx.allowSubmit, targetRole: ctx.targetRole, posting: ctx.posting });
        await mutate('CLICK', labelOf(field), () => act.click(ctx.page, live.ref));
        shared.say(`CHOOSE ${labelOf(field)} = "${clean(live.label)}"`);
        await shared.pause(600);
        fresh = await shared.freshSnapshot(current);
        target = shared.findField(fresh, field);
        if (!target) return;
        shown = shared.choicesFor(fresh, target.ref);
        // Some widgets close their list on blur, a tick after the choice handler updates the input.
        // Do not blur a newly opened child list: it still needs the next hierarchical pick.
        if (JSON.stringify(shown.map(option => [option.label, !!option.selected])) === signature && !isEmpty(target)) {
          await act.press(ctx.page, 'Tab');
          await shared.pause(400);
          fresh = await shared.freshSnapshot(current);
          target = shared.findField(fresh, field);
          if (!target) return;
          shown = shared.choicesFor(fresh, target.ref);
        }
        // A hierarchical list ("Other" → its sources) may fetch the child list a second or two after the click.
        for (let wait = 0; wait < 4 && shown.length && isEmpty(target)
          && JSON.stringify(shown.map(option => [option.label, !!option.selected])) === signature; wait++) {
          await shared.pause(600);
          fresh = await shared.freshSnapshot(current);
          target = shared.findField(fresh, field);
          if (!target) return;
          shown = shared.choicesFor(fresh, target.ref);
        }
        // A closed list whose choice has not shown yet: some widgets render the committed value a beat later.
        for (let wait = 0; wait < 3 && !shown.length && isEmpty(target); wait++) {
          await shared.pause(500);
          fresh = await shared.freshSnapshot(current);
          target = shared.findField(fresh, field);
          if (!target) return;
          shown = shared.choicesFor(fresh, target.ref);
        }
        // The field showing exactly the chosen option committed it, even while a stale "required" error from an earlier
        // Continue still marks it invalid (many sites re-validate only on the next submit).
        if (target.occupied === true || shown.some(candidate => candidate.selected && candidate.label === live.label)
          || (!shown.length && answers.normalize(target.value) === answers.normalize(live.label))
          || (!target.invalid && !isEmpty(target)
            && (!shown.length || answers.normalize(target.value) === answers.normalize(live.label)))) return;
      }
      shared.needsField(field, 'the owned choice hierarchy did not commit an answer after four picks');
    }

  return { pickOne };
}
