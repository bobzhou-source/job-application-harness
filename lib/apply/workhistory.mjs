// Work history is an identity-bound section, never a positional answer. Inspect the entry's own DOM
// group, match its company/title once across all siblings, and reconcile one mutation per observation.
import * as act from '../act.mjs';
import * as answers from '../answers.mjs';
import * as runlog from '../trace.mjs';
import { Stop, invalidPlan } from './stop.mjs';
import { labelOf, datePart, dateSegment, fieldType, isChoiceField, POSITIONAL_WORK_LABEL } from './fields.mjs';
import { mutate } from './controls.mjs';

const WORK_SECTION = /\b(?:work|professional|employment)\s+(?:experience|history)\b/i;
const bindings = new WeakMap();
const norm = text => answers.normalize(text);
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const present = value => /^(present|current|ongoing)$/i.test(text(value));
const entryName = group => `${text(group.title) || '(untitled)'} @ ${text(group.employer) || '(no company)'}`;

export function workFacts(values) {
  const entries = new Map();
  for (const [key, value] of values) {
    const match = /^facts\.work\.([1-9]\d*)\.(title|employer|location|start|end|description)$/.exec(key);
    if (!match) continue;
    const id = Number(match[1]);
    if (!entries.has(id)) entries.set(id, { id });
    entries.get(id)[match[2]] = value;
  }
  return [...entries.values()].sort((a, b) => a.id - b.id);
}

// Corporate suffixes and generic role words cannot identify an employer or a particular role.
const GENERIC = new Set(['the', 'and', 'of', 'at', 'inc', 'llc', 'ltd', 'corporation', 'company', 'university', 'independent', 'intern', 'internship']);
const tokens = value => new Set(norm(value).split(' ').filter(word => word && !GENERIC.has(word)));
function overlap(a, b) {
  if (!text(a) || !text(b)) return 0;
  if (norm(a) === norm(b)) return 1;
  const left = tokens(a), right = tokens(b);
  const common = [...left].filter(word => right.has(word)).length;
  const score = common / Math.max(1, Math.min(left.size, right.size));
  return score >= 0.6 ? score : 0;
}

export function matchWorkEntries(groups, facts) {
  // Strong complete pairs claim a fact before partial/misparsed duplicates. Title evidence beats a
  // company alone: the old singular-company fill must not turn a research role into another job.
  const edges = groups.flatMap((group, index) => facts.flatMap(fact => {
    const employer = overlap(group.employer, fact.employer);
    const title = overlap(group.title, fact.title);
    return employer || title ? [{ index, fact, score: employer * 3 + title * 4 }] : [];
  })).sort((a, b) => b.score - a.score);
  const result = groups.map(group => ({ group, fact: null, ambiguous: false }));
  const used = new Set();
  for (const edge of edges) {
    if (result[edge.index].fact || used.has(edge.fact.id)) continue;
    const tied = edges.some(other => other.index === edge.index && other.fact.id !== edge.fact.id
      && !used.has(other.fact.id) && Math.abs(other.score - edge.score) < 0.01);
    if (tied) { result[edge.index].ambiguous = true; continue; }
    if (result[edge.index].ambiguous) continue;
    result[edge.index].fact = edge.fact;
    used.add(edge.fact.id);
  }
  return result;
}

export function workFieldKind(field) {
  const machine = `${field.locator?.id ?? ''} ${field.locator?.aid ?? ''} ${field.name ?? ''}`.toLowerCase();
  const label = norm(field.label);
  if (/currentlyworkhere|currentemployer/.test(machine) || /\b(currently work|still work|current job|current employer|present employer)\b/.test(label)) return 'current';
  if (/jobtitle|positiontitle/.test(machine) || /\b(job title|position title|title)$/.test(label)) return 'title';
  if (/companyname|employername/.test(machine) || /\b(company|employer)( name)?$/.test(label)) return 'employer';
  if (/roledescription|jobdescription|responsibilities/.test(machine) || /\b(description|responsibilities|duties)$/.test(label)) return 'description';
  if (/startdate|fromdate/.test(machine) || /\b(start|from)( date)?( month|year|day|mm|yyyy|dd)?$/.test(label)) return 'start';
  if (/enddate|todate/.test(machine) || /\b(end|to)( date)?( month|year|day|mm|yyyy|dd)?$/.test(label)) return 'end';
  if (/\blocation\b/.test(machine) || /\blocation$/.test(label)) return 'location';
  return null;
}

export function isWorkHistoryField(current, field, values) {
  const bound = bindings.get(values);
  return looksWorkField(field) || (bound?.url === current.url && bound.fields.has(field.ref));
}

const looksWorkField = field => POSITIONAL_WORK_LABEL.test(labelOf(field))
  || /workExperience|professionalExperience|employmentHistory/i.test(field.locator?.id ?? '');

// Full DOM values matter here: snapshots truncate descriptions and may merge same-name current-job
// checkboxes across entries. Read each member in its own panel; use only already stamped refs.
export async function readWorkGroups(page, current) {
  const groups = [], adds = [], gone = [];
  const fields = current.fields.flatMap(field => (field.optionRefs?.length ? field.optionRefs : [field.ref])
    .map(ref => ({ ...field, ref })));
  const refs = [...new Set([...fields.map(field => field.ref), ...current.controls.map(control => control.ref)])];
  for (const frame of page.frames()) {
    const prefix = frame === page.mainFrame() ? '' : `f${encodeURIComponent(String(frame._id ?? frame._frameId))}:`;
    const local = refs.filter(ref => prefix ? ref.startsWith(prefix) : !ref.includes(':'));
    if (!local.length) continue;
    const result = await frame.evaluate(({ refs, prefix }) => {
      const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const nodes = new Map(refs.map(ref => [ref, document.querySelector(`[data-omp-ref="${CSS.escape(ref.slice(prefix.length))}"]`)]));
      const name = node => clean((node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
        || clean(node.getAttribute('aria-label')) || clean(node.querySelector('legend,h1,h2,h3,h4,h5,h6')?.textContent);
      const ownLabel = node => clean([...(node.labels ?? [])].map(label => label.textContent).join(' ')) || clean(node.getAttribute('aria-label'));
      const kind = node => {
        const machine = `${node.id} ${node.getAttribute('name') ?? ''} ${node.getAttribute('data-automation-id') ?? ''}`;
        const label = ownLabel(node).replace(/[\s*:]+$/, '');
        if (/jobTitle|positionTitle/i.test(machine) || /^(job title|position title|title)$/i.test(label)) return 'title';
        if (/companyName|employerName/i.test(machine) || /^(company|employer)( name)?$/i.test(label)) return 'employer';
        return null;
      };
      const inputs = [...document.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox]')].filter(node => node.getClientRects().length);
      const titles = inputs.filter(node => kind(node) === 'title');
      const employers = inputs.filter(node => kind(node) === 'employer');
      const panels = new Set();
      for (const title of titles) {
        for (let node = title.parentElement, depth = 0; node && node !== document.body && depth < 14; node = node.parentElement, depth++) {
          if (titles.filter(other => node.contains(other)).length > 1 || employers.filter(other => node.contains(other)).length > 1) break;
          if (!employers.some(other => node.contains(other))) continue;
          // A calendar button in the date row is not the entry boundary; its Delete/Remove is.
          const removes = [...node.querySelectorAll('button,[role=button]')].some(button =>
            /^(delete|remove)$/i.test(clean(button.getAttribute('aria-label') || button.innerText)));
          if (node.matches('[role=group],[role=region],fieldset') || removes) { panels.add(node); break; }
        }
      }
      const entries = [...panels].map(panel => {
        const held = [...nodes].filter(([, node]) => node && panel.contains(node));
        const fields = held.filter(([, node]) => node.matches('input,select,textarea,[role=combobox],[role=checkbox]')).map(([ref, node]) => ({
          ref, id: node.id, name: node.getAttribute('name') ?? '', label: ownLabel(node),
          value: node.matches('input[type=checkbox],[role=checkbox]') ? (node.checked || node.getAttribute('aria-checked') === 'true' ? 'Yes' : 'No')
            : node.tagName === 'SELECT' ? node.selectedOptions[0]?.textContent ?? '' : node.value ?? node.innerText ?? '',
          checked: Boolean(node.checked || node.getAttribute('aria-checked') === 'true'),
        }));
        const removers = held.filter(([, node]) => node.matches('button,[role=button]')
          && /^(delete|remove)(\s|$)/i.test(clean(node.getAttribute('aria-label') || node.innerText))
          && !/\b(value|file|document|resume|attachment|skill)\b/i.test(clean(node.getAttribute('aria-label') || node.innerText))
          && (!panel.matches('[role=group],[role=region],fieldset') || node.parentElement.closest('[role=group],[role=region],fieldset') === panel));
        return { name: name(panel), fields, remover: removers.length === 1 ? removers[0][0] : null };
      });
      const adds = [...nodes].filter(([, node]) => node?.matches('button,[role=button]') && /^add\b/i.test(clean(node.getAttribute('aria-label') || node.innerText)))
        .filter(([, node]) => {
          for (let parent = node.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth++) {
            if (!parent.matches('[role=group],[role=region],fieldset')) continue;
            return /\b(work|professional|employment)\s+(experience|history)\b/i.test(name(parent));
          }
          return /\b(work|professional|employment)\s+(experience|history)\b/i.test(clean(node.getAttribute('aria-label') || node.innerText));
        }).map(([ref]) => ref);
      // Refs the snapshot stamped that the DOM no longer shows: the screen moved on after a Save and Continue.
      const gone = [...nodes].filter(([, node]) => !node || !node.getClientRects().length).map(([ref]) => ref);
      return { entries, adds, gone };
    }, { refs: local, prefix });
    for (const entry of result.entries) {
      const members = entry.fields.map(raw => {
        const snapshot = fields.find(field => field.ref === raw.ref);
        if (!snapshot) return null;
        const field = { ...snapshot, value: raw.value, checked: raw.checked, name: raw.name,
          locator: { ...snapshot.locator, id: raw.id }, label: raw.label || snapshot.label };
        return { ...field, kind: workFieldKind(field) };
      }).filter(Boolean);
      if (!members.some(field => field.kind === 'title') || !members.some(field => field.kind === 'employer')) continue;
      groups.push({ name: entry.name, fields: members, remover: entry.remover,
        title: members.find(field => field.kind === 'title').value,
        employer: members.find(field => field.kind === 'employer').value });
    }
    adds.push(...result.adds);
    gone.push(...result.gone);
  }
  return { groups, adds: [...new Set(adds)], gone: new Set(gone) };
}

// Boundaries in resolveFill/choose route even a stale learned or model-selected key to this entry's
// own fact. New refs after a re-render are refused until prepare has observed and rebound them.
export function routeWorkFill(current, item, values) {
  const bound = bindings.get(values);
  const field = current.fields.find(field => field.ref === item.ref || field.optionRefs?.includes(item.ref));
  const binding = bound?.url === current.url ? bound.fields.get(item.ref) : null;
  if (!binding) {
    if (field && (looksWorkField(field) || (bound?.url === current.url
      && [...bound.fields.values()].some(other => other.label === field.label || (other.id && other.id === field.locator?.id))))) {
      invalidPlan(`stale-work-history ${labelOf(field)}`);
    }
    return item;
  }
  if (!binding.key) throw new Stop(`needs-user-work-history ${binding.entry}: no stored fact for ${binding.kind || 'this field'}`);
  // Labels may change when the company is corrected; the element's stable locator owns the binding.
  if (field && binding.id && field.locator?.id !== binding.id) invalidPlan(`stale-work-history ${binding.entry}`);
  return { ...item, key: binding.key };
}

function answerFor(values, fact, field) {
  if (!field.kind) return null;
  const base = `facts.work.${fact.id}.${field.kind}`;
  if (field.kind === 'current') {
    if (!fact.end) return null;
    values.set(base, present(fact.end) ? 'Yes' : 'No');
    return { key: base, value: values.get(base) };
  }
  if (!values.has(base) || (field.kind === 'end' && present(fact.end)
    && (datePart(field) || ['month', 'date'].includes(fieldType(field))))) return null;
  const part = ['start', 'end'].includes(field.kind) ? datePart(field) : null;
  let key = part && values.has(`${base}.${part}`) ? `${base}.${part}` : base;
  if (!part && ['start', 'end'].includes(field.kind)) {
    if (fieldType(field) === 'month' && values.has(`${base}.yyyy_mm`)) key = `${base}.yyyy_mm`;
    else if (/mm.*yyyy/i.test(field.placeholder ?? '') && values.has(`${base}.mm_yyyy`)) key = `${base}.mm_yyyy`;
  }
  const value = part ? dateSegment(field, values.get(base)) : values.get(key);
  return { key, value };
}

function sameValue(field, value) {
  const shown = text(field.value), expected = text(value);
  if (field.kind === 'current') return field.checked === (expected === 'Yes');
  if (['start', 'end'].includes(field.kind) && datePart(field) && /^\d+$/.test(shown) && /^\d+$/.test(expected)) return Number(shown) === Number(expected);
  return shown === expected;
}

export async function reconcileWorkHistory(ctx, shared, current) {
  const candidates = current.fields.some(field => looksWorkField(field) || workFieldKind(field) === 'title');
  if (!candidates && !current.controls.some(control => WORK_SECTION.test(control.label))) {
    bindings.delete(ctx.values);
    return false;
  }
  const { groups, adds, gone } = await readWorkGroups(ctx.page, current);
  const facts = workFacts(ctx.values);
  const state = ctx.workHistory;
  const fail = (group, why) => { throw new Stop(`needs-user-work-history ${entryName(group)}: ${why}`); };
  const spend = (group, action) => {
    const key = `${current.url}|${action}`;
    const tries = (state.attempts.get(key) ?? 0) + 1;
    const total = (state.mutations.get(current.url) ?? 0) + 1;
    if (tries > 3 || total > Math.max(40, facts.length * 30)) fail(group, 'the page did not retain the work-history correction');
    state.attempts.set(key, tries);
    state.mutations.set(current.url, total);
    ctx.queued = [];
    ctx.consultProgress = true;
  };
  const changed = async () => { await shared.pause(400); return true; };
  if (!groups.length) {
    bindings.delete(ctx.values);
    const title = current.fields.find(field => workFieldKind(field) === 'title');
    const employer = current.fields.find(field => workFieldKind(field) === 'employer');
    const workFields = current.fields.filter(field => looksWorkField(field) || field === title || field === employer);
    if (current.fields.some(looksWorkField) || (title && employer)) {
      // The snapshot was taken before a Save and Continue landed: its work fields are no longer in the DOM. The
      // screen moved on; a fresh observe follows (a verified entry is not re-read on the next screen). A page whose
      // work fields keep vanishing from under every snapshot is handed to the user after five looks.
      if (workFields.every(field => gone.has(field.ref))) {
        const key = `${current.url}|vanished`;
        state.attempts.set(key, (state.attempts.get(key) ?? 0) + 1);
        if (state.attempts.get(key) > 5) fail({ title: title?.value, employer: employer?.value }, 'its fields vanished from the page under every snapshot');
        return changed();
      }
      fail({ title: title?.value, employer: employer?.value }, 'could not establish the work entry ownership from its DOM group');
    }
    if (!adds.length || !facts.length) return false;
    if (adds.length !== 1) fail(facts[0], 'the empty section has more than one Add control');
    spend(facts[0], 'add-empty');
    await mutate('CLICK', 'Add Work Experience', () => act.click(ctx.page, adds[0]));
    shared.say('WORK HISTORY added one entry to the empty section');
    // Workday draws the new entry a beat after the click (a server round trip): a re-observe inside that beat sees
    // the section still empty and adds again (Midland States Bank: three blank entries, two then removed, or three
    // adds lost to a step transition and a stop). Wait for the entry's panel, up to 6 s.
    for (let waited = 0; waited < 6000; waited += 400) {
      await shared.pause(400);
      if ((await readWorkGroups(ctx.page, current)).groups.length) break;
    }
    return true;
  }
  const matched = matchWorkEntries(groups, facts);
  // Only an entirely blank, sole entry may be initialized from the first fact. No page ordinal is
  // ever treated as a fact index, and extra blank/junk entries never create missing jobs.
  if (groups.length === 1 && !text(groups[0].title) && !text(groups[0].employer) && facts.length) matched[0].fact = facts[0];
  const boundFields = new Map();
  for (const { group, fact } of matched) for (const field of group.fields) {
    const answer = fact && answerFor(ctx.values, fact, field);
    boundFields.set(field.ref, { key: answer?.key, kind: field.kind, entry: entryName(group), id: field.locator?.id, label: field.label });
    // Positional and caption-keyed QA/learned answers must not race the reconciler. Do not persist
    // a replacement mapping: the group's identity is re-established on every observation.
    const snapshot = current.fields.find(other => other.ref === field.ref || other.optionRefs?.includes(field.ref));
    for (const label of [field.label, snapshot?.label].filter(Boolean)) {
      delete ctx.learned.fields[norm(label)];
      ctx.values.delete(`qa.${norm(label)}`);
      delete ctx.filledKeys[label];
      delete ctx.learnAs[label];
    }
  }
  bindings.set(ctx.values, { url: current.url, fields: boundFields });
  const bad = matched.find(entry => !entry.fact);
  if (bad) {
    if (bad.ambiguous) fail(bad.group, 'company/title match more than one stored job');
    if (!bad.group.remover) fail(bad.group, 'unmatched entry has no unambiguous owned Delete/Remove control');
    spend(bad.group, `delete|${entryName(bad.group)}|${groups.length}`);
    await act.press(ctx.page, 'Escape').catch(() => undefined);
    await mutate('CLICK', `Delete ${bad.group.name || 'work entry'}`, () => act.click(ctx.page, bad.group.remover));
    shared.say(`WORK HISTORY removed unmatched entry "${entryName(bad.group)}"`);
    return changed();
  }
  for (const { group, fact } of matched) {
    if (!fact.title || !fact.employer) fail(group, `facts.work.${fact.id} is missing its title or employer`);
    // The current-job checkbox owns whether end-date controls exist; settle it before any dates.
    const ordered = [...group.fields].sort((a, b) => Number(b.kind === 'current') - Number(a.kind === 'current'));
    for (const field of ordered) {
      const answer = answerFor(ctx.values, fact, field);
      if (!answer) {
        if (field.kind === 'end' && present(fact.end) && group.fields.some(other => other.kind === 'current' && other.checked)) continue;
        if (field.kind || field.required) fail(group, `no stored fact for ${labelOf(field)} (facts.work.${fact.id}.${field.kind ?? 'unknown'})`);
        continue;
      }
      if (sameValue(field, answer.value)) continue;
      if (field.maxLength > 0 && answer.value.length > field.maxLength) fail(group, `${answer.key} exceeds the field's character limit`);
      spend(group, `fill|${answer.key}|${datePart(field) ?? ''}`);
      if (field.kind === 'current') await mutate('CLICK', labelOf(field), () => act.click(ctx.page, field.ref));
      else if (isChoiceField(field)) await shared.pickOne(current, field, answer.key, answer.value);
      else await mutate('FILL', labelOf(field), () => act.type(ctx.page, field.ref, answer.value, { secret: true }));
      shared.say(`WORK HISTORY corrected "${entryName(group)}" ${labelOf(field)} from ${answer.key}`);
      return changed();
    }
  }
  // The section already contains real jobs. Do not let a model's Add/Add Another expand it merely
  // because another section has a multi-item list (moreEntries is a page-wide legacy predicate).
  current.controls = current.controls.filter(control => !adds.includes(control.ref));
  const workRefs = new Set(boundFields.keys());
  ctx.queued = ctx.queued.filter(plan => !workRefs.has(plan.ref) && !plan.fields?.some(field => workRefs.has(field.ref))
    && !plan.refs?.some(ref => workRefs.has(ref)));
  const mark = JSON.stringify([current.url, matched.map(({ fact }) => fact.id)]);
  if (!state.verified.has(mark)) {
    state.verified.add(mark);
    shared.say(`WORK HISTORY verified ${matched.map(({ fact }) => `"${fact.title}" @ "${fact.employer}"`).join('; ')}`);
    runlog.trace('work-history', { entries: matched.map(({ fact }) => ({ fact: fact.id, title: fact.title, employer: fact.employer })) });
  }
  return false;
}
