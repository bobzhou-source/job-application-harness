// ATS family templates. One ATS product (Workday, Greenhouse, ...) has the same DOM and page order on every tenant, so
// what a run learned replays on the next tenant of that family with no model call. Locators (data-automation-id, name,
// id, else label) map to the answer key a site accepted, or to a forward step. A recording is confirmed on the next
// snapshot: a field left empty or flagged invalid, or a step that did not move the screen, counts a miss, and an entry
// replays only while its hits exceed its misses. Records live in learned.json under `families`; values never do.
import * as rules from '../rules.mjs';
import * as runlog from '../trace.mjs';
import { clean, labelOf, isEmpty, fieldType, learnLabel, isQuestionLabel } from './fields.mjs';
import { activeFields } from './screen.mjs';
import { SECRET_KEY } from './plan.mjs';
import { saveLearned } from './values.mjs';
import { familyOf, locatorKey } from '../family.mjs';
import { isWorkHistoryField } from './workhistory.mjs';
import { isControlledNameQuestion } from '../controlled-answers.mjs';
import { questionAnswer, stageQuestion, confirmQuestion } from './questions.mjs';

// Field types never recorded or replayed: secrets and files are never stored, free text is per-posting writer output.
const NEVER = ['password', 'file', 'hidden', 'textarea', 'radio', 'checkbox'];
// A dropdown still showing its placeholder (not a chosen value).
const PLACEHOLDER = /^(select|choose|please select|--)/i;
const trusted = entry => Boolean(entry) && entry.hits > entry.misses;
const isNext = control => /\b(next|continue)\b/i.test(clean(control.label ?? ''));

export function installTemplate(ctx, shared) {
  const today = () => new Date().toISOString();
  const pageFamily = () => familyOf(ctx.current?.url);
  const bucketFor = family => {
    ctx.learned.families ??= {};
    return (ctx.learned.families[family] ??= { fields: {}, controls: {} });
  };
  // A locator shared by several fields on the page (Workday repeats formField-jobTitle for every work-experience
  // entry) names none of them: those fields are neither recorded nor replayed, and the per-label learning keeps them.
  const repeated = () => {
    const counts = new Map();
    for (const field of ctx.current.fields) {
      const loc = locatorKey(field);
      if (loc) counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([loc]) => loc));
  };

  // Called from execute after a successful action. Nothing is persisted here; the next snapshot confirms it.
  function templateStage(action, list) {
    const family = pageFamily();
    if (!family) return;
    const dup = repeated();
    for (const { item, key, skip, secret, value, options } of list) {
      if (!item || (action !== 'click' && isWorkHistoryField(ctx.current, item, ctx.values))) continue;
      if (action !== 'click' && isControlledNameQuestion(labelOf(item))) continue;
      // Cross-tenant question memory (lib/apply/questions.mjs): a question's text plus its option set is the same
      // decision on every tenant of the family, whatever locator or questionnaire id that tenant mints. Recorded
      // for choice answers too (an option pick skips the locator entry), never for a secret.
      if (action !== 'click' && !secret && key?.startsWith('qa.')) {
        ctx.questionStaged.push({ family, label: learnLabel(item), options: options ?? item.options, key, value });
      }
      if (skip) continue;
      const loc = locatorKey(item);
      if (!loc || dup.has(loc)) continue;
      if (action === 'click') {
        const kind = rules.classifyControl(item);
        // A forward step, or an opener on a screen with nothing to fill (Workday's "Apply Manually" among the apply
        // options) when its locator is the site's own automation id: label-keyed openers vary by tenant.
        let how = null;
        if (kind === 'step' && isNext(item) && !item.href) how = 'next';
        else if (kind === 'other' && loc.startsWith('aid:') && !item.href && !activeFields(ctx.current).length) how = 'open';
        if (how) ctx.templateStaged.push({ family, kind: 'controls', loc, how, screen: ctx.screen });
        continue;
      }
      if (!key || key === SECRET_KEY || !ctx.values.has(key) || NEVER.includes(fieldType(item))) continue;
      ctx.templateStaged.push({ family, kind: 'fields', loc, how: action, key, label: learnLabel(item), screen: ctx.screen });
    }
  }

  // A refused action whose target the page no longer has is a miss for that locator, confirmed next pass. A refusal
  // from an executor guard or the answer policy is evidence about the *decision*, not the locator: counting it as a
  // miss untrusted the entry for every tenant of the family (hits > misses is the replay gate), so one policy answer
  // refused on one tenant quietly disabled the replays built on every other tenant.
  const LOST_TARGET = /^(?:invalid-plan )?(?:stale-target|control-ref|field-ownership|stale)\b/;
  function templateRefused(refs, reason = '') {
    const family = pageFamily();
    if (!family || !LOST_TARGET.test(String(reason))) return;
    for (const ref of refs.filter(Boolean)) {
      const control = ctx.current.controls.find(item => item.ref === ref);
      const item = control ?? ctx.current.fields.find(field => field.ref === ref);
      const loc = item && locatorKey(item);
      if (loc) ctx.templateStaged.push({ family, kind: control ? 'controls' : 'fields', loc, how: 'refused', screen: ctx.screen });
    }
  }

  // Runs at the top of each choose pass: settles what the last action did, then persists the change.
  async function templateConfirm() {
    let questionChanged = false;
    if (ctx.questionStaged.length) {
      for (const s of ctx.questionStaged.splice(0)) {
        const id = stageQuestion(ctx.learned, s)?.id;
        if (!id) continue;
        const label = s.label;
        const item = [...ctx.current.fields, ...ctx.current.controls]
          .find(x => learnLabel({ label: labelOf(x) || x.name, name: x.name }) === label);
        questionChanged = confirmQuestion(ctx.learned, id, item) || questionChanged;
      }
      if (questionChanged) await saveLearned(ctx.learned);
    }
    if (!ctx.templateStaged.length) return;
    const staged = ctx.templateStaged.splice(0);
    const counts = new Map();
    let changed = false;
    for (const s of staged) {
      const bucket = bucketFor(s.family);
      const store = s.kind === 'controls' ? bucket.controls : bucket.fields;
      if (s.how === 'refused') {
        if (store[s.loc]) { store[s.loc].misses++; store[s.loc].last = today(); changed = true; }
        continue;
      }
      let miss;
      if (s.kind === 'controls') {
        miss = ctx.screen === s.screen;
      } else {
        const item = [...ctx.current.fields, ...ctx.current.controls].find(x => locatorKey(x) === s.loc);
        if (!item) continue;
        const current = clean(item.current ?? '');
        miss = Boolean(item.invalid) || (item.current !== undefined ? !current || PLACEHOLDER.test(current) : isEmpty(item));
      }
      const fresh = !store[s.loc];
      const entry = store[s.loc] ??= s.kind === 'controls'
        ? { role: s.how, hits: 0, misses: 0, last: null }
        : { key: s.key, how: s.how, hits: 0, misses: 0, last: null };
      if (!miss && s.key) entry.key = s.key;
      // A confirmed choice is also a label mapping. The family locator is an optimization, not the only place
      // to remember a model's decision; another tenant can render the same question with a different locator.
      const keep = s.key?.replace(/\.alt_\d+$/, '');
      if (!miss && keep && s.label && isQuestionLabel(s.label) && !ctx.essayKeys.has(keep)) {
        ctx.learned.fields[s.label] = keep;
      }
      if (miss) entry.misses++; else entry.hits++;
      entry.last = today();
      changed = true;
      if (fresh && !miss) {
        const count = counts.get(s.family) ?? [0, 0];
        count[s.kind === 'controls' ? 1 : 0]++;
        counts.set(s.family, count);
      }
    }
    if (!changed) return;
    await saveLearned(ctx.learned);
    for (const [family, [fields, controls]] of counts) {
      shared.say(`TEMPLATE learned ${fields} field(s), ${controls} control(s) for ${family}`);
    }
  }

  // The next replayable plan for this page, or null. Fills batch up to 8 fields; a choose or a Next click follows
  // only once no empty field is left that the template cannot answer.
  function templatePlan() {
    const family = pageFamily();
    const bucket = family && ctx.learned.families?.[family];
    if (!bucket) return null;
    const url = ctx.current.url;
    const untried = ref => !ctx.learnedTried.has(`${url}|${ref}`);
    const dup = repeated();
    const entryOf = (store, item) => {
      if (store === bucket.fields && isWorkHistoryField(ctx.current, item, ctx.values)) return undefined;
      const loc = locatorKey(item);
      return loc && !dup.has(loc) ? store[loc] : undefined;
    };
    // Searchable picks can re-render their siblings; execute commits only one per observation.
    let autocompletePlanned = false;
    const fields = activeFields(ctx.current).flatMap(field => {
      if (isControlledNameQuestion(labelOf(field))) return [];
      const entry = entryOf(bucket.fields, field);
      if (!entry || entry.how !== 'fill' || !trusted(entry) || !ctx.values.has(entry.key)) return [];
      if (!isEmpty(field) || !untried(field.ref) || NEVER.includes(fieldType(field)) || (field.autocomplete && shared.skippable(field))) return [];
      if (field.autocomplete && autocompletePlanned) return [];
      autocompletePlanned ||= Boolean(field.autocomplete);
      return [{ ref: field.ref, key: entry.key, label: clean(labelOf(field)) }];
    }).slice(0, 8);
    let plan = null;
    let verb = '';
    let labels = '';
    if (fields.length) {
      plan = { action: 'fill', fields: fields.map(({ ref, key }) => ({ ref, key })) };
      verb = 'fill';
      labels = fields.map(field => field.label).join(', ');
    } else {
      const choose = ctx.current.controls.find(control => {
        if (isControlledNameQuestion(labelOf(control))) return false;
        const entry = entryOf(bucket.fields, control);
        const current = clean(control.current ?? '');
        return entry && entry.how === 'choose' && trusted(entry) && ctx.values.has(entry.key) && untried(control.ref)
          && control.formRef && control.current !== undefined && (!current || PLACEHOLDER.test(current));
      });
      if (choose) {
        plan = { action: 'choose', ref: choose.ref, key: entryOf(bucket.fields, choose).key };
        verb = 'choose';
        labels = clean(labelOf(choose));
      } else if (activeFields(ctx.current).every(field => !isEmpty(field) || shared.skippable(field))) {
        // A click is tried once per screen, not per URL: Workday draws every step of an application at one address,
        // so a Save and Continue that moved the screen is replayed on the next step too.
        const empty = !activeFields(ctx.current).length;
        const next = ctx.current.controls.find(control => {
          const entry = entryOf(bucket.controls, control);
          if (!entry || !trusted(entry) || control.href || ctx.learnedTried.has(`${ctx.screen}|${control.ref}`)) return false;
          return entry.role === 'next' ? isNext(control) : entry.role === 'open' && empty && rules.classifyControl(control) === 'other';
        });
        if (next) {
          plan = { action: 'click', ref: next.ref };
          verb = 'click';
          labels = clean(labelOf(next));
        }
      }
    }
    if (!plan) return null;
    if (plan.action === 'click') ctx.learnedTried.add(`${ctx.screen}|${plan.ref}`);
    else for (const ref of plan.fields?.map(field => field.ref) ?? [plan.ref]) ctx.learnedTried.add(`${url}|${ref}`);
    shared.say(`TEMPLATE ${verb} ${labels}`);
    runlog.trace('template', { family, replayed: plan.fields?.length ?? 1, action: plan.action });
    return plan;
  }

  return {
    templatePlan, templateStage, templateConfirm, templateRefused,
    // The trusted cross-tenant decision for a field's question and option set, or null (lib/apply/questions.mjs).
    questionAnswer: (field, policyKey = null) => questionAnswer(ctx.learned, field, policyKey),
  };
}
