// The answer ledger: every answer the runs committed, one row per event, indexed once from the traces into
// runs/answers-ledger.jsonl so any later question ("where did "Tolls" come from?", "which runs replayed this site
// answer?", "what did the writer pick?") is a scan of one file, not a re-read of every trace. Rows:
//   { t, day, run, host, site, title, job, outcome, kind, label, value, key, source, how, scope, question, grade,
//     why, revised, purpose, sure }
//   kind    choice  a dropdown/radio/combobox option committed (CHOOSE / FILL typed-text lines)
//           fill    a field filled from a stored key by a plan (value is the key's text, not kept in the trace)
//           stored  an answer written to answers.json (REMEMBERED → qa, REMEMBERED-SITE → written[site])
//           written a free-text draft the writer composed and the grader scored (grades events)
//   source  who planned the fill: template | learned | rule | registry | jev | deepseek
//   how     how the option was chosen: exact (stored answer or alias) | lead (leading words) | learned (a choice a
//           past run mapped) | model (choice step picked among listed options) | writer (preference pick, no stored
//           answer matched) | other ("Other" entry) | only (single child) | typed | nomatch
//   sure    false when the key was inferred for a trace written before CHOOSE lines carried "← key via how"
// updateLedger() indexes only traces not yet in the file; --rebuild starts over (the parser changed).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalize } from '../answers.mjs';

const RUNS = fileURLToPath(new URL('../../runs/', import.meta.url));
const LEDGER = `${RUNS}answers-ledger.jsonl`;
const STATE = `${RUNS}answers-ledger.state.json`;
const KINDS = ['"event":"log"', '"event":"plan"', '"event":"jev"', '"event":"grades"', '"event":"filled"'];

const labelKey = label => normalize(String(label ?? '').replace(/\*+$/, ''));
const siteOf = row => String(row.site ?? row.host ?? '?');

// Rows for one run, read from its trace.
export function parseTrace(row, text) {
  const base = { run: row.trace, day: String(row.t).slice(0, 10), host: row.host, site: siteOf(row), title: row.title ?? '', job: row.job ?? '', outcome: row.outcome };
  const rows = [];
  const refLabel = new Map();
  let lastPlan = null;
  let templateLabels = [];
  const writerPicks = new Map();
  const learnedPicks = new Set();
  const keyFor = label => {
    const want = labelKey(label);
    const fields = lastPlan?.fields ?? [];
    const byRef = fields.find(field => refLabel.has(field.ref) && labelKey(refLabel.get(field.ref)) === want);
    if (byRef) return { key: byRef.key, sure: true };
    const at = templateLabels.findIndex(text => labelKey(text) === want);
    if (at >= 0 && fields[at]?.key) return { key: fields[at].key, sure: true };
    if (fields.length === 1) return { key: fields[0].key, sure: false };
    return { key: null, sure: false };
  };
  // A fill plan's rows are held until the executor reports what it committed (the `filled` event, with each label and
  // key paired) and only stand in for a trace written before that event existed: refs are renumbered per snapshot, so
  // a label read back through refLabel can belong to an earlier screen.
  let pendingFill = [];
  const flushPending = () => { rows.push(...pendingFill); pendingFill = []; };
  const planned = (event, source, plan) => {
    flushPending();
    const fields = plan?.fields ?? (plan?.key ? [{ ref: plan.ref, key: plan.key }] : []);
    lastPlan = { source, fields };
    if (plan?.action !== 'fill') return;
    for (const field of fields) {
      const label = refLabel.get(field.ref) ?? templateLabels[fields.indexOf(field)] ?? null;
      pendingFill.push({ t: event.t, ...base, kind: 'fill', label, value: null, key: field.key, source, how: null, sure: false });
    }
  };
  for (const line of text.split('\n')) {
    if (!KINDS.some(needle => line.includes(needle))) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === 'jev') {
      for (const field of event.state?.fields ?? []) {
        const m = /^(e\d+) \| ([^|]+?) \|/.exec(String(field));
        if (m) refLabel.set(m[1], m[2].trim());
      }
      if (event.plan?.action) planned(event, 'jev', event.plan);
    } else if (event.event === 'plan') {
      planned(event, event.source, event.plan);
    } else if (event.event === 'filled') {
      const source = lastPlan?.source ?? null;
      pendingFill = [];
      for (const field of event.fields ?? []) {
        rows.push({ t: event.t, ...base, kind: 'fill', label: field.label ?? null, value: null, key: field.key ?? null, source, how: null, sure: true });
      }
    } else if (event.event === 'grades') {
      for (const item of event.items ?? []) {
        rows.push({ t: event.t, ...base, kind: 'written', label: item.question ?? '', value: item.answer ?? null, key: null, source: 'writer', how: 'writer',
          purpose: event.purpose, grade: item.grade, why: item.why, revised: Boolean(item.revised), sure: true });
      }
    } else if (event.event === 'log') {
      const text = String(event.line ?? '');
      let m;
      if ((m = /^TEMPLATE fill (.+)$/.exec(text))) { templateLabels = m[1].split(', '); continue; }
      if ((m = /^WRITER (?:choice|preference) "(.+?)" = (?:"(.*?)"|none)(?: \(no option matched (\S+)\))?$/.exec(text))) {
        if (m[2] != null) writerPicks.set(labelKey(m[1]), { value: m[2], key: m[3] ?? null });
        continue;
      }
      if ((m = /^LEARNED choice "(.+?)" for /.exec(text))) { learnedPicks.add(normalize(m[1])); continue; }
      if ((m = /^CHOOSE (.+?) = "(.*?)"(?: ← (\S+) via (\S+))?(?: \((leading words of the stored answer|not listed; the "Other" field takes it)\))?$/.exec(text))) {
        const [, label, value, key, how, note] = m;
        const writer = writerPicks.get(labelKey(label));
        const inferred = key ? { key, sure: true } : writer?.key ? { key: writer.key, sure: true } : keyFor(label);
        let chosen = how ?? (note?.startsWith('leading') ? 'lead' : note ? 'other' : writer && normalize(writer.value) === normalize(value) ? 'writer' : 'match');
        if ((chosen === 'match' || chosen === 'model') && learnedPicks.has(normalize(value))) chosen = 'learned';
        rows.push({ t: event.t, ...base, kind: 'choice', label, value, key: inferred.key, source: lastPlan?.source ?? null, how: chosen, sure: inferred.sure });
        continue;
      }
      if ((m = /^FILL (.+?) = typed text/.exec(text))) {
        const inferred = keyFor(m[1]);
        rows.push({ t: event.t, ...base, kind: 'choice', label: m[1], value: null, key: inferred.key, source: lastPlan?.source ?? null, how: 'typed', sure: inferred.sure });
        continue;
      }
      if ((m = /^REMEMBERED(-SITE)? "(.+?)" = "(.*?)"(?: \((.+)\))?$/.exec(text))) {
        rows.push({ t: event.t, ...base, kind: 'stored', label: m[2], value: m[3], key: `qa.${normalize(m[2])}`, source: null, how: null, scope: m[1] ? 'site' : 'global', sure: true });
        continue;
      }
      // The run's posting-country decision (lib/work-authorization.mjs): every authorization and sponsorship answer
      // in the run followed it, so a wrong country is a wrong answer on each.
      if ((m = /^WORK RIGHTS posting in (.+?): (authorized|not authorized)/.exec(text))) {
        rows.push({ t: event.t, ...base, kind: 'policy', label: 'posting country', value: m[1], key: 'work-rights', source: 'rule', how: m[2] === 'authorized' ? 'authorized' : 'not-authorized', sure: true });
      }
    }
  }
  flushPending();
  // A choice field planned and then committed appears once, as its commit; fill rows stay for text fields.
  const committed = new Set(rows.filter(row => row.kind === 'choice').map(row => `${labelKey(row.label)}|${row.key}`));
  return rows.filter(row => row.kind !== 'fill' || !committed.has(`${labelKey(row.label)}|${row.key}`));
}

export function loadLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// Index every summary row whose trace is on disk and not yet indexed; returns all ledger rows.
export function updateLedger(summaryRows, { rebuild = false } = {}) {
  const state = !rebuild && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { indexed: [] };
  const indexed = new Set(state.indexed);
  const fresh = [];
  let added = 0;
  for (const row of summaryRows) {
    if (!row.trace || indexed.has(row.trace)) continue;
    let text;
    try { text = readFileSync(`${RUNS}${row.trace}`, 'utf8'); } catch { continue; }
    const rows = parseTrace(row, text);
    fresh.push(...rows);
    indexed.add(row.trace);
    added += 1;
  }
  const lines = fresh.map(row => JSON.stringify(row)).join('\n');
  if (rebuild) writeFileSync(LEDGER, lines ? `${lines}\n` : '');
  else if (lines) appendFileSync(LEDGER, `${lines}\n`);
  writeFileSync(STATE, `${JSON.stringify({ indexed: [...indexed] })}\n`);
  const rows = rebuild ? fresh : loadLedger();
  return { rows, added, indexed: indexed.size };
}
