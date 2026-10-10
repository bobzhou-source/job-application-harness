// lib/trace.mjs — per-run decision log: runs/<timestamp>.jsonl, one JSON object per line.
// Callers pass only model-visible data (labels, keys, scores) and action labels:
// never answer values, passwords, resume paths, or query strings.

import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../runs/', import.meta.url));
let file = null;
let startedAt = 0;
let lastOutcome = null;
// Per-model call totals for this run: {calls, failed, ms, cost, input, output}.
const totals = {};
const refusals = {};
let actions = 0;
// Host of the last screen Jev saw: the employer site the run ended on, not the posting it started from.
let siteHost = null;

export function start() {
  mkdirSync(dir, { recursive: true });
  startedAt = Date.now();
  file = `${dir}${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.jsonl`;
  return file;
}

export function trace(event, data = {}) {
  if (event === 'log' && /^(STOP|SUBMITTED)\b/.test(data.line ?? '')) lastOutcome = data.line;
  if (event === 'jev' && data.state?.url?.host) siteHost = data.state.url.host;
  if (event === 'log' && /^(JEV|DEEPSEEK|CHOOSE|HARNESS) [A-Z_]+ /.test(data.line ?? '') && !/^DEEPSEEK [a-z]/.test(data.line)) actions++;
  if (event === 'refused') {
    const reason = String(data.reason ?? '').replace(/^invalid-plan /, '').split(' ')[0];
    refusals[reason] = (refusals[reason] ?? 0) + 1;
  }
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
}

// One model call: model is "jev" | "deepseek" | "writer"; cost in USD as billed or estimated (estimated: true).
export function meter(model, { purpose, ms, cost = 0, input = 0, cached = 0, output = 0, ok = true, estimated = false }) {
  const t = (totals[model] ??= { calls: 0, failed: 0, ms: 0, cost: 0, input: 0, output: 0 });
  t.calls++;
  if (!ok) t.failed++;
  t.ms += ms;
  t.cost += cost;
  t.input += input;
  t.output += output;
  trace('call', { model, purpose, ms, cost, input, ...(cached ? { cached } : {}), output, ok, ...(estimated ? { estimated } : {}) });
}

// Run summary: traced as the last event and appended to runs/summary.jsonl (one line per run) for the report.
export function summary(data = {}) {
  if (!file) return;
  const secs = Math.round((Date.now() - startedAt) / 100) / 10;
  const cost = Object.values(totals).reduce((sum, t) => sum + t.cost, 0);
  const outcome = /^SUBMITTED/.test(lastOutcome ?? '') ? 'submitted' : lastOutcome ? 'stopped' : 'unknown';
  const row = {
    t: new Date(startedAt).toISOString(), trace: file.slice(dir.length), ...data, site: siteHost ?? data.host ?? null, outcome,
    reason: (lastOutcome ?? '').replace(/^STOP: /, '').slice(0, 200), secs, actions,
    cost: Math.round(cost * 1e5) / 1e5, models: totals, refusals,
  };
  trace('summary', row);
  appendFileSync(`${dir}summary.jsonl`, `${JSON.stringify(row)}\n`);
}
