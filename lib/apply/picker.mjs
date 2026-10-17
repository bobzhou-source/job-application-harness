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
import { applicationExpectation, applicationOption } from '../work-authorization.mjs';

// "Other" / "Other (please specify)" list entries, and the free-text field that takes the unlisted answer.
const OTHER_OPTION = /^other\b(?!\s+than\b)/;
// List entries that state no fact about the applicant. A concrete stored answer is never honestly
// answered by one, so the writer fallback never sees them as choices for a fact question.
const CATCH_ALL = /^(neither|none(\s+of\s+(the\s+)?above)?|not\s+applicable|n a|other|prefer\s+not\s+to|decline)/;
const OTHER_FIELD = /^(if\s+)?other\b|\bplease specify\b/i;
// USPS street-suffix and directional abbreviations, as address finders list them.
const USPS = { avenue: 'Ave', boulevard: 'Blvd', circle: 'Cir', court: 'Ct', drive: 'Dr', lane: 'Ln', parkway: 'Pkwy', place: 'Pl',
  road: 'Rd', street: 'St', terrace: 'Ter', trail: 'Trl', north: 'N', south: 'S', east: 'E', west: 'W', apartment: 'Apt', suite: 'Ste' };

export function installPicker(ctx, shared) {
    // A choice is committed only through this field's owned options, never a nearby unrelated popup.
    // Category rows can open another owned list: re-observe each level, bounded to four picks.
    async function pickOne(current, field, key, value, listItem = false) {
      // This run already settled the field on "Other" (the answer is not listed): picking again only repeats that.
      if (ctx.otherChosen.has(labelOf(field)) && OTHER_OPTION.test(answers.normalize(field.value))) return;
      let fresh = await shared.openField(current, field);
      let target = shared.findField(fresh, field);
      if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
      const policyExpectation = applicationExpectation(labelOf(field), ctx.workAuthorization, key, value, ctx.values, field.options ?? []);
      if (policyExpectation?.answer === null) shared.needsField(field, `no stored ${policyExpectation.family} fact`);
      if (listItem && shared.choicesFor(fresh, target.ref).some(option => option.multi)) throw new shared.MultiList();
      ctx.typed[target.ref] = value;
      // The registry's answer to exactly this question ("Nationality" → "American") is the last equivalent of the
      // planned value (facts.country "United States"), for lists that phrase the answer that way.
      const asked = ctx.values.get(`qa.${answers.normalize(labelOf(field))}`);
      // Address finders list USPS forms ("11788 Vermont Dr, Rancho Cucamonga, CA 91730" for "11788 Vermont Drive"):
      // an address key's value is also tried abbreviated.
      const abbreviated = /address|street/i.test(key)
        ? value.replace(/\b(avenue|boulevard|circle|court|drive|lane|parkway|place|road|street|terrace|trail|north|south|east|west|apartment|suite)\b\.?/gi, word => USPS[word.toLowerCase().replace('.', '')])
        : value;
      const candidates = [...new Set([...shared.aliasesFor(key, value), ...(abbreviated !== value ? [abbreviated] : []),
        ...(typeof asked === 'string' && asked.trim() ? [asked] : [])])];
      const equivalent = candidates.map(answers.normalize);
      // How the committed option was chosen, for the CHOOSE trace line ("← key via how"; lib/report/ledger.mjs):
      // exact (stored answer or alias), lead, model (choice step among listed options), writer (preference pick),
      // other, only (single child entry).
      let how = 'exact';
      // A concrete stored answer (non-empty, and not itself a catch-all like "Neither"): a writer pick for this
      // field then must state the same fact, so a catch-all entry is never offered or remembered for it. That holds
      // only for the field's own answer — a fact, the registry's entry for this question, the mapping learned for its
      // label. A planner's guess of another question's key ("are you 18 years of age or older" = Yes for a
      // California-applicants waiver) states nothing about this field, and its honest option may be "Not applicable".
      const ownKey = /^facts\./.test(String(key ?? '')) || ctx.learned?.fields?.[learnLabel(field)] === key
        || answers.normalize(String(key ?? '').replace(/^qa\./, '')) === answers.normalize(questionOf(labelOf(field)));
      const concrete = ownKey && !!String(value ?? '').trim() && !CATCH_ALL.test(answers.normalize(value));
      // A suggestion that extends the stored answer ("42 Oak Street" → "42 OAK STREET, FAIRVIEW, OREGON, 97000") is the
      // same answer with context; among several, the one naming the most other stored facts
      // (city, ZIP) wins.
      const facts = [...ctx.values].filter(([name, fact]) => name.startsWith('facts.') && typeof fact === 'string' && fact.length >= 3)
        .map(([, fact]) => answers.normalize(fact));
      // Aliases are in preference order ("Computer Engineering", "Computer Science", …, "Engineering"): each alias in turn
      // takes an option equal to it, else one extending it ("Computer Science …") or, for a multi-word alias, naming it
      // ("Applied Computer Science"), before the next alias is tried. The site's list order never decides.
      const exact = (options, limit = equivalent.length) => {
        if (policyExpectation) return applicationOption(labelOf(field), options, ctx.workAuthorization, key, value, ctx.values);
        for (const text of equivalent.slice(0, limit)) {
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
      // A stored answer that names a listed option and then qualifies it ("Junior (class of 2029)" → "Junior",
      // "Bachelor of Arts (BA)" → "Bachelor of Arts") is that option, decided before any model pick. The option
      // label must be the answer's leading words, followed by end, whitespace, or a qualifier mark; a comma starts
      // a new statement instead ("Yes, I will require sponsorship" is not the option "Yes"), and the longest
      // matching label wins so a full option beats a shorter one that merely starts the same way.
      const leadMatch = options => {
        const tidy = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        for (const candidate of candidates) {
          const text = tidy(candidate);
          const matches = options.filter(option => {
            const label = tidy(option);
            return label.length > 0 && (text === label || (text.startsWith(label) && ' (-/:'.includes(text[label.length])));
          });
          if (matches.length) return matches.sort((a, b) => tidy(b).length - tidy(a).length)[0];
        }
        return undefined;
      };
      let shown = shared.choicesFor(fresh, target.ref);
      // A select-only widget fetching its list on open (Workday's Language list) shows no rows for a beat: it is
      // read again before its answer is judged unlisted. A native select's options are read from the element itself.
      for (let wait = 0; wait < 4 && !shown.length && target.tag !== 'select' && target.tag !== 'input'; wait++) {
        await shared.pause(600);
        fresh = await shared.freshSnapshot(current);
        target = shared.findField(fresh, field);
        if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
        shown = shared.choicesFor(fresh, target.ref);
      }
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
      // Whether the widget listed anything at all (a status row counts) while the answer was typed: a combobox that
      // lists nothing for the answer or any alias (Paylocity's address finder with no geocoder behind it) is a text box.
      let listedAny = false;
      if (target.tag === 'input' && fieldType(target) !== 'select' && !exact(shown.map(option => option.label))) {
        // The answer, then each stored alias, then its first word: a list without "Computer Engineering" may list
        // "Engineering". A descriptive answer is no search term when aliases exist, and a match counts only for the
        // candidate searched or a preferred one. Search-on-Enter widgets (prompt fields) show nothing new until Enter
        // (an open prompt keeps its unfiltered list on screen), and remote lookups lag.
        const searches = [...new Set([...candidates.filter(text => text.length <= 40 || candidates.length === 1), value.trim().split(/\s+/)[0]])];
        for (const search of searches) {
          const rank = candidates.includes(search) ? candidates.indexOf(search) + 1 : equivalent.length;
          const unfiltered = JSON.stringify(shown.map(option => option.label));
          await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, search, { secret: true }));
          let entered = false;
          for (let wait = 0; wait < 5; wait++) {
            await shared.pause(1000);
            fresh = await shared.freshSnapshot(current);
            target = shared.findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            shown = shared.choicesFor(fresh, target.ref);
            listedAny ||= fresh.controls.some(control => control.kind === 'option' && control.ownerRef === target.ref);
            const unchanged = shown.length && JSON.stringify(shown.map(option => option.label)) === unfiltered;
            if (shown.length && (!unchanged || entered)) break;
            if (wait >= 1 && !entered) { await act.searchEnter(ctx.page, target.ref); entered = true; }
          }
          if (exact(shown.map(option => option.label), rank)) break;
          // A list the search actually narrowed (aliases run in preference order) is offered to the choice step right
          // away: "Computer Science" narrowing to "Computer and Information Science" beats a later alias's list. Only
          // options carrying every word of the alias searched are its narrowings; a token hit on another subject
          // ("Computational Biology" listing "Biology") is not, and the next alias is searched instead.
          const real = shown.filter(option => !LIST_STATUS.test(clean(option.label)));
          const words = answers.normalize(search).split(' ').filter(word => word.length > 1);
          const narrowed = real.filter(option => words.every(word => ` ${answers.normalize(option.label)} `.includes(` ${word} `)));
          if (narrowed.length && JSON.stringify(shown.map(option => option.label)) !== unfiltered) {
            preferred = await shared.chooseOption(labelOf(field), value, narrowed.map(option => option.label), candidates, key);
            if (preferred) { how = 'model'; break; }
          }
        }
        // No listed match for any search: a filtered list ("Currently" leaves only "I'm not currently enrolled…") can
        // hide the right choice. The filtered list is offered to the choice step first; only when nothing there fits
        // is the search cleared and the full list offered instead (long lists render just their first entries, so
        // the filtered one is preferred).
        if (!preferred && shown.length && !exact(shown.map(option => option.label))) {
          preferred = await shared.chooseOption(labelOf(field), value, shown.map(option => option.label), candidates, key);
          if (preferred) how = 'model';
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
        if (companion && !policyExpectation && !exact(shown.map(option => option.label))) {
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
            shared.say(`CHOOSE ${labelOf(field)} = "${clean(other.label)}" ← ${key} via other`);
            ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(other.label)}"; put "${value}" in the matching "Other …" field`);
            ctx.otherChosen.add(labelOf(field));
            return;
          }
          // The probe filtered the widget's list by "Other" (react-select then shows only "No options"): the search is
          // cleared and the list reopened, so the full list is judged, not the probe's leftover.
          await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, '', { secret: true }));
          fresh = await shared.openField(current, target);
          target = shared.findField(fresh, field);
          if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
          shown = shared.choicesFor(fresh, target.ref);
        }
      }
      // A typeable combobox that listed nothing for the answer or any alias keeps typed text as its value (Paylocity's
      // address finder): the answer is typed and the box left; the value it then holds, with no error, is the fill.
      if (target.tag === 'input' && fieldType(target) !== 'select' && !shown.length && !listedAny) {
        await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, value, { secret: true }));
        await shared.pause(800);
        fresh = await shared.freshSnapshot(current);
        target = shared.findField(fresh, field);
        if (!target) return;
        if (!fresh.controls.some(control => control.kind === 'option' && control.ownerRef === target.ref)) {
          await act.press(ctx.page, 'Tab');
          await shared.pause(400);
          fresh = await shared.freshSnapshot(current);
          target = shared.findField(fresh, field);
          if (!target) return;
          if (!target.invalid && answers.normalize(target.value) === answers.normalize(value)) {
            shared.say(`FILL ${labelOf(field)} = typed text (the box listed no suggestions)`);
            return;
          }
        }
        shown = shared.choicesFor(fresh, target.ref);
      }
      if (!shown.length && (target.tag === 'select' || fieldType(target) === 'select')) {
        // Exact matches are checked against every option (an alias like "BA" shares no word with the answer, so a
        // long list trimmed by the answer's words drops it); the model chooses from the trimmed list only.
        let all = await act.selectOptions(ctx.page, target.ref, value, Infinity);
        // A select whose options the site fetches after its row is drawn (Workday's Language, a second after "Add
        // Another") lists only its placeholder for a beat.
        for (let wait = 0; wait < 4 && !all.some(choice => !PLACEHOLDER_OPTION.test(String(choice))); wait++) {
          await shared.pause(600);
          all = await act.selectOptions(ctx.page, target.ref, value, Infinity);
        }
        const listed = all.length > 40 ? await act.selectOptions(ctx.page, target.ref, candidates.join(' ')) : all;
        let option = exact(all);
        if (!option && (option = leadMatch(all.map(String)))) how = 'lead';
        if (!option && listed.length && (option = await shared.chooseOption(labelOf(field), value, listed, candidates, key))) how = 'model';
        // The key's value names no option (a follow-up "Source" listing campuses under "How did you hear: Campus"):
        // the writer picks the one option the applicant facts support, with the field's own context, once per field.
        const real = all.filter(choice => !PLACEHOLDER_OPTION.test(String(choice))).map(String);
        const writerOptions = concrete ? real.filter(choice => !CATCH_ALL.test(answers.normalize(choice))) : real;
        if (!option && !policyExpectation && writerOptions.length >= 2 && writerOptions.length <= 60 && !ctx.writeTried.has(`${current.url}|pref|${labelOf(field)}`)) {
          ctx.writeTried.add(`${current.url}|pref|${labelOf(field)}`);
          const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(ctx.postingText || current.pageText || '').slice(0, 3000) };
          const question = [labelOf(field), clean(field.context ?? '')].filter(Boolean).join(' — ').slice(0, 300);
          option = await pickPreference({ job, applicant: await shared.writerApplicant(), question, options: writerOptions });
          shared.say(`WRITER choice "${clean(labelOf(field))}" = ${option ? `"${clean(option)}"` : 'none'} (no option matched ${key})`);
          if (option) how = 'writer';
          if (option && !(concrete && CATCH_ALL.test(answers.normalize(option)))) shared.rememberForSite(labelOf(field), option);
        }
        // A long curated list without the answer (a school list missing the applicant's school) takes its "Other"
        // entry; the "If other, please specify" field it reveals then gets the real answer.
        const otherChoice = !policyExpectation && !option && all.map(String).find(choice => OTHER_OPTION.test(answers.normalize(choice)));
        if (otherChoice) {
          option = otherChoice;
          how = 'other';
          ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(otherChoice)}"; put "${value}" in the "If other, please specify" field it reveals`);
          ctx.otherChosen.add(labelOf(field));
        }
        if (!option) shared.needsField(field, policyExpectation
          ? 'the list offers no option that agrees with the applicant\'s work-authorization, sponsorship, or citizenship facts'
          : listed.length ? 'no option matches the stored answer or its aliases' : 'opening the widget exposed no owned options');
        await mutate('SELECT', labelOf(target), () => act.select(ctx.page, target.ref, option));
        shared.say(`CHOOSE ${labelOf(field)} = "${clean(option)}" ← ${key} via ${how}`);
        return;
      }
      // A country-code picker shows only the committed dial code ("+ 1") for its option ("United States +1"): the
      // displayed code ends the label, so it proves the click committed that option. Compared without spaces.
      const dialCodeShown = (shownText, chosen) => {
        const code = String(shownText ?? '').replace(/\s+/g, '');
        return /^\+\d{1,4}$/.test(code) && String(chosen ?? '').replace(/\s+/g, '').endsWith(code);
      };
      const visited = new Set();
      // A child list often repeats the parent just chosen as its first row (Workday's "back" header): picking it
      // returns to the parent list, so an option already picked at a higher level is never picked again.
      const picked = new Set();
      let retried = false;
      for (let depth = 0; depth < 4; depth++) {
        const signature = JSON.stringify(shown.map(option => [option.label, !!option.selected]));
        if (!shown.length || visited.has(signature)) shared.needsField(field, 'opening and picking did not commit a choice');
        visited.add(signature);
        const offered = shown.filter(option => !picked.has(option.label));
        // A child list under the chosen parent ("Other" → "Source Not Listed") with one entry is the only completion.
        let label = exact(offered.map(option => option.label));
        if (label) how = 'exact';
        if (!label && !policyExpectation && (label = leadMatch(offered.map(option => option.label)))) how = 'lead';
        if (!label && preferred && offered.some(option => option.label === preferred)) label = preferred;
        if (!label && !policyExpectation && depth > 0 && offered.length === 1) { label = offered[0].label; how = 'only'; }
        if (!label && offered.length && (label = await shared.chooseOption(labelOf(field), value, offered.map(option => option.label), candidates, key))) how = 'model';
        // Option labels keep the site's own spacing ("Internet Job Board /  Job Search"); a model returns them
        // tidied, so a chosen label is mapped back onto the listed one it names.
        const listedAs = text => text == null ? text
          : (shown.find(option => option.label === text) ?? shown.find(option => answers.normalize(option.label) === answers.normalize(text)))?.label ?? text;
        label = listedAs(label);
        if (picked.has(label)) label = null;
        preferred = null;
        // The key's value names no listed option (a yes/no answer under "Undergraduate"/"Graduate"): the writer picks
        // the one option the applicant facts support, once per field, as for native selects above.
        const real = offered.map(option => option.label).filter(choice => !PLACEHOLDER_OPTION.test(String(choice)));
        const writerOptions = concrete ? real.filter(choice => !CATCH_ALL.test(answers.normalize(choice))) : real;
        if (!policyExpectation && !shown.some(candidate => candidate.label === label) && writerOptions.length >= 2 && writerOptions.length <= 60
            && !ctx.writeTried.has(`${current.url}|pref|${labelOf(field)}`)) {
          ctx.writeTried.add(`${current.url}|pref|${labelOf(field)}`);
          const job = { title: current.title, site: credentials.hostFromUrl(current.url), page: String(ctx.postingText || current.pageText || '').slice(0, 3000) };
          const question = [labelOf(field), clean(field.context ?? '')].filter(Boolean).join(' — ').slice(0, 300);
          label = listedAs(await pickPreference({ job, applicant: await shared.writerApplicant(), question, options: writerOptions }));
          shared.say(`WRITER choice "${clean(labelOf(field))}" = ${label ? `"${clean(label)}"` : 'none'} (no option matched ${key})`);
          if (label) how = 'writer';
          if (label && !(concrete && CATCH_ALL.test(answers.normalize(label)))) shared.rememberForSite(labelOf(field), label);
        }
        let option = shown.find(candidate => candidate.label === label);
        // A child list renders only its first rows (Workday's "Job Board/Website" lists hundreds of boards and shows
        // twelve): the answer and each alias are searched for in the box before the list is judged not to hold it.
        if (!option && depth > 0) {
          const box = searchBoxOf(fresh, target) ?? (target.tag === 'input' && fieldType(target) !== 'select' ? target : null);
          // A descriptive stored answer ("Handshake (university/college career platform; …)") is no search term when
          // aliases exist; a match found while searching one candidate counts only for it or a preferred one, so a
          // generic late alias in the unfiltered list never pre-empts the aliases still to be searched.
          const searches = candidates.filter(text => text.length <= 40 || candidates.length === 1);
          for (const search of box ? searches : []) {
            const rank = candidates.indexOf(search) + 1;
            // The list as it stands before this search: a failed Workday search leaves the tree's top level on screen,
            // which is not the child list the first search started from.
            const unfiltered = JSON.stringify(shown.map(candidate => candidate.label));
            await mutate('FILL', labelOf(box), () => act.type(ctx.page, box.ref, search, { secret: true }));
            // Workday's search box filters nothing until Enter (typing alone leaves the tree's top level, or redraws
            // it, on screen): there Enter follows the first empty wait whatever the list did. Elsewhere the list
            // filtering as the text is typed proves it holds no match, and Enter would commit its highlighted row.
            const workday = /\.myworkday(?:jobs|site)\.com$/i.test(new URL(current.url).hostname);
            let entered = false;
            for (let wait = 0; wait < 5 && !option; wait++) {
              await shared.pause(800);
              fresh = await shared.freshSnapshot(current);
              target = shared.findField(fresh, field);
              if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
              shown = shared.choicesFor(fresh, target.ref);
              const found = exact(shown.filter(candidate => !picked.has(candidate.label)).map(candidate => candidate.label), rank);
              option = found ? shown.find(candidate => candidate.label === found) : undefined;
              const unchanged = JSON.stringify(shown.map(candidate => candidate.label)) === unfiltered;
              if (!option && wait >= 1 && (unchanged || workday) && !entered) { await act.searchEnter(ctx.page, box.ref); entered = true; }
            }
            if (option) { how = 'exact'; shared.say(`PICK ${labelOf(field)}: searching "${clean(search)}" listed "${clean(option.label)}"`); break; }
            shared.say(`PICK ${labelOf(field)}: searching "${clean(search)}"${entered ? ' (Enter)' : ''} listed ${shown.length ? shown.slice(0, 6).map(candidate => `"${clean(candidate.label).slice(0, 40)}"`).join(', ') : 'nothing'}`);
          }
        }
        // Nothing listed fits: the list's "Other" entry (searched for when the list pages or filters) takes the pick,
        // and the "If other, please specify" field it reveals gets the real answer.
        if (!option && depth === 0 && !policyExpectation) {
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
            how = 'other';
            ctx.history.push(`"${labelOf(field)}" does not list "${value}": chose "${clean(option.label)}"; put "${value}" in the "If other, please specify" field it reveals`);
            ctx.otherChosen.add(labelOf(field));
            shared.say(`PICK ${labelOf(field)}: "${clean(value)}" not listed; choosing "${clean(option.label)}"`);
          }
        }
        if (!option) shared.needsField(field, policyExpectation
          ? 'no owned option agrees with the applicant\'s work-authorization, sponsorship, or citizenship facts'
          : `no owned option matches the stored answer or its aliases (shown: ${shown.slice(0, 6).map(candidate => `"${clean(candidate.label).slice(0, 40)}"`).join(', ')})`);
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
        shared.say(`CHOOSE ${labelOf(field)} = "${clean(live.label)}" ← ${key} via ${how}`);
        picked.add(live.label);
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
        // A hierarchical list ("Other" → its sources) may fetch the child list a few seconds after the click, showing no
        // rows (a spinner) meanwhile. Only the labels count: the click itself flips the parent's selected flag, which
        // is not the child list arriving.
        const labels = list => JSON.stringify(list.map(option => option.label));
        const parentLabels = JSON.stringify(JSON.parse(signature).map(([optionLabel]) => optionLabel));
        // A virtualized parent list re-rendered at another scroll offset has other labels yet is still the parent list:
        // while the row just clicked is listed unchecked, its child list has not arrived.
        const parentShown = list => labels(list) === parentLabels || list.some(option => option.label === live.label && !option.selected);
        for (let wait = 0; wait < 6 && isEmpty(target) && (!shown.length || parentShown(shown)); wait++) {
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
        // Continue still marks it invalid (many sites re-validate only on the next submit). A list the widget keeps
        // open after the pick (Workday's multi-select lists on, the pick now checked) is closed with Escape, so the
        // next screen read sees a filled field, not a list waiting on a choice.
        if (target.occupied === true || shown.some(candidate => candidate.selected && candidate.label === live.label)
          || (!shown.length && answers.normalize(target.value) === answers.normalize(live.label))
          || dialCodeShown(target.value, live.label)
          || (!target.invalid && !isEmpty(target)
            && (!shown.length || answers.normalize(target.value) === answers.normalize(live.label)))) {
          if (shown.length) { await act.press(ctx.page, 'Escape'); await shared.pause(300); }
          return;
        }
        // The list closed on the click yet the field stayed empty: the click toggled off a choice the widget's hidden
        // state already held (Paylocity's address pickers after a resume parse: hidden "United States" under a shown
        // "Montenegro"; every further click on that option clears the box again, and typing it changes nothing).
        // Typing the option's label and leaving the box commits it when the shown value only lagged; otherwise another
        // option is chosen first (a change the widget does register), then the wanted one once more.
        if (!retried && !shown.length && isEmpty(target)) {
          retried = true;
          if (target.tag === 'input' && fieldType(target) !== 'select') {
            shared.say(`PICK ${labelOf(field)}: "${clean(live.label)}" did not stay chosen; typing it and leaving the box`);
            await mutate('FILL', labelOf(target), () => act.type(ctx.page, target.ref, live.label, { secret: true }));
            await shared.pause(800);
            await act.press(ctx.page, 'Tab');
            await shared.pause(600);
            fresh = await shared.freshSnapshot(current);
            target = shared.findField(fresh, field);
            if (!target) return;
            shown = shared.choicesFor(fresh, target.ref);
            if (!shown.length && !target.invalid && answers.normalize(target.value) === answers.normalize(live.label)) return;
          }
          fresh = await shared.openField(current, target);
          target = shared.findField(fresh, field);
          if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
          shown = shared.choicesFor(fresh, target.ref);
          const detour = shown.find(candidate => candidate.label !== live.label && !candidate.selected
            && !LIST_STATUS.test(clean(candidate.label)) && !PLACEHOLDER_OPTION.test(candidate.label));
          if (detour) {
            shared.say(`PICK ${labelOf(field)}: choosing "${clean(detour.label)}" first to unstick the box, then "${clean(live.label)}" again`);
            await mutate('CLICK', labelOf(field), () => act.click(ctx.page, detour.ref));
            await shared.pause(800);
            fresh = await shared.openField(current, target);
            target = shared.findField(fresh, field);
            if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
            shown = shared.choicesFor(fresh, target.ref);
          }
          picked.delete(live.label);
          visited.clear();
        }
      }
      shared.needsField(field, 'the owned choice hierarchy did not commit an answer after four picks');
    }

  return { pickOne };
}
