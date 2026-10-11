// Field and list picking: locating and opening fields, choosing list items, matching stored answers to a
// list's choices, and the small run-local helpers they share.

import * as act from '../act.mjs';
import * as answers from '../answers.mjs';
import * as credentials from '../credentials.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { clean, labelOf, questionOf, isEmailField, delay, isEmpty, fieldType, isChoiceField, screenFingerprint, learnLabel, isQuestionLabel, limitOf } from './fields.mjs';
import { observe, messageFor, rejectionFor, LIST_STATUS, abandonedFields, uploadedLabels } from './observe.mjs';
import { activeFields, signupControl, resultsPager, PLACEHOLDER_OPTION, modelView, offApplication, stopForGates } from './screen.mjs';
import { checkTarget, currentControl, mutate } from './controls.mjs';

export function installPick(ctx, shared) {
    const actionKeyOf = plan => plan.action === 'click' ? `click:${plan.ref}` : plan.action === 'check' ? `check:${plan.ref}`
      : plan.action === 'upload_resume' ? `upload:${plan.ref}` : plan.action === 'fill' ? 'fill'
      : plan.action === 'credentials' ? `credentials:${plan.mode}` : null;

    const noteRecent = line => { ctx.recent.push(line); if (ctx.recent.length > 6) ctx.recent.shift(); };

    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

    // List status rows ("No Items.", "No results found", "Loading…", "Searching") are not choices.
    const choicesFor = (snap, ref) => snap.controls.filter(c => c.kind === 'option' && c.ownerRef === ref
      && !/^(no (items|matches|results|options|records)\b|(loading|searching)\b)/i.test(clean(c.label)));

    const baseKey = key => key.replace(/\.(alt|alias)_\d+$/, '');

    const progressKey = (snap, field) => `${snap.url}|${learnLabel(field)}`;

    const fieldState = field => JSON.stringify([field.value ?? '', field.occupied === true, field.checkedRefs ?? []]);

    // A required field that cannot be committed needs the user; an optional one is abandoned and the run goes on.
    const needsField = (field, why) => {
      if (!field.required) {
        abandonedFields.add(`${ctx.page.url()}|${learnLabel(field)}`);
        shared.say(`SKIP optional "${labelOf(field)}": ${why}`);
        invalidPlan(`abandoned-optional ${labelOf(field)}`);
      }
      throw new Stop(`needs-user-field "${labelOf(field)}": ${why}`);
    };

    const findField = (snap, field) => {
      // The same element (refs live as long as it does) wins; rows sharing one label ("Office" ×3) are told apart by it.
      const own = activeFields(snap).find(candidate => candidate.ref === field.ref && candidate.tag === field.tag);
      if (own) return own;
      const same = activeFields(snap).filter(candidate => ['tag', 'type', 'label', 'name'].every(key => candidate[key] === field[key]));
      return same.length === 1 ? same[0] : null;
    };

    // An answer's equivalents are its own aliases plus those of any fact stating the same value (qa "veteran status"
    // = facts.veteran_status's "I am not a protected veteran" shares its "I am not a veteran" alias).
    const aliasesFor = (key, value) => {
      const same = [...ctx.values].filter(([name, stored]) => name.startsWith('facts.') && !/\.(alt|alias)_\d+$/.test(name)
        && typeof stored === 'string' && typeof value === 'string' && answers.normalize(stored) === answers.normalize(value)).map(([name]) => name);
      const bases = new Set([baseKey(key), ...same]);
      return [value, ...[...ctx.values].filter(([name]) => [...bases].some(base => name.startsWith(`${base}.alias_`))).map(([, alias]) => alias)];
    };


    async function openField(current, field) {
      const fresh = await shared.freshSnapshot(current);
      const target = findField(fresh, field);
      if (!target) invalidPlan(`stale-target ${labelOf(field)}`);
      await mutate('OPEN', labelOf(target), () => act.openList(ctx.page, target.ref));
      await pause(700);
      return shared.freshSnapshot(current);
    }


    class MultiList extends Error {}

    // A repeatable section (Languages, Skills) already holds one item of a stored list answer and another item is in
    // no field yet ("English" entered, "Spanish" not): "Add another" opens the row that item needs.
    const moreEntries = current => {
      const entered = new Set(activeFields(current).filter(field => !isEmpty(field)).map(field => answers.normalize(String(field.value))));
      return [...ctx.values].some(([key, value]) => !/\.(alt|alias)_\d+$/.test(key) && (() => {
        const items = shared.listItems(value)?.map(item => answers.normalize(item)) ?? [];
        return items.some(item => entered.has(item)) && items.some(item => ![...entered].some(text => text === item || text.startsWith(`${item} `) || item.startsWith(`${text} `)));
      })());
    };

    const listItems = value => {
      // Commas inside parentheses ("Handshake (career platform, campus engagement)") qualify one item, not separate it.
      const items = String(value ?? '').split(/\s*[,;]\s*(?![^()]*\))/).map(item => item.trim()).filter(Boolean);
      // A sentence ("Proficient - I have no difficulty in reading, writing, and speaking English.") is one answer.
      if (/[.!?]\s*$/.test(String(value ?? '').trim()) || items.some(item => /^(and|or|else|otherwise|if)\s/i.test(item))) return null;
      return items.length >= 2 && items.every(item => item.length <= 60) ? [...new Set(items)] : null;
    };

    async function pickField(current, field, key, value) {
      const items = listItems(value);
      if (!items) return shared.pickOne(current, field, key, value);
      const id = `${new URL(ctx.page.url()).host}|${learnLabel(field)}`;
      const used = ctx.listPicks.get(id) ?? new Set();
      ctx.listPicks.set(id, used);
      for (const sibling of activeFields(ctx.current)) {
        if (sibling.ref !== field.ref && labelOf(sibling) === labelOf(field) && !isEmpty(sibling)) used.add(answers.normalize(sibling.value));
      }
      for (const item of items.filter(item => !used.has(answers.normalize(item)))) {
        used.add(answers.normalize(item));
        try { await shared.pickOne(current, field, key, item, true); }
        catch (error) {
          if (error instanceof MultiList) { used.clear(); return shared.pickOne(current, field, key, value); }
          const optional = error instanceof Stop && error.message.startsWith('invalid-plan abandoned-optional');
          if (!(error instanceof Stop) || !(optional || error.message.startsWith('needs-user-field'))) throw error;
          // An unlisted item is not the field's last chance: the next item may be listed.
          if (optional) abandonedFields.delete(`${ctx.page.url()}|${learnLabel(field)}`);
          await act.press(ctx.page, 'Escape').catch(() => undefined);
          shared.say(`PICK "${labelOf(field)}": "${item}" is not listed; trying the next item of the stored list`);
          continue;
        }
        const rest = items.filter(other => !used.has(answers.normalize(other)));
        ctx.history.push(`"${labelOf(field)}" takes one item per entry: entered "${item}"${rest.length
          ? `; still to add, each as its own new entry (save this one, then use the section's Add control): ${rest.map(other => `"${other}"`).join(', ')}`
          : '; every listed item is now entered'}`);
        return;
      }
      needsField(field, `no listed choice matches any item of the stored list (${items.join(', ')}) not already entered`);
    }


  return { pause, noteRecent, actionKeyOf, choicesFor, baseKey, progressKey, fieldState, needsField, findField, aliasesFor, openField, MultiList, moreEntries, listItems, pickField };
}
